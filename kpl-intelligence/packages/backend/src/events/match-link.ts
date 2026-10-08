// P2 新闻 ↔ 比赛硬链接器：把归组好的 story 挂到 matches 上（新闻域与比赛域唯一的桥）。
// 幂等（ON CONFLICT DO NOTHING + 写前查重，game_no 为 NULL 时唯一约束不生效）；
// 找不到唯一候选（零候选/多候选）时不写，只记日志。失败不阻断归组（调用方 best-effort）。
import { sql, type Db } from "../db.ts";
import { extractMatchFingerprint, type KplMatchFingerprint } from "../lib/kpl-dedup.ts";

export interface StoryMatchLink {
  matchId: string;
  gameNo: number | null;
  linkType: "series" | "game" | "node";
}

const log = (msg: string) => console.warn(`[match-link] ${msg}`);

/** 故事日期 ±1 天的赛事日窗口（跨午夜比赛按赛事日口径不拆档）。 */
function eventDayWindow(dateKey: string): { start: Date; end: Date } {
  const base = Date.parse(`${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}T00:00:00+08:00`);
  return { start: new Date(base - 86_400_000), end: new Date(base + 2 * 86_400_000) };
}

interface LinkText {
  text: string;
  at: Date | null;
}

/**
 * linkStoryToMatch(db, storyId)：用 kpl-dedup 指纹（两队 slug + 日期键 + 赛事/阶段）在 matches
 * 表找候选：team_a_id/team_b_id 双向匹配且 played_at 或 scheduled_at 落在故事日期 ±1 天。
 * 唯一候选 → 写 match_story_links；多候选/零候选 → 不写。
 * game_no 归属：story 的 facts 若带局次信息（标题"第一局/第三局"）→ link_type='game'；
 * 否则整场级 link_type='series'（未知局次不误归档）。
 */
export async function linkStoryToMatch(db: Db = sql, storyId: number): Promise<StoryMatchLink | null> {
  const [story] = await db<{ id: number; title: string; first_report_at: Date | null }[]>`
    SELECT id, title, first_report_at FROM stories WHERE id = ${storyId} AND merged_into IS NULL`;
  if (!story) return null;

  const facts = await db<{ title: string }[]>`SELECT title FROM facts WHERE story_id = ${storyId}`;
  const articles = await db<{ title: string; published_at: Date | null }[]>`
    SELECT a.title, a.published_at
    FROM fact_articles fa JOIN articles a ON a.id = fa.article_id JOIN facts f ON f.id = fa.fact_id
    WHERE f.story_id = ${storyId} AND fa.role IN ('primary', 'report')
    ORDER BY a.published_at NULLS LAST LIMIT 20`;
  const texts: LinkText[] = [
    { text: story.title, at: story.first_report_at },
    ...facts.map((f) => ({ text: f.title, at: story.first_report_at })),
    ...articles.map((a) => ({ text: a.title, at: a.published_at })),
  ];

  let fp: KplMatchFingerprint | null = null;
  for (const t of texts) {
    const f = extractMatchFingerprint(t.text, t.at);
    if (f && f.dateKey) { fp = f; break; }
  }
  if (!fp?.dateKey) {
    log(`story ${storyId}: no match fingerprint, skip`);
    return null;
  }
  const teams = await db<{ id: string; slug: string }[]>`SELECT id, slug FROM teams WHERE slug = ANY(${fp.teams})`;
  const bySlug = new Map(teams.map((t) => [t.slug, t.id]));
  const idA = bySlug.get(fp.teams[0]!);
  const idB = bySlug.get(fp.teams[1]!);
  if (!idA || !idB) {
    log(`story ${storyId}: team slug not in kb (${fp.teams.join(",")}), skip`);
    return null;
  }
  const { start, end } = eventDayWindow(fp.dateKey);
  const candidates = await db<{ id: string }[]>`
    SELECT m.id FROM matches m
    WHERE ((m.team_a_id = ${idA} AND m.team_b_id = ${idB}) OR (m.team_a_id = ${idB} AND m.team_b_id = ${idA}))
      AND coalesce(m.played_at, m.scheduled_at) >= ${start.toISOString()}
      AND coalesce(m.played_at, m.scheduled_at) < ${end.toISOString()}`;
  if (candidates.length !== 1) {
    log(`story ${storyId}: ${candidates.length} match candidates for ${fp.teams.join(" vs ")} ${fp.dateKey}, skip`);
    return null;
  }
  const matchId = candidates[0]!.id;

  // 局次归属：story 内 facts/报道标题里出现的局次；唯一 → game 级，否则整场级（未知局次不误归档）。
  const gameNos = new Set<number>();
  for (const t of texts) {
    const f = extractMatchFingerprint(t.text, t.at);
    if (f?.game) gameNos.add(Number(f.game));
  }
  const gameNo = gameNos.size === 1 ? [...gameNos][0]! : null;
  const linkType: StoryMatchLink["linkType"] = gameNo != null ? "game" : "series";

  // 幂等：game_no 为 NULL 时 (match_id, story_id, game_no) 唯一约束不生效，先查重。
  const existing = await db<{ id: number }[]>`
    SELECT id FROM match_story_links
    WHERE match_id = ${matchId} AND story_id = ${storyId} AND game_no IS NOT DISTINCT FROM ${gameNo} LIMIT 1`;
  if (existing.length) return { matchId, gameNo, linkType };
  await db`INSERT INTO match_story_links (match_id, story_id, game_no, link_type, confidence, origin)
           VALUES (${matchId}, ${storyId}, ${gameNo}, ${linkType}, ${gameNo != null ? 0.9 : 0.7}, 'model')
           ON CONFLICT DO NOTHING`;
  return { matchId, gameNo, linkType };
}

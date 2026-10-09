// KB 检索的文本块层（阶段 4.1）：把比赛综述、战队/选手/英雄档案与文章统一渲染成 chunks，
// 供语义通道（pgvector）与关键词通道检索。写入一律先删后插（事务内幂等，跑两遍行数不变）；
// embedding 复用 ensureEmbeddings（缓存 + 计费回执 + 1024 维校验），
// MODEL_CALLS_ENABLED=false 时只落文本块，空向量在下次重建/回填时补齐。
import { createHash } from "node:crypto";
import { beijingDate } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { canonicalOriginalText } from "../content/canonical.ts";
import type { CanonicalContent } from "../content/extractors/types.ts";
import { ensureEmbeddings, embeddingsAvailable } from "../providers/embeddings.ts";

const CHUNK_TARGET = 800; // 组块目标大小（字符，中文）
const CHUNK_HARD_MAX = 1200; // 超长段落硬切阈值

export type ChunkSourceType = "article" | "match" | "team" | "player" | "hero";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** 按 Markdown/纯文本段落切块：组装到 ~800 字符，超长单段硬切；不重叠（段落边界切分，避免引用噪声）。 */
export function chunkText(text: string, target = CHUNK_TARGET, hardMax = CHUNK_HARD_MAX): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const blocks: string[] = [];
  let current = "";
  for (const p of paras) {
    if (p.length > hardMax) {
      if (current) blocks.push(current);
      current = "";
      for (let i = 0; i < p.length; i += target) blocks.push(p.slice(i, i + target));
      continue;
    }
    if (current && current.length + p.length + 2 > target) {
      blocks.push(current);
      current = p;
    } else {
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/** 覆盖式写入一个主体的 chunks（先删后插）；返回块数。 */
async function writeChunks(sourceType: ChunkSourceType, refId: string, title: string, blocks: string[]): Promise<number> {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM chunks WHERE source_type = ${sourceType} AND ref_id = ${refId}`;
    for (const [ord, content] of blocks.entries()) {
      await tx`
        INSERT INTO chunks (source_type, ref_id, ord, title, content, token_count, text_hash)
        VALUES (${sourceType}, ${refId}, ${ord}, ${title}, ${content}, ${Math.ceil(content.length / 2)}, ${sha(content)})`;
    }
  });
  await fillChunkEmbeddings(sourceType, refId);
  return blocks.length;
}

/** 给某主体尚未生成向量的 chunks 补算 embedding（ensureEmbeddings 自带缓存与计费回执）。 */
export async function fillChunkEmbeddings(sourceType: ChunkSourceType, refId: string): Promise<number> {
  if (!embeddingsAvailable()) return 0;
  const rows = await sql<{ ord: number; content: string }[]>`
    SELECT ord, content FROM chunks
    WHERE source_type = ${sourceType} AND ref_id = ${refId} AND embedding IS NULL
    ORDER BY ord`;
  if (!rows.length) return 0;
  const items = rows.map((r) => ({ id: `${sourceType}:${refId}:${r.ord}`, text: r.content }));
  const vectors = await ensureEmbeddings(items);
  let filled = 0;
  for (const row of rows) {
    const vec = vectors.get(`${sourceType}:${refId}:${row.ord}`);
    if (!vec) continue;
    // pgvector 不接受数组字面量参数，走字符串再 ::vector
    await sql`UPDATE chunks SET embedding = ${`[${vec.join(",")}]`}::vector
      WHERE source_type = ${sourceType} AND ref_id = ${refId} AND ord = ${row.ord}`;
    filled += 1;
  }
  return filled;
}

/** 文章正文 → chunks（标题取 articles.title；正文为空时清空该文章的旧块）。
 * 针对 social_post 实施 RAG 知识库质量准入门槛：过滤低分与无事实动态，守护向量库纯净。
 */
export async function rebuildArticleChunks(articleId: string): Promise<number> {
  const [article] = await sql<{
    title: string;
    body_text: string | null;
    content_kind: string | null;
    content_quality_score: number | null;
    canonical_content: CanonicalContent | null;
  }[]>`
    SELECT title, body_text, content_kind, content_quality_score, canonical_content FROM articles WHERE id = ${articleId}`;
  if (!article) return 0;

  // 社交动态 (social_post) 准入守卫：仅当质量分 >= 70 时方可切块入库
  if (article.content_kind === "social_post") {
    const score = article.content_quality_score ?? 0;
    if (score < 70) {
      await sql`DELETE FROM chunks WHERE source_type = 'article' AND ref_id = ${articleId}`;
      return 0;
    }
  }

  const text = article.canonical_content?.discussion
    ? canonicalOriginalText(article.canonical_content)
    : article.body_text;
  return writeChunks("article", articleId, article.title, text ? chunkText(text) : []);
}

interface MatchRow {
  id: string;
  stage: string | null;
  bo: number | null;
  played_at: Date | null;
  scheduled_at: Date | null;
  score_a: number | null;
  score_b: number | null;
  winner_id: string | null;
  season_name: string;
  a_name: string;
  b_name: string;
}

interface GameRow {
  game_no: number;
  mode: string;
  winner_team: string | null;
  duration_secs: number | null;
  mvp: string | null;
  kills_a: number | null;
  kills_b: number | null;
  gold_a: string | null;
  gold_b: string | null;
}

function fmtGold(v: string | number | null): string | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n / 10000)}k` : String(v);
}

function renderMatch(m: MatchRow, games: GameRow[]): string {
  const when = m.played_at ?? m.scheduled_at;
  const lines = [
    `【比赛】${m.season_name}${m.stage ? ` · ${m.stage}` : ""}`,
    `对阵:${m.a_name} vs ${m.b_name}${m.bo ? `（BO${m.bo}）` : ""}`,
    when ? `时间:${beijingDate(when)}` : null,
    (m.score_a != null || m.score_b != null) ? `比分:${m.a_name} ${m.score_a ?? 0} : ${m.score_b ?? 0} ${m.b_name}` : null,
  ];
  for (const g of games) {
    const bits = [
      `胜者 ${g.winner_team ?? "-"}`,
      g.mvp ? `MVP ${g.mvp}` : null,
      g.duration_secs ? `时长 ${Math.floor(g.duration_secs / 60)}分${g.duration_secs % 60}秒` : null,
      (g.kills_a != null || g.kills_b != null) ? `人头 ${g.kills_a ?? 0}:${g.kills_b ?? 0}` : null,
      (g.gold_a != null || g.gold_b != null) ? `经济 ${fmtGold(g.gold_a) ?? "-"}:${fmtGold(g.gold_b) ?? "-"}` : null,
      g.mode === "pinnacle" ? "巅峰对决" : null,
    ].filter(Boolean);
    lines.push(`第${g.game_no}局:${bits.join(" | ")}`);
  }
  return lines.filter((l): l is string => l !== null).join("\n");
}

/** 比赛综述 → chunks；不传 matchId 则全量重建。返回写入的块数。 */
export async function rebuildMatchChunks(matchId?: string): Promise<number> {
  const matches = await sql<MatchRow[]>`
    SELECT m.id, m.stage, m.bo, m.played_at, m.scheduled_at, m.score_a, m.score_b, m.winner_id,
           s.name AS season_name, ta.name AS a_name, tb.name AS b_name
    FROM matches m
    JOIN teams ta ON ta.id = m.team_a_id
    JOIN teams tb ON tb.id = m.team_b_id
    JOIN seasons s ON s.id = m.season_id
    ${matchId ? sql`WHERE m.id = ${matchId}` : sql``}
    ORDER BY coalesce(m.played_at, m.scheduled_at) DESC NULLS LAST`;
  let total = 0;
  for (const m of matches) {
    const games = await sql<GameRow[]>`
      SELECT g.game_no, g.mode, tw.name AS winner_team, g.duration_secs, p.nickname AS mvp,
             g.kills_a, g.kills_b, g.gold_a::text, g.gold_b::text
      FROM games g
      LEFT JOIN teams tw ON tw.id = g.winner_id
      LEFT JOIN players p ON p.id = g.mvp_player_id
      WHERE g.match_id = ${m.id}
      ORDER BY g.game_no`;
    total += await writeChunks("match", m.id, `${m.a_name} vs ${m.b_name}`, chunkText(renderMatch(m, games)));
  }
  return total;
}

interface TeamRow {
  id: string;
  slug: string;
  name: string;
  city: string | null;
  founded_at: string | null;
  history_names: string[] | null;
  league: string;
  style_notes: string | null;
}

function renderTeam(t: TeamRow, roster: { nickname: string; position: string | null }[]): string {
  const lines = [
    `【战队档案】${t.name}（slug: ${t.slug}）`,
    `联赛:${t.league}${t.city ? ` | 城市:${t.city}` : ""}${t.founded_at ? ` | 成立:${t.founded_at}` : ""}`,
    t.history_names?.length ? `历史名称:${t.history_names.join("、")}` : null,
    t.style_notes ? `风格:${t.style_notes}` : null,
    roster.length ? `现役阵容:${roster.map((p) => (p.position ? `${p.nickname}（${p.position}）` : p.nickname)).join("、")}` : null,
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

/** 战队档案 → chunks；不传 teamId 则全量重建。 */
export async function rebuildTeamChunks(teamId?: string): Promise<number> {
  const teams = await sql<TeamRow[]>`
    SELECT id, slug, name, city, founded_at::text, history_names, league, style_notes
    FROM teams
    ${teamId ? sql`WHERE id = ${teamId}` : sql``}
    ORDER BY sort_weight DESC, id`;
  let total = 0;
  for (const t of teams) {
    const roster = await sql<{ nickname: string; position: string | null }[]>`
      SELECT nickname, position FROM players WHERE current_team_id = ${t.id} AND is_active
      ORDER BY position NULLS LAST, nickname`;
    total += await writeChunks("team", t.id, t.name, chunkText(renderTeam(t, roster)));
  }
  return total;
}

/** 选手档案 → chunks；不传 playerId 则全量重建。 */
export async function rebuildPlayerChunks(playerId?: string): Promise<number> {
  const players = await sql<{ id: string; slug: string; nickname: string; real_name: string | null; position: string | null; debut_at: string | null; bio: string | null; team: string | null }[]>`
    SELECT p.id, p.slug, p.nickname, p.real_name, p.position, p.debut_at::text, p.bio, t.name AS team
    FROM players p LEFT JOIN teams t ON t.id = p.current_team_id
    ${playerId ? sql`WHERE p.id = ${playerId}` : sql``}
    ORDER BY p.id`;
  let total = 0;
  for (const p of players) {
    const lines = [
      `【选手档案】${p.nickname}${p.real_name ? `（本名 ${p.real_name}）` : ""}（slug: ${p.slug}）`,
      [p.position ? `位置:${p.position}` : null, p.team ? `战队:${p.team}` : null, p.debut_at ? `出道:${p.debut_at}` : null].filter(Boolean).join(" | ") || null,
      p.bio ? `简介:${p.bio}` : null,
    ].filter((l): l is string => l !== null);
    total += await writeChunks("player", p.id, p.nickname, chunkText(lines.join("\n")));
  }
  return total;
}

/** 英雄档案 → chunks；不传 heroId 则全量重建。 */
export async function rebuildHeroChunks(heroId?: string): Promise<number> {
  const heroes = await sql<{ id: string; slug: string; name: string; title: string | null; roles: string[] | null; positions: string[] | null; power_period: string | null; function_tags: string[] | null; notes: string | null; version_strength: number | null }[]>`
    SELECT id, slug, name, title, roles, positions, power_period, function_tags, notes, version_strength
    FROM heroes
    ${heroId ? sql`WHERE id = ${heroId}` : sql``}
    ORDER BY id`;
  const PERIOD: Record<string, string> = { early: "前期", mid: "中期", late: "后期", all: "全程" };
  let total = 0;
  for (const h of heroes) {
    const lines = [
      `【英雄档案】${h.name}（slug: ${h.slug}）`,
      [h.title ? `称号:${h.title}` : null, h.roles?.length ? `定位:${h.roles.join("/")}` : null, h.positions?.length ? `位置:${h.positions.join("/")}` : null, h.power_period ? `强势期:${PERIOD[h.power_period] ?? h.power_period}` : null].filter(Boolean).join(" | ") || null,
      h.function_tags?.length ? `功能标签:${h.function_tags.join("、")}` : null,
      h.version_strength != null ? `版本强度:${h.version_strength}/10` : null,
      h.notes ? `特征:${h.notes}` : null,
    ].filter((l): l is string => l !== null);
    total += await writeChunks("hero", h.id, h.name, chunkText(lines.join("\n")));
  }
  return total;
}

/** 按实体类型重建档案 chunks（team/player/hero 的统一入口）。 */
export async function rebuildEntityChunks(kind: "team" | "player" | "hero", id?: string): Promise<number> {
  if (kind === "team") return rebuildTeamChunks(id);
  if (kind === "player") return rebuildPlayerChunks(id);
  return rebuildHeroChunks(id);
}

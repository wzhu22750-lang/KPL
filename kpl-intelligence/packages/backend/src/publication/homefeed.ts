// 首页混合信息流（P4）：热榜 entries + 时间线 cards，按分桶配比混排。
// 混排算法是纯函数 mixFeed（无 DB，单测覆盖）；loadHomeFeed 只负责取数、分类、分页切片。
import type {
  FollowedResponse,
  HomeFeedBucket,
  HomeFeedCoverage,
  HomeFeedEntry,
  HomeFeedResponse,
  HotStripEntry,
  TimelineCard,
} from "@aihot/contracts/site";
import { HOMEFEED } from "@aihot/industry/homefeed";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { sql } from "../db.ts";
import { decodeCursor, encodeCursor, InvalidCursorError, queryBinding } from "../lib/cursor.ts";
import { ITEM_COLUMNS, ITEM_FROM, toFeedItemSummary, type ItemRow } from "./items.ts";
import { latestHotRanking, rankingExtras } from "./hot.ts";
import { loadTimeline } from "./timeline.ts";
import { listedCondition } from "./scope.ts";
import type { HotEntry } from "../events/hot.ts";

/** 评论类类别（taxonomy 的 commentary 标记）：opinion/tactics。 */
const COMMENTARY_CATEGORIES: Set<string> = new Set(CATEGORIES.filter((c) => "commentary" in c).map((c) => c.key));

export type FeedBucket = HomeFeedBucket;
export type FeedRatios = Record<FeedBucket, number>;

const BUCKETS: FeedBucket[] = ["dispute", "other", "opinion", "fun"];

/** mixFeed 的输入项：key 全局唯一，storyKey 用于热榜/时间线去重，priority 越大越靠前。 */
export interface MixItem {
  key: string;
  storyKey: string | null;
  bucket: FeedBucket;
  priority: number;
}

function normalizedRatios(ratios: FeedRatios): FeedRatios {
  const total = BUCKETS.reduce((s, b) => s + Math.max(0, ratios[b] ?? 0), 0);
  if (!(total > 0)) return { dispute: 0.5, other: 0.2, opinion: 0.15, fun: 0.15 };
  const out = {} as FeedRatios;
  for (const b of BUCKETS) out[b] = Math.max(0, ratios[b] ?? 0) / total;
  return out;
}

/**
 * 加权轮询混排（纯函数）：
 * - 热榜已覆盖的 story 在时间线部分跳过（同一 story 一屏只出现一次）；
 * - 桶内按 priority 降序；桶位不足时配比自动回填到还有剩余的桶，不硬凑；
 * - 平滑加权轮询保证桶间配比大致符合 ratios（软目标）。
 * 返回完整的确定性序列，分页在外层按 offset 切片。
 */
export function mixFeed(hot: MixItem[], timeline: MixItem[], ratios: FeedRatios): MixItem[] {
  const r = normalizedRatios(ratios);
  const covered = new Set(hot.map((h) => h.storyKey).filter((k): k is string => k !== null));
  const seen = new Set<string>();
  const pools = new Map<FeedBucket, MixItem[]>(BUCKETS.map((b) => [b, []]));
  const push = (item: MixItem) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    pools.get(item.bucket)!.push(item);
  };
  for (const h of [...hot].sort((a, b) => b.priority - a.priority)) push(h);
  for (const t of [...timeline].sort((a, b) => b.priority - a.priority)) {
    if (t.storyKey !== null && covered.has(t.storyKey)) continue;
    push(t);
  }
  // Smooth weighted round-robin over the non-empty buckets.
  const order: MixItem[] = [];
  const current = new Map<FeedBucket, number>(BUCKETS.map((b) => [b, 0]));
  const total = BUCKETS.reduce((s, b) => s + r[b], 0);
  for (;;) {
    let best: FeedBucket | null = null;
    for (const b of BUCKETS) {
      if (pools.get(b)!.length === 0) continue;
      const v = current.get(b)! + r[b];
      current.set(b, v);
      if (best === null || v > current.get(best)!) best = b;
    }
    if (best === null) break;
    current.set(best, current.get(best)! - total);
    order.push(pools.get(best)!.shift()!);
  }
  return order;
}

/** 游标：混排序列中的 offset，与产生它的热榜 ranking 绑定（ranking 变化时从头开始）。 */
const CURSOR_PREFIX = "hf1";
const cursorBinding = queryBinding({ r: HOMEFEED.ratios });

interface StoryMeta {
  topicKind: "general" | "dispute" | "fun";
  disputeStatus: "ongoing" | "responded" | "clarified" | "settled" | null;
}

/**
 * 每篇报道所属故事的 topic_kind/dispute_status（走 publications.story_id，事实卡与独立条目都覆盖）。
 * key 为 article_id；publicId 供输出用。
 */
async function storyMetas(articleIds: string[]): Promise<Map<string, StoryMeta & { publicId: string | null }>> {
  const ids = [...new Set(articleIds)];
  if (!ids.length) return new Map();
  const rows = await sql<{ article_id: string; public_id: string | null; topic_kind: string | null; dispute_status: string | null }[]>`
    SELECT p.article_id, st.public_id::text AS public_id, st.topic_kind, st.dispute_status
    FROM publications p LEFT JOIN stories st ON st.id = p.story_id AND st.merged_into IS NULL
    WHERE p.article_id IN ${sql(ids)}`;
  const map = new Map<string, StoryMeta & { publicId: string | null }>();
  for (const row of rows) {
    map.set(row.article_id, {
      publicId: row.public_id,
      topicKind: row.topic_kind === "dispute" || row.topic_kind === "fun" ? row.topic_kind : "general",
      disputeStatus: (["ongoing", "responded", "clarified", "settled"] as const).includes(row.dispute_status as never)
        ? (row.dispute_status as StoryMeta["disputeStatus"])
        : null,
    });
  }
  return map;
}

/** 分桶（纯函数）：先看故事的 topic_kind，再看类别是否为评论类。 */
export function bucketOf(topicKind: StoryMeta["topicKind"], category: string | null): FeedBucket {
  if (topicKind === "dispute") return "dispute";
  if (topicKind === "fun") return "fun";
  if (category !== null && COMMENTARY_CATEGORIES.has(category)) return "opinion";
  return "other";
}

export interface HomeFeedQuery {
  limit?: number;
  cursor?: string | null;
}

/**
 * 首页混合流：一屏内同一 story 只出现一次，热榜优先、时间线回填。
 * 无今日热榜（entries 为空）时全部由时间线回填；HOMEFEED.enabled=false 时返回空。
 */
export async function loadHomeFeed(q: HomeFeedQuery = {}): Promise<HomeFeedResponse> {
  if (!HOMEFEED.enabled) return { enabled: false, entries: [], nextCursor: null };
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 40);
  let offset = 0;
  let rankingId: number | null = null;
  if (q.cursor) {
    const c = decodeCursor<{ o: number; r: number | null; b: string }>(CURSOR_PREFIX, q.cursor);
    if (c.b !== cursorBinding || typeof c.o !== "number" || c.o < 0) throw new InvalidCursorError("cursor does not match this query");
    offset = c.o;
    rankingId = c.r;
  }

  const ranking = await latestHotRanking();
  const entries: HotEntry[] = ranking?.entries ?? [];
  // 游标与热榜 ranking 绑定：ranking 变化（新一轮榜单）时从头开始，避免错位。
  if (rankingId !== null && (ranking === null || ranking.id !== rankingId)) offset = 0;
  const currentRankingId = ranking?.id ?? null;

  // 时间线取数：混合需要各桶都有料，多取一些再混排（/api/site/timeline 本身不动）。
  const tl = await loadTimeline({ channel: "all", category: null, tag: null, limit: 40 });
  const meta = await storyMetas([
    ...entries.map((e) => e.representativeItemId).filter((id): id is string => !!id),
    ...tl.cards.map((c) => c.item.id),
  ]);
  const hotExtras = ranking ? await rankingExtras(ranking) : null;

  const hotItems: MixItem[] = entries.map((e) => {
    const m = e.representativeItemId ? meta.get(e.representativeItemId) : undefined;
    const storyKey = m?.publicId ? `story:${m.publicId}` : `hotstory:${e.storyId}`;
    return {
      key: `hot:${e.storyId}`,
      storyKey,
      bucket: bucketOf(m?.topicKind ?? "general", null),
      priority: e.heat,
    };
  });
  const heatByStory = new Map<string, number>();
  for (const e of entries) {
    const m = e.representativeItemId ? meta.get(e.representativeItemId) : undefined;
    if (m?.publicId) heatByStory.set(m.publicId, e.heat);
  }
  const timelineItems: MixItem[] = tl.cards.map((c) => {
    const m = meta.get(c.item.id);
    const storyKey = m?.publicId ? `story:${m.publicId}` : `card:${c.key}`;
    const heat = m?.publicId ? heatByStory.get(m.publicId) ?? null : null;
    return {
      key: `tl:${c.key}`,
      storyKey,
      bucket: bucketOf(m?.topicKind ?? "general", c.item.category),
      // 热榜已覆盖的故事在时间线部分整体跳过；剩余卡片中，有热度的故事优先。
      priority: heat !== null ? 1e18 + heat : new Date(c.anchorAt).getTime() / 1e9,
    };
  });

  const sequence = mixFeed(hotItems, timelineItems, { ...HOMEFEED.ratios });
  const page = sequence.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < sequence.length ? encodeCursor(CURSOR_PREFIX, { o: nextOffset, r: currentRankingId, b: cursorBinding }) : null;

  const cardByKey = new Map(tl.cards.map((c) => [`tl:${c.key}`, c]));
  const hotStripByStory = new Map<string, HotStripEntry>();
  if (ranking && hotExtras) {
    for (const e of entries) {
      hotStripByStory.set(`hot:${e.storyId}`, {
        rank: e.rank,
        title: e.title ?? "",
        heat: e.heat,
        trend: e.trend,
        storyPublicId: e.storyPublicId,
        itemId: e.representativeItemId,
        participants: hotExtras.participants(e),
        participantCount: e.participantCount,
      });
    }
  }

  const out: HomeFeedEntry[] = page.map((m) => {
    if (m.key.startsWith("hot:")) {
      const storyId = Number(m.key.slice(4));
      const entry = entries.find((e) => e.storyId === storyId);
      const sm = entry?.representativeItemId ? meta.get(entry.representativeItemId) : undefined;
      const hot = entry ? hotStripByStory.get(`hot:${entry.storyId}`) ?? null : null;
      return {
        kind: "hot", bucket: m.bucket, storyPublicId: sm?.publicId ?? null,
        topicKind: sm?.topicKind ?? null, disputeStatus: sm?.disputeStatus ?? null,
        heat: hot?.heat ?? null, trend: hot?.trend ?? null, coverage: "known" as HomeFeedCoverage,
        hot, card: null,
      };
    }
    const card = cardByKey.get(m.key);
    const sm = card ? meta.get(card.item.id) : undefined;
    const heat = sm?.publicId ? heatByStory.get(sm.publicId) ?? null : null;
    let coverage: HomeFeedCoverage;
    if (heat !== null) coverage = "known";
    else if (card && !card.item.selected) coverage = "pending_review";
    else coverage = "unknown";
    return {
      kind: "timeline", bucket: m.bucket, storyPublicId: sm?.publicId ?? null,
      topicKind: sm?.topicKind ?? null, disputeStatus: sm?.disputeStatus ?? null,
      heat, trend: null, coverage, hot: null, card: card ?? null,
    };
  });
  return { enabled: true, entries: out, nextCursor };
}

// ── 关注动态（无账号方案）：按本地关注的战队 slugs 取最新卡片 ──────────────────────────

export interface FollowedQuery {
  teams: string[];
  limit?: number;
}

const TEAM_SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;

/**
 * 复用时间线卡片形态：entity_mentions 桥联战队最近的已列出报道。
 * teams 为空或全非法时返回空 teams；单队上限 limit（默认 6）。
 */
export async function loadFollowed(q: FollowedQuery): Promise<FollowedResponse> {
  const perTeam = Math.min(Math.max(q.limit ?? 6, 1), 12);
  const slugs = [...new Set(q.teams.map((s) => s.trim().toLowerCase()).filter((s) => TEAM_SLUG_PATTERN.test(s)))].slice(0, 20);
  if (!slugs.length) return { teams: [] };
  const now = new Date();
  const teams = await sql<{ id: string; slug: string; name: string }[]>`
    SELECT id, slug, name FROM teams WHERE slug IN ${sql(slugs)}`;
  const bySlug = new Map(teams.map((t) => [t.slug, t]));
  const out: FollowedResponse["teams"] = [];
  for (const slug of slugs) {
    const team = bySlug.get(slug);
    if (!team) continue;
    const rows = await sql<ItemRow[]>`
      SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
      JOIN entity_mentions em ON em.article_id = p.article_id AND em.entity_type = 'team' AND em.entity_id = ${team.id}
      WHERE ${listedCondition(now)}
      ORDER BY p.sort_at DESC NULLS LAST LIMIT ${perTeam}`;
    out.push({
      slug: team.slug,
      name: team.name,
      cards: rows.map((row, i) => ({
        key: `follow:${slug}:${row.id}`,
        anchorAt: (row.timeline_at ?? row.discovered_at).toISOString(),
        item: toFeedItemSummary(row),
        group: null as TimelineCard["group"],
      })),
    });
  }
  return { teams: out };
}

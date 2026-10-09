// Platform counters are observations, not edits to the article. Never trigger paid text analysis
// just because a counter changed, and never merge a missing value with an older known value.
import type { Db } from "../db.ts";
import type { CanonicalContent, Engagement } from "./extractors/types.ts";

export interface EngagementObservationInput {
  platform: string;
  observedAt: Date;
  metrics: Engagement;
  method: "source_api" | "page_dom";
}

export const ENGAGEMENT_METRICS = [
  "views",
  "likes",
  "comments",
  "shares",
  "favorites",
  "coins",
  "danmaku",
] as const;

/** Unknown, malformed, negative and imprecise counters remain null; a real zero remains zero. */
export function observedCounter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeObservation(input: EngagementObservationInput) {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(input.platform)) throw new Error("invalid engagement platform");
  if (!(input.observedAt instanceof Date) || !Number.isFinite(input.observedAt.getTime())) throw new Error("invalid engagement observation time");
  if (input.method !== "source_api" && input.method !== "page_dom") throw new Error("invalid engagement observation method");
  const metrics = Object.fromEntries(ENGAGEMENT_METRICS.map((key) => [key, observedCounter(input.metrics[key])])) as Required<Engagement>;
  return { ...input, metrics, coverage: ENGAGEMENT_METRICS.some((key) => metrics[key] !== null) ? "observed" as const : "unknown" as const };
}

export async function recordEngagement(db: Db, articleId: string, sourceId: string, input: EngagementObservationInput): Promise<void> {
  const o = normalizeObservation(input);
  await db`INSERT INTO engagement_observations (article_id, source_id, platform, observed_at, method, metrics, coverage)
    VALUES (${articleId}, ${sourceId}, ${o.platform}, ${o.observedAt}, ${o.method}, ${db.json(o.metrics)}, ${o.coverage})
    ON CONFLICT (article_id, source_id, platform, observed_at, method) DO NOTHING`;
}

/**
 * 从 CanonicalContent 中安全识别平台标识（如 hupu, bilibili, weibo）。
 */
export function resolvePlatformFromCanonical(c: CanonicalContent): string | null {
  const extractor = c.extraction?.extractor?.toLowerCase();
  if (extractor === "hupu" || extractor === "bilibili" || extractor === "weibo") return extractor;
  const postPlatform = c.discussion?.originalPost?.platform?.toLowerCase();
  if (postPlatform === "hupu" || postPlatform === "bilibili" || postPlatform === "weibo") return postPlatform;
  if (extractor && /^[a-z][a-z0-9_-]{0,39}$/.test(extractor)) return extractor;
  return null;
}

/**
 * 记录来自 extractor 的互动指标（若存在）。
 * 即使内容哈希相同（samehash），只要抽取成功且包含指标，如实记录当前时间戳观察。
 * coins / danmaku 允许为 null。
 */
export async function recordCanonicalEngagement(
  db: Db,
  articleId: string,
  sourceId: string,
  canonical: CanonicalContent,
  observedAt: Date = new Date(),
): Promise<boolean> {
  if (!canonical.engagement) return false;
  const platform = resolvePlatformFromCanonical(canonical);
  if (!platform) return false;
  const method = canonical.extraction?.bodyProvenance === "source_api" ? "source_api" : "page_dom";
  await recordEngagement(db, articleId, sourceId, {
    platform,
    observedAt,
    metrics: canonical.engagement,
    method,
  });
  return true;
}

/** Keep 30 days of growth history plus the newest sample per source/platform for quiet articles. */
export async function pruneEngagement(db: Db, now = new Date()): Promise<number> {
  const removed = await db`DELETE FROM engagement_observations old
    WHERE old.observed_at < ${new Date(now.getTime() - 30 * 86400_000)}
      AND EXISTS (SELECT 1 FROM engagement_observations newer
        WHERE newer.article_id = old.article_id AND newer.source_id = old.source_id AND newer.platform = old.platform
          AND (newer.observed_at, newer.id) > (old.observed_at, old.id))`;
  return removed.count;
}

/** Latest per collecting source and platform: never compare or add unlike platforms here.
 * A later unknown snapshot stays unknown. The caller can inspect history explicitly for growth.
 */
export async function latestEngagement(db: Db, articleId: string) {
  return db<{ source_id: string; platform: string; observed_at: Date; method: string; metrics: Engagement; coverage: "observed" | "unknown" }[]>`
    SELECT DISTINCT ON (source_id, platform) source_id, platform, observed_at, method, metrics, coverage
    FROM engagement_observations WHERE article_id = ${articleId}
    ORDER BY source_id, platform, observed_at DESC, id DESC`;
}

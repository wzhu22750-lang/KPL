// Community refresh closed loop: durable pagination, canonical merge without revision increments,
// and per-platform concurrency controls.
//
// Rules enforced:
// 1. Guarded: only runs when (config.collectEnabled || COLLECT_ENABLED === 'true') && COMMUNITY_COLLECTION_ENABLED === 'true'.
//    Force option MUST NOT bypass global safety valves, source disabled, or source isolated state.
// 2. Source-level opt-in: source.enabled === true, source.participation_mode !== 'isolated', sourceConfig.communityComments.enabled === true.
// 3. Concurrency 1 per platform (Hupu, Weibo, Bilibili) with rate-limiting.
// 4. Platform exact URL parse: hostname checked strictly against permitted platform domains without substring matching or fallback to Hupu.
// 5. Hupu: strictly validates HTTPS bbs.hupu.com with exact same tid; supports resume via canonical nextCursor (actual URL, not numeric);
//    bounds <=3 pages and <=100 comments; preserves page 1 OP when resuming; merges replies by stable ID.
// 6. Respects actual nextCursor and terminal evidence from parsed pages rather than blindly guessing sequential pages; HTTP non-200 fails explicitly.
// 7. Persists incoming Hupu engagement only when actual fresh main thread is successfully loaded; no guessed quality 70/full when no canonical (body remains unconfirmed).
// 8. Preserves canonical full base from main; on failure, article body_html and body_text are NEVER overwritten by comment data.
// 9. Atomic transaction with FOR UPDATE revision and source recheck before update to avoid races; stale revision aborts write.
// 10. Database errors and migration failures in monitoring table (community_collection_runs) throw explicitly (never swallowed silently).
// 11. Weibo & Bilibili resumes: correctly merges prior and new replies, deduplicates, accurate count, bounded to 100 comments max; zero placeholder author/time metrics.
// 12. Scheduled sweep: strictly excludes disabled/isolated sources so no budget is leaked; counts only non-skipped executions.
import { config } from "../config.ts";
import { sql, type Db, type Tx } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { canonicalToBody, mergeCanonicalForRefresh, canonicalEvidenceHash } from "./canonical.ts";
import { queueRadar } from "../jobs/radar.ts";
import { publishArticleTx } from "../publication/publish.ts";
import { createCommunityRequestController } from "./community-platform-controls.ts";
import {
  executeSerializedPlatformFetch,
  fetchBilibiliComments,
  fetchWeiboComments,
  defaultGuardedFetchJson,
  isCommunityCollectionEnabled,
  DEFAULT_COMMENT_BUDGETS,
  HARD_MAX_COMMENTS,
} from "./community-comments.ts";
import { recordCanonicalEngagement } from "./engagement.ts";
import { rankReplies, replyScore } from "./extractors/forum.ts";
import { extractCanonical, profileFor } from "./extractors/index.ts";
import type { CanonicalContent, DiscussionContent, DiscussionPost } from "./extractors/types.ts";

export interface CommunityRefreshConfig {
  enabled?: boolean;
  endpointTemplate?: string;
  endpoint?: string;
  maxPages?: number;
  maxComments?: number;
  pageSize?: number;
  minIntervalMs?: number;
  maxPostsPerRun?: number;
  refreshMinutes?: number;
  normalRefreshMinutes?: number;
  hotRefreshMinutes?: number;
}

export interface RefreshArticleOptions {
  sourceId?: string;
  force?: boolean;
  resumeCursor?: string | null;
  db?: Db;
  fetchHtml?: (url: string) => Promise<string>;
  fetchJson?: (url: string) => Promise<unknown>;
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RefreshArticleResult {
  articleId: string;
  platform: string;
  status: "ok" | "partial" | "unavailable" | "skipped" | "failed";
  fetchedReplies: number;
  totalReplies: number | null;
  nextCursor: string | null;
  clearedSummary: boolean;
  preservedPrevious: boolean;
  error?: string;
  requestCount: number;
  latencyMs: number;
}

export interface SweepCommunityOptions {
  db?: Db;
  budget?: number;
  inline?: boolean;
  enqueueFn?: (articleId: string, sourceId: string) => Promise<string | null>;
  refreshFn?: (articleId: string, opts?: RefreshArticleOptions) => Promise<RefreshArticleResult>;
}

export interface SweepCommunityResult {
  skipped: boolean;
  reason?: string;
  evaluated: number;
  enqueued: number;
  executed: number;
  results?: RefreshArticleResult[];
}

/** Global opt-in gate: requires collectEnabled AND process.env.COMMUNITY_COLLECTION_ENABLED === 'true'. */
export { isCommunityCollectionEnabled };

// ---------------------------------------------------------------------------
// Helpers: Author, Time, Metrics Sanitization
// ---------------------------------------------------------------------------

/** Ensures zero placeholder author, time, and floor metrics across posts. */
export function sanitizeDiscussionPost(post: DiscussionPost): DiscussionPost {
  let authorName = post.author?.name ? post.author.name.trim() : null;
  if (authorName === "未知用户" || authorName === "未知" || authorName === "anonymous" || authorName === "") {
    authorName = null;
  }
  let floor = typeof post.floor === "number" && post.floor > 0 ? post.floor : null;
  let publishedAt = post.publishedAt;
  if (publishedAt && (publishedAt.startsWith("1970-01-01") || publishedAt === "0")) {
    publishedAt = null;
  }
  let likes = typeof post.likes === "number" && post.likes >= 0 ? post.likes : null;
  let replyCount = typeof post.replyCount === "number" && post.replyCount >= 0 ? post.replyCount : null;

  return {
    ...post,
    author: {
      name: authorName,
      avatarUrl: post.author?.avatarUrl ?? null,
    },
    floor,
    publishedAt,
    likes,
    replyCount,
  };
}

/**
 * Deduplicates and merges prior and new replies, bounding total replies to max 100.
 * - Updates prior duplicate IDs with latest text, likes, replyCount, etc. from newReplies (not stale first).
 * - When collection cap is reached (total unique > limit), dynamically ranks top comments by:
 *   original author status, likes, reply counts, content density, and freshness, so new text is not ignored.
 */
export function mergeDiscussionReplies(
  priorReplies: DiscussionPost[] | undefined | null,
  newReplies: DiscussionPost[] | undefined | null,
  limit = 100,
): { merged: DiscussionPost[]; reachedLimit: boolean } {
  interface PostEntry {
    post: DiscussionPost;
    isNew: boolean;
    order: number;
  }

  const entriesMap = new Map<string, PostEntry>();
  let counter = 0;

  for (const raw of priorReplies ?? []) {
    const post = sanitizeDiscussionPost(raw);
    const id = post.id ? String(post.id).trim() : "";
    const key = id || `${post.author.name ?? ""}:${post.text}`;
    if (!entriesMap.has(key)) {
      entriesMap.set(key, { post, isNew: false, order: counter++ });
    }
  }

  for (const raw of newReplies ?? []) {
    const post = sanitizeDiscussionPost(raw);
    const id = post.id ? String(post.id).trim() : "";
    const key = id || `${post.author.name ?? ""}:${post.text}`;
    const existing = entriesMap.get(key);
    if (existing) {
      // Replace duplicate ID with latest text, likes, and other fields (not stale first!)
      entriesMap.set(key, { post, isNew: true, order: existing.order });
    } else {
      entriesMap.set(key, { post, isNew: true, order: counter++ });
    }
  }

  const allEntries = Array.from(entriesMap.values());

  if (allEntries.length <= limit) {
    allEntries.sort((a, b) => a.order - b.order);
    return {
      merged: allEntries.map((e) => e.post),
      reachedLimit: allEntries.length >= limit,
    };
  }

  // When collection cap reached (> limit):
  // Rank top dynamically so new text is not ignored
  function scoreEntry(e: PostEntry): number {
    const p = e.post;
    let score = 0;
    if (p.isOriginalAuthor) score += 10000;
    const likes = typeof p.likes === "number" && Number.isFinite(p.likes) && p.likes > 0 ? p.likes : 0;
    score += likes * 10;
    const replyCount = typeof p.replyCount === "number" && Number.isFinite(p.replyCount) && p.replyCount > 0 ? p.replyCount : 0;
    score += replyCount * 5;
    score += replyScore(p);
    if (e.isNew) score += 15; // Freshness boost ensures new text competes against stale 0-engagement posts
    if (p.text) score += Math.min(10, p.text.length / 10);
    return score;
  }

  allEntries.sort((a, b) => {
    const scoreDiff = scoreEntry(b) - scoreEntry(a);
    if (scoreDiff !== 0) return scoreDiff;
    return a.order - b.order;
  });

  const selected = allEntries.slice(0, limit);
  selected.sort((a, b) => a.order - b.order);

  return {
    merged: selected.map((e) => e.post),
    reachedLimit: true,
  };
}

// ---------------------------------------------------------------------------
// Platform Detection (Exact URL parsing, no substrings, no default Hupu)
// ---------------------------------------------------------------------------

export function detectPlatform(
  article: { url: string; source_kind: string },
  canonical: CanonicalContent | null,
): "hupu" | "weibo" | "bilibili" | "unknown" {
  const extractor = canonical?.extraction?.extractor?.toLowerCase();
  if (extractor === "hupu" || extractor === "weibo" || extractor === "bilibili") return extractor;

  const originalPostPlatform = canonical?.discussion?.originalPost?.platform?.toLowerCase();
  if (originalPostPlatform === "hupu" || originalPostPlatform === "weibo" || originalPostPlatform === "bilibili") {
    return originalPostPlatform;
  }

  try {
    const parsed = new URL(article.url);
    const host = parsed.hostname.toLowerCase();

    // Hupu: exact bbs.hupu.com or subdomain of hupu.com
    if (host === "bbs.hupu.com" || host.endsWith(".hupu.com")) {
      return "hupu";
    }

    // Weibo: exact hosts or subdomains of weibo.com / weibo.cn
    if (
      host === "weibo.com" ||
      host.endsWith(".weibo.com") ||
      host === "weibo.cn" ||
      host.endsWith(".weibo.cn") ||
      article.source_kind === "weibo"
    ) {
      return "weibo";
    }

    // Bilibili: exact hosts or subdomains of bilibili.com or b23.tv
    if (
      host === "bilibili.com" ||
      host.endsWith(".bilibili.com") ||
      host === "b23.tv" ||
      host.endsWith(".b23.tv")
    ) {
      return "bilibili";
    }
  } catch {
    // Malformed URL
  }

  // Strictly no default Hupu!
  return "unknown";
}

// ---------------------------------------------------------------------------
// Hupu Thread URL Validation and URL Builder
// ---------------------------------------------------------------------------

export function threadIdOfUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const tidParam = u.searchParams.get("tid") || u.searchParams.get("threadId");
    if (tidParam) return tidParam;
    const m = u.pathname.match(/(?:^|\/)(\d+)(?:-\d+)?(?:\.html)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function parseHupuPageUrl(url: string): { tid: string; page: number } | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/(?:^|\/)(\d+)(?:-(\d+))?(?:\.html)?$/);
    if (!m) return null;
    const tid = m[1];
    const page = m[2] ? parseInt(m[2], 10) : 1;
    return { tid, page };
  } catch {
    return null;
  }
}

/**
 * Validates that a Hupu thread URL uses HTTPS, bbs.hupu.com (or .hupu.com),
 * has no auth credentials, and matches the expected thread ID.
 */
export function validateHupuThreadUrl(
  rawUrl: string,
  expectedTid?: string,
): { ok: true; url: URL; tid: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Invalid Hupu URL: "${rawUrl}"` };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `Protocol must be https:, got "${parsed.protocol}"` };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Credentials in Hupu URL are forbidden" };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "bbs.hupu.com" && !hostname.endsWith(".hupu.com")) {
    return { ok: false, reason: `Host "${hostname}" is not permitted for Hupu BBS` };
  }

  if (parsed.port && parsed.port !== "443") {
    return { ok: false, reason: `Non-standard port "${parsed.port}" is forbidden` };
  }

  const tid = threadIdOfUrl(rawUrl);
  if (!tid) {
    return { ok: false, reason: `Could not parse thread ID from "${rawUrl}"` };
  }

  if (expectedTid && tid !== expectedTid) {
    return { ok: false, reason: `Thread ID mismatch: expected "${expectedTid}", got "${tid}"` };
  }

  return { ok: true, url: parsed, tid };
}

export function buildHupuPageUrl(tid: string, page: number): string {
  if (page <= 1) {
    return `https://bbs.hupu.com/${tid}.html`;
  }
  return `https://bbs.hupu.com/${tid}-${page}.html`;
}

// ---------------------------------------------------------------------------
// Single Article Refresh
// ---------------------------------------------------------------------------

export async function refreshArticleCommunity(
  articleId: string,
  options: RefreshArticleOptions = {},
): Promise<RefreshArticleResult> {
  const db = options.db ?? sql;
  const startTime = Date.now();

  // 1. Global Opt-in Gate: force must NOT bypass global safety valve!
  if (!isCommunityCollectionEnabled()) {
    return {
      articleId,
      platform: "unknown",
      status: "skipped",
      fetchedReplies: 0,
      totalReplies: null,
      nextCursor: null,
      clearedSummary: false,
      preservedPrevious: false,
      error: "Community collection is globally disabled (check config.collectEnabled and COMMUNITY_COLLECTION_ENABLED)",
      requestCount: 0,
      latencyMs: Date.now() - startTime,
    };
  }

  // 2. Load Article and Source
  const [row] = await db<{
    id: string;
    source_id: string;
    url: string;
    identity_key: string;
    title: string;
    author: string | null;
    published_at: Date | null;
    body_text: string | null;
    body_status: string;
    raw: any;
    revision: number;
    canonical_content: CanonicalContent | null;
    source_config: Record<string, any> | null;
    source_kind: string;
    source_enabled: boolean;
    source_participation_mode: string;
  }[]>`
    SELECT a.id, a.source_id, a.url, a.identity_key, a.title, a.author, a.published_at, a.body_text, a.body_status, a.raw,
           a.revision, a.canonical_content, s.config as source_config, s.kind as source_kind, s.enabled as source_enabled,
           s.participation_mode as source_participation_mode
    FROM articles a
    JOIN sources s ON s.id = a.source_id
    WHERE a.id = ${articleId}
  `;

  if (!row) {
    return {
      articleId,
      platform: "unknown",
      status: "failed",
      fetchedReplies: 0,
      totalReplies: null,
      nextCursor: null,
      clearedSummary: false,
      preservedPrevious: false,
      error: `Article "${articleId}" not found`,
      requestCount: 0,
      latencyMs: Date.now() - startTime,
    };
  }

  const initialRevision = row.revision;

  // 3. Source-level Safety Valves: force must NOT bypass source disabled or isolated state!
  if (!row.source_enabled) {
    return {
      articleId,
      platform: "unknown",
      status: "skipped",
      fetchedReplies: 0,
      totalReplies: null,
      nextCursor: null,
      clearedSummary: false,
      preservedPrevious: false,
      error: "Source is disabled",
      requestCount: 0,
      latencyMs: Date.now() - startTime,
    };
  }

  if (row.source_participation_mode === "isolated") {
    return {
      articleId,
      platform: "unknown",
      status: "skipped",
      fetchedReplies: 0,
      totalReplies: null,
      nextCursor: null,
      clearedSummary: false,
      preservedPrevious: false,
      error: "Source is isolated",
      requestCount: 0,
      latencyMs: Date.now() - startTime,
    };
  }

  const sourceConfig = (row.source_config ?? {}) as Record<string, any>;
  const communityCfg = (sourceConfig.communityComments ?? {}) as CommunityRefreshConfig;

  if (communityCfg.enabled !== true) {
    return {
      articleId,
      platform: "unknown",
      status: "skipped",
      fetchedReplies: 0,
      totalReplies: null,
      nextCursor: null,
      clearedSummary: false,
      preservedPrevious: false,
      error: "Community comments are not enabled for this source",
      requestCount: 0,
      latencyMs: Date.now() - startTime,
    };
  }

  const existingCanonical = row.canonical_content;
  const platform = detectPlatform(row, existingCanonical);
  if (platform === "unknown") {
    return {
      articleId,
      platform: "unknown",
      status: "failed",
      fetchedReplies: 0,
      totalReplies: null,
      nextCursor: null,
      clearedSummary: false,
      preservedPrevious: false,
      error: `Unsupported or unknown platform for URL: "${row.url}"`,
      requestCount: 0,
      latencyMs: Date.now() - startTime,
    };
  }

  const minIntervalMs = options.minIntervalMs ?? communityCfg.minIntervalMs ?? 1000;
  const controller = createCommunityRequestController(db, platform);

  let requestCount = 0;
  let incomingDiscussion: DiscussionContent | null = null;
  let incomingEngagement: CanonicalContent["engagement"] = null;
  let freshCanonicalFromMain: CanonicalContent | null = null;
  let fetchError: string | null = null;
  let extractionFail = false;

  try {
    if (platform === "hupu") {
      const hupuRes = await refreshHupuThread({
        requestGate: (fetch) => controller.run(fetch),
        article: row,
        existingCanonical,
        config: communityCfg,
        resumeCursor: options.resumeCursor ?? existingCanonical?.discussion?.collection?.nextCursor ?? null,
        fetchHtml: options.fetchHtml,
        minIntervalMs,
        sleep: options.sleep,
      });
      requestCount = hupuRes.requestCount;
      incomingDiscussion = hupuRes.discussion;
      freshCanonicalFromMain = hupuRes.freshCanonicalFromMain ?? null;
      // Persist incoming Hupu engagement ONLY when actual fresh successfully loaded main
      if (freshCanonicalFromMain?.engagement && !hupuRes.extractionFail) {
        incomingEngagement = freshCanonicalFromMain.engagement;
      }
      fetchError = hupuRes.error ?? null;
      extractionFail = hupuRes.extractionFail;
    } else if (platform === "weibo") {
      const weiboRes = await refreshWeiboPost({
        requestGate: (fetch) => controller.run(fetch),
        article: row,
        existingCanonical,
        sourceConfig,
        resumeCursor: options.resumeCursor ?? existingCanonical?.discussion?.collection?.nextCursor ?? null,
        fetchJson: options.fetchJson,
        minIntervalMs,
        sleep: options.sleep,
      });
      requestCount = weiboRes.requestCount;
      incomingDiscussion = weiboRes.discussion;
      fetchError = weiboRes.error ?? null;
      extractionFail = weiboRes.extractionFail;
    } else if (platform === "bilibili") {
      const biliRes = await refreshBilibiliVideo({
        requestGate: (fetch) => controller.run(fetch),
        article: row,
        existingCanonical,
        sourceConfig,
        resumeCursor: options.resumeCursor ?? existingCanonical?.discussion?.collection?.nextCursor ?? null,
        fetchJson: options.fetchJson,
        minIntervalMs,
        sleep: options.sleep,
      });
      requestCount = biliRes.requestCount;
      incomingDiscussion = biliRes.discussion;
      incomingEngagement = biliRes.engagement;
      fetchError = biliRes.error ?? null;
      extractionFail = biliRes.extractionFail;
    }
  } catch (err: any) {
    fetchError = err?.message ? String(err.message) : String(err);
    extractionFail = true;
  }

  requestCount = controller.requestCount; // Denied reservations are not network requests.
  if (controller.denial && requestCount === 0) return {
    articleId, platform, status: "skipped", fetchedReplies: 0,
    totalReplies: existingCanonical?.discussion?.totalReplies ?? null,
    nextCursor: existingCanonical?.discussion?.collection?.nextCursor ?? null,
    clearedSummary: false, preservedPrevious: true, error: controller.denial.message,
    requestCount: 0, latencyMs: Date.now() - startTime,
  };
  await controller.finish(fetchError ?? incomingDiscussion?.collection?.error ?? null);

  // If incomingDiscussion is null or fetch had a fatal crash, construct a failed incoming structure
  if (!incomingDiscussion) {
    const preservedCursor = options.resumeCursor ?? existingCanonical?.discussion?.collection?.nextCursor ?? null;
    incomingDiscussion = {
      originalPost: existingCanonical?.discussion?.originalPost ? sanitizeDiscussionPost(existingCanonical.discussion.originalPost) : {
        id: row.id,
        author: { name: row.author, avatarUrl: null },
        text: row.body_text ?? row.title,
        publishedAt: row.published_at?.toISOString() ?? null,
        likes: null,
        floor: null,
        isOriginalAuthor: true,
        platform: platform as any,
        quote: null,
      },
      authorFollowups: existingCanonical?.discussion?.authorFollowups ?? [],
      highlightedReplies: existingCanonical?.discussion?.highlightedReplies ?? [],
      collectedReplies: existingCanonical?.discussion?.collectedReplies ?? [],
      totalReplies: existingCanonical?.discussion?.totalReplies ?? null,
      fetchedReplies: existingCanonical?.discussion?.fetchedReplies ?? existingCanonical?.discussion?.collectedReplies?.length ?? 0,
      collection: {
        collectedAt: new Date().toISOString(),
        coverage: "unavailable",
        provenance: platform === "hupu" ? "page_dom" : "source_api",
        sourceUrl: row.url,
        nextCursor: preservedCursor,
        error: fetchError ?? "Extraction failed",
      },
    };
  }

  // 4. Merge Canonical Base
  // Rule: "Preserve canonical full base from main when first extraction else no article body overwritten by comment on failure."
  // Rule: "no guessed quality70/full when no canonical (return unconfirmed never auto)."
  const canonicalBase = existingCanonical ?? freshCanonicalFromMain;

  let incomingCanonical: CanonicalContent;
  if (canonicalBase) {
    incomingCanonical = {
      kind: canonicalBase.kind,
      title: canonicalBase.title ?? row.title,
      author: canonicalBase.author ?? { name: row.author, avatarUrl: null, profileUrl: null, role: null },
      publishedAt: canonicalBase.publishedAt ?? row.published_at?.toISOString() ?? null,
      lead: canonicalBase.lead ?? null,
      main: canonicalBase.main ?? [],
      media: canonicalBase.media ?? [],
      bodyHtmlSource: canonicalBase.bodyHtmlSource ?? null,
      discussion: incomingDiscussion,
      video: canonicalBase.video ?? null,
      social: canonicalBase.social ?? null,
      engagement: incomingEngagement ?? canonicalBase.engagement ?? null,
      extraction: canonicalBase.extraction ?? {
        extractor: platform,
        version: "1.0.0",
        sourceId: row.source_id,
        sourceFamily: platform,
        fallbackUsed: false,
        bodyProvenance: platform === "hupu" ? "page_dom" : "source_api",
        sourceAuthority: "community",
      },
      quality: canonicalBase.quality,
    };
  } else {
    // When no canonical base exists from main, NEVER guess quality 70/full! Mark failed quality so body remains unconfirmed.
    incomingCanonical = {
      kind: "forum_thread",
      title: row.title,
      author: { name: row.author, avatarUrl: null, profileUrl: null, role: null },
      publishedAt: row.published_at?.toISOString() ?? null,
      lead: null,
      main: [],
      media: [],
      bodyHtmlSource: null,
      discussion: incomingDiscussion,
      video: null,
      social: null,
      engagement: null,
      extraction: {
        extractor: platform,
        version: "1.0.0",
        sourceId: row.source_id,
        sourceFamily: platform,
        fallbackUsed: false,
        bodyProvenance: platform === "hupu" ? "page_dom" : "source_api",
        sourceAuthority: "community",
      },
      quality: { score: 0, completeness: "failed", warnings: ["No canonical base content"] },
    };
  }

  const { canonical: mergedCanonical, clearedSummary, preservedPrevious } = mergeCanonicalForRefresh(
    existingCanonical,
    incomingCanonical,
  );

  const finalDiscussion = mergedCanonical.discussion;
  const coverage = finalDiscussion?.collection?.coverage ?? "unavailable";
  const finalStatus: "ok" | "partial" | "unavailable" | "failed" =
    coverage === "complete" ? "ok" : coverage === "partial" ? "partial" : "unavailable";

  const nextCursor = finalDiscussion?.collection?.nextCursor ?? null;
  const totalReplies = finalDiscussion?.totalReplies ?? null;
  const fetchedReplies = finalDiscussion?.fetchedReplies ?? finalDiscussion?.collectedReplies?.length ?? 0;
  const latencyMs = Date.now() - startTime;
  const isFailure = extractionFail || finalStatus === "unavailable" || (finalStatus as string) === "failed";

  // 5. Atomic Transaction: lock row FOR UPDATE, recheck revision and source state
  // "Atomic transaction FOR UPDATE revision/source recheck before update avoids races; stale result no write."
  // "remove catches swallowing metrics/monitor DB errors ('If table not migrated continue silently' forbidden); migration failures throw."
  const withTx = async <T>(database: Db, fn: (tx: Db) => Promise<T>): Promise<T> => {
    if ("begin" in database && typeof (database as any).begin === "function") {
      return (database as any).begin(async (tx: Db) => fn(tx));
    }
    return fn(database);
  };

  type TxResult =
    | { aborted: true; status: "failed" | "skipped"; error: string }
    | { aborted: false };

  const evidenceChanged = !existingCanonical || canonicalEvidenceHash(existingCanonical) !== canonicalEvidenceHash(mergedCanonical);
  const txResult = await withTx<TxResult>(db, async (tx) => {
    const [current] = await tx<{
      revision: number;
      body_status: string;
      source_enabled: boolean;
      source_participation_mode: string;
      community_comments_enabled: boolean | null;
    }[]>`
      SELECT a.revision, a.body_status, s.enabled as source_enabled, s.participation_mode as source_participation_mode,
             (s.config->'communityComments'->>'enabled')::boolean as community_comments_enabled
      FROM articles a
      JOIN sources s ON s.id = a.source_id
      WHERE a.id = ${articleId}
      FOR UPDATE OF a
    `;

    if (!current) {
      return { aborted: true, status: "failed" as const, error: `Article "${articleId}" was deleted during refresh` };
    }

    if (current.revision !== initialRevision) {
      return {
        aborted: true,
        status: "failed" as const,
        error: `Article revision changed during refresh (${initialRevision} -> ${current.revision}); stale result not written`,
      };
    }

    if (!current.source_enabled) {
      return { aborted: true, status: "skipped" as const, error: "Source disabled during refresh; stale result not written" };
    }

    if (current.source_participation_mode === "isolated") {
      return { aborted: true, status: "skipped" as const, error: "Source isolated during refresh; stale result not written" };
    }

    if (current.community_comments_enabled !== true) {
      return { aborted: true, status: "skipped" as const, error: "Source community comments disabled during refresh; stale result not written" };
    }

    // Write directly to database without revising article or triggering model reruns
    // Rule: "Preserve canonical full base from main when first extraction else no article body overwritten by comment on failure."
    if (isFailure) {
      // On failure, NEVER overwrite body_html or body_text!
      await tx`
        UPDATE articles SET
          canonical_content = ${tx.json(mergedCanonical as never)},
          updated_at = now()
        WHERE id = ${articleId}
      `;
    } else {
      const derived = canonicalToBody(mergedCanonical);
      // When no canonical base was available, body_status is unconfirmed (never auto ok)
      const targetBodyStatus = !canonicalBase || canonicalBase.quality.completeness === "failed"
        ? "unconfirmed"
        : freshCanonicalFromMain ? "ok" : undefined;

      await tx`
        UPDATE articles SET
          canonical_content = ${tx.json(mergedCanonical as never)},
          content_kind = ${mergedCanonical.kind},
          content_quality_score = ${mergedCanonical.quality.score},
          content_completeness = ${mergedCanonical.quality.completeness},
          content_extraction_meta = ${tx.json(mergedCanonical.extraction as never)},
          author = coalesce(author, ${mergedCanonical.author?.name ?? null}),
          body_html = coalesce(${derived.html || null}, body_html),
          body_text = coalesce(${derived.text || null}, body_text),
          ${targetBodyStatus ? tx`body_status = ${targetBodyStatus},` : tx``}
          updated_at = now()
        WHERE id = ${articleId}
      `;
    }

    // Fresh platform metadata remains valid even when the independent comment request fails.
    if (incomingEngagement) {
      await recordCanonicalEngagement(tx, articleId, row.source_id, mergedCanonical);
    }

    if (!existingCanonical && freshCanonicalFromMain && !isFailure) await publishArticleTx(tx as Tx, articleId);

    // Append attempt to community_collection_runs table.
    // Migration failures or insert errors must throw directly (no catch swallowing).
    const cursorState = {
      resumeCursor: options.resumeCursor ?? null,
      nextCursor,
      reachedEnd: nextCursor === null && coverage === "complete",
    };
    await tx`
      INSERT INTO community_collection_runs (
        article_id, source_id, platform, status, request_count, latency_ms, fetched_count,
        total_replies, extraction_fail, cursor_state, error, attempted_at
      ) VALUES (
        ${articleId}, ${row.source_id}, ${platform}, ${finalStatus}, ${requestCount}, ${latencyMs},
        ${fetchedReplies}, ${totalReplies}, ${extractionFail}, ${tx.json(cursorState as never)},
        ${fetchError ?? null}, now()
      )
    `;

    return { aborted: false };
  });

  if (txResult.aborted) {
    return {
      articleId,
      platform,
      status: txResult.status,
      fetchedReplies: 0,
      totalReplies: null,
      nextCursor: null,
      clearedSummary: false,
      preservedPrevious: false,
      error: txResult.error,
      requestCount,
      latencyMs: Date.now() - startTime,
    };
  }

  // Counters alone reuse the prior judgment. New real text needs an evidence-bound safety review.
  if (evidenceChanged && !isFailure) await queueRadar(articleId);
  return {
    articleId,
    platform,
    status: finalStatus,
    fetchedReplies,
    totalReplies,
    nextCursor,
    clearedSummary,
    preservedPrevious,
    error: fetchError ?? undefined,
    requestCount,
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// Hupu Refresh Implementation
// ---------------------------------------------------------------------------

async function refreshHupuThread(params: {
  requestGate: <T>(fetch: () => Promise<T>) => Promise<T>;
  article: { id: string; url: string; title: string; author: string | null; published_at: Date | null };
  existingCanonical: CanonicalContent | null;
  config: CommunityRefreshConfig;
  resumeCursor: string | null;
  fetchHtml?: (url: string) => Promise<string>;
  minIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  discussion: DiscussionContent | null;
  freshCanonicalFromMain: CanonicalContent | null;
  requestCount: number;
  error?: string;
  extractionFail: boolean;
}> {
  const { article, existingCanonical, config: cfg, resumeCursor, minIntervalMs } = params;

  // Validate root thread URL
  const val = validateHupuThreadUrl(article.url);
  if (!val.ok) {
    return {
      discussion: null,
      freshCanonicalFromMain: null,
      requestCount: 0,
      error: val.reason,
      extractionFail: true,
    };
  }

  const tid = val.tid;
  // maxPages clamped to 3, not 5!
  const maxPages = Math.min(Math.max(1, Number(cfg.maxPages) || 3), 3);
  const maxComments = Math.min(Math.max(1, Number(cfg.maxComments) || DEFAULT_COMMENT_BUDGETS.maxComments), HARD_MAX_COMMENTS);

  let startPage = 1;
  let resumeUrlCursor: string | null = null;
  if (resumeCursor != null && String(resumeCursor).trim() !== "") {
    const sCursor = String(resumeCursor).trim();
    if (sCursor.startsWith("http")) {
      const pageVal = validateHupuThreadUrl(sCursor, tid);
      if (!pageVal.ok) {
        return {
          discussion: null,
          freshCanonicalFromMain: null,
          requestCount: 0,
          error: `Invalid Hupu resume cursor: ${pageVal.reason}`,
          extractionFail: true,
        };
      }
      const parsedPage = parseHupuPageUrl(sCursor);
      startPage = parsedPage?.page && parsedPage.page > 0 ? parsedPage.page : 1;
      resumeUrlCursor = sCursor;
    } else if (/^\d+$/.test(sCursor)) {
      startPage = Math.max(1, parseInt(sCursor, 10));
      resumeUrlCursor = buildHupuPageUrl(tid, startPage);
    }
  }

  // Preserve OP: If existingCanonical has OP, sanitize and keep it.
  const existingOp = existingCanonical?.discussion?.originalPost
    ? sanitizeDiscussionPost(existingCanonical.discussion.originalPost)
    : null;
  let threadOp: DiscussionPost | null = existingOp;

  // Accumulate replies
  const allReplies: DiscussionPost[] = [];
  const seenIds = new Set<string>();

  // If resuming, seed seen IDs from previously collected replies
  if (startPage > 1 && existingCanonical?.discussion?.collectedReplies) {
    for (const p of existingCanonical.discussion.collectedReplies) {
      const sp = sanitizeDiscussionPost(p);
      if (sp.id) seenIds.add(sp.id);
      allReplies.push(sp);
    }
  }

  // HTTP non-200 explicit fail
  const defaultFetchHtml = async (url: string): Promise<string> => {
    const res = await guardedFetch(url, {
      timeoutMs: 20_000,
      maxBytes: 6 * 1024 * 1024,
      headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8" },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status} fetch failed`);
    }
    return res.text();
  };

  const fetchHtml = params.fetchHtml ?? defaultFetchHtml;
  let requestCount = 0;
  let lastError: string | null = null;
  let reachedEnd = false;
  let totalReplies: number | null = existingCanonical?.discussion?.totalReplies ?? null;
  let currentPage = startPage;
  let nextPageToFetchUrl: string | null = resumeUrlCursor ?? buildHupuPageUrl(tid, startPage);
  let pageExplicitNextCursor: string | null = null;
  let newCountThisRun = 0;
  let freshCanonicalFromMain: CanonicalContent | null = null;
  const seenPageUrls = new Set<string>();

  for (let p = 0; p < maxPages; p++) {
    if (!nextPageToFetchUrl) {
      reachedEnd = true;
      break;
    }
    const pageUrl = nextPageToFetchUrl;

    const pageVal = validateHupuThreadUrl(pageUrl, tid);
    if (!pageVal.ok) {
      lastError = pageVal.reason;
      break;
    }

    if (seenPageUrls.has(pageUrl)) {
      lastError = `Repeated page URL requested: "${pageUrl}"`;
      break;
    }
    seenPageUrls.add(pageUrl);

    const parsedPageMeta = parseHupuPageUrl(pageUrl);
    currentPage = parsedPageMeta?.page ?? (startPage + p);

    let html: string;
    try {
      requestCount++;
      html = await executeSerializedPlatformFetch(
        "hupu",
        minIntervalMs,
        () => params.requestGate(() => fetchHtml(pageUrl)),
        params.sleep,
      );
    } catch (err: any) {
      lastError = err?.message ? String(err.message) : String(err);
      break;
    }

    let parsedCanonical: CanonicalContent | null = null;
    try {
      const extracted = await extractCanonical({
        url: pageUrl,
        html,
        title: article.title ?? null,
        author: article.author ?? null,
        publishedAt: article.published_at ?? null,
        profile: profileFor({ url: pageUrl, kind: "web_list", config: cfg as any }),
        sourceConfig: params.config as any,
        raw: null,
        sourceId: null,
        sourceKind: null,
        excerpt: null,
        xPost: null,
        fetchJson: null,
      });
      parsedCanonical = extracted?.content ?? null;
    } catch (err: any) {
      lastError = err?.message ? String(err.message) : String(err);
      break;
    }

    if (!parsedCanonical?.discussion) {
      lastError = `Failed to extract thread discussion from "${pageUrl}"`;
      break;
    }

    // Only fresh successfully loaded main thread (page 1) provides fresh canonical base and engagement
    if (currentPage === 1 && parsedCanonical.main && parsedCanonical.main.length > 0) {
      freshCanonicalFromMain = parsedCanonical;
    }

    const d = parsedCanonical.discussion;
    if (d.totalReplies !== null) {
      totalReplies = d.totalReplies;
    }

    // Page 1 establishes OP if not already established
    if (currentPage === 1 && !threadOp) {
      threadOp = sanitizeDiscussionPost(d.originalPost);
    }

    // For page > 1: DO NOT LET THE FIRST REPLY BECOME OP!
    const pageReplies: DiscussionPost[] =
      currentPage === 1
        ? (d.collectedReplies ?? d.highlightedReplies ?? [])
        : [d.originalPost, ...(d.collectedReplies ?? d.highlightedReplies ?? [])];

    let newCountThisPage = 0;
    const opAuthorName = threadOp?.author.name ?? null;

    for (const r of pageReplies) {
      if (allReplies.length >= maxComments) break;
      const sr = sanitizeDiscussionPost(r);
      if (sr.id && seenIds.has(sr.id)) continue;

      if (sr.id) seenIds.add(sr.id);
      newCountThisPage++;
      newCountThisRun++;

      const isOp = Boolean(opAuthorName && sr.author.name === opAuthorName);
      allReplies.push({
        ...sr,
        isOriginalAuthor: isOp,
        platform: "hupu",
      });
    }

    // Respect actual nextCursor/terminal evidence from parsed page
    pageExplicitNextCursor = d.collection?.nextCursor ?? null;

    if (d.collection?.coverage === "complete") {
      reachedEnd = true;
      nextPageToFetchUrl = null;
      break;
    }

    if (allReplies.length >= maxComments) {
      reachedEnd = false;
      break;
    }

    if (newCountThisPage === 0) {
      reachedEnd = true;
      nextPageToFetchUrl = null;
      break;
    }

    if (totalReplies !== null && allReplies.length >= totalReplies) {
      reachedEnd = true;
      nextPageToFetchUrl = null;
      break;
    }

    // Determine next page URL to fetch
    if (pageExplicitNextCursor) {
      const nextVal = validateHupuThreadUrl(pageExplicitNextCursor, tid);
      if (nextVal.ok) {
        nextPageToFetchUrl = pageExplicitNextCursor;
      } else {
        nextPageToFetchUrl = buildHupuPageUrl(tid, currentPage + 1);
      }
    } else {
      nextPageToFetchUrl = buildHupuPageUrl(tid, currentPage + 1);
    }
  }

  if (!threadOp) {
    return {
      discussion: null,
      freshCanonicalFromMain: null,
      requestCount,
      error: lastError ?? "No OP found for Hupu thread",
      extractionFail: true,
    };
  }

  // Next cursor logic:
  // "Hupu actual nextCursor is URL not numeric"
  // "Make tests accurate resumed URL fail pages preserve partial cursor."
  let nextCursor: string | null = null;
  if (reachedEnd) {
    nextCursor = null;
  } else if (lastError) {
    // Preserve partial cursor on failure: use the URL that failed or resume cursor
    nextCursor = nextPageToFetchUrl ?? (resumeUrlCursor ?? buildHupuPageUrl(tid, currentPage));
  } else if (pageExplicitNextCursor) {
    nextCursor = pageExplicitNextCursor;
  } else {
    nextCursor = buildHupuPageUrl(tid, currentPage + 1);
  }

  let coverage: "partial" | "complete" | "unavailable";
  if ((allReplies.length === 0 || newCountThisRun === 0) && lastError) {
    coverage = "unavailable";
  } else if (
    reachedEnd &&
    !lastError &&
    totalReplies !== null &&
    allReplies.length >= totalReplies
  ) {
    coverage = "complete";
  } else {
    coverage = "partial";
  }

  const authorFollowups = allReplies.filter((p) => p.isOriginalAuthor);
  const others = allReplies.filter((p) => !p.isOriginalAuthor);
  const highlightPool = others.length > 0 ? others : allReplies;
  const highlightedReplies = rankReplies(highlightPool, 8);

  const discussion: DiscussionContent = {
    originalPost: threadOp,
    authorFollowups,
    highlightedReplies,
    collectedReplies: allReplies,
    totalReplies,
    fetchedReplies: allReplies.length,
    collection: {
      collectedAt: new Date().toISOString(),
      coverage,
      provenance: "page_dom",
      sourceUrl: article.url,
      nextCursor,
      error: lastError ?? undefined,
    },
  };

  return {
    discussion,
    freshCanonicalFromMain,
    requestCount,
    error: lastError ?? undefined,
    extractionFail: coverage === "unavailable",
  };
}

// ---------------------------------------------------------------------------
// Weibo Refresh Implementation
// ---------------------------------------------------------------------------

async function refreshWeiboPost(params: {
  requestGate: <T>(fetch: () => Promise<T>) => Promise<T>;
  article: { id: string; url: string; title: string; author: string | null; body_text: string | null; raw: any; published_at: Date | null };
  existingCanonical: CanonicalContent | null;
  sourceConfig: Record<string, any>;
  resumeCursor: string | null;
  fetchJson?: (url: string) => Promise<unknown>;
  minIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  discussion: DiscussionContent | null;
  requestCount: number;
  error?: string;
  extractionFail: boolean;
}> {
  const { article, existingCanonical, sourceConfig, resumeCursor, minIntervalMs } = params;

  const raw = article.raw;
  const rawId = raw?.id ?? raw?.mid ?? raw?.idstr ?? extractWeiboIdFromUrl(article.url);

  if (!rawId) {
    return {
      discussion: null,
      requestCount: 0,
      error: "Could not determine Weibo post ID from article raw or URL",
      extractionFail: true,
    };
  }

  const op: DiscussionPost = existingCanonical?.discussion?.originalPost
    ? sanitizeDiscussionPost(existingCanonical.discussion.originalPost)
    : {
        id: String(rawId),
        author: {
          name: existingCanonical?.author?.name ?? article.author ?? null,
          avatarUrl: existingCanonical?.author?.avatarUrl ?? null,
        },
        text: existingCanonical?.social?.postText ?? article.body_text ?? existingCanonical?.title ?? article.title,
        publishedAt: existingCanonical?.publishedAt ?? article.published_at?.toISOString() ?? null,
        likes: existingCanonical?.engagement?.likes ?? null,
        floor: null,
        isOriginalAuthor: true,
        platform: "weibo",
        parentCommentId: null,
        replyCount: existingCanonical?.engagement?.comments ?? null,
        originalUrl: article.url,
        quote: existingCanonical?.social?.quoted
          ? { author: existingCanonical.social.quoted.author, text: existingCanonical.social.quoted.text }
          : null,
      };

  let requestCount = 0;
  const effectiveFetchJson = params.fetchJson ?? defaultGuardedFetchJson;
  const wrappedFetchJson = async (url: string) => {
    requestCount++;
    return params.requestGate(() => effectiveFetchJson(url));
  };

  const rawDiscussion = await fetchWeiboComments({
    id: rawId,
    postAuthorId: raw?.user?.id ?? null,
    originalUrl: article.url,
    originalPost: op,
    sourceConfig,
    fetchJson: wrappedFetchJson,
    resumeCursor,
    minIntervalMs,
    sleep: params.sleep,
  });

  if (!rawDiscussion || rawDiscussion.collection?.coverage === "unavailable") {
    return {
      discussion: rawDiscussion,
      requestCount,
      error: rawDiscussion?.collection?.error ?? "Weibo fetch unavailable",
      extractionFail: true,
    };
  }

  // Merge prior replies and new replies, dedup, bounded to 100, zero placeholder metrics
  const { merged, reachedLimit } = mergeDiscussionReplies(
    existingCanonical?.discussion?.collectedReplies,
    rawDiscussion.collectedReplies,
    100,
  );

  const authorFollowups = merged.filter((p) => p.isOriginalAuthor);
  const others = merged.filter((p) => !p.isOriginalAuthor);
  const highlightedReplies = rankReplies(others.length > 0 ? others : merged, 6);

  const nextCursor = reachedLimit ? null : (rawDiscussion.collection?.nextCursor ?? null);
  const totalReplies = rawDiscussion.totalReplies ?? existingCanonical?.discussion?.totalReplies ?? null;
  const coverage = totalReplies !== null && merged.length >= totalReplies && nextCursor === null
    ? "complete"
    : "partial";

  const discussion: DiscussionContent = {
    ...rawDiscussion,
    authorFollowups,
    highlightedReplies,
    collectedReplies: merged,
    fetchedReplies: merged.length,
    totalReplies,
    collection: {
      collectedAt: rawDiscussion.collection?.collectedAt ?? new Date().toISOString(),
      coverage,
      provenance: rawDiscussion.collection?.provenance ?? "source_api",
      sourceUrl: rawDiscussion.collection?.sourceUrl ?? article.url,
      nextCursor,
      error: rawDiscussion.collection?.error ?? null,
    },
  };

  return {
    discussion,
    requestCount,
    error: discussion.collection?.error ?? undefined,
    extractionFail: false,
  };
}

function extractWeiboIdFromUrl(url: string): string | null {
  try {
    const m = url.match(/\/detail\/(\d+)/i) || url.match(/\/status\/([A-Za-z0-9]+)/i) || url.match(/\/(\d{10,})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bilibili Refresh Implementation
// ---------------------------------------------------------------------------

async function refreshBilibiliVideo(params: {
  requestGate: <T>(fetch: () => Promise<T>) => Promise<T>;
  article: { id: string; url: string; title: string; author: string | null; body_text: string | null; raw: any; published_at: Date | null };
  existingCanonical: CanonicalContent | null;
  sourceConfig: Record<string, any>;
  resumeCursor: string | null;
  fetchJson?: (url: string) => Promise<unknown>;
  minIntervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  discussion: DiscussionContent | null;
  engagement: CanonicalContent["engagement"] | null;
  requestCount: number;
  error?: string;
  extractionFail: boolean;
}> {
  const { article, existingCanonical, sourceConfig, resumeCursor, minIntervalMs } = params;

  let requestCount = 0;
  const rawAid = Number.isFinite(article.raw?.aid)
    ? Number(article.raw?.aid)
    : typeof article.raw?.aid === "string" && /^\d+$/.test(article.raw?.aid)
      ? Number(article.raw?.aid)
      : null;
  let aid: number | null = rawAid && rawAid > 0 ? rawAid : null;
  const bvid = article.raw?.bvid ?? extractBvidFromUrl(article.url);
  let engagement: CanonicalContent["engagement"] | null = null;
  let upMid: number | string | null = article.raw?.owner?.mid ?? null;

  const effectiveFetchJson = params.fetchJson ?? defaultGuardedFetchJson;

  if (!aid && bvid) {
    try {
      requestCount++;
      const viewData = (await params.requestGate(() => effectiveFetchJson(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      ))) as any;
      if (viewData?.code === 0 && viewData?.data) {
        const resolvedAid = Number(viewData.data.aid);
        if (Number.isFinite(resolvedAid) && resolvedAid > 0) {
          aid = resolvedAid;
        }
        upMid = viewData.data.owner?.mid ?? upMid;
        const stat = viewData.data.stat;
        if (stat) {
          engagement = {
            views: stat.view ?? null,
            likes: stat.like ?? null,
            comments: stat.reply ?? null,
            shares: stat.share ?? null,
            favorites: stat.favorite ?? null,
            coins: stat.coin ?? null,
            danmaku: stat.danmaku ?? null,
          };
        }
      }
    } catch {
      // Best-effort view fetch
    }
  }

  if (!aid) {
    return {
      discussion: null,
      engagement,
      requestCount,
      error: "Could not determine Bilibili aid: finite safe ID required from raw.aid or view API",
      extractionFail: true,
    };
  }

  const targetId = aid;

  const op: DiscussionPost = existingCanonical?.discussion?.originalPost
    ? sanitizeDiscussionPost(existingCanonical.discussion.originalPost)
    : {
        id: String(targetId),
        author: {
          name: existingCanonical?.author?.name ?? article.author ?? null,
          avatarUrl: existingCanonical?.author?.avatarUrl ?? null,
        },
        text: existingCanonical?.video?.description ?? article.body_text ?? article.title,
        publishedAt: existingCanonical?.publishedAt ?? article.published_at?.toISOString() ?? null,
        likes: engagement?.likes ?? existingCanonical?.engagement?.likes ?? null,
        floor: null,
        isOriginalAuthor: true,
        platform: "bilibili",
        parentCommentId: null,
        replyCount: engagement?.comments ?? existingCanonical?.engagement?.comments ?? null,
        originalUrl: article.url,
        quote: null,
      };

  const wrappedFetchJson = async (url: string) => {
    requestCount++;
    return params.requestGate(() => effectiveFetchJson(url));
  };

  const rawDiscussion = await fetchBilibiliComments({
    oid: aid ?? null,
    bvid,
    upMid,
    originalPost: op,
    sourceConfig,
    fetchJson: wrappedFetchJson,
    resumeCursor,
    minIntervalMs,
    sleep: params.sleep,
  });

  if (!rawDiscussion || rawDiscussion.collection?.coverage === "unavailable") {
    return {
      discussion: rawDiscussion,
      engagement,
      requestCount,
      error: rawDiscussion?.collection?.error ?? "Bilibili fetch unavailable",
      extractionFail: true,
    };
  }

  // Merge prior replies and new replies, dedup, bounded to 100, zero placeholder metrics
  const { merged, reachedLimit } = mergeDiscussionReplies(
    existingCanonical?.discussion?.collectedReplies,
    rawDiscussion.collectedReplies,
    100,
  );

  const authorFollowups = merged.filter((p) => p.isOriginalAuthor);
  const others = merged.filter((p) => !p.isOriginalAuthor);
  const highlightedReplies = rankReplies(others.length > 0 ? others : merged, 6);

  const nextCursor = reachedLimit ? null : (rawDiscussion.collection?.nextCursor ?? null);
  const totalReplies = rawDiscussion.totalReplies ?? existingCanonical?.discussion?.totalReplies ?? null;
  const coverage = totalReplies !== null && merged.length >= totalReplies && nextCursor === null
    ? "complete"
    : "partial";

  const discussion: DiscussionContent = {
    ...rawDiscussion,
    authorFollowups,
    highlightedReplies,
    collectedReplies: merged,
    fetchedReplies: merged.length,
    totalReplies,
    collection: {
      collectedAt: rawDiscussion.collection?.collectedAt ?? new Date().toISOString(),
      coverage,
      provenance: rawDiscussion.collection?.provenance ?? "source_api",
      sourceUrl: rawDiscussion.collection?.sourceUrl ?? article.url,
      nextCursor,
      error: rawDiscussion.collection?.error ?? null,
    },
  };

  return {
    discussion,
    engagement,
    requestCount,
    error: discussion.collection?.error ?? undefined,
    extractionFail: false,
  };
}

function extractBvidFromUrl(url: string): string | null {
  try {
    const m = url.match(/\/video\/(BV[\w]+)/i) || url.match(/bvid=(BV[\w]+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scheduled Sweep Implementation
// ---------------------------------------------------------------------------

export async function sweepCommunityRefresh(
  options: SweepCommunityOptions = {},
): Promise<SweepCommunityResult> {
  const db = options.db ?? sql;

  // 1. Check Global Valve
  if (!isCommunityCollectionEnabled()) {
    return {
      skipped: true,
      reason: "Community collection is globally disabled (COLLECT_ENABLED + COMMUNITY_COLLECTION_ENABLED required)",
      evaluated: 0,
      enqueued: 0,
      executed: 0,
    };
  }

  const budget = options.budget ?? 10;

  // 2. Select Eligible Candidates
  // - Belongs to enabled source with communityComments.enabled === true
  // - Not isolated (participation_mode <> 'isolated')
  // - Filter out articles in cooldown up front so they do not consume source budget
  // - Prioritizes accepted items in content_radar
  // - Orders by latest observed discussion count vs unknown last (no stale fallback from an unknown observation)
  const candidates = await db<{
    id: string;
    source_id: string;
    url: string;
    total_replies: number | null;
    is_radar_accepted: boolean;
  }[]>`
    WITH eligible_articles AS (
      SELECT
        a.id,
        a.source_id,
        a.url,
        a.created_at,
        CASE WHEN eo.id IS NOT NULL THEN (eo.metrics->>'comments')::numeric
          ELSE (a.canonical_content->'discussion'->>'totalReplies')::numeric END AS total_replies,
        COALESCE(rm.state = 'accepted', false) AS is_radar_accepted,
        COALESCE(
          (s.config->'communityComments'->>'maxPostsPerRun')::int,
          5
        ) AS source_budget,
        COALESCE(
          (SELECT MAX(ccr.attempted_at) FROM community_collection_runs ccr WHERE ccr.article_id = a.id),
          (a.canonical_content->'discussion'->'collection'->>'collectedAt')::timestamptz,
          a.created_at
        ) AS last_attempt_at,
        COALESCE(
          (s.config->'communityComments'->>'hotRefreshMinutes')::int,
          30
        ) AS hot_cooldown_mins,
        COALESCE(
          (s.config->'communityComments'->>'normalRefreshMinutes')::int,
          (s.config->'communityComments'->>'refreshMinutes')::int,
          120
        ) AS normal_cooldown_mins
      FROM articles a
      JOIN sources s ON s.id = a.source_id
      LEFT JOIN LATERAL (
        SELECT id, metrics FROM engagement_observations
        WHERE article_id = a.id AND source_id = a.source_id
        ORDER BY observed_at DESC, id DESC LIMIT 1
      ) eo ON true
      LEFT JOIN radar_materials rm ON rm.article_id = a.id AND rm.input_revision = a.revision
      WHERE s.enabled = true
        AND s.participation_mode <> 'isolated'
        AND (s.config->'communityComments'->>'enabled')::boolean = true
        AND a.created_at > now() - interval '60 days'
    ),
    filtered_cooldown AS (
      SELECT *
      FROM eligible_articles
      WHERE (
        (is_radar_accepted = true AND last_attempt_at < now() - make_interval(mins => hot_cooldown_mins))
        OR (is_radar_accepted = false AND last_attempt_at < now() - make_interval(mins => normal_cooldown_mins))
      )
    ),
    ranked_candidates AS (
      SELECT
        id, source_id, url, total_replies, is_radar_accepted,
        ROW_NUMBER() OVER (
          PARTITION BY source_id
          ORDER BY
            CASE WHEN is_radar_accepted THEN 0 ELSE 1 END ASC,
            CASE WHEN total_replies IS NOT NULL THEN 0 ELSE 1 END ASC,
            total_replies DESC NULLS LAST,
            created_at DESC,
            id DESC
        ) AS source_rank,
        source_budget
      FROM filtered_cooldown
    )
    SELECT id, source_id, url, total_replies, is_radar_accepted
    FROM ranked_candidates
    WHERE source_rank <= source_budget
    ORDER BY
      CASE WHEN is_radar_accepted THEN 0 ELSE 1 END ASC,
      CASE WHEN total_replies IS NOT NULL THEN 0 ELSE 1 END ASC,
      total_replies DESC NULLS LAST
    LIMIT ${budget}
  `;

  let enqueued = 0;
  let executed = 0;
  const results: RefreshArticleResult[] = [];

  for (const c of candidates) {
    if (options.inline) {
      const res = options.refreshFn
        ? await options.refreshFn(c.id, { sourceId: c.source_id })
        : await refreshArticleCommunity(c.id, { db, sourceId: c.source_id });
      results.push(res);
      if (res.status !== "skipped") {
        executed++;
      }
    } else if (options.enqueueFn) {
      const jobId = await options.enqueueFn(c.id, c.source_id);
      if (jobId) {
        enqueued++;
      }
    }
  }

  return {
    skipped: false,
    evaluated: candidates.length,
    enqueued,
    executed,
    results: options.inline ? results : undefined,
  };
}

// ---------------------------------------------------------------------------
// Coordinator Summary Helper
// ---------------------------------------------------------------------------

export async function getCommunityRunsSummary(db: Db = sql): Promise<{
  totalAttempts: number;
  statusBreakdown: Record<string, number>;
  platformBreakdown: Record<string, number>;
  avgLatencyMs: number;
  totalFetched: number;
  extractionFails: number;
}> {
  const [row] = await db<{
    total: number;
    avg_latency: number;
    total_fetched: number;
    extraction_fails: number;
  }[]>`
    SELECT
      count(*)::int as total,
      coalesce(avg(latency_ms), 0)::int as avg_latency,
      coalesce(sum(fetched_count), 0)::int as total_fetched,
      coalesce(sum(case when extraction_fail then 1 else 0 end), 0)::int as extraction_fails
    FROM community_collection_runs
  `;

  const statusRows = await db<{ status: string; count: number }[]>`
    SELECT status, count(*)::int as count
    FROM community_collection_runs
    GROUP BY status
  `;

  const platformRows = await db<{ platform: string; count: number }[]>`
    SELECT platform, count(*)::int as count
    FROM community_collection_runs
    GROUP BY platform
  `;

  const statusBreakdown: Record<string, number> = {};
  for (const r of statusRows) statusBreakdown[r.status] = r.count;

  const platformBreakdown: Record<string, number> = {};
  for (const r of platformRows) platformBreakdown[r.platform] = r.count;

  return {
    totalAttempts: row?.total ?? 0,
    statusBreakdown,
    platformBreakdown,
    avgLatencyMs: row?.avg_latency ?? 0,
    totalFetched: row?.total_fetched ?? 0,
    extractionFails: row?.extraction_fails ?? 0,
  };
}

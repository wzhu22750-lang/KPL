// Community comments fetcher and parsers for Bilibili and Weibo.
// Enforces:
// 1. Fetch comments ONLY when sourceConfig.communityComments.enabled === true
// 2. Verified permitted endpoint explicitly configured (exact HTTPS host allowlist, no guessed APIs, no arbitrary hosts)
// 3. Injectable fetchJson
// 4. Hard page & comment budgets with bounded pagination
// 5. Partial results survive page failure; fail state unavailable does not fail original extraction
// 6. Bad shape (null, {}, denied, missing list) throws and marks coverage unavailable (not complete)
// 7. Explicit terminal pagination evidence required; repeated cursor causes partial error
// 8. Unknown total never substitutes allPosts.length; replyCount never substitutes nested sample length
// 9. Flatten nested comments into single DiscussionPost[] parent IDs, bounded iterative depth <= 8 and total 100 max, dedup ids, enforce budgets before visiting descendants, mark partial when omitted nested
// 10. resumeCursor option allows resuming from prior cursor
// 11. Per-platform serialized concurrency 1 with default 1000ms minInterval (injectable for zero-delay tests)
// 12. Conservative coverage: hot sample even at end is partial unless actual known totals <= fetched all IDs
import { config } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { stripTags } from "../lib/text.ts";
import { parseWeiboDate } from "../sources/adapters/weibo.ts";
import { rankReplies } from "./extractors/forum.ts";
import type { DiscussionContent, DiscussionPost } from "./extractors/types.ts";

export function isCommunityCollectionEnabled(): boolean {
  const collectEnabled = Boolean(config.collectEnabled || process.env.COLLECT_ENABLED === "true");
  const communityEnabled = process.env.COMMUNITY_COLLECTION_ENABLED === "true";
  return collectEnabled && communityEnabled;
}

/**
 * Production default JSON fetcher backed by guardedFetch:
 * - HTTPS only
 * - maxBytes: 2MB (2 * 1024 * 1024)
 * - timeoutMs: 15_000
 * - redirectPolicy: "same-origin" (cross-origin redirects rejected)
 * - Requires HTTP status 200 (any non-200 throws an error)
 */
export async function defaultGuardedFetchJson(rawUrl: string): Promise<unknown> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid fetch URL: "${rawUrl}"`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Fetch URL protocol must be https:, got "${parsed.protocol}"`);
  }

  const res = await guardedFetch(rawUrl, {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
    },
    timeoutMs: 15_000,
    maxBytes: 2 * 1024 * 1024,
    redirectPolicy: "same-origin",
  });

  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: fetch failed for "${rawUrl}"`);
  }

  try {
    return JSON.parse(res.text());
  } catch (err: any) {
    throw new Error(`Failed to parse JSON response from "${rawUrl}": ${err?.message ?? err}`);
  }
}

export const PERMITTED_COMMENT_HOSTS = {
  bilibili: new Set(["api.bilibili.com"]),
  weibo: new Set(["m.weibo.cn", "api.weibo.cn", "api.weibo.com"]),
} as const;

export const DEFAULT_COMMENT_BUDGETS = {
  maxPages: 3,
  maxComments: 50,
  pageSize: 20,
} as const;

export const HARD_MAX_PAGES = 5;
export const HARD_MAX_COMMENTS = 100;
export const HARD_MAX_PAGE_SIZE = 50;
export const MAX_NESTED_DEPTH = 8;
export const DEFAULT_MIN_INTERVAL_MS = 1000;

export interface CommunityCommentsConfig {
  enabled?: boolean;
  endpointTemplate?: string;
  endpoint?: string;
  maxPages?: number;
  maxComments?: number;
  pageSize?: number;
  minIntervalMs?: number;
}

export interface ParsedReplyPage {
  posts: DiscussionPost[];
  totalReplies: number | null;
  nextCursor: string | null;
  isEnd: boolean;
  hasTerminalEvidence: boolean;
  hasOmittedNested: boolean;
}

// ---------------------------------------------------------------------------
// Per-Platform Concurrency 1 & Min-Interval Serialization
// ---------------------------------------------------------------------------

interface PlatformQueueState {
  lastRequestTime: number;
  activeChain: Promise<unknown>;
}

const platformQueues = new Map<string, PlatformQueueState>();

export function resetPlatformQueues(): void {
  platformQueues.clear();
}

export function getPlatformQueueState(platform: string): PlatformQueueState {
  let q = platformQueues.get(platform);
  if (!q) {
    q = { lastRequestTime: 0, activeChain: Promise.resolve() };
    platformQueues.set(platform, q);
  }
  return q;
}

export async function executeSerializedPlatformFetch<T>(
  platform: string,
  minIntervalMs: number,
  fetchFn: () => Promise<T>,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  const state = getPlatformQueueState(platform);

  const execute = async (): Promise<T> => {
    const now = Date.now();
    const elapsed = now - state.lastRequestTime;
    const waitTime = minIntervalMs > 0 && state.lastRequestTime > 0 && elapsed < minIntervalMs
      ? minIntervalMs - elapsed
      : 0;

    if (waitTime > 0) {
      await sleepFn(waitTime);
    }

    try {
      return await fetchFn();
    } finally {
      state.lastRequestTime = Date.now();
    }
  };

  const nextPromise = state.activeChain.then(execute, execute);
  state.activeChain = nextPromise.catch(() => {});
  return nextPromise;
}

/**
 * Validates that an endpoint URL uses HTTPS, targets a permitted host for the platform,
 * does not include credentials, and does not use non-standard ports.
 */
export function validateCommentEndpointUrl(
  rawUrl: string,
  platform: "bilibili" | "weibo",
): { ok: true; url: URL } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Invalid endpoint URL: "${rawUrl}"` };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: `Protocol must be https:, got "${parsed.protocol}"` };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: "Credentials in endpoint URL are forbidden" };
  }

  const hostname = parsed.hostname.toLowerCase();
  const allowed = PERMITTED_COMMENT_HOSTS[platform];
  if (!allowed.has(hostname as any)) {
    return { ok: false, reason: `Host "${hostname}" is not in the permitted allowlist for platform "${platform}"` };
  }

  if (parsed.port && parsed.port !== "443") {
    return { ok: false, reason: `Non-standard port "${parsed.port}" is forbidden` };
  }

  return { ok: true, url: parsed };
}

/**
 * Resolves template variables in an endpoint URL template and validates the resulting URL.
 */
export function resolveEndpointUrl(
  template: string,
  vars: Record<string, string | number | undefined | null>,
  platform: "bilibili" | "weibo",
): { ok: true; url: string } | { ok: false; reason: string } {
  if (!template || typeof template !== "string") {
    return { ok: false, reason: "Endpoint template is missing or empty" };
  }

  let missingRequiredVar: string | null = null;
  const resolved = template.replace(/\{(\w+)\}/g, (match, key) => {
    const val = vars[key];
    if (val === undefined || val === null) {
      // Critical identifiers must not be missing
      if (["oid", "aid", "id", "mid"].includes(key)) {
        missingRequiredVar = key;
      }
      return "";
    }
    return encodeURIComponent(String(val));
  });

  if (missingRequiredVar) {
    return { ok: false, reason: `Missing required template variable: "${missingRequiredVar}"` };
  }

  const validation = validateCommentEndpointUrl(resolved, platform);
  if (!validation.ok) {
    return validation;
  }

  return { ok: true, url: resolved };
}

/**
 * Bounded iterative comment flattener.
 * - Flattens nested comments into a single DiscussionPost[] with parent IDs
 * - Bounded iterative depth <= 8
 * - Total comments <= 100 max (or caller maxLimit)
 * - Deduplicates by ID
 * - Enforces budgets BEFORE visiting descendants
 * - Marks hasOmittedNested = true when nested comments cannot be visited
 */
function flattenNestedComments(
  rawRoots: any[],
  mapItem: (raw: any, parentFallbackId: string | null) => DiscussionPost,
  getChildren: (raw: any) => any[] | undefined | null,
  getReplyCount: (raw: any) => number | null,
  options?: { maxDepth?: number; maxLimit?: number },
): { posts: DiscussionPost[]; hasOmittedNested: boolean } {
  const maxDepth = Math.min(options?.maxDepth ?? MAX_NESTED_DEPTH, MAX_NESTED_DEPTH);
  const maxLimit = Math.min(options?.maxLimit ?? HARD_MAX_COMMENTS, HARD_MAX_COMMENTS);

  const posts: DiscussionPost[] = [];
  const seenIds = new Set<string>();
  let hasOmittedNested = false;

  interface StackEntry {
    raw: any;
    depth: number;
    parentFallbackId: string | null;
  }

  const stack: StackEntry[] = [];
  for (let i = rawRoots.length - 1; i >= 0; i--) {
    stack.push({
      raw: rawRoots[i],
      depth: 1,
      parentFallbackId: null,
    });
  }

  while (stack.length > 0) {
    const entry = stack.pop()!;
    const { raw, depth, parentFallbackId } = entry;

    if (depth > maxDepth) {
      hasOmittedNested = true;
      continue;
    }

    if (posts.length >= maxLimit) {
      hasOmittedNested = true;
      break;
    }

    const post = mapItem(raw, parentFallbackId);
    const id = post.id;

    if (id && seenIds.has(id)) {
      continue;
    }

    if (id) {
      seenIds.add(id);
    }
    posts.push(post);

    const children = getChildren(raw);
    const hasChildren = Array.isArray(children) && children.length > 0;
    const reportedReplyCount = getReplyCount(raw);

    if (reportedReplyCount !== null && reportedReplyCount > (hasChildren ? children.length : 0)) {
      hasOmittedNested = true;
    }

    if (hasChildren) {
      // Enforce budgets before visiting descendants
      if (posts.length >= maxLimit) {
        hasOmittedNested = true;
      } else if (depth >= maxDepth) {
        hasOmittedNested = true;
      } else {
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push({
            raw: children[i],
            depth: depth + 1,
            parentFallbackId: id || parentFallbackId,
          });
        }
      }
    }
  }

  return { posts, hasOmittedNested };
}

/**
 * Reusable parser for publicly observed Bilibili reply responses (e.g. x/v2/reply, x/v2/reply/main).
 * - Throws on null, {}, denied error codes, or missing replies list -> triggers unavailable
 * - Flattens nested replies into a single DiscussionPost[] with parent IDs
 * - Requires explicit terminal pagination evidence (cursor.is_end or page count boundary)
 * - Normalizes unknown counters strictly to null (never uses sample length)
 */
export function parseBilibiliReplyResponse(
  raw: unknown,
  options?: {
    oid?: number | string | null;
    bvid?: string | null;
    upMid?: number | string | null;
    maxComments?: number;
    maxDepth?: number;
  },
): ParsedReplyPage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Bad response shape: response must be a non-null object");
  }

  const root = raw as Record<string, any>;
  if (Object.keys(root).length === 0) {
    throw new Error("Bad response shape: response is an empty object");
  }

  if (root.code !== undefined && root.code !== 0) {
    throw new Error(root.message ? String(root.message) : `Bilibili API error code ${root.code}`);
  }

  if (root.code === undefined && !("data" in root)) {
    throw new Error("Bad response shape: missing code and data in response");
  }

  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, any>;

  const verifiedCode0 = root.code === 0;
  const cursorAllCount = Number.isFinite(data.cursor?.all_count) ? Number(data.cursor.all_count) : null;
  const cursorTotal = Number.isFinite(data.cursor?.total) ? Number(data.cursor.total) : null;
  const pageCount = Number.isFinite(data.page?.count) ? Number(data.page.count) : null;

  const isZeroPageCountOrCursorTotal0 =
    cursorAllCount === 0 || cursorTotal === 0 || pageCount === 0;

  let rawReplies: any[];
  if (data.replies === null) {
    if (verifiedCode0 && isZeroPageCountOrCursorTotal0) {
      rawReplies = [];
    } else {
      throw new Error("Bad response shape: replies list is missing or not an array");
    }
  } else if (Array.isArray(data.replies)) {
    rawReplies = data.replies;
  } else {
    throw new Error("Bad response shape: replies list is missing or not an array");
  }

  // Total reply count from cursor or page
  const totalReplies = cursorAllCount !== null
    ? cursorAllCount
    : pageCount !== null
      ? pageCount
      : cursorTotal !== null
        ? cursorTotal
        : (data.replies === null && verifiedCode0 && isZeroPageCountOrCursorTotal0 ? 0 : null);

  // Pagination / cursor info with explicit terminal evidence
  let isEnd = false;
  let hasTerminalEvidence = false;
  let nextCursor: string | null = null;

  if (data.cursor && typeof data.cursor === "object") {
    if (data.cursor.is_end === true || (cursorAllCount === 0 && rawReplies.length === 0)) {
      isEnd = true;
      hasTerminalEvidence = true;
      nextCursor = null;
    } else {
      isEnd = false;
      hasTerminalEvidence = false;
      if (data.cursor.next !== undefined && data.cursor.next !== null) {
        nextCursor = String(data.cursor.next);
      }
    }
  } else if (data.page && typeof data.page === "object") {
    const pageNum = Number(data.page.num) || 1;
    const pageSize = Number(data.page.size) || 20;
    const count = Number.isFinite(data.page.count) ? Number(data.page.count) : null;
    if (count !== null) {
      if (count === 0 || pageNum * pageSize >= count) {
        isEnd = true;
        hasTerminalEvidence = true;
        nextCursor = null;
      } else {
        isEnd = false;
        hasTerminalEvidence = false;
        nextCursor = String(pageNum + 1);
      }
    } else {
      isEnd = false;
      hasTerminalEvidence = false;
      nextCursor = String(pageNum + 1);
    }
  } else {
    if (totalReplies === 0 && rawReplies.length === 0) {
      isEnd = true;
      hasTerminalEvidence = true;
    }
  }

  if (rawReplies.length === 0 && totalReplies === 0) {
    isEnd = true;
    hasTerminalEvidence = true;
    nextCursor = null;
  }

  const mapReplyItem = (item: any, parentFallbackId: string | null): DiscussionPost => {
    const rpid = String(item.rpid ?? "");
    const member = item.member && typeof item.member === "object" ? item.member : null;
    const content = item.content && typeof item.content === "object" ? item.content : null;

    const uname = typeof member?.uname === "string" && member.uname.trim() ? member.uname.trim() : null;
    const avatar = typeof member?.avatar === "string" ? member.avatar.replace(/^http:/, "https:") : null;

    const publishedAt = Number.isFinite(item.ctime) && item.ctime > 0
      ? new Date(item.ctime * 1000).toISOString()
      : null;

    const text = typeof content?.message === "string" ? content.message.trim() : "";
    const likes = Number.isFinite(item.like) && item.like >= 0 ? Number(item.like) : null;
    const floor = Number.isFinite(item.floor) && item.floor > 0 ? Number(item.floor) : null;

    const mid = item.mid ?? member?.mid;
    const isOriginalAuthor = options?.upMid != null && mid != null && String(mid) === String(options.upMid);

    let parentCommentId: string | null = null;
    if (item.parent && item.parent !== 0) {
      parentCommentId = String(item.parent);
    } else if (item.root && item.root !== 0) {
      parentCommentId = String(item.root);
    } else {
      parentCommentId = parentFallbackId;
    }

    // Strictly null when unknown; NEVER substitute sample length!
    const replyCount = Number.isFinite(item.rcount) && item.rcount >= 0
      ? Number(item.rcount)
      : Number.isFinite(item.count) && item.count >= 0
        ? Number(item.count)
        : null;

    let originalUrl: string | null = null;
    if (options?.bvid && rpid) {
      originalUrl = `https://www.bilibili.com/video/${options.bvid}#reply${rpid}`;
    } else if (options?.oid && rpid) {
      originalUrl = `https://www.bilibili.com/video/av${options.oid}#reply${rpid}`;
    }

    return {
      id: rpid,
      author: {
        name: uname,
        avatarUrl: avatar,
      },
      publishedAt,
      text,
      likes,
      floor,
      isOriginalAuthor,
      platform: "bilibili",
      parentCommentId,
      replyCount,
      originalUrl,
      quote: null,
    };
  };

  const { posts, hasOmittedNested } = flattenNestedComments(
    rawReplies,
    mapReplyItem,
    (raw) => (Array.isArray(raw.replies) ? raw.replies : null),
    (raw) => (Number.isFinite(raw.rcount) && raw.rcount >= 0 ? Number(raw.rcount) : Number.isFinite(raw.count) && raw.count >= 0 ? Number(raw.count) : null),
    {
      maxDepth: options?.maxDepth,
      maxLimit: options?.maxComments,
    },
  );

  return {
    posts,
    totalReplies,
    nextCursor,
    isEnd,
    hasTerminalEvidence,
    hasOmittedNested,
  };
}

/**
 * Reusable parser for publicly observed Weibo comment responses (m.weibo.cn hotflow or comments/show).
 * - Throws on null, {}, denied (ok=0), or missing comments list -> triggers unavailable
 * - Flattens nested comments into a single DiscussionPost[] with parent IDs
 * - Requires explicit terminal evidence (max_id === 0)
 * - Normalizes unknown counters strictly to null (never uses sample length)
 */
export function parseWeiboCommentResponse(
  raw: unknown,
  options?: {
    originalUrl?: string | null;
    postAuthorId?: number | string | null;
    maxComments?: number;
    maxDepth?: number;
  },
): ParsedReplyPage {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Bad response shape: response must be a non-null object");
  }

  const root = raw as Record<string, any>;
  if (Object.keys(root).length === 0) {
    throw new Error("Bad response shape: response is an empty object");
  }

  if (root.ok === 0) {
    throw new Error(root.msg ? String(root.msg) : "Weibo request denied (ok: 0)");
  }

  if (root.error || root.error_code || root.errno) {
    throw new Error(String(root.error || root.msg || `Weibo error code ${root.error_code || root.errno}`));
  }

  const dataObj = root.data && typeof root.data === "object" ? root.data : null;
  let rawComments: any[] | null = null;
  if (dataObj && Array.isArray(dataObj.data)) {
    rawComments = dataObj.data;
  } else if (Array.isArray(root.data)) {
    rawComments = root.data;
  } else if (Array.isArray(root.comments)) {
    rawComments = root.comments;
  }

  if (rawComments === null) {
    throw new Error("Bad response shape: comments list is missing or not an array");
  }

  const totalReplies = Number.isFinite(dataObj?.total_number)
    ? Number(dataObj.total_number)
    : Number.isFinite(root.total_number)
      ? Number(root.total_number)
      : null;

  const maxId = dataObj?.max_id ?? root.max_id;
  let isEnd = false;
  let hasTerminalEvidence = false;
  let nextCursor: string | null = null;

  if (maxId === 0 || maxId === "0") {
    isEnd = true;
    hasTerminalEvidence = true;
    nextCursor = null;
  } else if (maxId !== undefined && maxId !== null && String(maxId).trim() !== "" && String(maxId).trim() !== "0") {
    isEnd = false;
    hasTerminalEvidence = false;
    nextCursor = String(maxId);
  } else {
    if (totalReplies === 0 && rawComments.length === 0) {
      isEnd = true;
      hasTerminalEvidence = true;
    } else {
      isEnd = true;
      hasTerminalEvidence = false;
    }
  }

  const mapWeiboItem = (item: any, parentFallbackId: string | null): DiscussionPost => {
    const id = String(item.id ?? item.mid ?? item.idstr ?? "");
    const user = item.user && typeof item.user === "object" ? item.user : null;

    const name = typeof user?.screen_name === "string" && user.screen_name.trim()
      ? user.screen_name.trim()
      : typeof user?.name === "string" && user.name.trim()
        ? user.name.trim()
        : null;

    const avatarUrl = typeof user?.profile_image_url === "string"
      ? user.profile_image_url.replace(/^http:/, "https:")
      : typeof user?.avatar_large === "string"
        ? user.avatar_large.replace(/^http:/, "https:")
        : null;

    let publishedAt: string | null = null;
    if (item.created_at) {
      const parsedDate = parseWeiboDate(String(item.created_at));
      if (parsedDate && Number.isFinite(parsedDate.getTime())) {
        publishedAt = parsedDate.toISOString();
      } else {
        const fallback = Date.parse(String(item.created_at));
        if (Number.isFinite(fallback)) {
          publishedAt = new Date(fallback).toISOString();
        }
      }
    }

    const text = stripTags(String(item.text ?? "")).trim();

    const rawLikes = item.like_count ?? item.like_counts;
    const likes = Number.isFinite(rawLikes) && rawLikes >= 0 ? Number(rawLikes) : null;

    const rawFloor = item.floor_number;
    const floor = Number.isFinite(rawFloor) && rawFloor > 0 ? Number(rawFloor) : null;

    const authorUid = user?.id;
    const isOriginalAuthor = options?.postAuthorId != null && authorUid != null && String(authorUid) === String(options.postAuthorId);

    let parentCommentId: string | null = null;
    if (item.rootid && String(item.rootid) !== "0" && String(item.rootid) !== id) {
      parentCommentId = String(item.rootid);
    } else if (item.parent_id && String(item.parent_id) !== "0" && String(item.parent_id) !== id) {
      parentCommentId = String(item.parent_id);
    } else {
      parentCommentId = parentFallbackId;
    }

    // Strictly null when unknown; NEVER substitute sample length!
    const replyCount = Number.isFinite(item.total_number) && item.total_number >= 0
      ? Number(item.total_number)
      : null;

    const originalUrl = options?.originalUrl && id ? `${options.originalUrl}#comment-${id}` : null;

    return {
      id,
      author: {
        name,
        avatarUrl,
      },
      publishedAt,
      text,
      likes,
      floor,
      isOriginalAuthor,
      platform: "weibo",
      parentCommentId,
      replyCount,
      originalUrl,
      quote: null,
    };
  };

  const { posts, hasOmittedNested } = flattenNestedComments(
    rawComments,
    mapWeiboItem,
    (raw) => (Array.isArray(raw.comments) ? raw.comments : null),
    (raw) => (Number.isFinite(raw.total_number) && raw.total_number >= 0 ? Number(raw.total_number) : null),
    {
      maxDepth: options?.maxDepth,
      maxLimit: options?.maxComments,
    },
  );

  return {
    posts,
    totalReplies,
    nextCursor,
    isEnd,
    hasTerminalEvidence,
    hasOmittedNested,
  };
}

export interface FetchCommunityCommentsOptions {
  platform: "bilibili" | "weibo";
  targetId: string | number;
  bvid?: string | null;
  authorId?: string | number | null;
  originalUrl?: string | null;
  originalPost?: DiscussionPost;
  sourceConfig: Record<string, any> | null;
  fetchJson?: ((url: string) => Promise<unknown>) | null;
  highlightLimit?: number;
  resumeCursor?: string | null;
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Core bounded comment fetcher.
 * - Only runs when sourceConfig.communityComments.enabled === true
 * - Enforces global COLLECT_ENABLED and COMMUNITY_COLLECTION_ENABLED safety valves at actual network shared function
 * - Requires explicit permitted HTTPS endpoint configuration matching platform allowlist
 * - Per-platform concurrency 1 and serialized minInterval rate limiting
 * - Respects hard pagination and comment budgets
 * - Survives partial page fetch failures
 * - Returns unavailable status on initial bad shape or network failure (never completes improperly)
 * - Requires explicit terminal pagination evidence; repeated cursor triggers partial error
 * - Never substitutes allPosts.length for unknown totalReplies
 * - Conservative coverage: hot samples even at end are partial unless actual known totals <= fetched all IDs
 */
export async function fetchCommunityComments(
  options: FetchCommunityCommentsOptions,
): Promise<DiscussionContent | null> {
  const { platform, targetId, bvid, authorId, originalUrl, originalPost, sourceConfig, highlightLimit } = options;

  // Global safety valve check: COLLECT_ENABLED + COMMUNITY_COLLECTION_ENABLED
  // Enforced at actual network shared function! Injected fixtures not allowed to bypass in production.
  if (!isCommunityCollectionEnabled()) {
    return null;
  }

  const cfg = (sourceConfig?.communityComments ?? null) as CommunityCommentsConfig | null;

  // Strict opt-in check: comments fetched ONLY when explicitly enabled
  if (cfg?.enabled !== true) {
    return null;
  }

  const defaultOp: DiscussionPost = originalPost ?? {
    id: String(targetId || ""),
    author: { name: null, avatarUrl: null },
    text: "",
    publishedAt: null,
    likes: null,
    floor: 0,
    isOriginalAuthor: true,
    platform,
    parentCommentId: null,
    replyCount: null,
    originalUrl: originalUrl ?? null,
    quote: null,
  };

  const template = cfg.endpointTemplate ?? cfg.endpoint;
  const collectedAt = new Date().toISOString();

  // No guessed APIs: permitted endpoint must be explicitly configured
  if (!template || typeof template !== "string" || !template.trim()) {
    return {
      originalPost: defaultOp,
      authorFollowups: [],
      highlightedReplies: [],
      totalReplies: null,
      fetchedReplies: 0,
      collection: {
        collectedAt,
        coverage: "unavailable",
        provenance: "source_api",
        sourceUrl: "",
        error: "Community comments enabled but no endpointTemplate is explicitly configured",
      },
    };
  }

  const fetchJson = options.fetchJson ?? defaultGuardedFetchJson;

  // Budgets
  const maxPages = Math.min(Math.max(1, Number(cfg.maxPages) || DEFAULT_COMMENT_BUDGETS.maxPages), HARD_MAX_PAGES);
  const maxComments = Math.min(Math.max(1, Number(cfg.maxComments) || DEFAULT_COMMENT_BUDGETS.maxComments), HARD_MAX_COMMENTS);
  const pageSize = Math.min(Math.max(1, Number(cfg.pageSize) || DEFAULT_COMMENT_BUDGETS.pageSize), HARD_MAX_PAGE_SIZE);
  const minIntervalMs = options.minIntervalMs ?? cfg.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  const allPosts: DiscussionPost[] = [];
  const seenPostIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = options.resumeCursor != null && String(options.resumeCursor).trim() !== ""
    ? String(options.resumeCursor)
    : null;
  let totalReplies: number | null = null;
  let firstUrl = "";
  let lastError: string | null = null;
  let reachedEnd = false;
  let hasOmittedNested = false;

  for (let page = 1; page <= maxPages; page++) {
    if (cursor !== null) {
      seenCursors.add(cursor);
    }

    // Fix numeric pagination: {pn} / {page} uses cursor directly if numeric cursor present, otherwise page
    const isNumericCursor = cursor !== null && /^\d+$/.test(cursor) && Number(cursor) > 0;
    const pageNum = isNumericCursor ? Number(cursor) : page;

    const urlResult = resolveEndpointUrl(
      template,
      {
        oid: targetId,
        aid: targetId,
        bvid: bvid ?? undefined,
        id: targetId,
        mid: targetId,
        page: pageNum,
        pn: pageNum,
        pageSize,
        ps: pageSize,
        cursor: cursor ?? (platform === "bilibili" ? "0" : ""),
        next: cursor ?? (platform === "bilibili" ? "0" : ""),
        maxId: cursor ?? "",
        max_id: cursor ?? "",
        maxIdType: "0",
        max_id_type: "0",
      },
      platform,
    );

    if (!urlResult.ok) {
      lastError = urlResult.reason;
      break;
    }

    const currentUrl = urlResult.url;
    if (!firstUrl) firstUrl = currentUrl;

    let responsePayload: unknown;
    try {
      responsePayload = await executeSerializedPlatformFetch(
        platform,
        minIntervalMs,
        () => fetchJson!(currentUrl),
        options.sleep,
      );
    } catch (err: any) {
      lastError = err?.message ? String(err.message) : String(err);
      // Partial results survive page failure!
      break;
    }

    let parsedPage: ParsedReplyPage;
    try {
      if (platform === "bilibili") {
        parsedPage = parseBilibiliReplyResponse(responsePayload, {
          oid: targetId,
          bvid,
          upMid: authorId,
          maxComments: maxComments - allPosts.length,
        });
      } else {
        parsedPage = parseWeiboCommentResponse(responsePayload, {
          originalUrl,
          postAuthorId: authorId,
          maxComments: maxComments - allPosts.length,
        });
      }
    } catch (err: any) {
      lastError = err?.message ? String(err.message) : String(err);
      break;
    }

    if (parsedPage.totalReplies !== null) {
      totalReplies = parsedPage.totalReplies;
    }

    if (parsedPage.hasOmittedNested) {
      hasOmittedNested = true;
    }

    // Add unique posts to allPosts up to maxComments budget
    for (const post of parsedPage.posts) {
      if (allPosts.length >= maxComments) {
        hasOmittedNested = true;
        break;
      }
      if (post.id && seenPostIds.has(post.id)) {
        continue;
      }
      if (post.id) {
        seenPostIds.add(post.id);
      }
      allPosts.push(post);
    }

    if (allPosts.length >= maxComments) {
      reachedEnd = false;
      break;
    }

    if (parsedPage.posts.length === 0) {
      if (parsedPage.hasTerminalEvidence) {
        reachedEnd = true;
      }
      break;
    }

    if (parsedPage.isEnd && parsedPage.hasTerminalEvidence) {
      reachedEnd = true;
      cursor = null;
      break;
    }

    // Check repeated cursor: repeated cursor is a partial error
    if (parsedPage.nextCursor !== null) {
      if (seenCursors.has(parsedPage.nextCursor) || parsedPage.nextCursor === cursor) {
        lastError = `Repeated pagination cursor detected: "${parsedPage.nextCursor}"`;
        reachedEnd = false;
        break;
      }
      cursor = parsedPage.nextCursor;
    } else {
      reachedEnd = false;
      break;
    }
  }

  const posts = allPosts.slice(0, maxComments);
  const uniqueIds = new Set(posts.map((p) => p.id).filter((id): id is string => Boolean(id)));

  // Conservative coverage:
  // Not full if only hot sample even end unless actual known totals <= fetched all IDs
  const isHotSample =
    template.includes("hotflow") ||
    template.includes("hot") ||
    template.includes("mode=3");

  const hasKnownFullTotals = totalReplies !== null && totalReplies <= uniqueIds.size;

  let coverage: "partial" | "complete" | "unavailable";
  if (posts.length === 0 && lastError) {
    coverage = "unavailable";
  } else if (
    reachedEnd &&
    !lastError &&
    !hasOmittedNested &&
    hasKnownFullTotals &&
    (!isHotSample || hasKnownFullTotals)
  ) {
    coverage = "complete";
  } else {
    coverage = "partial";
  }

  const authorFollowups = posts.filter((p) => p.isOriginalAuthor);
  const others = posts.filter((p) => !p.isOriginalAuthor);
  const highlightPool = others.length > 0 ? others : posts;
  const highlightedReplies = rankReplies(highlightPool, highlightLimit ?? 6);

  return {
    originalPost: defaultOp,
    authorFollowups,
    highlightedReplies,
    collectedReplies: posts,
    totalReplies, // unknown total never substitutes allPosts.length
    fetchedReplies: posts.length,
    collection: {
      collectedAt,
      coverage,
      provenance: "source_api",
      sourceUrl: firstUrl || template,
      nextCursor: reachedEnd ? null : cursor,
      error: lastError ?? undefined,
    },
  };
}

/**
 * Reusable fetch function for Bilibili comments.
 * Handles numeric oid (aid from view API), bvid, and upMid.
 */
export async function fetchBilibiliComments(params: {
  oid?: number | string | null;
  bvid?: string | null;
  upMid?: number | string | null;
  originalPost?: DiscussionPost;
  sourceConfig: Record<string, any> | null;
  fetchJson?: ((url: string) => Promise<unknown>) | null;
  highlightLimit?: number;
  resumeCursor?: string | null;
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<DiscussionContent | null> {
  const targetId = params.oid ?? (params.bvid ? String(params.bvid) : "");
  return fetchCommunityComments({
    platform: "bilibili",
    targetId,
    bvid: params.bvid ?? null,
    authorId: params.upMid ?? null,
    originalPost: params.originalPost,
    sourceConfig: params.sourceConfig,
    fetchJson: params.fetchJson,
    highlightLimit: params.highlightLimit,
    resumeCursor: params.resumeCursor,
    minIntervalMs: params.minIntervalMs,
    sleep: params.sleep,
  });
}

/**
 * Reusable fetch function for Weibo comments.
 * Exported so coordinator can invoke it on collection for Weibo items.
 */
export async function fetchWeiboComments(params: {
  id: string | number;
  postAuthorId?: number | string | null;
  originalUrl?: string | null;
  originalPost?: DiscussionPost;
  sourceConfig: Record<string, any> | null;
  fetchJson?: ((url: string) => Promise<unknown>) | null;
  highlightLimit?: number;
  resumeCursor?: string | null;
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<DiscussionContent | null> {
  return fetchCommunityComments({
    platform: "weibo",
    targetId: params.id,
    authorId: params.postAuthorId ?? null,
    originalUrl: params.originalUrl ?? null,
    originalPost: params.originalPost,
    sourceConfig: params.sourceConfig,
    fetchJson: params.fetchJson,
    highlightLimit: params.highlightLimit,
    resumeCursor: params.resumeCursor,
    minIntervalMs: params.minIntervalMs,
    sleep: params.sleep,
  });
}

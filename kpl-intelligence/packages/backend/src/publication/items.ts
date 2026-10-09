// Public read layer, item level. Every exit (site API, v1, RSS, MCP, sitemap) reads
// items through these columns and views; which rows are public is decided by scope.ts.
import type { CategoryKey, ChannelKey, SourceGroupKey } from "@aihot/contracts/taxonomy";
import type { ContentView, DiscussionPostView, FeedItemSummary, ItemSummary, MediaView, SiteContentKind, XPostView } from "@aihot/contracts/site";
import { sql, type Db } from "../db.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";
import { displayTags, publicSourceName } from "./rules.ts";
import { seatedCondition } from "./scope.ts";
import { sourceGroupExpression } from './source-groups.ts';

export interface ItemRow {
  id: string;
  title: string;
  original_title: string | null;
  summary: string | null;
  reason: string | null;
  category: string | null;
  tags: string[];
  score: number | null;
  selected: boolean;
  channel: "news" | "x";
  url: string;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  /** Holds its fact's selected seat (publish.ts settleSeats). */
  seat: boolean;
  visibility: string;
  body_mode: "full" | "summary";
  indexable: boolean;
  fact_id: number | null;
  source_name: string;
  source_group?: SourceGroupKey | null;
  /** Participation mode of the source now (editorial, hot_signal, isolated). */
  source_mode: string;
  x_post: Record<string, any> | null;
  author: string | null;
  language: string | null;
  /** 内容类型（CanonicalContent 的 kind）：article 族以外的形态有专属视图。 */
  content_kind: string | null;
  story_public_id: string | null;
  story_title: string | null;
  zh_text: string | null;
  /** Chinese translation of the post an X post quotes. */
  quoted_zh: string | null;
  body_status?: string | null;
  canonical_content?: Record<string, any> | null;
  radar_state?: string | null;
  radar_input_revision?: number | null;
  radar_score_version?: string | null;
  radar_input_evidence_hash?: string | null;
  radar_judgment?: any | null;
  feedback_approved?: boolean | null;
  feedbackApproved?: boolean | null;
}

/** Columns every item listing selects. Internal judgement details never leave this layer. */
export const ITEM_COLUMNS = sql`
  p.article_id AS id, p.title, p.original_title, p.summary, p.reason, p.category, p.tags, p.score,
  p.selected, p.seat, p.channel, p.url, p.published_at, p.discovered_at, p.timeline_at, p.visibility,
  p.body_mode, p.indexable, p.fact_id, s.name AS source_name, s.participation_mode AS source_mode, ${sourceGroupExpression} AS source_group,
  a.x_post, a.author, a.language, a.content_kind, a.body_status, a.canonical_content,
  st.public_id::text AS story_public_id, st.title AS story_title,
  CASE WHEN p.channel = 'x' THEN tr.body_text END AS zh_text, qt.text_zh AS quoted_zh`;

/** Public API listings never render article bodies, X media or story metadata. */
export type ApiItemRow = Pick<ItemRow, "id" | "title" | "original_title" | "summary" | "source_name" | "url" | "published_at" | "discovered_at" | "category" | "score" | "selected" | "reason">;
/** `selected` is the machine meaning: the report holds its fact's selected seat (scope.ts seatedCondition). */
export const API_ITEM_COLUMNS = sql`
  p.article_id AS id, p.title, p.original_title, p.summary, s.name AS source_name, p.url,
  p.published_at, p.discovered_at, p.category, p.score, (p.selected AND p.seat) AS selected, p.reason`;
export const API_ITEM_FROM = sql`FROM publications p JOIN sources s ON s.id = p.source_id`;

/** A translation of an older revision is left out: the original changed after it (the worker translates it again). */
export const ITEM_FROM = sql`
  FROM publications p
  JOIN sources s ON s.id = p.source_id
  JOIN articles a ON a.id = p.article_id
  LEFT JOIN stories st ON st.id = p.story_id AND st.merged_into IS NULL
  LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh' AND tr.revision >= a.revision
  LEFT JOIN quote_translations qt ON p.channel = 'x' AND qt.tweet_id = substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)')`;

export function channelCondition(channel: ChannelKey | null | undefined) {
  if (!channel || channel === "all") return sql``;
  if (channel === "firstParty") return sql`AND p.source_id IN (SELECT id FROM sources WHERE tier = 'T1')`;
  return sql`AND p.channel = ${channel}`;
}

export function categoryCondition(category: CategoryKey | null | undefined, v1 = false) {
  void v1;
  if (!category) return sql``;
  return sql`AND p.category = ${category}`;
}

export function tagCondition(tag: string | null | undefined) {
  if (!tag) return sql``;
  return sql`AND p.tags @> ${[tag]}::text[]`;
}

function mediaView(m: Record<string, any>, mode: "card" | "thumb" | "full" = "thumb", responsive = false): MediaView | null {
  const url = proxiedImage(m.url, mode);
  if (!url) return null;
  const srcSet = responsive ? proxiedImageSet(m.poster ?? m.url, mode === "full" ? "body" : "card") : null;
  return {
    kind: m.kind === "video" ? "video" : "image",
    url,
    ...(responsive && mode !== "full" ? { fullUrl: proxiedImage(m.url, "full")! } : {}),
    ...(srcSet ? { srcSet } : {}),
    width: typeof m.width === "number" ? m.width : null,
    height: typeof m.height === "number" ? m.height : null,
    alt: m.alt ?? null,
    poster: m.poster ? proxiedImage(m.poster, mode === "card" ? "card" : "thumb") : null,
  };
}

export function xView(row: Pick<ItemRow, "x_post" | "zh_text"> & Partial<Pick<ItemRow, "quoted_zh">>, compact = false, responsive = compact): XPostView | null {
  const x = row.x_post;
  if (!x) return null;
  const quoted = x.quoted && typeof x.quoted === "object"
    ? {
      authorName: String(x.quoted.authorName ?? ""), handle: String(x.quoted.handle ?? ""), text: String(x.quoted.text ?? ""), url: String(x.quoted.url ?? ""),
      translation: row.quoted_zh && row.quoted_zh.trim() !== String(x.quoted.text ?? "").trim() ? row.quoted_zh : null,
    }
    : null;
  const media = ((x.media ?? []) as Array<Record<string, any>>)
    .map((raw) => ({ raw, view: mediaView(raw, compact || !responsive ? "thumb" : "full", responsive) }))
    .filter((entry): entry is { raw: Record<string, any>; view: MediaView } => entry.view !== null);
  const avatarSrcSet = responsive ? proxiedImageSet(x.avatarUrl, "avatar") : null;
  return {
    authorName: String(x.authorName ?? x.handle ?? ""),
    handle: String(x.handle ?? ""),
    avatarUrl: proxiedImage(x.avatarUrl, "avatar"),
    ...(avatarSrcSet ? { avatarSrcSet } : {}),
    text: String(x.text ?? ""),
    translation: row.zh_text && row.zh_text.trim() !== String(x.text ?? "").trim() ? row.zh_text : null,
    quoted,
    // A multi-image list grid is 112 CSS px wide; one image can be 240 px. Keep 3x pixels for both.
    // Detail retains full media for the lightbox; srcSet bounds the displayed image.
    media: media.map(({ raw, view }) => compact && media.length > 1 ? mediaView(raw, "card", responsive)! : view),
  };
}

/** The shared public article; its X post is added as each answer shows it. */
export function toItemSummary(row: ItemRow): ItemSummary {
  return {
    id: row.id,
    title: row.title,
    originalTitle: row.original_title,
    summary: row.summary,
    reason: row.selected ? row.reason : null,
    source: { name: publicSourceName(row.source_name), ...(row.source_group ? { group: row.source_group } : {}) },
    links: { original: row.url },
    publishedAt: row.published_at?.toISOString() ?? null,
    discoveredAt: row.discovered_at.toISOString(),
    timelineAt: row.timeline_at.toISOString(),
    category: (row.category as CategoryKey | null) ?? null,
    tags: displayTags(row.tags),
    score: row.score === null ? null : Math.round(Number(row.score)),
    selected: row.selected,
    channel: row.channel,
    story: row.story_public_id ? { publicId: row.story_public_id, title: row.story_title ?? "" } : null,
  };
}

/** Project the shared public article into the exact fields a site card renders. */
export function toFeedItemSummary(row: ItemRow, feedbackApproved?: boolean | unknown): FeedItemSummary {
  const item = toItemSummary(row);
  // An X post's own text and media are its body: shown only where the source allows full text.
  const isFull = row.body_mode === "full" && (!row.body_status || row.body_status === "ok");
  const x = row.channel === "x" && isFull ? xView(row, true) : null;
  const canonical = row.canonical_content;
  const replies = canonical?.discussion?.highlightedReplies;
  const firstReply = Array.isArray(replies) && replies.length > 0 ? replies[0] : null;
  const collection = canonical?.discussion?.collection;
  const hasCollection = Boolean(collection);
  const isApproved = hasCollection
    ? (feedbackApproved !== undefined
        ? Boolean(feedbackApproved)
        : (row.feedback_approved !== undefined
            ? Boolean(row.feedback_approved)
            : (row.feedbackApproved !== undefined
                ? Boolean(row.feedbackApproved)
                : false)))
    : true;
  const commentPreview = isFull && firstReply && isApproved ? postView(firstReply) : null;
  return {
    id: item.id, title: item.title, summary: item.summary, reason: item.reason,
    source: item.source, publishedAt: item.publishedAt, timelineAt: item.timelineAt,
    category: item.category, tags: item.tags, score: item.score, selected: item.selected, channel: item.channel,
    contentKind: contentKindOf(row),
    commentPreview,
    x: x ? {
      authorName: x.authorName, handle: x.handle, avatarUrl: x.avatarUrl,
      ...(x.avatarSrcSet ? { avatarSrcSet: x.avatarSrcSet } : {}), media: x.media,
      quoted: x.quoted ? { authorName: x.quoted.authorName, handle: x.quoted.handle, text: x.quoted.text, translation: x.quoted.translation } : null,
    } : null,
  };
}

/**
 * An article written in Chinese: its language says so, or its text opens in Chinese and it is not marked
 * English (the translator's rule, editorial/translate.ts). Every exit shows such a body as it is.
 */
export function isChineseBody(a: { language?: string | null; body_text?: string | null }): boolean {
  return a.language === "zh" || (/[一-鿿]/.test(a.body_text?.slice(0, 400) ?? "") && a.language !== "en");
}

/** The complete Chinese translation an export (Markdown, full RSS) carries; a page also shows a partial one. */
export function exportTranslation(a: { language?: string | null; body_text?: string | null; tr_html?: string | null; tr_complete?: boolean | null }): string | null {
  return !isChineseBody(a) && a.tr_html && a.tr_complete ? a.tr_html : null;
}

/**
 * For listed rows that are selected but yield their fact's seat: the report holding it, by row id.
 * (The home timeline folds these into reading groups; flat lists say which report stands for them.)
 */
export async function seatHolders(rows: ItemRow[], now: Date, db: Db = sql): Promise<Map<string, { id: string; title: string }>> {
  const yielding = rows.filter((r) => r.selected && !r.seat && r.fact_id !== null);
  if (!yielding.length) return new Map();
  const holders = await db<{ fact_id: number; id: string; title: string }[]>`
    SELECT p.fact_id, p.article_id AS id, p.title FROM publications p
    WHERE p.fact_id IN ${db([...new Set(yielding.map((r) => r.fact_id!))])} AND ${seatedCondition(now)}`;
  const byFact = new Map(holders.map((h) => [Number(h.fact_id), { id: h.id, title: h.title }]));
  return new Map(yielding.flatMap((r) => (byFact.has(Number(r.fact_id)) ? [[r.id, byFact.get(Number(r.fact_id))!] as const] : [])));
}

// ---------------------------------------------------------------------------
// Source-aware content views：canonical 行到站内 content 视图的投影
// ---------------------------------------------------------------------------

/** 行的内容类型：X 帖子恒为 social_post，其余取 content_kind。 */
export function contentKindOf(row: Pick<ItemRow, "channel" | "content_kind">): SiteContentKind | null {
  if (row.channel === "x") return "social_post";
  return (row.content_kind as SiteContentKind | null) ?? null;
}

const ARTICLE_KINDS = new Set<string>(["article", "news", "official_announcement", "interview", "analysis", "unknown"]);

export const postView = (p: Record<string, any>): DiscussionPostView => ({
  id: p.id ?? null,
  author: typeof p.author === "string" ? p.author : (p.author?.name ?? null),
  avatarUrl: p.avatarUrl ?? proxiedImage(p.author?.avatarUrl, "avatar"),
  text: String(p.text ?? ""),
  publishedAt: p.publishedAt ?? null,
  likes: typeof p.likes === "number" ? p.likes : null,
  floor: typeof p.floor === "number" ? p.floor : null,
  isOriginalAuthor: !!p.isOriginalAuthor,
  platform: p.platform ?? null,
  parentCommentId: p.parentCommentId ?? null,
  replyCount: typeof p.replyCount === "number" ? p.replyCount : null,
  originalUrl: p.originalUrl ?? null,
  quote: p.quote?.text ? { author: typeof p.quote.author === "string" ? p.quote.author : (p.quote.author?.name ?? null), text: String(p.quote.text) } : null,
});

/**
 * canonical_content → ContentView：forum/video/social 各有专属结构（原话全部来自真实抓取）；
 * article 族只在正文不完整时携带 quality（完整文章走原有 body 通道，content 为 null）。
 */
export function toContentView(row: ItemRow & {
  canonical_content?: Record<string, any> | null;
  content_quality_score?: number | null;
  content_completeness?: string | null;
  body_status?: string | null;
  radar_state?: string | null;
  radar_input_revision?: number | null;
  radar_score_version?: string | null;
  radar_input_evidence_hash?: string | null;
  radar_judgment?: any | null;
  feedback_approved?: boolean | null;
  feedbackApproved?: boolean | null;
}, feedbackApproved?: boolean): ContentView | null {
  const canonical = row.canonical_content ?? null;
  const kind = canonical?.kind ?? contentKindOf(row);
  if (!kind) return null;

  const isFullAllowed = row.body_mode === "full" && (!row.body_status || row.body_status === "ok");

  const quality = {
    score: canonical?.quality?.score ?? row.content_quality_score ?? null,
    completeness: (!isFullAllowed
      ? ("summary_only" as const)
      : (canonical?.quality?.completeness ?? (row.content_completeness as ContentView["quality"]["completeness"]) ?? null)),
    warnings: Array.isArray(canonical?.quality?.warnings) ? canonical.quality.warnings : [],
  };

  // article 族：正文完整且已授权时不需要专属视图；不完整或未授权时如实携带质量提示（前端显示摘要或正文提示）。
  if (ARTICLE_KINDS.has(kind)) {
    if (isFullAllowed && (quality.completeness === null || quality.completeness === "full")) return null;
    return { kind, quality };
  }

  // 非 article 形态（forum_thread / video_post / social_post）：
  // 若未获得全文授权或正文未确认，不向前端泄露未授权全文数据，仅保留类型与合规摘要状态。
  if (!isFullAllowed) {
    return {
      kind,
      quality,
      community: null,
      video: null,
      social: null,
      gallery: null,
    };
  }

  const content: ContentView = { kind, quality, community: null, video: null, social: null, gallery: null };
  const discussion = canonical?.discussion;

  const hasCollection = Boolean(discussion?.collection);
  const isApproved = hasCollection
    ? (feedbackApproved !== undefined
        ? feedbackApproved
        : (row.feedback_approved !== undefined
            ? Boolean(row.feedback_approved)
            : (row.feedbackApproved !== undefined
                ? Boolean(row.feedbackApproved)
                : false)))
    : true;

  const buildCommunity = (d: Record<string, any>): NonNullable<ContentView["community"]> => {
    const op = d.originalPost ? postView(d.originalPost) : {
      id: null,
      author: null,
      avatarUrl: null,
      text: "",
      publishedAt: null,
      likes: null,
      floor: null,
      isOriginalAuthor: false,
      quote: null,
    };

    if (hasCollection && !isApproved) {
      return {
        originalPost: op,
        authorFollowups: [],
        highlightedReplies: [],
        totalReplies: typeof d.totalReplies === "number" ? d.totalReplies : null,
        fetchedReplies: typeof d.fetchedReplies === "number" ? d.fetchedReplies : null,
        collection: {
          collectedAt: "",
          coverage: "unavailable",
          sourceUrl: d.collection?.sourceUrl ?? null,
          provenance: d.collection?.provenance ?? null,
          nextCursor: null,
          error: d.collection?.error ?? "pendingSafetyReview",
        },
        communitySummary: null,
      };
    }

    return {
      originalPost: op,
      authorFollowups: (d.authorFollowups ?? []).map(postView),
      highlightedReplies: (d.highlightedReplies ?? []).map(postView),
      totalReplies: typeof d.totalReplies === "number" ? d.totalReplies : null,
      fetchedReplies: typeof d.fetchedReplies === "number" ? d.fetchedReplies : null,
      collection: d.collection ? {
        collectedAt: d.collection.collectedAt,
        coverage: d.collection.coverage,
        sourceUrl: d.collection.sourceUrl ?? null,
        provenance: d.collection.provenance ?? null,
        nextCursor: d.collection.nextCursor ?? null,
        error: d.collection.error ?? null,
      } : null,
      communitySummary: d.communitySummary ?? null,
    };
  };

  if (kind === "forum_thread" && discussion) {
    content.community = buildCommunity(discussion);
    content.gallery = ((canonical?.media ?? []) as Array<Record<string, any>>)
      .map((m) => mediaView({ kind: "image", ...m }, "full", true))
      .filter((m): m is MediaView => m !== null);
  }
  if (kind === "video_post" && canonical?.video) {
    const coverUrl = proxiedImage(canonical.video.cover, "full");
    content.video = {
      description: canonical.video.description ?? null,
      cover: coverUrl ? { url: coverUrl, width: null, height: null } : null,
      durationSeconds: typeof canonical.video.durationSeconds === "number" ? canonical.video.durationSeconds : null,
      views: canonical.engagement?.views ?? null,
      likes: canonical.engagement?.likes ?? null,
      comments: canonical.engagement?.comments ?? null,
      favorites: canonical.engagement?.favorites ?? null,
      shares: canonical.engagement?.shares ?? null,
      coins: canonical.engagement?.coins ?? null,
      danmaku: canonical.engagement?.danmaku ?? null,
      transcriptSummary: canonical.video.transcriptSummary ?? null,
    };
    if (discussion) {
      content.community = buildCommunity(discussion);
    }
  }
  if (kind === "social_post" && canonical?.social && row.channel !== "x") {
    content.social = {
      postText: String(canonical.social.postText ?? ""),
      quoted: canonical.social.quoted?.text ? { author: canonical.social.quoted.author ?? null, text: String(canonical.social.quoted.text) } : null,
      views: canonical.engagement?.views ?? null,
      likes: canonical.engagement?.likes ?? null,
      comments: canonical.engagement?.comments ?? null,
      shares: canonical.engagement?.shares ?? null,
      favorites: canonical.engagement?.favorites ?? null,
    };
    if (discussion) {
      content.community = buildCommunity(discussion);
    }
  }
  return content;
}

// CanonicalContent：一切来源抓取后的统一中间层，正文的结构化真源。
// body_html / body_text 由它派生（content/canonical.ts），不再是独立的真源。
// 硬约束：main/discussion 里的所有"原话"只能来自真实抓取内容；AI 只能写 summary 类字段。

export type ContentKind =
  | "article"
  | "news"
  | "official_announcement"
  | "forum_thread"
  | "social_post"
  | "video_post"
  | "interview"
  | "analysis"
  | "unknown";

export const CONTENT_KINDS: ContentKind[] = [
  "article", "news", "official_announcement", "forum_thread", "social_post", "video_post", "interview", "analysis", "unknown",
];

// ---------------------------------------------------------------------------
// Content blocks：正文的构成单元
// ---------------------------------------------------------------------------

export interface ParagraphBlock {
  type: "paragraph";
  text: string;
}

export interface HeadingBlock {
  type: "heading";
  level: number;
  text: string;
}

export interface QuoteBlock {
  type: "quote";
  text: string;
  attribution?: string | null;
}

export interface ImageBlock {
  type: "image";
  url: string;
  caption?: string | null;
  alt?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface GalleryBlock {
  type: "gallery";
  images: ImageBlock[];
}

export interface ListBlock {
  type: "list";
  ordered: boolean;
  items: string[];
}

export interface TableBlock {
  type: "table";
  rows: string[][];
}

export interface VideoBlock {
  type: "video";
  url: string;
  poster?: string | null;
}

export type ContentBlock =
  | ParagraphBlock
  | HeadingBlock
  | QuoteBlock
  | ImageBlock
  | GalleryBlock
  | ListBlock
  | TableBlock
  | VideoBlock;

/** 图片角色：只有 content_image 进入正文 gallery。 */
export type ImageRole = "content_image" | "cover" | "avatar" | "emoji" | "icon" | "qr_code" | "advertisement" | "tracking_pixel";

// ---------------------------------------------------------------------------
// Discussion：论坛/社区的统一结构（虎扑只是它的一个 adapter）
// ---------------------------------------------------------------------------

export interface DiscussionAuthor {
  name: string | null;
  avatarUrl?: string | null;
}

export interface DiscussionPost {
  id: string | null;
  author: DiscussionAuthor;
  text: string;
  html?: string | null;
  publishedAt?: string | null;
  likes?: number | null;
  /** 楼层号（论坛从 1 开始；主帖为 0 时可空）。 */
  floor?: number | null;
  isOriginalAuthor: boolean;
  quote?: {
    author?: string | null;
    text: string;
  } | null;
}

export interface DiscussionContent {
  originalPost: DiscussionPost;
  /** 楼主在同一帖内的追加（满足"楼主补充"独立呈现）。 */
  authorFollowups: DiscussionPost[];
  /** 按 Comment Ranking 选出的高价值回复，默认 5～10 条。 */
  highlightedReplies: DiscussionPost[];
  totalReplies: number | null;
  /** AI 整理的社区讨论焦点（唯一允许 AI 生成的讨论字段）。 */
  communitySummary?: string | null;
}

// ---------------------------------------------------------------------------
// Video / Social 的专属视图
// ---------------------------------------------------------------------------

export interface VideoContent {
  /** 视频简介——永远不冒充正文。 */
  description: string | null;
  cover: string | null;
  durationSeconds: number | null;
  /** 已有字幕/transcript 时才有：没有就禁止根据标题简介推断视频内容。 */
  transcriptSummary?: string | null;
  chapters?: Array<{ at: string; text: string }> | null;
}

export interface SocialContent {
  postText: string;
  quoted?: { author: string | null; handle?: string | null; text: string } | null;
}

// ---------------------------------------------------------------------------
// Engagement / quality / extraction provenance
// ---------------------------------------------------------------------------

export interface Engagement {
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  favorites?: number | null;
}

export type ContentCompleteness = "full" | "partial" | "summary_only" | "failed";

export interface ContentQuality {
  score: number;
  completeness: ContentCompleteness;
  warnings: string[];
}

export type SourceAuthority = "official" | "publisher" | "caster" | "analyst" | "community" | "user_comment";

export type BodyProvenance = "source_api" | "page_dom" | "readability" | "jina" | "feed" | "manual";

export interface ExtractionMeta {
  extractor: string;
  version: string;
  sourceId: string | null;
  sourceFamily: string;
  fallbackUsed: boolean;
  bodyProvenance: BodyProvenance;
  sourceAuthority: SourceAuthority | null;
  rawHash?: string | null;
  canonicalHash?: string | null;
}

// ---------------------------------------------------------------------------
// CanonicalContent
// ---------------------------------------------------------------------------

export interface CanonicalAuthor {
  name: string | null;
  avatarUrl?: string | null;
  profileUrl?: string | null;
  role?: string | null;
}

export interface CanonicalContent {
  kind: ContentKind;
  title: string | null;
  author: CanonicalAuthor | null;
  publishedAt: string | null;
  /** 导语：短摘要式第一段（真实原文，不来自 AI）。 */
  lead: string | null;
  /** 正文主体（article/news/announcement/interview）；forum/social/video 时为空或极短。 */
  main: ContentBlock[];
  media: ImageBlock[];
  /** article 族的富 HTML 源（净化后的原始排版，含链接/加粗/表格）；body_html 优先由它派生。 */
  bodyHtmlSource?: string | null;
  discussion: DiscussionContent | null;
  video: VideoContent | null;
  social: SocialContent | null;
  engagement: Engagement | null;
  extraction: ExtractionMeta;
  quality: ContentQuality;
}

/** 正文的可检索文本（AI 输入、全文搜索、body_text 的共同上游）。 */
export function canonicalSearchText(c: CanonicalContent): string {
  const parts: string[] = [];
  if (c.lead) parts.push(c.lead);
  for (const b of c.main) {
    if (b.type === "paragraph" || b.type === "quote" || b.type === "heading") parts.push(b.text);
    else if (b.type === "list") parts.push(b.items.join("\n"));
    else if (b.type === "table") parts.push(b.rows.map((r) => r.join(" ")).join("\n"));
  }
  if (c.discussion) {
    parts.push(c.discussion.originalPost.text);
    for (const p of [...c.discussion.authorFollowups, ...c.discussion.highlightedReplies]) parts.push(p.text);
  }
  if (c.social) {
    parts.push(c.social.postText);
    if (c.social.quoted?.text) parts.push(c.social.quoted.text);
  }
  if (c.video?.description) parts.push(c.video.description);
  return parts.filter((p) => p && p.trim()).join("\n\n");
}

/** 主文本长度（段落字数 + 讨论原帖），供质量引擎与派生逻辑使用。 */
export function canonicalMainLength(c: CanonicalContent): number {
  if (c.discussion) return c.discussion.originalPost.text.length + c.discussion.authorFollowups.reduce((n, p) => n + p.text.length, 0);
  if (c.social) return c.social.postText.length;
  if (c.video) return c.video.description?.length ?? 0;
  return c.main.reduce((n, b) => {
    if (b.type === "paragraph" || b.type === "quote" || b.type === "heading") return n + b.text.length;
    if (b.type === "list") return n + b.items.join("").length;
    return n;
  }, 0);
}

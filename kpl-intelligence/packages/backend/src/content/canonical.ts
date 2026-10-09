// CanonicalContent → 兼容字段（body_html / body_text / media）的派生层。
// body_html 是 CanonicalContent 的派生产物，不是真源；body_text 由 searchable text 生成。
import type { CanonicalContent, DiscussionContent } from "./extractors/types.ts";
import { canonicalSearchText } from "./extractors/types.ts";
import { blocksToHtml } from "./extractors/html-blocks.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { sha256 } from "../lib/ids.ts";
import { sanitizeBody } from "./sanitize.ts";

export interface DerivedBody {
  html: string;
  text: string;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
}

/**
 * 派生规则：文章族 → blocks HTML（正文即 blocks）；forum → 主帖 + 楼主补充 + 高亮回复的文本流
 * （body_text 供 AI/搜索，前端展示走 canonical.discussion，不用这段 HTML）；video → 简介文本；
 * social → post text。
 */
export function canonicalToBody(c: CanonicalContent): DerivedBody {
  if (typeof c.bodyHtmlSource === "string") {
    c.bodyHtmlSource = sanitizeBody(c.bodyHtmlSource);
  }

  const images = c.media.map((m) => ({ kind: "image" as const, url: m.url, width: m.width ?? null, height: m.height ?? null }));
  if (c.discussion) {
    const d = c.discussion;
    const htmlParts: string[] = [];
    htmlParts.push(`<p>${escapeHtml(d.originalPost.text).replace(/\n/g, "<br>")}</p>`);
    for (const f of d.authorFollowups) htmlParts.push(`<p>【楼主补充】${escapeHtml(f.text).replace(/\n/g, "<br>")}</p>`);
    const textParts: string[] = [d.originalPost.text, ...d.authorFollowups.map((f) => `【楼主补充】${f.text}`)];
    if (d.highlightedReplies.length) {
      htmlParts.push(`<p>【社区讨论】</p>`);
      textParts.push("【社区讨论】");
      for (const r of d.highlightedReplies) {
        htmlParts.push(`<p>@${escapeHtml(r.author.name ?? "网友")}：${escapeHtml(r.text).replace(/\n/g, "<br>")}</p>`);
        textParts.push(`@${r.author.name ?? "网友"}：${r.text}`);
      }
    }
    return { html: sanitizeBody(htmlParts.join("")), text: textParts.join("\n\n"), images };
  }
  if (c.social) {
    const text = c.social.quoted?.text ? `${c.social.postText}\n\n[引用]：${c.social.quoted.text}` : c.social.postText;
    return { html: sanitizeBody(`<p>${escapeHtml(c.social.postText).replace(/\n/g, "<br>")}</p>`), text, images };
  }
  if (c.video) {
    const text = c.video.description ?? "";
    return { html: text ? sanitizeBody(`<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`) : "", text, images };
  }
  // 文章族：body_text 只来自正文块（lead 是页面 meta 的导语，属于摘要，不属于正文），
  // 块间以空白合并（与旧 stripTags 的单空格输出一致）；body_html 优先用 extractor 的净化富 HTML
  // （保住链接/加粗/图片排版），没有时才从 blocks 降级重建。所有落库 HTML 必须经过 sanitizeBody 清洗。
  const text = collapseWhitespace(c.main.reduce((n, b) => {
    if (b.type === "paragraph" || b.type === "quote" || b.type === "heading") return `${n}\n${b.text}`;
    if (b.type === "list") return `${n}\n${b.items.join("\n")}`;
    if (b.type === "table") return `${n}\n${b.rows.map((r) => r.join(" ")).join("\n")}`;
    return n;
  }, ""));
  const rawHtml = c.bodyHtmlSource ?? blocksToHtml(c.main);
  return { html: sanitizeBody(rawHtml), text, images };
}

/** Fact analysis and article RAG read only the original, never replies (even by the OP).
 * Missing original content stays empty; never fall back to a flattened comment-bearing body.
 * Radar deliberately uses canonicalEvidenceText instead.
 */
export function canonicalOriginalText(c: CanonicalContent): string {
  if (c.social) {
    const text = typeof c.social.postText === "string" ? c.social.postText : "";
    const quote = c.social.quoted?.text;
    return typeof quote === "string" && quote ? `${text}\n\n[引用]：${quote}` : text;
  }
  if (c.video) return typeof c.video.description === "string" ? c.video.description : "";
  if (c.discussion) return typeof c.discussion.originalPost?.text === "string" ? c.discussion.originalPost.text : "";
  return Array.isArray(c.main) ? canonicalIdentityText(c) : "";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 正文核心主体身份文本（专供主体哈希与版本判重，排除了社区高亮回复与评论流）。
 * 优先级：social / video 优先于 discussion（主帖正文）；文章族回退到 main blocks。
 * 评论刷新或点赞计数变动不改变主体哈希，从而避免触发昂贵的付费 AI 分析。
 */
export function canonicalIdentityText(c: CanonicalContent): string {
  if (c.social) {
    return c.social.quoted?.text
      ? `${c.social.postText}\n\n[引用]：${c.social.quoted.text}`
      : c.social.postText;
  }
  if (c.video) {
    return c.video.description ?? "";
  }
  if (c.discussion) {
    const d = c.discussion;
    const parts = [
      d.originalPost.text,
      ...d.authorFollowups.map((f) => `【楼主补充】${f.text}`),
    ].filter(Boolean);
    return parts.join("\n\n");
  }
  return collapseWhitespace(c.main.reduce((n, b) => {
    if (b.type === "paragraph" || b.type === "quote" || b.type === "heading") return `${n}\n${b.text}`;
    if (b.type === "list") return `${n}\n${b.items.join("\n")}`;
    if (b.type === "table") return `${n}\n${b.rows.map((r) => r.join(" ")).join("\n")}`;
    return n;
  }, ""));
}

/**
 * 完整证据链文本（包含社区高亮回复与评论流，供 AI 分析输入与证据检索使用）。
 */
export function canonicalEvidenceText(c: CanonicalContent): string {
  return canonicalSearchText(c);
}

/**
 * 证据哈希：统一中央实现。独立于主体身份哈希。
 * 支持传入 CanonicalContent、包装对象 { canonical_content }、或回退 plain-body。
 * 评论/原话变动时证据哈希改变，计数变动时不改变证据哈希。
 */
export function canonicalEvidenceHash(
  canonical?: CanonicalContent | Record<string, any> | null,
  fallback?: { title?: string | null; bodyText?: string | null; excerpt?: string | null; body_text?: string | null } | string | null,
): string {
  if (canonical && typeof canonical === "object") {
    const actualCanonical = "canonical_content" in canonical
      ? (canonical.canonical_content as CanonicalContent | null)
      : (canonical as CanonicalContent);
    if (actualCanonical && typeof actualCanonical === "object") {
      const text = canonicalEvidenceText(actualCanonical);
      if (text && text.trim().length > 0) {
        return sha256(collapseWhitespace(text));
      }
    }
    // 兼容可能传入的 plain-body guessed 结构
    if ("title" in canonical || "body_text" in canonical || "bodyText" in canonical) {
      const title = (canonical as any).title ?? "";
      const body = (canonical as any).body_text ?? (canonical as any).bodyText ?? (canonical as any).excerpt ?? "";
      const combined = [title, body].filter(Boolean).join("\n");
      if (combined.trim().length > 0) {
        return sha256(collapseWhitespace(combined));
      }
    }
  }

  const fallbackStr = typeof fallback === "string"
    ? fallback
    : [fallback?.title, fallback?.bodyText ?? fallback?.body_text ?? fallback?.excerpt ?? ""].filter(Boolean).join("\n");
  return sha256(collapseWhitespace(fallbackStr || ""));
}

export interface RefreshDiscussionResult {
  discussion: DiscussionContent | null;
  clearedSummary: boolean;
  preservedPrevious: boolean;
}

/**
 * 刷新社区讨论数据：
 * 1. 刷新失败时（例如 coverage === "unavailable" 或 error 存在且回复为空），保留原先已采集的回帖与摘要，
 *    但如实记录本次失败状态（coverage 为 unavailable，记录 error，严禁误将旧缓存当成功）。
 * 2. 刷新成功时，对比高亮回帖的实际文本。若文本发生实质变动，清空已过期的 AI communitySummary；
 *    若回帖文本完全未变（仅赞数/计数变动），保留原 AI communitySummary。
 */
export function refreshCanonicalDiscussion(
  existing: CanonicalContent | null | undefined,
  incoming: CanonicalContent,
): RefreshDiscussionResult {
  const existingDiscussion = existing?.discussion ?? null;
  const incomingDiscussion = incoming.discussion ?? null;

  // 1. 判断 incoming 是否属于刷新失败 (failed refresh)
  const incomingFailed = !incomingDiscussion ||
    incomingDiscussion.collection?.coverage === "unavailable" ||
    Boolean(incomingDiscussion.collection?.error && (!incomingDiscussion.highlightedReplies || incomingDiscussion.highlightedReplies.length === 0));

  if (incomingFailed) {
    if (!existingDiscussion) {
      return { discussion: incomingDiscussion, clearedSummary: false, preservedPrevious: false };
    }
    // 保护既往抓取资产，但真实记录本次抓取失败（严禁 cache as success）
    const failedCollection: DiscussionContent["collection"] = {
      collectedAt: incomingDiscussion?.collection?.collectedAt ?? new Date().toISOString(),
      coverage: "unavailable",
      provenance: incomingDiscussion?.collection?.provenance ?? existingDiscussion.collection?.provenance ?? "source_api",
      sourceUrl: incomingDiscussion?.collection?.sourceUrl ?? existingDiscussion.collection?.sourceUrl ?? "",
      error: incomingDiscussion?.collection?.error ?? "refresh failed",
      nextCursor: incomingDiscussion?.collection?.nextCursor ?? existingDiscussion.collection?.nextCursor ?? null,
    };

    const preservedDiscussion: DiscussionContent = {
      ...existingDiscussion,
      totalReplies: incomingDiscussion?.totalReplies ?? existingDiscussion.totalReplies,
      collection: failedCollection,
    };

    return {
      discussion: preservedDiscussion,
      clearedSummary: false,
      preservedPrevious: true,
    };
  }

  // 2. 刷新成功：比较实际评论文本是否发生变动
  const oldReplies = existingDiscussion?.highlightedReplies ?? [];
  const newReplies = incomingDiscussion.highlightedReplies ?? [];

  const oldTexts = oldReplies.map((r) => r.text);
  const newTexts = newReplies.map((r) => r.text);

  const commentTextsChanged = oldTexts.length !== newTexts.length || oldTexts.some((t, i) => t !== newTexts[i]);

  let communitySummary: string | null = null;
  let clearedSummary = false;

  if (commentTextsChanged) {
    // 评论内容发生变动：AI 总结失效，必须清空
    communitySummary = null;
    clearedSummary = Boolean(existingDiscussion?.communitySummary);
  } else {
    // 评论文本未变（仅点赞/评论数刷新）：保留现有有效 AI 总结
    communitySummary = existingDiscussion?.communitySummary ?? incomingDiscussion.communitySummary ?? null;
  }

  const refreshedDiscussion: DiscussionContent = {
    ...incomingDiscussion,
    communitySummary,
  };

  return {
    discussion: refreshedDiscussion,
    clearedSummary,
    preservedPrevious: false,
  };
}

/**
 * 在保持主身份哈希不变的前提下合并刷新 CanonicalContent：
 * 刷新 discussion 与 engagement，不破坏主体 kind 与 main blocks。
 */
export function mergeCanonicalForRefresh(
  existing: CanonicalContent | null | undefined,
  incoming: CanonicalContent,
): { canonical: CanonicalContent; clearedSummary: boolean; preservedPrevious: boolean } {
  const { discussion, clearedSummary, preservedPrevious } = refreshCanonicalDiscussion(existing, incoming);
  const canonical: CanonicalContent = {
    ...incoming,
    discussion,
    engagement: incoming.engagement ?? existing?.engagement ?? null,
  };
  return { canonical, clearedSummary, preservedPrevious };
}

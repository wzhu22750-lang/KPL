// CanonicalContent → 兼容字段（body_html / body_text / media）的派生层。
// body_html 是 CanonicalContent 的派生产物，不是真源；body_text 由 searchable text 生成。
import type { CanonicalContent } from "./extractors/types.ts";
import { blocksToHtml } from "./extractors/html-blocks.ts";
import { collapseWhitespace } from "../lib/text.ts";
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

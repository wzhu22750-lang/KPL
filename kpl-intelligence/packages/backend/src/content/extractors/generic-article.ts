// Generic article extractor：没有专用 adapter 的页面也能稳。
// 链条：JSON-LD articleBody → 语义候选评分（text/link 密度、段落、heading 邻近、class/id 提示）
// → Readability（降级为兜底，不再是核心）。Jina 由 extract.ts 在全部失败后兜底。
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { sanitizeBody, trimTrailingChrome } from "../sanitize.ts";
import { htmlToBlocks } from "./html-blocks.ts";
import { collectBy, jsonLdBlocks, ldPublished, metaContent, textOfJsonLd, type ExtractionInput, type ContentExtractor } from "./base.ts";
import type { CanonicalContent } from "./types.ts";

const ARTICLE_LD = (o: Record<string, unknown>) =>
  /Article|NewsArticle|Report|BlogPosting|SocialMediaPosting/.test(String(o["@type"] ?? ""));

function ldArticleOf(html: string): Record<string, unknown> | null {
  for (const block of jsonLdBlocks(html)) {
    const found = collectBy(block, ARTICLE_LD);
    if (found.length) return found[0]!;
  }
  return null;
}

/** 语义候选：常见正文容器按"密度分"挑最好的一个。 */
const CANDIDATE_HINTS = /(?:article|content|main|post|body|text|rich|detail|news)/i;
const CANDIDATE_NEGATIVE = /(?:comment|sidebar|footer|header|nav|menu|related|recommend|list|share|subscribe)/i;

function semanticCandidate(html: string): string | null {
  const { document } = parseHTML(html);
  const nodes = [...document.querySelectorAll("article, [itemprop='articleBody'], main, [class], [id]")];
  let best: { el: any; score: number } | null = null;
  for (const node of nodes) {
    const el = node as any;
    if (!el || typeof el.querySelectorAll !== "function") continue;
    const label = `${el.getAttribute?.("class") ?? ""} ${el.getAttribute?.("id") ?? ""} ${el.getAttribute?.("itemprop") ?? ""} ${el.tagName?.toLowerCase() ?? ""}`;
    if (CANDIDATE_NEGATIVE.test(label)) continue;
    const text = el.textContent ?? "";
    const paragraphs = el.querySelectorAll("p").length;
    if (text.trim().length < 300 && paragraphs < 3) continue;
    let score = 0;
    score += Math.min(60, text.length / 100);
    score += Math.min(30, paragraphs * 2);
    // 链接密度低加分（导航的特征是短文本多链接）
    const links = el.querySelectorAll("a").length;
    const linkDensity = text.length > 0 ? links * 60 / text.length : 1;
    score -= Math.min(30, linkDensity * 30);
    if (/article|articleBody/.test(label)) score += 25;
    if (CANDIDATE_HINTS.test(label)) score += 12;
    // heading 邻近：正文容器里通常有 h2/h3
    if (el.querySelector("h2, h3")) score += 8;
    // DOM 深度越浅越像整页容器（body 直接塞所有内容的反例已在 negative 过滤）
    if (!best || score > best.score) best = { el, score };
  }
  const winner = best && best.score >= 24 ? best.el.innerHTML : null;
  return winner && winner.replace(/\s+/g, " ").length > 200 ? winner : null;
}

/** 页面 <title>，去掉站点名后缀（"标题 - 站点"、"标题 | 站点"、"标题_站点"）。 */
function docTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return null;
  const t = m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const cleaned = t.split(/\s+[-_|—–]\s+/)[0]!.trim();
  return cleaned.length >= 4 ? cleaned : t.trim() || null;
}

function readabilityBody(html: string, url: string): string | null {
  const { document } = parseHTML(html);
  try {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  } catch {
    // no head
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: 120, keepClasses: false }).parse();
  if (!article?.content) return null;
  return article.content;
}

export const genericArticleExtractor: ContentExtractor = {
  id: "generic-article",
  version: "1.0.0",

  canHandle(input: ExtractionInput): boolean {
    // 家族兜底：article/news/official/unknown 都按文章语义处理；论坛/视频/社交有专属 extractor。
    return !["forum", "video", "social"].includes(input.profile.contentFamily);
  },

  async extract(input: ExtractionInput): Promise<CanonicalContent | null> {
    const html = input.html;
    if (!html) return null;

    // 1) JSON-LD：headline/articleBody/datePublished/author（页面自带结构化数据优先）。
    const ld = ldArticleOf(html);
    const ldBody = ld ? textOfJsonLd(ld.articleBody) : null;
    const ldTitle = ld ? textOfJsonLd(ld.headline) : null;
    const publishedAt = ldPublished(ld) ?? metaContent(html, "article:published_time") ?? input.publishedAt?.toISOString() ?? null;

    // 2) 语义候选评分；3) Readability 兜底。
    let bodyHtml: string | null = null;
    let provenance: "page_dom" | "readability" = "page_dom";
    let fallbackUsed = false;
    const candidate = semanticCandidate(html);
    if (candidate) {
      bodyHtml = candidate;
    } else {
      const readability = readabilityBody(html, input.url);
      if (!readability) return null;
      bodyHtml = readability;
      provenance = "readability";
      fallbackUsed = true;
    }

    const cleaned = trimTrailingChrome(sanitizeBody(bodyHtml, input.url));
    const { blocks, media } = htmlToBlocks(cleaned, input.url);
    if (!blocks.length) return null;
    // 正文长度门槛（老 readable() 的守门搬到这里）：一句话的页面不是文章，宁可 unconfirmed。
    const bodyText = blocks.reduce((n, b) => (b.type === "paragraph" || b.type === "quote" || b.type === "heading" ? n + b.text.length : n), 0);
    if (bodyText < 120) return null;

    const title = ldTitle ?? metaContent(html, "og:title") ?? input.title ?? docTitle(html);
    const authorName = (ld ? textOfJsonLd(ld.author) : null) ?? input.author;
    const lead = metaContent(html, "description") ?? blocks.find((b): b is Extract<typeof b, { type: "paragraph" }> => b.type === "paragraph")?.text ?? null;

    const content: CanonicalContent = {
      kind: "article",
      title: title ?? null,
      author: authorName ? { name: authorName } : null,
      publishedAt,
      lead,
      main: blocks,
      media,
      bodyHtmlSource: cleaned,
      discussion: null,
      video: null,
      social: null,
      engagement: null,
      extraction: {
        extractor: "generic-article",
        version: "1.0.0",
        sourceId: input.sourceId,
        sourceFamily: input.profile.contentFamily,
        fallbackUsed,
        bodyProvenance: ldBody && !candidate ? "source_api" : provenance,
        sourceAuthority: input.profile.contentFamily === "official" ? "official" : "publisher",
      },
      quality: { score: 0, completeness: bodyText >= 200 ? "full" : "partial", warnings: [] },
    };
    return content;
  },
};

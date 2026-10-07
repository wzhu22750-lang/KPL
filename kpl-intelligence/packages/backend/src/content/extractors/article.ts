// 已持有正文 HTML 的通道（RSS content:encoded、微信公众号服务商正文）共用的 canonical 构造器。
// 不重新抓页面：把手里净化的 HTML 直接块化，并如实标注 provenance（feed / source_api）。
import { collapseWhitespace } from "../../lib/text.ts";
import { htmlToBlocks } from "./html-blocks.ts";
import { evaluateContentQuality } from "./quality.ts";
import { detectContentKind } from "./base.ts";
import type { CanonicalContent, ContentKind } from "./types.ts";
import type { SourceContentProfile } from "./profiles.ts";
import type { SourceAuthority } from "./types.ts";

export interface ArticleSourceInput {
  url: string;
  html: string;
  text: string;
  title: string | null;
  author: string | null;
  excerpt: string | null;
  publishedAt: Date | null;
  sourceId: string | null;
  profile: SourceContentProfile;
  extractor: string;
  /** feed：RSS 自带正文；source_api：服务商正文接口；page_dom：网页 DOM。 */
  bodyProvenance: "feed" | "source_api" | "page_dom";
  sourceAuthority?: SourceAuthority | null;
}

/** 从已有正文 HTML 构造 article canonical（含 kind 精化与质量评估）。 */
export function articleCanonicalFromHtml(input: ArticleSourceInput): CanonicalContent | null {
  const { blocks, media } = htmlToBlocks(input.html, input.url);
  if (!blocks.length) return null;
  const mainText = collapseWhitespace(blocks.reduce((n, b) => {
    if (b.type === "paragraph" || b.type === "quote" || b.type === "heading") return `${n}\n${b.text}`;
    if (b.type === "list") return `${n}\n${b.items.join("\n")}`;
    return n;
  }, ""));
  if (mainText.length < 80) return null;
  const lead = blocks.find((b): b is Extract<typeof b, { type: "paragraph" }> => b.type === "paragraph")?.text ?? input.excerpt;
  const detected = detectContentKind({ profile: input.profile, title: input.title, text: mainText, html: input.html });
  const kind: ContentKind = detected.confidence >= 0.7 ? detected.kind : "article";
  const content: CanonicalContent = {
    kind,
    title: input.title,
    author: input.author ? { name: input.author } : null,
    publishedAt: input.publishedAt?.toISOString() ?? null,
    lead: lead ? collapseWhitespace(lead).slice(0, 400) : null,
    main: blocks,
    media,
    bodyHtmlSource: input.html,
    discussion: null,
    video: null,
    social: null,
    engagement: null,
    extraction: {
      extractor: input.extractor,
      version: "1.0.0",
      sourceId: input.sourceId,
      sourceFamily: input.profile.contentFamily,
      fallbackUsed: false,
      bodyProvenance: input.bodyProvenance,
      sourceAuthority: input.sourceAuthority ?? (input.profile.contentFamily === "official" ? "official" : "publisher"),
    },
    quality: { score: 0, completeness: "full", warnings: [] },
  };
  const quality = evaluateContentQuality({ kind, sourceFamily: content.extraction.sourceFamily, title: input.title, canonical: content, fallbackUsed: false });
  return { ...content, quality };
}
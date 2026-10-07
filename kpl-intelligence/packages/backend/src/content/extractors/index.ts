// Extractor Registry：所有来源抓取后的统一入口。
// 优先级：Source-specific → Content-family → Generic article → Readability（generic 内部）→ Jina（extract.ts）。
// 产出收口：detectContentKind 补 kind、evaluateContentQuality 补质量、canonicalToBody 派生兼容字段。
import { canonicalMainLength, canonicalSearchText, type CanonicalContent, type ContentKind } from "./types.ts";
import { detectContentKind, type ContentExtractor, type ExtractionInput } from "./base.ts";
import { evaluateContentQuality } from "./quality.ts";
import { canonicalToBody } from "../canonical.ts";
import { wechatExtractor } from "./wechat.ts";
import { hupuExtractor } from "./hupu.ts";
import { bilibiliExtractor } from "./bilibili.ts";
import { socialExtractor } from "./social.ts";
import { forumExtractor } from "./forum.ts";
import { genericArticleExtractor } from "./generic-article.ts";

export * from "./types.ts";
export type { ExtractionInput, ContentExtractor } from "./base.ts";
export { profileFor, type SourceContentProfile } from "./profiles.ts";
export { evaluateContentQuality } from "./quality.ts";
export { canonicalToBody } from "../canonical.ts";

const EXTRACTORS: ContentExtractor[] = [wechatExtractor, hupuExtractor, bilibiliExtractor, socialExtractor, forumExtractor, genericArticleExtractor];

export interface ExtractResult {
  content: CanonicalContent;
  /** 派生 body 字段（body_html/body_text/images 的兼容形式）。 */
  body: { html: string; text: string; images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }> };
}

/** Input 的构造入口：profile 由调用方（profileFor）给出。 */
export function extractInput(input: Omit<ExtractionInput, "profile"> & { profile?: ExtractionInput["profile"] }): ExtractionInput {
  return input as ExtractionInput;
}

/**
 * 跑一遍 extractor 链：profile.preferredExtractor 最先（generic-article 除外——它永远垫底兜底），
 * 其余专属 extractor 按注册序；这样未知域名的页面上虎扑/B站仍能按 hostname 认领，generic 不抢跑。
 */
export async function extractCanonical(input: ExtractionInput): Promise<ExtractResult | null> {
  const preferred = input.profile.preferredExtractor;
  const ordered = [
    ...EXTRACTORS.filter((e) => e.id === preferred && e.id !== "generic-article"),
    ...EXTRACTORS.filter((e) => e.id !== preferred && e.id !== "generic-article" && e.canHandle(input)),
    ...EXTRACTORS.filter((e) => e.id === "generic-article"),
  ];
  for (const extractor of ordered) {
    if (!extractor.canHandle(input)) continue;
    try {
      const content = await extractor.extract(input);
      if (content) return finalize(content, input);
    } catch {
      // An extractor's failure moves down the chain, never fails the article.
    }
  }
  return null;
}

/** Jina 兜底回来后的收口：不重跑 extractor，只做派生与质量收口。 */
export function finalizeCanonical(content: CanonicalContent, input: ExtractionInput, via: "jina" | "manual"): ExtractResult {
  const marked: CanonicalContent = {
    ...content,
    extraction: { ...content.extraction, bodyProvenance: via === "jina" ? "jina" : content.extraction.bodyProvenance, fallbackUsed: true },
  };
  return finalize(marked, input);
}

function finalize(content: CanonicalContent, input: ExtractionInput): ExtractResult {
  // 结构说了算的 kind（forum/social/video）由 extractor 直接给出；article/unknown 按来源+信号
  // 精化（官方公告/采访/分析），但置信度不足时保持 article，不让正文里的零星词翻转类型。
  let kind: ContentKind = content.kind;
  if (kind === "article" || kind === "unknown") {
    const text = canonicalMainLength(content) > 0 ? canonicalSearchText(content) : null;
    const detected = detectContentKind({ profile: input.profile, title: content.title, text, html: input.html });
    if (detected.kind !== "unknown" && detected.confidence >= 0.7) kind = detected.kind;
  }
  const withKind: CanonicalContent = { ...content, kind };
  const quality = evaluateContentQuality({
    kind,
    sourceFamily: withKind.extraction.sourceFamily,
    title: withKind.title,
    canonical: withKind,
    fallbackUsed: withKind.extraction.fallbackUsed,
  });
  const final: CanonicalContent = { ...withKind, quality };
  return { content: final, body: canonicalToBody(final) };
}

/** registry 之外的直接收口（collect 的 detail 路径已经拿到 canonical 时）。 */
export function finalizeExternal(content: CanonicalContent, input: ExtractionInput): ExtractResult {
  return finalize(content, input);
}

// Social extractor：X / 微博 / 短内容平台的 post 结构（author/post text/quoted/media/engagement）。
// x_search 来源在抓取时就带有完整 xPost 数据：不需要页面，直接映射。
import type { ContentExtractor, ExtractionInput } from "./base.ts";
import type { CanonicalContent } from "./types.ts";

export const socialExtractor: ContentExtractor = {
  id: "social",
  version: "1.0.0",

  canHandle(input: ExtractionInput): boolean {
    return !!input.xPost || input.profile.preferredExtractor === "social" || /(^|\.)(?:x\.com|twitter\.com)$/i.test(hostOf(input.url));
  },

  async extract(input: ExtractionInput): Promise<CanonicalContent | null> {
    const x = input.xPost;
    if (!x) return null;
    const text = String(x.text ?? "").trim();
    if (!text) return null;

    const content: CanonicalContent = {
      kind: "social_post",
      title: null,
      author: {
        name: x.authorName ?? input.author,
        avatarUrl: x.avatarUrl ?? null,
        profileUrl: x.handle ? `https://x.com/${x.handle}` : null,
        role: x.handle ? `@${x.handle}` : null,
      },
      publishedAt: input.publishedAt?.toISOString() ?? null,
      lead: null,
      // 短内容不装进"正文块"结构：postText 单独走 social 视图，UI 原样呈现。
      main: [],
      media: Array.isArray(x.media) ? x.media.filter((m: any) => m.kind === "image" && m.url).slice(0, 12) : [],
      discussion: null,
      video: null,
      social: {
        postText: text,
        quoted: x.quoted?.text
          ? { author: x.quoted.authorName ?? null, handle: x.quoted.handle ?? null, text: String(x.quoted.text) }
          : null,
      },
      engagement: null,
      extraction: {
        extractor: "social",
        version: "1.0.0",
        sourceId: input.sourceId,
        sourceFamily: input.profile.contentFamily,
        fallbackUsed: false,
        bodyProvenance: "source_api",
        sourceAuthority: "caster",
      },
      quality: { score: 0, completeness: "full", warnings: [] },
    };
    return content;
  },
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

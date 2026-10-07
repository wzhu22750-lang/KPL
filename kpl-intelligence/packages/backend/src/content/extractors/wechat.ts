// 微信公众号文章 extractor：DOM 映射 + 噪音清除（二维码/在看/商务/招聘/推荐阅读），
// "编辑：XXX" 的截断结合位置与上下文判断（clean-noise 的密度逻辑），不机械截断。
import { cleanWechatHtml } from "../../sources/wechat2rss/parser.ts";
import { isNoiseBlock, pruneHtmlNoise } from "../clean-noise.ts";
import { collapseWhitespace } from "../../lib/text.ts";
import { htmlToBlocks } from "./html-blocks.ts";
import type { ContentExtractor, ExtractionInput } from "./base.ts";
import type { CanonicalContent, ContentBlock } from "./types.ts";

const WECHAT_URL = /mp\.weixin\.qq\.com/i;

export const wechatExtractor: ContentExtractor = {
  id: "wechat",
  version: "1.0.0",

  canHandle(input: ExtractionInput): boolean {
    return WECHAT_URL.test(input.url) || input.profile.preferredExtractor === "wechat";
  },

  async extract(input: ExtractionInput): Promise<CanonicalContent | null> {
    const html = input.html;
    if (!html) return null;
    const cleaned = cleanWechatHtml(html);
    if (!cleaned.html || cleaned.text.length < 40) return null;

    const cheerio = await import("cheerio");
    const $ = cheerio.load(html);
    const title = collapseWhitespace($("#activity-name").text() || $('meta[property="og:title"]').attr("content") || (input.title ?? "")) || null;
    const accountName = collapseWhitespace($("#js_name").text() || $('meta[property="og:site_name"]').attr("content") || "") || null;
    const authorName = accountName ?? input.author ?? null;
    const publishedAt = parseWechatTime(html) ?? input.publishedAt?.toISOString() ?? null;

    // 尾部噪音（在看引导/招聘/推荐阅读/署名）走密度+位置的剪除；块级再过一遍 isNoiseBlock。
    const prunedHtml = pruneHtmlNoise(cleaned.html);
    const { blocks: allBlocks, media } = htmlToBlocks(prunedHtml, input.url, { maxImages: 30 });
    const blocks = allBlocks.filter((b, i) => !(i > allBlocks.length * 0.5 && blockText(b) && isNoiseBlock(blockText(b)!)));
    if (!blocks.length) return null;
    const lead = blocks.find((b): b is Extract<typeof b, { type: "paragraph" }> => b.type === "paragraph")?.text ?? null;

    const content: CanonicalContent = {
      kind: "article",
      title,
      author: authorName ? { name: authorName, role: "公众号" } : null,
      publishedAt,
      lead,
      main: blocks,
      media,
      bodyHtmlSource: prunedHtml,
      discussion: null,
      video: null,
      social: null,
      engagement: null,
      extraction: {
        extractor: "wechat",
        version: "1.0.0",
        sourceId: input.sourceId,
        sourceFamily: input.profile.contentFamily,
        fallbackUsed: false,
        bodyProvenance: "page_dom",
        sourceAuthority: "official",
      },
      quality: { score: 0, completeness: "full", warnings: [] },
    };
    return content;
  },
};

/** #publish_time、var ct = "…"、var oriCreateTime = "…"（毫秒）。 */
function parseWechatTime(html: string): string | null {
  const publish = html.match(/id="publish_time"[^>]*>([^<]+)</i)?.[1];
  if (publish) {
    const t = Date.parse(publish.trim());
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  const ori = html.match(/var\s+oriCreateTime\s*=\s*'?(\d{13})'?/)?.[1];
  if (ori) return new Date(Number(ori)).toISOString();
  const ct = html.match(/var\s+ct\s*=\s*"?(\d{10})"?/)?.[1];
  if (ct) return new Date(Number(ct) * 1000).toISOString();
  return null;
}

const blockText = (b: ContentBlock): string | null => {
  if (b.type === "paragraph" || b.type === "quote" || b.type === "heading") return b.text;
  if (b.type === "list") return b.items.join(" ");
  return null;
};

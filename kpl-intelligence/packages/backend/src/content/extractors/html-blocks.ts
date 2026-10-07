// HTML → ContentBlock[]：所有 DOM 系 extractor 共用的正文块化机制。
// 图片按角色分类（只有 content_image 进正文 gallery）；二维码/头像/表情/广告/追踪像素不进。
import * as cheerio from "cheerio";
import { isTrackingImage } from "../../lib/image-url.ts";
import { collapseWhitespace } from "../../lib/text.ts";
import type { ContentBlock, ImageBlock, ImageRole } from "./types.ts";

const QR_HINTS = /(?:qr|qrcode|qrcode|二维码|扫码|scan)/i;
const AD_HINTS = /(?:advert|ads?[-_]|banner|sponsor|promotion|promo|guanggao)/i;
const AVATAR_HINTS = /(?:avatar|face|头像|profile[-_]?img)/i;
const ICON_HINTS = /(?:icon|logo|sprite|badge)/i;
const EMOJI_HINTS = /(?:emoji|smilies?|weixin[-_]?emotion)/i;

/** 图片角色：src 与尺寸共同判断；未知角色按 content_image 处理（宁可保留）。 */
export function classifyImage(src: string | undefined, $el: cheerio.Cheerio<any> | null, width?: number | null, height?: number | null): ImageRole {
  const s = src ?? "";
  if (!s || isTrackingImage(s, width !== null && width !== undefined ? String(width) : undefined, height !== null && height !== undefined ? String(height) : undefined)) return "tracking_pixel";
  if (width != null && height != null && width <= 1 && height <= 1) return "tracking_pixel";
  const lower = s.toLowerCase();
  const cls = $el ? `${$el.attr("class") ?? ""} ${$el.attr("id") ?? ""}`.toLowerCase() : "";
  if (QR_HINTS.test(lower) || QR_HINTS.test(cls)) return "qr_code";
  if (EMOJI_HINTS.test(lower) || EMOJI_HINTS.test(cls)) return "emoji";
  if (AVATAR_HINTS.test(lower) || AVATAR_HINTS.test(cls)) return "avatar";
  if (width != null && height != null && width <= 48 && height <= 48) return "icon";
  if (AD_HINTS.test(lower) || AD_HINTS.test(cls)) return "advertisement";
  if (ICON_HINTS.test(cls) && (width == null || width <= 64)) return "icon";
  return "content_image";
}

function resolveSrc($el: cheerio.Cheerio<any>, base: string): string | null {
  const raw = $el.attr("data-src") || $el.attr("data-original") || $el.attr("src") || "";
  const s = raw.trim();
  if (!s || s.startsWith("data:")) return null;
  try {
    return new URL(s.startsWith("//") ? `https:${s}` : s, base || undefined).toString();
  } catch {
    return null;
  }
}

function imageOf($el: cheerio.Cheerio<any>, base: string): { block: ImageBlock; role: ImageRole } | null {
  const src = resolveSrc($el, base);
  if (!src) return null;
  const wAttr = $el.attr("width");
  const hAttr = $el.attr("height");
  const width = wAttr && /^\d+$/.test(wAttr) ? Number(wAttr) : null;
  const height = hAttr && /^\d+$/.test(hAttr) ? Number(hAttr) : null;
  const role = classifyImage(src, $el, width, height);
  const alt = collapseWhitespace($el.attr("alt") ?? "") || null;
  return { block: { type: "image", url: src, caption: null, alt, width, height }, role };
}

const BLOCK = "p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, table, figure, pre, img, video, section > p";

/**
 * 把一段已净化的正文 HTML 转成 ContentBlock 列表。块内行内文本保留为纯文本；
 * 图片按角色过滤：只有 content_image / cover 进入结果。
 */
export function htmlToBlocks(html: string, baseUrl: string, opts: { imageRoles?: ImageRole[]; maxImages?: number } = {}): { blocks: ContentBlock[]; media: ImageBlock[] } {
  const $ = cheerio.load(html, null, false);
  const blocks: ContentBlock[] = [];
  const media: ImageBlock[] = [];
  const allowedRoles = new Set(opts.imageRoles ?? ["content_image", "cover"]);
  const maxImages = opts.maxImages ?? 30;

  const root = $.root();
  const walk = (parent: cheerio.Cheerio<any>) => {
    for (const node of parent.children().toArray()) {
      const el = $(node);
      const tag = (node as { tagName?: string }).tagName?.toLowerCase() ?? "";
      if (tag === "p" || tag === "section" || tag === "div") {
        // 段落里的行内图片先提出来（微信正文常见 <p><img></p>）。
        const imgs = el.find("img").toArray();
        const text = collapseWhitespace(el.text());
        for (const im of imgs) {
          const got = imageOf(el.find(String((im as { tagName?: string }).tagName)).length ? $(im) : $(im), baseFrom(baseUrl));
          if (got && allowedRoles.has(got.role) && media.length < maxImages) {
            media.push(got.block);
            blocks.push(got.block);
          }
        }
        if (text) blocks.push({ type: "paragraph", text });
        continue;
      }
      if (/^h[1-6]$/.test(tag)) {
        const text = collapseWhitespace(el.text());
        if (text) blocks.push({ type: "heading", level: Number(tag[1]), text });
        continue;
      }
      if (tag === "blockquote") {
        const text = collapseWhitespace(el.text());
        if (text) blocks.push({ type: "quote", text, attribution: null });
        continue;
      }
      if (tag === "ul" || tag === "ol") {
        const items = el.children("li").toArray().map((li) => collapseWhitespace($(li).text())).filter(Boolean);
        if (items.length) blocks.push({ type: "list", ordered: tag === "ol", items });
        continue;
      }
      if (tag === "table") {
        const rows = el.find("tr").toArray().map((tr) => $(tr).find("th, td").toArray().map((td) => collapseWhitespace($(td).text())));
        if (rows.length) blocks.push({ type: "table", rows });
        continue;
      }
      if (tag === "img") {
        const got = imageOf(el, baseFrom(baseUrl));
        if (got && allowedRoles.has(got.role) && media.length < maxImages) {
          media.push(got.block);
          blocks.push(got.block);
        }
        continue;
      }
      if (tag === "video") {
        const src = resolveSrc(el, baseFrom(baseUrl)) ?? el.find("source").attr("src") ?? null;
        if (src) blocks.push({ type: "video", url: src, poster: el.attr("poster") ?? null });
        continue;
      }
      if (tag === "figure" || tag === "pre") {
        if (tag === "pre") {
          const text = el.text();
          if (text.trim()) blocks.push({ type: "paragraph", text: collapseWhitespace(text) });
          continue;
        }
        const img = el.find("img").first();
        if (img.length) {
          const got = imageOf(img, baseFrom(baseUrl));
          const caption = collapseWhitespace(el.find("figcaption").text()) || null;
          if (got && allowedRoles.has(got.role) && media.length < maxImages) {
            media.push({ ...got.block, caption });
            blocks.push({ ...got.block, caption });
          }
          continue;
        }
        walk(el);
        continue;
      }
      // 其它容器递归；叶子文本归入段落。
      if (el.children().length) walk(el);
      else {
        const text = collapseWhitespace(el.text());
        if (text) blocks.push({ type: "paragraph", text });
      }
    }
  };
  walk(root);
  return { blocks, media };
}

function baseFrom(url: string): string {
  return url;
}

/** blocks → 兼容用的净化 HTML（body_html 的派生形式，与 sanitize 的白名单风格一致）。 */
export function blocksToHtml(blocks: ContentBlock[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "paragraph": out.push(`<p>${esc(b.text)}</p>`); break;
      case "heading": out.push(`<h${Math.min(6, Math.max(2, b.level))}>${esc(b.text)}</h${Math.min(6, Math.max(2, b.level))}>`); break;
      case "quote": out.push(`<blockquote><p>${esc(b.text)}</p></blockquote>`); break;
      case "image": out.push(`<p><img src="${esc(b.url)}" alt="${esc(b.alt ?? "")}"${b.width ? ` width="${b.width}"` : ""}${b.height ? ` height="${b.height}"` : ""} /></p>`); break;
      case "gallery": out.push(`<p>${b.images.map((i) => `<img src="${esc(i.url)}" alt="${esc(i.alt ?? "")}" />`).join("")}</p>`); break;
      case "list": out.push(`<${b.ordered ? "ol" : "ul"}>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</${b.ordered ? "ol" : "ul"}>`); break;
      case "table": out.push(`<table>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`); break;
      case "video": out.push(`<p><video src="${esc(b.url)}"${b.poster ? ` poster="${esc(b.poster)}"` : ""}></video></p>`); break;
    }
  }
  return out.join("");
}

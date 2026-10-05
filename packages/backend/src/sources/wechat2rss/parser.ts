import * as cheerio from "cheerio";
import { collapseWhitespace, stripTags } from "../../lib/text.ts";
import { pruneHtmlNoise, pruneTextNoise } from "../../content/clean-noise.ts";
import type { WechatArticle } from "./types.ts";

export interface CleanHtmlResult {
  html: string;
  text: string;
  images: string[];
}

/**
 * 清洗微信公众号文章的 HTML：
 * 1. 突破防盗链：将 data-src / data-original 转为 src，并添加 referrerpolicy="no-referrer"
 * 2. 移除干扰元素（脚本、样式、广告、点赞赞赏条、二维码等）
 * 3. 规范化段落与图片排版
 */
export function cleanWechatHtml(rawHtml: string): CleanHtmlResult {
  if (!rawHtml || !rawHtml.trim()) {
    return { html: "", text: "", images: [] };
  }

  const $ = cheerio.load(rawHtml, { xml: false });
  const images: string[] = [];

  // 1. 移除无关干扰节点
  $(
    "script, style, iframe, noscript, svg, #js_toobar, .qr_code_pc_outer, .rich_media_tool, " +
    ".profile_container, .reward_area, #js_sponsor_ad_area, .like_comment_wraper, .wx_follow_nickname, " +
    ".rich_media_area_extra, .js_audio_frame, [style*='display: none'], [style*='display:none']"
  ).remove();

  // 2. 处理图片标签
  $("img").each((_, el) => {
    const $img = $(el);
    const dataSrc = $img.attr("data-src") || $img.attr("data-original") || $img.attr("src") || "";

    if (dataSrc && !dataSrc.startsWith("data:image/svg+xml")) {
      // 规范化微信图片链接
      let cleanUrl = dataSrc.trim();
      if (cleanUrl.startsWith("//")) {
        cleanUrl = `https:${cleanUrl}`;
      }

      $img.attr("src", cleanUrl);
      $img.attr("referrerpolicy", "no-referrer");
      $img.attr("loading", "lazy");
      $img.removeAttr("data-src");
      $img.removeAttr("data-original");
      $img.removeAttr("data-ratio");
      $img.removeAttr("data-w");
      $img.removeAttr("style"); // 移除微信可能硬编码的宽高样式

      if (cleanUrl.startsWith("http")) {
        images.push(cleanUrl);
      }
    } else if (dataSrc.startsWith("data:image/svg+xml")) {
      // 占位 svg 占位图如果无 real src 则移除
      const realSrc = $img.attr("data-src") || $img.attr("data-original");
      if (!realSrc) {
        $img.remove();
      }
    }
  });

  // 3. 处理段落和文本节点
  $("p, section").each((_, el) => {
    const $el = $(el);
    // 去除多余内联 style 影响阅读器排版
    const style = $el.attr("style");
    if (style && (style.includes("visibility: hidden") || style.includes("display: none"))) {
      $el.remove();
    }
  });

  // 提取正文内容容器（如果是抓取整个微信页面，提取 #js_content）
  let $content = $("#js_content");
  if ($content.length === 0) {
    $content = $("body");
  }

  const rawContentHtml = $content.html()?.trim() || "";
  const cleanedHtml = pruneHtmlNoise(rawContentHtml);
  const rawText = collapseWhitespace(stripTags(cleanedHtml.replace(/<\/p>|<br\s*\/?>/gi, "\n")))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const cleanedText = pruneTextNoise(rawText);

  return {
    html: cleanedHtml,
    text: cleanedText,
    images: Array.from(new Set(images)),
  };
}

/**
 * 健壮解析各类微信与第三方搜索结果中的发布时间
 */
export function parseWechatDate(raw: unknown): Date {
  if (!raw) return new Date();

  if (raw instanceof Date) {
    return isNaN(raw.getTime()) ? new Date() : raw;
  }

  if (typeof raw === "number") {
    if (isNaN(raw) || raw <= 0) return new Date();
    return new Date(raw < 1e11 ? raw * 1000 : raw);
  }

  const str = String(raw).trim();
  if (!str) return new Date();

  // 1. timeConvert('1716047117') 或 timeConvert(1716047117)
  const timeConvertMatch = str.match(/timeConvert\(["']?(\d+)["']?\)/i);
  if (timeConvertMatch && timeConvertMatch[1]) {
    const ts = parseInt(timeConvertMatch[1], 10);
    if (!isNaN(ts)) return new Date(ts < 1e11 ? ts * 1000 : ts);
  }

  // 2. 独立 10 位 Unix 时间戳
  const ts10Match = str.match(/\b(1[5-9]\d{8})\b/);
  if (ts10Match && ts10Match[1]) {
    const ts = parseInt(ts10Match[1], 10);
    if (!isNaN(ts)) return new Date(ts * 1000);
  }

  // 3. 独立 13 位毫秒时间戳
  const ts13Match = str.match(/\b(1[5-9]\d{11})\b/);
  if (ts13Match && ts13Match[1]) {
    const ts = parseInt(ts13Match[1], 10);
    if (!isNaN(ts)) return new Date(ts);
  }

  // 4. 相对时间：分钟/小时/天
  const minMatch = str.match(/(\d+)\s*分钟前/);
  if (minMatch && minMatch[1]) {
    return new Date(Date.now() - parseInt(minMatch[1], 10) * 60_000);
  }
  const hourMatch = str.match(/(\d+)\s*小时前/);
  if (hourMatch && hourMatch[1]) {
    return new Date(Date.now() - parseInt(hourMatch[1], 10) * 3600_000);
  }
  const dayMatch = str.match(/(\d+)\s*天前/);
  if (dayMatch && dayMatch[1]) {
    return new Date(Date.now() - parseInt(dayMatch[1], 10) * 86400_000);
  }
  if (str.includes("昨天")) {
    const timeInYesterday = str.match(/昨天\s*(\d{1,2}):(\d{1,2})/);
    const d = new Date(Date.now() - 86400_000);
    if (timeInYesterday && timeInYesterday[1] && timeInYesterday[2]) {
      d.setHours(parseInt(timeInYesterday[1], 10), parseInt(timeInYesterday[2], 10), 0, 0);
    }
    return d;
  }
  if (str.includes("前天")) {
    const timeInBeforeYesterday = str.match(/前天\s*(\d{1,2}):(\d{1,2})/);
    const d = new Date(Date.now() - 172800_000);
    if (timeInBeforeYesterday && timeInBeforeYesterday[1] && timeInBeforeYesterday[2]) {
      d.setHours(parseInt(timeInBeforeYesterday[1], 10), parseInt(timeInBeforeYesterday[2], 10), 0, 0);
    }
    return d;
  }

  // 5. 中文日期格式：YYYY年MM月DD日 [HH:mm[:ss]]
  const cnDateMatch = str.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (cnDateMatch && cnDateMatch[1] && cnDateMatch[2] && cnDateMatch[3]) {
    const year = parseInt(cnDateMatch[1], 10);
    const month = parseInt(cnDateMatch[2], 10) - 1;
    const day = parseInt(cnDateMatch[3], 10);
    const hours = cnDateMatch[4] ? parseInt(cnDateMatch[4], 10) : 0;
    const minutes = cnDateMatch[5] ? parseInt(cnDateMatch[5], 10) : 0;
    const seconds = cnDateMatch[6] ? parseInt(cnDateMatch[6], 10) : 0;
    return new Date(year, month, day, hours, minutes, seconds);
  }

  // 6. 标准日期字符串（YYYY-MM-DD 或 YYYY/MM/DD 等）
  const parsed = Date.parse(str);
  if (!isNaN(parsed)) {
    return new Date(parsed);
  }

  return new Date();
}

/**
 * 从微信公众平台文章原始 HTML 中提取结构化元数据
 */
export function extractWechatArticleFromHtml(pageHtml: string, pageUrl: string): Partial<WechatArticle> {
  const $ = cheerio.load(pageHtml);

  // 1. 标题提取
  const title =
    $("#activity-name").text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $('meta[name="twitter:title"]').attr("content")?.trim() ||
    $("title").text().replace(/[\r\n\t]/g, "").trim();

  // 2. 作者 / 公众号名称提取
  const author =
    $("#js_name").text().trim() ||
    $('meta[property="og:article:author"]').attr("content")?.trim() ||
    $(".rich_media_meta_text").first().text().trim() ||
    null;

  // 3. 摘要提取
  const description =
    $('meta[property="og:description"]').attr("content")?.trim() ||
    $('meta[name="description"]').attr("content")?.trim() ||
    null;

  // 4. 封面图提取
  const coverUrl =
    $('meta[property="og:image"]').attr("content")?.trim() ||
    $('meta[name="twitter:image"]').attr("content")?.trim() ||
    null;

  // 5. 发布时间提取（多源探测，避免回退到爬取时间）
  let publishedAt: Date = new Date();
  const scriptContent = $("script").text();
  const timeMatch =
    scriptContent.match(/create_time\s*:\s*JsDecode\('([^']+)'\)/) ||
    pageHtml.match(/create_time\s*:\s*JsDecode\('([^']+)'\)/) ||
    scriptContent.match(/var\s+createTime\s*=\s*'(\d+)'/) ||
    scriptContent.match(/var\s+ct\s*=\s*'(\d+)'/) ||
    scriptContent.match(/["']?create_time["']?\s*[:=]\s*["']?(\d+)["']?/) ||
    scriptContent.match(/ori_create_time\s*[:=]\s*["']?(\d+)["']?/) ||
    pageHtml.match(/ori_create_time\s*[:=]\s*["']?(\d+)["']?/) ||
    scriptContent.match(/["']?publish_time["']?\s*[:=]\s*["']?([^'";]+)["']?/) ||
    pageHtml.match(/publish_time\s*[:=]\s*["']?([^'";]+)["']?/);

  const domTime =
    $("#publish_time").text().trim() ||
    $("em#publish_time").text().trim() ||
    $(".rich_media_meta#publish_time").text().trim() ||
    $('meta[property="article:published_time"]').attr("content")?.trim() ||
    $('meta[name="publishdate"]').attr("content")?.trim();

  if (timeMatch && timeMatch[1]) {
    publishedAt = parseWechatDate(timeMatch[1]);
  } else if (domTime) {
    publishedAt = parseWechatDate(domTime);
  }

  // 6. 清洗正文
  const { html, text } = cleanWechatHtml($("#js_content").html() || $("body").html() || "");

  return {
    title,
    author,
    url: pageUrl,
    description,
    coverUrl,
    publishedAt,
    contentHtml: html,
    contentText: text,
  };
}

import { escapeXml } from "../../lib/text.ts";
import type { FeedOptions, WechatAccount, WechatArticle } from "./types.ts";

function cdata(str: string): string {
  return `<![CDATA[${str.replace(/]]>/g, "]]]]><![CDATA[>").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")}]]>`;
}

function rfc822(d: Date): string {
  return isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString();
}

/**
 * 将微信公众号数据和文章列表生成标准 RSS 2.0 XML
 */
export function generateRssFeed(
  account: WechatAccount,
  articles: WechatArticle[],
  options: FeedOptions = {}
): string {
  const feedUrl = options.feedUrl || account.url || "https://mp.weixin.qq.com";
  const siteUrl = options.siteUrl || account.url || "https://mp.weixin.qq.com";
  const ttl = options.ttlMinutes || 30;
  const language = options.language || "zh-CN";
  const channelTitle = `${account.name} - 微信公众号`;
  const channelDesc = account.description || `${account.name} 的微信公众号最新文章 RSS 订阅源（由 WeChat2RSS Bridge 生成）`;

  const itemXmls: string[] = [];

  for (const article of articles) {
    const pubDateStr = rfc822(article.publishedAt);
    const authorStr = escapeXml(article.author || account.name);
    const titleStr = escapeXml(article.title);
    const linkStr = escapeXml(article.url);
    const guidStr = escapeXml(article.id || article.url);

    const descHtml = article.description || article.contentText?.slice(0, 300) || article.title;
    const bodyHtml = article.contentHtml || `<p>${descHtml}</p>`;

    let enclosureTag = "";
    if (article.coverUrl && article.coverUrl.startsWith("http")) {
      enclosureTag = `\n      <enclosure url="${escapeXml(article.coverUrl)}" type="image/jpeg" />`;
    }

    itemXmls.push(`    <item>
      <title>${titleStr}</title>
      <link>${linkStr}</link>
      <guid isPermaLink="false">${guidStr}</guid>
      <pubDate>${pubDateStr}</pubDate>
      <dc:creator>${authorStr}</dc:creator>
      <description>${cdata(descHtml)}</description>
      <content:encoded>${cdata(bodyHtml)}</content:encoded>${enclosureTag}
    </item>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escapeXml(channelTitle)}</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>${escapeXml(channelDesc)}</description>
    <language>${escapeXml(language)}</language>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
    <lastBuildDate>${rfc822(new Date())}</lastBuildDate>
    <ttl>${ttl}</ttl>
    <generator>WeChat2RSS Bridge</generator>
${itemXmls.join("\n")}
  </channel>
</rss>
`;
}

/**
 * 生成 JSON Feed 格式（可选）
 */
export function generateJsonFeed(
  account: WechatAccount,
  articles: WechatArticle[],
  options: FeedOptions = {}
): Record<string, unknown> {
  const feedUrl = options.feedUrl || account.url || "https://mp.weixin.qq.com";
  const siteUrl = options.siteUrl || account.url || "https://mp.weixin.qq.com";

  return {
    version: "https://jsonfeed.org/version/1.1",
    title: `${account.name} - 微信公众号`,
    home_page_url: siteUrl,
    feed_url: feedUrl,
    description: account.description || `${account.name} 的微信公众号 RSS 源`,
    icon: account.avatar,
    items: articles.map((a) => ({
      id: a.id || a.url,
      url: a.url,
      title: a.title,
      content_html: a.contentHtml,
      content_text: a.contentText,
      summary: a.description,
      image: a.coverUrl,
      date_published: a.publishedAt.toISOString(),
      author: {
        name: a.author || account.name,
      },
    })),
  };
}

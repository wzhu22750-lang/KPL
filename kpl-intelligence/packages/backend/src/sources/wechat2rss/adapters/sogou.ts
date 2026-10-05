import * as cheerio from "cheerio";
import { guardedFetch } from "../../../lib/http-fetch.ts";
import { cleanWechatHtml, parseWechatDate } from "../parser.ts";
import type { WechatAccount, WechatAdapter, WechatAdapterResult, WechatArticle } from "../types.ts";

export class SogouAdapter implements WechatAdapter {
  readonly name = "sogou";

  private getHeaders(): Record<string, string> {
    return {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Referer: "https://weixin.sogou.com/",
    };
  }

  /**
   * 搜索公众号信息
   */
  async search(keyword: string): Promise<WechatAccount[]> {
    try {
      const url = `https://weixin.sogou.com/weixin?type=1&query=${encodeURIComponent(keyword)}&ie=utf8&s_from=input`;
      const res = await guardedFetch(url, { headers: this.getHeaders(), timeoutMs: 15_000 });
      if (res.status !== 200) return [];

      const $ = cheerio.load(res.text());
      const accounts: WechatAccount[] = [];

      $(".news-box .news-list2 li").each((_, el) => {
        const $li = $(el);
        const name = $li.find(".tit a").text().trim();
        const wechatId = $li.find(".info label").text().trim();
        const avatar = $li.find(".img-box img").attr("src") || "";
        const desc = $li.find(".txt-info").text().trim();
        const link = $li.find(".tit a").attr("href") || "";

        if (name) {
          accounts.push({
            id: wechatId || name,
            name,
            nickname: name,
            avatar: avatar.startsWith("//") ? `https:${avatar}` : avatar,
            description: desc,
            url: link ? `https://weixin.sogou.com${link}` : undefined,
          });
        }
      });

      return accounts;
    } catch {
      return [];
    }
  }

  /**
   * 获取公众号文章（通过搜狗文章搜索）
   */
  async getArticles(accountIdentifier: string, limit = 10): Promise<WechatAdapterResult | null> {
    try {
      // 搜索包含该公众号的文章
      const url = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(accountIdentifier)}&ie=utf8&s_from=input`;
      const res = await guardedFetch(url, { headers: this.getHeaders(), timeoutMs: 15_000 });
      if (res.status !== 200) return null;

      const $ = cheerio.load(res.text());
      const articles: WechatArticle[] = [];

      $(".news-box .news-list li").each((_, el) => {
        if (articles.length >= limit) return;
        const $li = $(el);
        const title = $li.find(".txt-box h3 a").text().trim();
        const rawUrl = $li.find(".txt-box h3 a").attr("href") || "";
        const summary = $li.find(".txt-info").text().trim();
        const author = $li.find(".s-p .account").text().trim();
        const timeHtml = $li.find(".s-p .s2").html() || $li.find(".s-p").html() || "";
        const timeText = $li.find(".s-p .s2").text().trim() || $li.find(".s-p").text().trim();
        const cover = $li.find(".img-box img").attr("src") || "";

        if (title && rawUrl) {
          const articleUrl = rawUrl.startsWith("http") ? rawUrl : `https://weixin.sogou.com${rawUrl}`;
          const { html, text } = cleanWechatHtml(summary);
          const publishedAt = parseWechatDate(timeHtml || timeText);

          articles.push({
            id: String(articles.length + 1),
            title,
            url: articleUrl,
            author: author || accountIdentifier,
            description: summary || text,
            contentHtml: html || `<p>${summary || title}</p>`,
            contentText: text || summary || title,
            coverUrl: cover.startsWith("//") ? `https:${cover}` : cover || null,
            publishedAt,
          });
        }
      });

      if (articles.length === 0) return null;

      return {
        account: {
          id: accountIdentifier,
          name: accountIdentifier,
          url: `https://weixin.sogou.com/weixin?type=1&query=${encodeURIComponent(accountIdentifier)}`,
        },
        articles,
      };
    } catch {
      return null;
    }
  }
}

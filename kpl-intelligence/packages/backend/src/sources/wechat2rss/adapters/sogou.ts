import * as cheerio from "cheerio";
import { guardedFetch } from "../../../lib/http-fetch.ts";
import { cleanWechatHtml, parseWechatDate } from "../parser.ts";
import { normalizeAccountName, type WechatAccount, type WechatAdapter, type WechatAdapterResult, type WechatArticle } from "../types.ts";

/** 日志只留下可排查的错误类别与账号标识，绝不打印完整响应或凭据。 */
function warn(message: string): void {
  console.warn(`[wechat2rss:sogou] ${message}`);
}

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
      if (res.status !== 200) {
        warn(`account search HTTP ${res.status} for "${keyword}"`);
        return [];
      }

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
    } catch (error) {
      warn(`account search failed for "${keyword}": ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * 通过搜狗文章搜索获取候选文章。只保留作者名与目标账号精确一致的文章；第三方提及一律拒收。
   * 搜狗只能给出展示名称，因此结果标为 identity=display_name，不能单独作为官方身份凭据。
   */
  async getArticles(accountIdentifier: string, limit = 10): Promise<WechatAdapterResult | null> {
    try {
      const url = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(accountIdentifier)}&ie=utf8&s_from=input`;
      const res = await guardedFetch(url, { headers: this.getHeaders(), timeoutMs: 15_000 });
      if (res.status !== 200) {
        warn(`article search HTTP ${res.status} for "${accountIdentifier}"`);
        return null;
      }

      const $ = cheerio.load(res.text());
      const target = normalizeAccountName(accountIdentifier);
      const articles: WechatArticle[] = [];
      let dropped = 0;
      let candidates = 0;

      $(".news-box .news-list li").each((_, el) => {
        const $li = $(el);
        const title = $li.find(".txt-box h3 a").text().trim();
        const rawUrl = $li.find(".txt-box h3 a").attr("href") || "";
        const summary = $li.find(".txt-info").text().trim();
        const author = $li.find(".s-p .account").text().trim();
        const timeHtml = $li.find(".s-p .s2").html() || $li.find(".s-p").html() || "";
        const timeText = $li.find(".s-p .s2").text().trim() || $li.find(".s-p").text().trim();
        const cover = $li.find(".img-box img").attr("src") || "";
        if (!title || !rawUrl) return;
        candidates += 1;
        // 身份校验：作者缺失或不精确匹配目标账号名 → 第三方/无法确认，拒收并计数。
        if (!author || normalizeAccountName(author) !== target) {
          dropped += 1;
          return;
        }
        if (articles.length >= limit) return;

        const articleUrl = rawUrl.startsWith("http") ? rawUrl : `https://weixin.sogou.com${rawUrl}`;
        // 搜狗列表只有摘要：保留为 description，绝不生成 contentHtml/contentText 冒充完整正文。
        const { html, text } = cleanWechatHtml(summary);
        articles.push({
          id: String(articles.length + 1),
          title,
          url: articleUrl,
          author,
          description: summary || text || null,
          contentHtml: html || null,
          contentText: text || null,
          coverUrl: cover.startsWith("//") ? `https:${cover}` : cover || null,
          publishedAt: parseWechatDate(timeHtml || timeText),
          extra: { sogou_identity: "display_name" },
        });
      });

      // 搜狗返回 200 但一个列表条目都没有：更可能是反爬/验证码页，而不是账号真的没有文章。
      if (candidates === 0) {
        warn(`article search parsed no items for "${accountIdentifier}" (anti-bot page?)`);
        return null;
      }

      return {
        account: {
          id: accountIdentifier,
          name: accountIdentifier,
          url: `https://weixin.sogou.com/weixin?type=1&query=${encodeURIComponent(accountIdentifier)}`,
        },
        articles,
        identity: "display_name",
        droppedUnverified: dropped,
        fetchedAt: Date.now(),
      };
    } catch (error) {
      warn(`article search failed for "${accountIdentifier}": ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

import { guardedFetch } from "../../../lib/http-fetch.ts";
import { cleanWechatHtml, parseWechatDate } from "../parser.ts";
import type { WechatAccount, WechatAdapter, WechatAdapterResult, WechatArticle } from "../types.ts";

export class WereadAdapter implements WechatAdapter {
  readonly name = "weread";
  private cookie: string | null = null;

  constructor(cookie?: string) {
    this.cookie = cookie || process.env.WEREAD_COOKIE || null;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Referer: "https://weread.qq.com/",
    };
    if (this.cookie) {
      headers["Cookie"] = this.cookie;
    }
    return headers;
  }

  /**
   * 搜索公众号
   */
  async search(keyword: string): Promise<WechatAccount[]> {
    try {
      const url = `https://weread.qq.com/web/search/global?keyword=${encodeURIComponent(keyword)}&maxIdx=0&fragmentSize=120&count=10`;
      const res = await guardedFetch(url, { headers: this.getHeaders(), timeoutMs: 15_000 });
      if (res.status !== 200) return [];

      const data = JSON.parse(res.text());
      const accounts: WechatAccount[] = [];

      // 解析搜索结果中的公众号（mp）
      if (Array.isArray(data.mps)) {
        for (const item of data.mps) {
          accounts.push({
            id: String(item.mpId || item.id || item.name),
            name: item.name || item.title || keyword,
            nickname: item.name,
            avatar: item.avatar || item.cover,
            description: item.intro || item.description,
            url: `https://weread.qq.com/web/mp/${item.mpId || item.id}`,
          });
        }
      }

      return accounts;
    } catch {
      return [];
    }
  }

  /**
   * 获取公众号最新文章列表
   */
  async getArticles(accountIdentifier: string, limit = 15): Promise<WechatAdapterResult | null> {
    try {
      // 1. 如果传参是公众号名称，先搜索获取 mpId
      let mpId = accountIdentifier;
      let accountName = accountIdentifier;
      let avatar: string | undefined;
      let description: string | undefined;

      // 判断是否需要通过搜索定位
      const isPureId = /^[a-zA-Z0-9_-]{16,}$/.test(accountIdentifier);
      if (!isPureId) {
        const found = await this.search(accountIdentifier);
        const match = found.find((a) => a.name === accountIdentifier) || found[0];
        if (match) {
          mpId = match.id;
          accountName = match.name;
          avatar = match.avatar;
          description = match.description;
        }
      }

      // 2. 调用微信读书获取文章列表
      const listUrl = `https://weread.qq.com/web/mp/get_article_list?mp_id=${encodeURIComponent(mpId)}&count=${limit}`;
      const res = await guardedFetch(listUrl, { headers: this.getHeaders(), timeoutMs: 20_000 });

      if (res.status !== 200) {
        // 尝试备用 API 端点
        const fallbackUrl = `https://weread.qq.com/v1/mp/feed?mp_id=${encodeURIComponent(mpId)}&count=${limit}`;
        const fbRes = await guardedFetch(fallbackUrl, { headers: this.getHeaders(), timeoutMs: 20_000 });
        if (fbRes.status !== 200) return null;
        return this.parseFeedResponse(fbRes.text(), mpId, accountName, avatar, description);
      }

      return this.parseListResponse(res.text(), mpId, accountName, avatar, description);
    } catch {
      return null;
    }
  }

  private parseListResponse(
    responseText: string,
    mpId: string,
    accountName: string,
    avatar?: string,
    description?: string
  ): WechatAdapterResult | null {
    try {
      const data = JSON.parse(responseText);
      const items = data.articles || data.items || data.data || [];
      if (!Array.isArray(items) || items.length === 0) {
        return null;
      }

      const articles: WechatArticle[] = [];

      for (const item of items) {
        const title = item.title || item.name;
        const url = item.url || item.link || item.mp_url;
        if (!title || !url) continue;

        const rawContent = item.content || item.html || item.digest || item.abstract || "";
        const { html, text } = cleanWechatHtml(rawContent);

        const pubTime = item.publish_time || item.create_time || item.post_time || item.time;
        const publishedAt = parseWechatDate(pubTime);

        articles.push({
          id: String(item.id || item.doc_id || item.article_id || url),
          title,
          url,
          author: item.author || accountName,
          description: item.digest || item.abstract || item.summary || text.slice(0, 300),
          contentHtml: html || `<p>${item.digest || title}</p>`,
          contentText: text || item.digest || title,
          coverUrl: item.cover || item.pic_url || item.cover_url,
          publishedAt: isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
          extra: { weread_mp_id: mpId },
        });
      }

      return {
        account: {
          id: mpId,
          name: data.mp_name || accountName,
          avatar: data.avatar || avatar,
          description: data.intro || description,
          url: `https://weread.qq.com/web/mp/${mpId}`,
        },
        articles,
      };
    } catch {
      return null;
    }
  }

  private parseFeedResponse(
    responseText: string,
    mpId: string,
    accountName: string,
    avatar?: string,
    description?: string
  ): WechatAdapterResult | null {
    try {
      const data = JSON.parse(responseText);
      const items = data.feed || data.articles || [];
      const articles: WechatArticle[] = [];

      for (const item of items) {
        const title = item.title;
        const url = item.link || item.url;
        if (!title || !url) continue;

        const { html, text } = cleanWechatHtml(item.content || item.summary || "");
        articles.push({
          id: String(item.id || url),
          title,
          url,
          author: item.author || accountName,
          description: item.summary || text.slice(0, 300),
          contentHtml: html || `<p>${title}</p>`,
          contentText: text || title,
          coverUrl: item.cover,
          publishedAt: parseWechatDate(item.pub_time || item.publish_time || item.create_time),
        });
      }

      return {
        account: {
          id: mpId,
          name: accountName,
          avatar,
          description,
          url: `https://weread.qq.com/web/mp/${mpId}`,
        },
        articles,
      };
    } catch {
      return null;
    }
  }
}

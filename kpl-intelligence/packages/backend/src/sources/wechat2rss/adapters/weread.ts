import { guardedFetch } from "../../../lib/http-fetch.ts";
import { cleanWechatHtml, parseWechatDate } from "../parser.ts";
import { normalizeAccountName, type WechatAccount, type WechatAdapter, type WechatAdapterResult, type WechatArticle } from "../types.ts";

/** 日志只留下可排查的错误类别与账号标识，绝不打印完整响应、Cookie 或凭据。 */
function warn(message: string): void {
  console.warn(`[wechat2rss:weread] ${message}`);
}

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
      if (res.status !== 200) {
        warn(`search HTTP ${res.status} for "${keyword}"`);
        return [];
      }

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
    } catch (error) {
      warn(`search failed for "${keyword}": ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * 获取公众号最新文章列表
   */
  async getArticles(accountIdentifier: string, limit = 15): Promise<WechatAdapterResult | null> {
    try {
      // 1. 定位公众号的 mpId。只有精确同名才接受；同名/近似名不能自动获得官方身份。
      let mpId: string;
      let accountName = accountIdentifier;
      let avatar: string | undefined;
      let description: string | undefined;

      const isPureId = /^[a-zA-Z0-9_-]{16,}$/.test(accountIdentifier);
      if (isPureId) {
        mpId = accountIdentifier;
      } else {
        const found = await this.search(accountIdentifier);
        const target = normalizeAccountName(accountIdentifier);
        const match = found.find((a) => normalizeAccountName(a.name) === target);
        if (!match) {
          warn(`no exact account match for "${accountIdentifier}" among ${found.length} candidates`);
          return null;
        }
        mpId = match.id;
        accountName = match.name;
        avatar = match.avatar;
        description = match.description;
      }

      // 2. 调用微信读书获取文章列表
      const listUrl = `https://weread.qq.com/web/mp/get_article_list?mp_id=${encodeURIComponent(mpId)}&count=${limit}`;
      const res = await guardedFetch(listUrl, { headers: this.getHeaders(), timeoutMs: 20_000 });

      if (res.status !== 200) {
        // 尝试备用 API 端点
        const fallbackUrl = `https://weread.qq.com/v1/mp/feed?mp_id=${encodeURIComponent(mpId)}&count=${limit}`;
        const fbRes = await guardedFetch(fallbackUrl, { headers: this.getHeaders(), timeoutMs: 20_000 });
        if (fbRes.status !== 200) {
          warn(`article list HTTP ${res.status} / fallback HTTP ${fbRes.status} for mp_id ${mpId}`);
          return null;
        }
        return this.parseList(res.text(), mpId, accountName, avatar, description, ["feed", "articles"]);
      }

      return this.parseList(res.text(), mpId, accountName, avatar, description, ["articles", "items", "data"]);
    } catch (error) {
      warn(`getArticles failed for "${accountIdentifier}": ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** 解析文章列表响应；JSON 里没有预期数组则返回 null（结构异常，不是“正常无更新”）。 */
  private parseList(
    responseText: string,
    mpId: string,
    accountName: string,
    avatar?: string,
    description?: string,
    arrayKeys: string[] = ["articles", "items", "data"]
  ): WechatAdapterResult | null {
    let data: Record<string, any>;
    try {
      data = JSON.parse(responseText);
    } catch {
      warn(`article list was not JSON for mp_id ${mpId}`);
      return null;
    }
    const items = arrayKeys.map((k) => data[k]).find((v) => Array.isArray(v)) as Record<string, any>[] | undefined;
    if (!items) {
      warn(`article list had no ${arrayKeys.join("/")} array for mp_id ${mpId}`);
      return null;
    }

    const account: WechatAccount = {
      id: mpId,
      name: data.mp_name || accountName,
      avatar: data.avatar || avatar,
      description: data.intro || description,
      url: `https://weread.qq.com/web/mp/${mpId}`,
    };
    if (items.length === 0) {
      return { account, articles: [], status: "empty", identity: "mp_id", fetchedAt: Date.now() };
    }

    const articles: WechatArticle[] = [];
    for (const item of items) {
      const title = item.title || item.name;
      const url = item.url || item.link || item.mp_url;
      if (!title || !url) continue;

      const rawContent = item.content || item.html || "";
      const { html, text } = cleanWechatHtml(rawContent);
      const digest = item.digest || item.abstract || item.summary || null;

      articles.push({
        id: String(item.id || item.doc_id || item.article_id || url),
        title,
        url,
        author: item.author || null,
        description: digest || item.desc || (text ? text.slice(0, 300) : null),
        // 列表接口通常只有摘要：没有真实正文时保持 null，别把摘要冒充完整正文。
        contentHtml: html || null,
        contentText: text || null,
        coverUrl: item.cover || item.pic_url || item.cover_url,
        publishedAt: parseWechatDate(item.publish_time || item.create_time || item.post_time || item.time),
        extra: { weread_mp_id: mpId },
      });
    }

    return { account, articles, status: "ok", identity: "mp_id", fetchedAt: Date.now() };
  }
}

import { guardedFetch } from "../../../lib/http-fetch.ts";
import { extractWechatArticleFromHtml } from "../parser.ts";
import type { WechatArticle } from "../types.ts";

export class DirectWechatFetcher {
  readonly name = "direct";

  private getHeaders(): Record<string, string> {
    return {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.48 NetType/WIFI Language/zh_CN",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9",
    };
  }

  /**
   * 抓取单篇微信公众号文章的完整正文和元数据
   */
  async fetchArticle(url: string): Promise<WechatArticle | null> {
    try {
      const res = await guardedFetch(url, { headers: this.getHeaders(), timeoutMs: 15_000 });
      if (res.status !== 200) return null;

      const extracted = extractWechatArticleFromHtml(res.text(), url);
      if (!extracted.title) return null;

      return {
        id: url,
        title: extracted.title,
        url,
        author: extracted.author || null,
        description: extracted.description || null,
        contentHtml: extracted.contentHtml || null,
        contentText: extracted.contentText || null,
        coverUrl: extracted.coverUrl || null,
        publishedAt: extracted.publishedAt || new Date(),
      };
    } catch {
      return null;
    }
  }
}

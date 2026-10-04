import { generateJsonFeed, generateRssFeed } from "./generator.ts";
import { WereadAdapter } from "./adapters/weread.ts";
import { SogouAdapter } from "./adapters/sogou.ts";
import type { FeedOptions, WechatAccount, WechatAdapter, WechatAdapterResult, WechatArticle } from "./types.ts";

interface CacheEntry {
  result: WechatAdapterResult;
  rssXml: string;
  cachedAt: number;
}

// 预置常用官方账号别名映射，方便配置短标识
const ACCOUNT_ALIASES: Record<string, string> = {
  kpl: "KPL王者荣耀职业联赛",
  "kpl-official": "KPL王者荣耀职业联赛",
  "mp-kpl-official": "KPL王者荣耀职业联赛",
  hok: "王者荣耀",
  "hok-official": "王者荣耀",
  "mp-hok-official": "王者荣耀",
};

export class Wechat2RssBridge {
  private adapters: WechatAdapter[];
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTtlMs: number;

  constructor(options: { cacheTtlMinutes?: number; wereadCookie?: string } = {}) {
    this.cacheTtlMs = (options.cacheTtlMinutes || 15) * 60 * 1000;
    this.adapters = [
      new WereadAdapter(options.wereadCookie),
      new SogouAdapter(),
    ];
  }

  /**
   * 规范化公众号标识名称
   */
  resolveAccountName(identifier: string): string {
    const raw = decodeURIComponent(identifier).trim();
    return ACCOUNT_ALIASES[raw.toLowerCase()] || raw;
  }

  /**
   * 搜索微信公众号
   */
  async search(keyword: string): Promise<WechatAccount[]> {
    for (const adapter of this.adapters) {
      if (adapter.search) {
        try {
          const res = await adapter.search(keyword);
          if (res && res.length > 0) return res;
        } catch {
          // 继续尝试下一个适配器
        }
      }
    }
    return [];
  }

  /**
   * 获取公众号文章与元数据
   */
  async fetchAccountArticles(
    accountIdentifier: string,
    opts: { force?: boolean; limit?: number } = {}
  ): Promise<WechatAdapterResult | null> {
    const resolvedName = this.resolveAccountName(accountIdentifier);
    const cacheKey = resolvedName.toLowerCase();

    // 检查缓存
    if (!opts.force) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
        return cached.result;
      }
    }

    // 轮询适配器抓取
    for (const adapter of this.adapters) {
      try {
        const result = await adapter.getArticles(resolvedName, opts.limit || 15);
        if (result && result.articles.length > 0) {
          const rssXml = generateRssFeed(result.account, result.articles);
          this.cache.set(cacheKey, {
            result,
            rssXml,
            cachedAt: Date.now(),
          });
          return result;
        }
      } catch {
        // 继续尝试下一个适配器
      }
    }

    // 若适配器抓取全部失败，但缓存有旧数据，则返回过期的旧数据兜底
    const stale = this.cache.get(cacheKey);
    if (stale) {
      return stale.result;
    }

    return null;
  }

  /**
   * 生成公众号的标准 RSS 2.0 XML
   */
  async getRssXml(
    accountIdentifier: string,
    opts: { force?: boolean; feedOptions?: FeedOptions } = {}
  ): Promise<string> {
    const resolvedName = this.resolveAccountName(accountIdentifier);
    const cacheKey = resolvedName.toLowerCase();

    if (!opts.force) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
        return cached.rssXml;
      }
    }

    const result = await this.fetchAccountArticles(accountIdentifier, opts);
    if (!result || result.articles.length === 0) {
      // 生成一个空/错误提示的合法 RSS XML
      const placeholderAccount: WechatAccount = {
        id: accountIdentifier,
        name: resolvedName,
        description: `暂未抓取到 ${resolvedName} 的公众号文章`,
      };
      return generateRssFeed(placeholderAccount, [], opts.feedOptions);
    }

    const xml = generateRssFeed(result.account, result.articles, opts.feedOptions);
    this.cache.set(cacheKey, {
      result,
      rssXml: xml,
      cachedAt: Date.now(),
    });
    return xml;
  }

  /**
   * 生成公众号的 JSON Feed
   */
  async getJsonFeed(
    accountIdentifier: string,
    opts: { force?: boolean; feedOptions?: FeedOptions } = {}
  ): Promise<Record<string, unknown>> {
    const result = await this.fetchAccountArticles(accountIdentifier, opts);
    const resolvedName = this.resolveAccountName(accountIdentifier);

    if (!result || result.articles.length === 0) {
      const placeholderAccount: WechatAccount = {
        id: accountIdentifier,
        name: resolvedName,
      };
      return generateJsonFeed(placeholderAccount, [], opts.feedOptions);
    }

    return generateJsonFeed(result.account, result.articles, opts.feedOptions);
  }

  /**
   * 清除特定账号或全部缓存
   */
  clearCache(accountIdentifier?: string) {
    if (accountIdentifier) {
      const resolved = this.resolveAccountName(accountIdentifier).toLowerCase();
      this.cache.delete(resolved);
    } else {
      this.cache.clear();
    }
  }
}

// 导出单例实例供系统共用
export const wechatBridge = new Wechat2RssBridge();

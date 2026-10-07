import { generateJsonFeed, generateRssFeed } from "./generator.ts";
import { WereadAdapter } from "./adapters/weread.ts";
import { SogouAdapter } from "./adapters/sogou.ts";
import type { FeedOptions, WechatAccount, WechatAdapter, WechatAdapterResult, WechatArticle, WechatFeed } from "./types.ts";

interface CacheEntry {
  result: WechatAdapterResult;
  rssXml: string;
  /** When this entry was put in the cache (for TTL). */
  cachedAt: number;
  /** When the upstream really answered (never moves on a stale read). */
  fetchedAt: number;
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

function warn(message: string): void {
  console.warn(`[wechat2rss] ${message}`);
}

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
        } catch (error) {
          warn(`${adapter.name} search threw: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return [];
  }

  /**
   * 获取公众号文章与元数据。
   * 返回值的 status 明确区分 ok / empty / stale；只有 mp_id 身份（可信账号主键）默认通过，
   * 仅展示名称匹配的结果被拒收并计入 droppedUnverified。
   * 全部适配器失败但有旧缓存时返回 stale（保留真实 fetchedAt），否则返回 null。
   */
  async fetchAccountArticles(
    accountIdentifier: string,
    opts: { force?: boolean; limit?: number; allowDisplayNameIdentity?: boolean } = {}
  ): Promise<WechatAdapterResult | null> {
    const resolvedName = this.resolveAccountName(accountIdentifier);
    const cacheKey = resolvedName.toLowerCase();

    // 检查缓存（TTL 内直接复用；stale 读取不会刷新 cachedAt）
    if (!opts.force) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < this.cacheTtlMs) {
        return { ...cached.result, status: cached.result.status ?? "ok", fetchedAt: cached.fetchedAt };
      }
    }

    let droppedUnverified = 0;
    for (const adapter of this.adapters) {
      let result: WechatAdapterResult | null;
      try {
        result = await adapter.getArticles(resolvedName, opts.limit || 15);
      } catch (error) {
        warn(`${adapter.name} getArticles threw: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!result) continue;
      droppedUnverified += result.droppedUnverified ?? 0;

      const identity = result.identity ?? "unknown";
      const trusted = identity === "mp_id" || (identity === "display_name" && opts.allowDisplayNameIdentity === true);
      if (!trusted) {
        // 身份无法确认：不接收。展示名称只能作为辅助证据，不能作为唯一官方身份凭据。
        droppedUnverified += result.articles.length;
        warn(`${adapter.name} returned ${result.articles.length} article(s) for "${resolvedName}" with identity=${identity}; rejected`);
        continue;
      }
      if (result.articles.length === 0 && result.status !== "empty") continue;

      const status = result.status ?? (result.articles.length > 0 ? "ok" : "empty");
      const fetchedAt = result.fetchedAt ?? Date.now();
      const accepted: WechatAdapterResult = { ...result, status, fetchedAt, droppedUnverified };
      this.cache.set(cacheKey, {
        result: accepted,
        rssXml: generateRssFeed(accepted.account, accepted.articles),
        cachedAt: Date.now(),
        fetchedAt,
      });
      return accepted;
    }

    // 全部适配器失败/无可用结果：有旧缓存则降级返回（绝不刷新其真实抓取时间）。
    const stale = this.cache.get(cacheKey);
    if (stale) {
      warn(`all adapters failed for "${resolvedName}"; serving cache fetched at ${new Date(stale.fetchedAt).toISOString()}`);
      return { ...stale.result, status: "stale", fetchedAt: stale.fetchedAt, droppedUnverified };
    }
    warn(`all adapters failed for "${resolvedName}" and no cache is available`);
    return null;
  }

  /**
   * 采集入口读取的 feed：status/fetchedAt 如实反映上游结果。公开订阅仍可展示缓存，但调用方
   * （采集路径）能据此识别降级，不会把缓存当成新一轮成功。
   */
  async getFeed(
    accountIdentifier: string,
    opts: { force?: boolean; feedOptions?: FeedOptions } = {}
  ): Promise<WechatFeed> {
    const resolvedName = this.resolveAccountName(accountIdentifier);
    const cacheKey = resolvedName.toLowerCase();
    const result = await this.fetchAccountArticles(accountIdentifier, opts);

    if (!result) {
      throw new Error(`wechat bridge: upstream unavailable and no cache for "${resolvedName}"`);
    }
    const status = result.status ?? "ok";
    const fetchedAt = result.fetchedAt ?? Date.now();
    if (status === "stale") {
      const cached = this.cache.get(cacheKey);
      return {
        xml: cached?.rssXml ?? generateRssFeed(result.account, result.articles, opts.feedOptions),
        status,
        fetchedAt,
        degraded: true,
        droppedUnverified: result.droppedUnverified ?? 0,
      };
    }
    // ok / empty：更新缓存（cachedAt=now，fetchedAt 保留真实上游时间）。
    const thisEntry = this.cache.get(cacheKey);
    const xml = thisEntry && thisEntry.fetchedAt === fetchedAt
      ? thisEntry.rssXml
      : generateRssFeed(result.account, result.articles, opts.feedOptions);
    this.cache.set(cacheKey, {
      result,
      rssXml: xml,
      cachedAt: Date.now(),
      fetchedAt,
    });
    return { xml, status, fetchedAt, degraded: false, droppedUnverified: result.droppedUnverified ?? 0 };
  }

  /**
   * 生成公众号的标准 RSS 2.0 XML（公开订阅出口：降级时展示缓存，不抛错）
   */
  async getRssXml(
    accountIdentifier: string,
    opts: { force?: boolean; feedOptions?: FeedOptions } = {}
  ): Promise<string> {
    return (await this.getFeed(accountIdentifier, opts)).xml;
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

export interface WechatAccount {
  id: string; // 唯一标识（例如公众号ID、微信号或slug）
  name: string; // 公众号名称（例如 "KPL王者荣耀职业联赛"）
  nickname?: string;
  ghid?: string; // 原始ID（gh_开头）
  avatar?: string; // 头像URL
  description?: string; // 公众号简介
  url?: string; // 公众号主页或参考URL
}

export interface WechatArticle {
  id: string; // 唯一标识（如文章doc_id、mid_idx或URL hash）
  title: string; // 文章标题
  url: string; // 文章永久链接
  author?: string | null; // 文章作者
  description?: string | null; // 摘要
  contentHtml?: string | null; // 清洗后的正文HTML（已修复防盗链）
  contentText?: string | null; // 纯文本正文
  coverUrl?: string | null; // 封面图URL
  publishedAt: Date; // 发布时间
  extra?: Record<string, unknown>; // 扩展元数据
}

/**
 * 采集结果的性质。
 * - ok：上游正常返回了文章
 * - empty：上游正常返回、确实没有文章（可验证的空结果，不等于抓取失败）
 * - stale：适配器全部失败后，由桥返回旧缓存（降级，不代表新鲜）
 */
export type WechatFetchStatus = "ok" | "empty" | "stale";

/**
 * 账号身份的建立方式。
 * - mp_id：通过平台/服务商的账号主键（微信读书 mpId、Dajiala ghid）确认，可信
 * - display_name：只有展示名称匹配，不足以单独证明是官方账号
 * - unknown：缺失身份信息
 */
export type WechatIdentity = "mp_id" | "display_name" | "unknown";

export interface WechatAdapterResult {
  account: WechatAccount;
  articles: WechatArticle[];
  /** ok：上游返回了文章；empty：上游返回且确认为空；stale：缓存降级（仅桥内部使用）。 */
  status?: WechatFetchStatus;
  /** 真正产出 articles 的上游响应时间（epoch ms），绝不等于读取缓存的时间。 */
  fetchedAt?: number;
  /** 账号身份的建立方式；缺失视为 unknown，不得默认通过官方校验。 */
  identity?: WechatIdentity;
  /** 适配器返回过、但因身份无法确认而被拒收的文章数（用于排查）。 */
  droppedUnverified?: number;
}

export interface WechatAdapter {
  readonly name: string;
  search?(keyword: string): Promise<WechatAccount[]>;
  getArticles(accountIdentifier: string, limit?: number): Promise<WechatAdapterResult | null>;
}

export interface FeedOptions {
  feedUrl?: string;
  siteUrl?: string;
  ttlMinutes?: number;
  language?: string;
}

/** 采集入口读取的 feed：保留真实的上游时间与降级状态，展示可用性不冒充采集成功。 */
export interface WechatFeed {
  xml: string;
  status: WechatFetchStatus;
  /** 真实上游获取时间（epoch ms）；stale 时仍是当初成功抓取的时间。 */
  fetchedAt: number;
  /** status === "stale" 的便捷判断。 */
  degraded: boolean;
  /** 身份无法确认而被拒收的文章数。 */
  droppedUnverified: number;
}

/** 归一化账号名，用于精确比较（去空格、全角括号备注、大小写）。 */
export function normalizeAccountName(name: string): string {
  return name
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .trim();
}

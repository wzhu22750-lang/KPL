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

export interface WechatAdapterResult {
  account: WechatAccount;
  articles: WechatArticle[];
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

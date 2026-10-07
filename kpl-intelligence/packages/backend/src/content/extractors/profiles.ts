// SourceContentProfile：来源差异的单一声明处。
// 新增一个来源 ≈ 新增一个 Profile（+ 可选 Adapter），而不是在系统里散落 if (hostname)。
// transport（rss/json_list/web_list 如何发现）与 content type（它到底是什么）在此彻底分开。
import type { ContentKind } from "./types.ts";

export type ContentFamily = "publisher" | "official" | "forum" | "social" | "video" | "blog" | "aggregator" | "unknown";

export type Presentation = "article" | "thread" | "social" | "video" | "announcement";

export interface SourceContentProfile {
  id: string;
  match: {
    sourceIds?: string[];
    hostnames?: string[];
    urlPatterns?: RegExp[];
  };
  contentFamily: ContentFamily;
  preferredExtractor: string;
  supports: {
    fullText: boolean;
    images: boolean;
    author: boolean;
    comments: boolean;
    nestedReplies: boolean;
    engagement: boolean;
    videoMeta: boolean;
  };
  presentation: Presentation;
  /** 评论排名默认保留的高价值回复数（不足时有多少收多少）。 */
  highlightLimit?: number;
}

const BUILT_IN: SourceContentProfile[] = [
  {
    id: "wechat-mp",
    match: { hostnames: ["mp.weixin.qq.com", "mp.weixin.qq.cn"] },
    contentFamily: "official",
    preferredExtractor: "wechat",
    supports: { fullText: true, images: true, author: true, comments: false, nestedReplies: false, engagement: false, videoMeta: false },
    presentation: "article",
  },
  {
    id: "hupu-forum",
    match: { hostnames: ["bbs.hupu.com", "hupu.com"] },
    contentFamily: "forum",
    preferredExtractor: "hupu",
    supports: { fullText: true, images: true, author: true, comments: true, nestedReplies: true, engagement: true, videoMeta: false },
    presentation: "thread",
    highlightLimit: 8,
  },
  {
    id: "bilibili",
    match: { hostnames: ["bilibili.com", "www.bilibili.com", "b23.tv"] },
    contentFamily: "video",
    preferredExtractor: "bilibili",
    supports: { fullText: false, images: true, author: true, comments: true, nestedReplies: false, engagement: true, videoMeta: true },
    presentation: "video",
    highlightLimit: 5,
  },
  {
    id: "x-social",
    match: { hostnames: ["x.com", "twitter.com"] },
    contentFamily: "social",
    preferredExtractor: "social",
    supports: { fullText: true, images: true, author: true, comments: false, nestedReplies: false, engagement: true, videoMeta: true },
    presentation: "social",
  },
];

/** 论坛族缺省 profile：新论坛来源无需专用 adapter 也能走 thread 结构。 */
const FORUM_FALLBACK: SourceContentProfile = {
  id: "generic-forum",
  match: {},
  contentFamily: "forum",
  preferredExtractor: "forum",
  supports: { fullText: true, images: true, author: true, comments: true, nestedReplies: true, engagement: true, videoMeta: false },
  presentation: "thread",
  highlightLimit: 6,
};

const UNKNOWN: SourceContentProfile = {
  id: "unknown",
  match: {},
  contentFamily: "unknown",
  preferredExtractor: "generic-article",
  supports: { fullText: true, images: true, author: true, comments: false, nestedReplies: false, engagement: false, videoMeta: false },
  presentation: "article",
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

function matches(p: SourceContentProfile, sourceId: string | null, url: string): boolean {
  const { sourceIds, hostnames, urlPatterns } = p.match;
  if (sourceIds?.length && sourceId && sourceIds.includes(sourceId)) return true;
  if (hostnames?.length) {
    const host = hostOf(url);
    if (host && hostnames.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`))) return true;
  }
  if (urlPatterns?.length && urlPatterns.some((re) => re.test(url))) return true;
  return false;
}

/**
 * A source's own config may name a profile (`contentProfile: "wechat-mp"`) or override the family
 * (`contentFamily: "forum"` → the generic forum extractor). Built-ins match by hostname first:
 * discovery transport (rss / json_list / web_list) never decides what the content is.
 */
export function profileFor(input: { sourceId?: string | null; url: string; kind?: string | null; config?: Record<string, any> | null }): SourceContentProfile {
  const { sourceId, url, kind, config } = input;
  if (config?.contentProfile) {
    const named = BUILT_IN.find((p) => p.id === config.contentProfile);
    if (named) return named;
  }
  const bySourceOrHost = BUILT_IN.find((p) => matches(p, sourceId ?? null, url));
  if (bySourceOrHost) {
    // A source whose ids match a built-in but whose family is overridden (a hupu-shaped board on
    // another host, a json_list of bilibili links) keeps the built-in's extractor mapping.
    if (config?.contentFamily && config.contentFamily !== bySourceOrHost.contentFamily) {
      return withFamily(bySourceOrHost, config.contentFamily);
    }
    return bySourceOrHost;
  }
  if (config?.contentProfile === "forum" || config?.contentFamily === "forum") return FORUM_FALLBACK;
  if (kind === "x_search") return BUILT_IN[3]!;
  return UNKNOWN;
}

function withFamily(base: SourceContentProfile, family: ContentFamily): SourceContentProfile {
  if (family === "forum") return { ...FORUM_FALLBACK, id: `${base.id}-as-forum` };
  return { ...base, id: `${base.id}-as-${family}`, contentFamily: family };
}

/** The extraction chain position the profile asks for first. */
export function preferredExtractorOf(p: SourceContentProfile): string {
  return p.preferredExtractor;
}

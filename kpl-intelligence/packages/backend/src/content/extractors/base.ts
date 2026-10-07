// Extractor 接口与公共工具：canHandle → extract → CanonicalContent。
// 执行优先级（registry 按 preferredExtractor 排序后落到这里约定）：
//   Source-specific → Content-family → Generic article → Readability（generic 内部兜底）→ Jina（extract.ts 兜底）
import type { SourceContentProfile } from "./profiles.ts";
import type { CanonicalContent, ContentKind } from "./types.ts";

export interface ExtractionInput {
  url: string;
  /** 已经抓到的页面 HTML（detail fetch 复用字节时非空；extract 队列先抓后传）。 */
  html: string | null;
  profile: SourceContentProfile;
  sourceId: string | null;
  sourceKind: string | null;
  /** listing/数据库已知的线索，extractor 不得把它们当正文。 */
  title: string | null;
  excerpt: string | null;
  author: string | null;
  publishedAt: Date | null;
  /** X 帖子的结构化数据（x_search 来源）。 */
  xPost: Record<string, any> | null;
  /** listing 的 raw（externalId 等）。 */
  raw: unknown;
  /** 来源 config（threadSelectors 等 extractor 专用配置从这里读）。 */
  sourceConfig: Record<string, any> | null;
  /** extractor 需要的受限 JSON 抓取（B站 view API）；离线测试为 null。 */
  fetchJson: ((url: string) => Promise<unknown>) | null;
}

export interface ContentExtractor {
  id: string;
  version: string;
  canHandle(input: ExtractionInput): boolean;
  extract(input: ExtractionInput): Promise<CanonicalContent | null>;
}

// ---------------------------------------------------------------------------
// detectContentKind：内容类型由 来源 profile + 页面信号 共同判断，不只看 sourceId。
// ---------------------------------------------------------------------------

const ANNOUNCE_WORDS = /公告|通知|声明|处罚|罚单|禁赛|官方声明|关于.{0,20}的?(通知|公告)/;
const INTERVIEW_WORDS = /专访|采访|对话|Q&A|问答|声音|我们和.{0,12}聊了/;
const ANALYSIS_WORDS = /复盘|战术|分析|解读|深度|前瞻|评分|打法|体系|数据贴|战术板|赛后小结/;
const NEWS_WORDS = /快讯|官宣|正式|首发|名单|签下|加盟|续约|伤退|获胜|战胜|不敌|夺得|夺冠/;

/**
 * kind + 置信度：采访/分析等强信号只看标题（正文词太容易误命中，"体系/解读"满篇都是）；
 * 公告词允许出现在首段（官方公告常把"公告"写在正文首句）；结构说了算的 forum/social/video
 * 由 extractor 直接给出 kind，不经过这里。
 */
export function detectContentKind(input: { profile: SourceContentProfile; title: string | null; text: string | null; html: string | null }): { kind: ContentKind; confidence: number } {
  const { profile, title, text } = input;
  const head = `${title ?? ""}\n${text?.slice(0, 300) ?? ""}`;
  if (profile.contentFamily === "official" && ANNOUNCE_WORDS.test(head)) {
    return { kind: "official_announcement", confidence: (text?.length ?? 0) > 0 && (text?.length ?? 0) <= 800 ? 0.9 : 0.7 };
  }
  if (title && INTERVIEW_WORDS.test(title)) return { kind: "interview", confidence: 0.75 };
  if (title && ANALYSIS_WORDS.test(title)) return { kind: "analysis", confidence: 0.7 };
  if (profile.contentFamily === "official") return { kind: "article", confidence: 0.5 };
  if (profile.contentFamily === "publisher" || profile.contentFamily === "aggregator" || profile.contentFamily === "blog") {
    return { kind: title && NEWS_WORDS.test(title) ? "news" : "article", confidence: 0.6 };
  }
  return { kind: "unknown", confidence: 0.3 };
}

// ---------------------------------------------------------------------------
// 共用小工具
// ---------------------------------------------------------------------------

/** 页面的 JSON-LD 块（@graph 与数组递归展开）。 */
export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      out.push(JSON.parse(m[1]!.trim()));
    } catch {
      // a broken block: the next one may still parse
    }
  }
  return out;
}

/** 在任意 JSON 结构里按谓词收集（@graph/数组递归，限深）。 */
export function collectBy(root: unknown, pred: (o: Record<string, unknown>) => boolean, depth = 0, acc: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (depth > 8 || root === null || typeof root !== "object") return acc;
  if (Array.isArray(root)) {
    for (const x of root) collectBy(x, pred, depth + 1, acc);
    return acc;
  }
  const o = root as Record<string, unknown>;
  if (pred(o)) acc.push(o);
  for (const v of Object.values(o)) collectBy(v, pred, depth + 1, acc);
  return acc;
}

const TEXT_OF = (v: unknown): string | null => {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (Array.isArray(v) && v.length && typeof v[0] === "string") return v[0]!.trim() || null;
  if (v && typeof v === "object" && typeof (v as Record<string, unknown>).name === "string") return (v as { name: string }).name.trim() || null;
  return null;
};

/** JSON-LD / meta 的发布时间。 */
export function ldPublished(o: Record<string, unknown> | null): string | null {
  if (!o) return null;
  const v = o.datePublished ?? o.dateCreated ?? o.uploadDate;
  const s = TEXT_OF(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** <meta property/name/itemprop="key" content="…"> 的值（静态正则 + match，无动态拼接）。 */
export function metaContent(html: string, key: string): string | null {
  for (const m of html.matchAll(/<meta[^>]+>/gi)) {
    const tag = m[0];
    const keyMatch = tag.match(/(?:property|name|itemprop)=["']([^"']+)["']/i);
    if (!keyMatch || keyMatch[1]!.toLowerCase() !== key.toLowerCase()) continue;
    const content = tag.match(/content=["']([^"']*)["']/i);
    if (content?.[1]?.trim()) return content[1]!.trim();
  }
  return null;
}

export { TEXT_OF as textOfJsonLd };

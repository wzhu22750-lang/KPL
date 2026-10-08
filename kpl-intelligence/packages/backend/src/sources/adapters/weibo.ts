// WeiboAdapter：基于 m.weibo.cn 移动端轻量接口的微博 Social Source Adapter
// 1. 全自动协商 Sina Visitor System 访客 Cookie（无账号密码依赖、无浏览器重型常驻）
// 2. 支持博主主页模式（UID），自动化管理游标（since_id / lastMid）
// 3. 产出标准化 CanonicalContent (social_post)，包含九宫格原图矩阵与转评赞互动量
// 4. 实体绑定感知（战队/选手）与真实发布时间保真
import { guardedFetch } from "../../lib/http-fetch.ts";
import { observedCounter } from "../../content/engagement.ts";
import { collapseWhitespace, stripTags } from "../../lib/text.ts";
import { decideTimeline, type MaterialInput, type TimelineDecision } from "../../content/materials.ts";
import { ENTITIES } from "@aihot/industry/taxonomy";
import type { CanonicalContent, ImageBlock } from "../../content/extractors/types.ts";
import type { Candidate, SourceRow } from "../types.ts";
import { BaseSourceAdapter } from "./base.ts";
import type {
  AdapterCollectOptions,
  AdapterCollectResult,
  AdapterCursor,
  EntityHint,
} from "./types.ts";

/** 微博原始数据结构定义 */
export interface WeiboRawUser {
  id: number | string;
  screen_name: string;
  profile_image_url?: string;
  avatar_hd?: string;
  description?: string;
  followers_count?: number;
  verified?: boolean;
}

export interface WeiboRawPic {
  pid: string;
  url: string;
  large?: { url: string; width: number; height: number };
  geo?: { width: number; height: number };
}

export interface WeiboRawMblog {
  id: string;
  mid?: string;
  bid: string;
  created_at: string;
  text: string;
  textLength?: number;
  source?: string;
  user?: WeiboRawUser;
  attitudes_count?: number;
  comments_count?: number;
  reposts_count?: number;
  pics?: WeiboRawPic[];
  page_info?: {
    type?: string;
    media_info?: {
      stream_url?: string;
      duration?: number;
    };
  };
  retweeted_status?: WeiboRawMblog;
  isLongText?: boolean;
}

/** 微博移动端访客 Cookie 协商管理器（进程级单例，内存缓存与自动续期） */
export class WeiboVisitorSession {
  private static instance: WeiboVisitorSession;
  private cookieStr: string | null = null;
  private expiresAt = 0;
  private inflight: Promise<string> | null = null;

  static getInstance(): WeiboVisitorSession {
    if (!WeiboVisitorSession.instance) {
      WeiboVisitorSession.instance = new WeiboVisitorSession();
    }
    return WeiboVisitorSession.instance;
  }

  async getCookie(forceRefresh = false): Promise<string> {
    const now = Date.now();
    if (!forceRefresh && this.cookieStr && now < this.expiresAt) {
      return this.cookieStr;
    }
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.negotiateVisitorCookie();
    try {
      this.cookieStr = await this.inflight;
      // 成功后缓存 12 小时（微博官方访客凭证有效期通常为数天）
      this.expiresAt = Date.now() + 12 * 3600 * 1000;
      return this.cookieStr;
    } finally {
      this.inflight = null;
    }
  }

  private async negotiateVisitorCookie(): Promise<string> {
    const url = "https://visitor.passport.weibo.cn/visitor/genvisitor2";
    const body = `cb=visitor_gray_callback&ver=20250916&request_id=3a68e657c02b556afd832759fde330f0&tid=&from=weibo&webdriver=false&rid=${Date.now()}&return_url=https%3A%2F%2Fm.weibo.cn%2F`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": "https://visitor.passport.weibo.cn/visitor/visitor?entry=sinawap&a=enter&url=https%3A%2F%2Fm.weibo.cn%2F&domain=.weibo.cn&ua=php-sso_sdk_client-0.6.36",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status !== 200) {
      throw new Error(`Weibo visitor negotiation failed with HTTP ${res.status}`);
    }

    const text = await res.text();
    const subMatch = text.match(/"sub"\s*:\s*"([^"]+)"/);
    const subpMatch = text.match(/"subp"\s*:\s*"([^"]+)"/);

    if (!subMatch?.[1] || !subpMatch?.[1]) {
      throw new Error("Weibo visitor response did not yield required tokens");
    }

    return `SUB=${subMatch[1]}; SUBP=${subpMatch[1]}`;
  }
}

const WEIBO_UTC_OFFSET_MIN = 480; // m.weibo.cn renders times in Asia/Shanghai (+08:00)
const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** A +08:00 wall-clock time as an absolute instant: the server's own timezone must not matter. */
function fromBeijingWallClock(year: number, month: number, day: number, hour: number, minute: number, second = 0): Date {
  return new Date(Date.UTC(year, month, day, hour, minute, second) - WEIBO_UTC_OFFSET_MIN * 60_000);
}
function beijingParts(at: Date): { year: number; month: number; day: number } {
  const shifted = new Date(at.getTime() + WEIBO_UTC_OFFSET_MIN * 60_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/**
 * 微博时间戳。无法识别的形态返回 null：未知的发布时间必须保持未知，绝不能用抓取时间冒充
 * （发现时间由 decideTimeline / discovered_at 另行记录）。
 * 相对时间与 "昨天" 按平台时区（+08:00）换算，不依赖运行机器的本地时区。
 */
export function parseWeiboDate(dateStr: string, now = new Date()): Date | null {
  const trimmed = String(dateStr ?? "").trim();
  if (!trimmed) return null;

  // 1. "Wed Oct 07 15:26:20 +0800 2026"（移动端接口原生格式，年份在时区之后）。
  const native = trimmed.match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([+-]\d{4})\s+(\d{4})$/);
  if (native) {
    const month = MONTHS[native[1]!.toLowerCase()];
    if (month !== undefined) {
      const sign = native[6]!.startsWith("-") ? -1 : 1;
      const offsetMin = sign * (Number(native[6]!.slice(1, 3)) * 60 + Number(native[6]!.slice(3, 5)));
      const d = new Date(Date.UTC(Number(native[7]), month, Number(native[2]), Number(native[3]), Number(native[4]), Number(native[5])) - offsetMin * 60_000);
      if (Number.isFinite(d.getTime())) return d;
    }
  }

  // 2. 相对时间：绝对偏移，与时区无关。
  if (trimmed.includes("刚刚")) return new Date(now.getTime());
  const seconds = trimmed.match(/^(\d+)\s*秒前/);
  if (seconds) return new Date(now.getTime() - Number(seconds[1]) * 1000);
  const minutes = trimmed.match(/^(\d+)\s*分钟前/);
  if (minutes) return new Date(now.getTime() - Number(minutes[1]) * 60_000);
  const hours = trimmed.match(/^(\d+)\s*小时前/);
  if (hours) return new Date(now.getTime() - Number(hours[1]) * 3_600_000);

  // 3. "今天/昨天 HH:mm"：按平台时区的当天，而非服务器当天。
  const relativeDay = trimmed.match(/^(今天|昨天)\s*(\d{1,2}):(\d{1,2})/);
  if (relativeDay) {
    const p = beijingParts(now);
    const back = relativeDay[1] === "昨天" ? 1 : 0;
    return fromBeijingWallClock(p.year, p.month, p.day - back, Number(relativeDay[2]), Number(relativeDay[3]));
  }

  // 4. "MM-DD HH:mm"（当年）。落在未来的一天以上说明是去年，不当作未来发布时间。
  const monthDay = trimmed.match(/^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (monthDay) {
    const p = beijingParts(now);
    const month = Number(monthDay[1]) - 1;
    const day = Number(monthDay[2]);
    let d = fromBeijingWallClock(p.year, month, day, Number(monthDay[3]), Number(monthDay[4]));
    if (d.getTime() > now.getTime() + 24 * 3_600_000) d = fromBeijingWallClock(p.year - 1, month, day, Number(monthDay[3]), Number(monthDay[4]));
    return d;
  }

  // 5. 显式年份，按 +08:00 墙上时间解释。
  const explicit = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (explicit) {
    return fromBeijingWallClock(Number(explicit[1]), Number(explicit[2]) - 1, Number(explicit[3]), Number(explicit[4] ?? 0), Number(explicit[5] ?? 0), Number(explicit[6] ?? 0));
  }

  // 6. 仅当字符串自带时区时才交给通用解析器，绝不按本地时区解释无时区的时间。
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const t = Date.parse(trimmed);
    if (Number.isFinite(t)) return new Date(t);
  }
  return null;
}

/** 微博正文深度清洗与末尾截断净化：剥离 HTML 标签，彻底消除 "... 全文" 及末尾悬空省略号 */
export function cleanWeiboText(raw: string): string {
  if (!raw) return "";
  let s = raw;
  // Only remove a button's own label; a link that discusses 全文 is still content.
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (link, inner: string) =>
    /^(?:展开全文|查看全文|阅读全文|全文|展开)$/.test(collapseWhitespace(inner.replace(/<[^>]+>/g, "")).trim()) ? "" : link);
  // 2. 换行与标签处理
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  // 3. 常见 html 实体还原
  s = s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  // Find the finite label first. Nested nullable repetitions here used to freeze the worker on
  // ordinary whitespace runs (verified by a live CPU profile); never repeat a nullable branch.
  s = s.trimEnd();
  const label = /(?:展开全文|查看全文|阅读全文|全文|展开)$/.exec(s);
  if (label) {
    const prefix = s.slice(0, label.index), trimmed = prefix.trimEnd();
    if (prefix !== trimmed || trimmed.endsWith('…') || trimmed.endsWith('...')) s = trimmed;
  }
  // Linear backwards scan, preserving ordinary one/two-dot punctuation.
  let end = s.length;
  while (end > 0 && (s[end - 1] === '.' || s[end - 1] === '…')) end -= 1;
  if (s.slice(end).includes('…') || s.length - end >= 3) s = s.slice(0, end);
  // 6. 折叠多余空白
  return collapseWhitespace(s).trim();
}

/** 提取博文标题（提取话题标签或截取正文首句） */
export function extractWeiboHeadline(cleanText: string): string {
  // 优先匹配首个话题：如 #2026KPL年总赛程#
  const topicMatch = cleanText.match(/#([^#]+)#/);
  if (topicMatch?.[1]) {
    const topic = topicMatch[1].trim();
    if (topic.length >= 4 && topic.length <= 40) {
      return topic;
    }
  }
  // 兜底截取首段首句（最多45字符）
  const firstLine = cleanText.split("\n")[0]?.trim() || cleanText;
  if (firstLine.length <= 45) return firstLine;
  return firstLine.slice(0, 42) + "…";
}

/** 一页微博的解析结果：博文 + 服务端给出的“更旧一页”游标。 */
export interface WeiboPageData {
  ok: number;
  status?: number;
  data?: { cards?: unknown[]; cardlistInfo?: { since_id?: unknown }; since_id?: unknown };
}

/** 从 cards 里取出博文（含 card_group 子卡片）。 */
export function extractMblogs(cards: unknown[] | undefined): WeiboRawMblog[] {
  const out: WeiboRawMblog[] = [];
  for (const card of cards ?? []) {
    const c = card as { mblog?: WeiboRawMblog; card_group?: Array<{ mblog?: WeiboRawMblog }> };
    if (c?.mblog) out.push(c.mblog);
    else if (Array.isArray(c?.card_group)) for (const sub of c.card_group) if (sub?.mblog) out.push(sub.mblog);
  }
  return out;
}

/** 服务端的分页 token（cardlistInfo.since_id）：空表示没有更旧的一页。 */
export function weiboPageToken(data: WeiboPageData["data"]): string | null {
  const token = data?.cardlistInfo?.since_id ?? data?.since_id;
  return token === undefined || token === null || token === "" ? null : String(token);
}

/** 微博 id 是数字字符串；比 watermark 新才算新内容。非数字 id 绝不误判为新。 */
export function weiboIdGreater(id: string, watermark: string | null): boolean {
  if (!watermark) return true;
  try {
    return BigInt(id) > BigInt(watermark);
  } catch {
    return false;
  }
}

/** 每轮最多读几页（配置 maxPages 可覆盖）：过去一周回溯默认允许翻到 10 页。 */
const WEIBO_PAGE_BUDGET = 10;

export class WeiboAdapter extends BaseSourceAdapter<WeiboRawMblog> {
  readonly kind = "weibo";
  private session = WeiboVisitorSession.getInstance();

  supports(source: SourceRow): boolean {
    return source.kind === "weibo" || source.config?.platform === "weibo";
  }

  /**
   * 抓取阶段：
   * 1. 支持模式 A（默认）：按博主 UID 拉取主页微博，支持过去 7 天时间窗口自动穿透
   * 2. 支持模式 B：按超话/战队关键词拉取社区讨论（mode === 'topic' || mode === 'search' || query）
   */
  async collect(
    source: SourceRow,
    cursor: AdapterCursor = {},
    _opts?: AdapterCollectOptions,
  ): Promise<AdapterCollectResult<WeiboRawMblog>> {
    const isSearchMode = source.config?.mode === "topic" || source.config?.mode === "search" || !!source.config?.query;
    if (isSearchMode) {
      return this.collectSearchTopic(source, cursor);
    }
    return this.collectUserTimeline(source, cursor);
  }

  /**
   * 模式 A：官方博主时间线抓取（带过去一周时间窗口）
   */
  private async collectUserTimeline(
    source: SourceRow,
    cursor: AdapterCursor = {},
  ): Promise<AdapterCollectResult<WeiboRawMblog>> {
    const uid = String(source.config?.uid || source.config?.owner_entity_id || "").trim();
    if (!uid) {
      throw new Error(`WeiboAdapter: source ${source.id} missing required 'uid' in config`);
    }
    const maxPages = Math.max(1, Number(source.config?.maxPages ?? WEIBO_PAGE_BUDGET));
    const timeWindowDays = Math.max(1, Number(source.config?.timeWindowDays ?? 7)); // 默认过去 7 天
    const cutoffMs = Date.now() - timeWindowDays * 24 * 3600 * 1000;
    const watermark = cursor?.lastMid ? String(cursor.lastMid) : null;

    let cookie = await this.session.getCookie();
    let containerid = source.config?.containerid || (await this.fetchUserContainerId(uid, cookie));

    const rawItems: WeiboRawMblog[] = [];
    const seen = new Set<string>();
    let token: string | null = null;
    let pages = 0;
    let reachedWatermark = false;
    let reachedEnd = false;
    let reachedTimeCutoff = false;
    let truncated = false;
    let incompleteReason: string | undefined;

    for (;;) {
      if (pages >= maxPages) {
        truncated = true;
        break;
      }
      const requested: string | null = pages === 0 ? null : token;
      let page = await this.fetchMblogPage(uid, containerid, cookie, requested);
      if (!page.ok && pages === 0) {
        cookie = await this.session.getCookie(true);
        containerid = source.config?.containerid || (await this.fetchUserContainerId(uid, cookie));
        page = await this.fetchMblogPage(uid, containerid, cookie, requested);
      }
      if (!page.ok) {
        if (pages === 0) throw new Error(`WeiboAdapter: failed to fetch mblogs for UID ${uid}, response not ok (HTTP ${page.status ?? "?"})`);
        truncated = true;
        incompleteReason = `Weibo profile page ${pages + 1} failed (HTTP ${page.status ?? "unknown"})`;
        break;
      }
      pages += 1;
      const pageBlogs = extractMblogs(page.data?.cards);
      for (const m of pageBlogs) {
        if (!m?.id || seen.has(String(m.id))) continue;
        seen.add(String(m.id));
        // 若博文标记为长文本，自动请求展开后的完整原文
        if (m.isLongText) {
          const fullText = await this.fetchLongText(String(m.id), cookie);
          if (fullText) m.text = fullText;
        }
        if (m.retweeted_status?.isLongText && m.retweeted_status?.id) {
          const fullRt = await this.fetchLongText(String(m.retweeted_status.id), cookie);
          if (fullRt) m.retweeted_status.text = fullRt;
        }
        rawItems.push(m);
      }

      // 时间窗口检查：如果本页最旧的一条博文时间已经早于 7 天前截止时间，停止翻页
      const pageOldest = pageBlogs.length ? pageBlogs[pageBlogs.length - 1] : null;
      if (pageOldest) {
        const pubDate = parseWeiboDate(pageOldest.created_at);
        if (pubDate && pubDate.getTime() < cutoffMs) {
          reachedTimeCutoff = true;
        }
        if (watermark && !weiboIdGreater(String(pageOldest.id), watermark)) {
          reachedWatermark = true;
        }
      }

      const next = weiboPageToken(page.data);
      if (!next || next === requested) {
        reachedEnd = true;
        break;
      }
      token = next;
      if (reachedWatermark || reachedTimeCutoff) break;
    }

    // 过滤超出 7 天时间窗口的历史博文，精准锁定过去一周
    const filteredItems = rawItems.filter((m) => {
      const pub = parseWeiboDate(m.created_at);
      return !pub || pub.getTime() >= cutoffMs;
    });

    const newest = filteredItems.reduce<string | null>((max, m) => (weiboIdGreater(String(m.id), max) ? String(m.id) : max), watermark);
    const caughtUp = reachedWatermark || reachedEnd || reachedTimeCutoff;
    return {
      rawItems: filteredItems,
      nextCursor: {
        ...cursor,
        containerid,
        lastMid: newest ?? cursor?.lastMid,
        ...(caughtUp ? { pageSinceId: null } : { pageSinceId: token }),
        lastFetchAt: new Date().toISOString(),
      },
      detail: { capability: "account_posts", coverage: incompleteReason ? "partial" : truncated ? "bounded" : "complete", uid, pages, extractedMblogs: filteredItems.length, truncated, reachedEnd, reachedWatermark, reachedTimeCutoff },
      incompleteReason,
    };
  }

  /**
   * 模式 B：俱乐部超话与社区舆论搜索抓取
   */
  private async collectSearchTopic(
    source: SourceRow,
    cursor: AdapterCursor = {},
  ): Promise<AdapterCollectResult<WeiboRawMblog>> {
    const query = String(source.config?.query || source.name).trim();
    const maxPages = Math.max(1, Math.min(Number(source.config?.maxPages ?? 3), 6));
    const timeWindowDays = Math.max(1, Number(source.config?.timeWindowDays ?? 7));
    const cutoffMs = Date.now() - timeWindowDays * 24 * 3600 * 1000;
    const cookie = await this.session.getCookie();

    const rawItems: WeiboRawMblog[] = [];
    const seen = new Set<string>();
    let pages = 0;
    let ended = false;
    let incompleteReason: string | undefined;

    for (let p = 1; p <= maxPages; p++) {
      const searchUrl = `https://m.weibo.cn/api/container/getIndex?containerid=100103type%3D1%26q%3D${encodeURIComponent(query)}&page_type=searchall&page=${p}`;
      let blogs: WeiboRawMblog[];
      try {
        const res = await fetch(searchUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
            "Cookie": cookie,
            "Accept": "application/json, text/plain, */*",
            "MWeibo-Pwa": "1",
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const json = await res.json() as WeiboPageData;
        if (json.ok !== 1 || !Array.isArray(json.data?.cards)) throw new Error("invalid or rejected search response");
        blogs = extractMblogs(json.data.cards);
        pages += 1;
      } catch (error) {
        const reason = error instanceof Error && /^HTTP \d+$/.test(error.message) ? error.message : "unavailable or invalid response";
        incompleteReason = `Weibo keyword search page ${p} failed: ${reason}`;
        if (p === 1) throw new Error(incompleteReason);
        break;
      }
      if (!blogs.length) { ended = true; break; }

      for (const m of blogs) {
        if (!m?.id || seen.has(String(m.id))) continue;
        seen.add(String(m.id));
        // 自动展开长文
        if (m.isLongText) {
          const fullText = await this.fetchLongText(String(m.id), cookie);
          if (fullText) m.text = fullText;
        }
        rawItems.push(m);
      }
    }

    // 过滤出过去一周内的有效博文
    const filtered = rawItems.filter((m) => {
      const pub = parseWeiboDate(m.created_at);
      return !pub || pub.getTime() >= cutoffMs;
    });

    return {
      rawItems: filtered,
      nextCursor: {
        ...cursor,
        lastFetchAt: new Date().toISOString(),
      },
      detail: { capability: "keyword_search", coverage: incompleteReason ? "partial" : ended ? "complete" : "bounded", pages, query, totalRaw: rawItems.length, filteredCount: filtered.length },
      incompleteReason,
    };
  }

  private async fetchLongText(id: string, cookie: string): Promise<string | null> {
    try {
      const url = `https://m.weibo.cn/statuses/extend?id=${encodeURIComponent(id)}`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
          "Cookie": cookie,
          "Accept": "application/json, text/plain, */*",
          "MWeibo-Pwa": "1",
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status === 200) {
        const json = (await res.json()) as any;
        if (json?.ok && json.data?.longTextContent) {
          return String(json.data.longTextContent);
        }
      }
    } catch {
      // 容错兜底：长文接口异常时不中断主流程
    }
    return null;
  }

  private async fetchUserContainerId(uid: string, cookie: string): Promise<string> {
    const profileUrl = `https://m.weibo.cn/api/container/getIndex?type=uid&value=${encodeURIComponent(uid)}`;
    const res = await fetch(profileUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
        "Cookie": cookie,
        "Accept": "application/json, text/plain, */*",
        "MWeibo-Pwa": "1",
        "Referer": `https://m.weibo.cn/u/${uid}`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status !== 200) {
      throw new Error(`WeiboAdapter: get profile failed HTTP ${res.status}`);
    }

    let json: any;
    try {
      json = await res.json();
    } catch {
      throw new Error(`WeiboAdapter: invalid JSON profile response for UID ${uid}`);
    }
    const tabs = json.data?.tabsInfo?.tabs || [];
    const weiboTab = tabs.find((t: any) => t.tab_type === "weibo");

    if (weiboTab?.containerid) {
      return String(weiboTab.containerid);
    }
    // 默认回退规则：107603 + UID
    return `107603${uid}`;
  }

  private async fetchMblogPage(uid: string, containerid: string, cookie: string, sinceId?: string | null): Promise<WeiboPageData> {
    let listUrl = `https://m.weibo.cn/api/container/getIndex?type=uid&value=${encodeURIComponent(uid)}&containerid=${encodeURIComponent(containerid)}`;
    if (sinceId) {
      listUrl += `&since_id=${encodeURIComponent(sinceId)}`;
    }

    const res = await fetch(listUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
        "Cookie": cookie,
        "Accept": "application/json, text/plain, */*",
        "MWeibo-Pwa": "1",
        "Referer": `https://m.weibo.cn/u/${uid}`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status !== 200) {
      return { ok: 0, status: res.status };
    }
    try {
      return (await res.json()) as WeiboPageData;
    } catch {
      return { ok: 0, status: -1 };
    }
  }

  /**
   * 解析阶段：将 WeiboRawMblog 转为标准的 Candidate
   */
  parse(raw: WeiboRawMblog, source: SourceRow): Candidate | null {
    if (!raw.id || !raw.text) return null;

    const cleanText = cleanWeiboText(raw.text);
    if (!cleanText) return null;

    const uid = raw.user?.id ? String(raw.user.id) : (source.config?.uid || "");
    const bid = raw.bid || raw.id;
    const url = `https://weibo.com/${uid}/${bid}`;
    const title = extractWeiboHeadline(cleanText);
    // 解析不出的发布时间保持 null，由 decideTimeline 区分发布时间与发现时间。
    const publishedAt = parseWeiboDate(raw.created_at);

    // 提取高清配图
    const media = (raw.pics || []).map((p) => ({
      kind: "image" as const,
      url: p.large?.url || p.url,
      width: p.large?.width || p.geo?.width || null,
      height: p.large?.height || p.geo?.height || null,
      alt: "微博配图",
    }));

    // 针对官方微博动态打上显式的 "微博官方" 标签；针对社区讨论打上 "微博超话" 标签
    const categories: string[] = ["社交", "微博"];
    if (source.owner_type === "league" || source.owner_type === "club") {
      categories.push("微博官方", "官方");
    } else if (source.owner_type === "community") {
      categories.push("微博超话", "社区", "舆论");
    }
    const sourceTags = source.tags || source.config?.tags;
    if (sourceTags && Array.isArray(sourceTags)) {
      for (const t of sourceTags) {
        if (!categories.includes(t)) categories.push(t);
      }
    }

    return {
      url,
      title,
      author: raw.user?.screen_name || source.name,
      bodyText: cleanText,
      excerpt: cleanText.slice(0, 180),
      publishedAt,
      media,
      categories,
    };
  }

  /**
   * 标准化阶段：直接组装高保真 CanonicalContent (social_post)
   * 包括作者、正文、原帖引用、多媒体画廊、互动量（赞/评/转）
   */
  normalize(candidate: Candidate, raw: WeiboRawMblog, source: SourceRow): MaterialInput {
    const cleanText = candidate.bodyText || "";
    const rawMblog = raw as WeiboRawMblog;
    const uid = rawMblog?.user?.id ? String(rawMblog.user.id) : (source.config?.uid || "");

    // 转发/原博引用结构
    let quoted: { author: string | null; handle?: string | null; text: string } | null = null;
    if (rawMblog?.retweeted_status) {
      const rt = rawMblog.retweeted_status;
      const rtText = cleanWeiboText(rt.text || "");
      quoted = {
        author: rt.user?.screen_name || "原微博",
        handle: rt.user?.id ? String(rt.user.id) : undefined,
        text: rtText,
      };
    }

    const imageBlocks: ImageBlock[] = (candidate.media || []).map((m) => ({
      type: "image",
      url: m.url,
      width: m.width ?? null,
      height: m.height ?? null,
      alt: m.alt ?? null,
    }));

    const isLongText = rawMblog?.isLongText === true;
    const canonical: CanonicalContent = {
      kind: "social_post",
      title: candidate.title,
      author: {
        name: candidate.author || rawMblog?.user?.screen_name || source.name,
        avatarUrl: rawMblog?.user?.avatar_hd || rawMblog?.user?.profile_image_url || null,
        profileUrl: uid ? `https://weibo.com/u/${uid}` : null,
        role: source.owner_type || null,
      },
      publishedAt: candidate.publishedAt ? candidate.publishedAt.toISOString() : null,
      lead: null,
      main: [],
      media: imageBlocks,
      discussion: null,
      video: rawMblog?.page_info?.media_info?.stream_url
        ? {
            description: candidate.title,
            cover: imageBlocks[0]?.url || null,
            durationSeconds: rawMblog.page_info.media_info.duration || null,
          }
        : null,
      social: {
        postText: cleanText,
        quoted,
      },
      engagement: {
        likes: observedCounter(rawMblog?.attitudes_count),
        comments: observedCounter(rawMblog?.comments_count),
        shares: observedCounter(rawMblog?.reposts_count),
      },
      extraction: {
        extractor: "weibo",
        version: "1.0.0",
        sourceId: source.id,
        sourceFamily: "social",
        fallbackUsed: false,
        bodyProvenance: "source_api",
        sourceAuthority: source.tier === "T1" ? "official" : "community",
      },
      quality: {
        score: source.tier === "T1" ? 90 : 75,
        // isLongText 但未补全文：如实标记部分内容，绝不因为有 bodyText 就冒充完整。
        completeness: isLongText ? "partial" : "full",
        warnings: isLongText ? ["long_text_truncated"] : [],
      },
    };

    return {
      ...candidate,
      sourceId: source.id,
      via: "fetch",
      raw,
      canonical,
      engagementObservation: {
        platform: "weibo", observedAt: new Date(), method: "source_api", metrics: canonical.engagement!,
      },
      bodyStatus: "ok",
    };
  }

  /**
   * 只返回账号主体绑定（owner），且战队 id 必须存在于项目实体词典 ENTITIES。
   * 正文里提到别的战队/选手属于“提及关系”，由 kb/entity-mentions 在分析后用别名词典抽取，
   * 不在适配器里用硬编码关键词映射，避免把主体关系和提及关系混为一谈。
   */
  extractEntities(candidate: Candidate, raw: WeiboRawMblog, source: SourceRow): EntityHint[] {
    const hints = super.extractEntities(candidate, raw, source);
    return hints.filter((h) => h.entityType !== "team" || Object.hasOwn(ENTITIES, h.entityId));
  }

  /**
   * 时间线时间决策：严格保真微博真实发布时间
   */
  resolveTimeline(candidate: Candidate, _raw: WeiboRawMblog, _source: SourceRow): TimelineDecision | null {
    if (candidate.publishedAt && Number.isFinite(candidate.publishedAt.getTime())) {
      return decideTimeline(candidate.publishedAt, new Date());
    }
    return null;
  }
}

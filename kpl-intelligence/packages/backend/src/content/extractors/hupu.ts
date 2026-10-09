// HupuExtractor：虎扑 thread 的精确 DOM/JSON 映射，ForumThreadExtractor 的 source adapter。
// 链条：结构化状态 JSON（__INITIAL_STATE__ / pageData）→ 虎扑 DOM（.post-wrapper 等）→ 通用 forum DOM 兜底。
// 修复点：
// 1. 真实 totalReplies：未显式给出时为 null（未知不冒充已抓数）；fetchedReplies 为实际解析回帖数；无证据时 coverage 为 partial；0 回帖合法。
// 2. 引用剥离与保全：引文彻底从自身正文剥离，存入 quote 字段。
// 3. 稳定 ID 与去重：楼层/PID 派生稳定唯一 ID，重复回帖去重。
// 4. 头像与楼层映射：头像与楼层号精准绑定自身帖子，无多处越界偏移。
// 5. 正文 HTML 与图片保序净化：主帖图片按序进入 blocks 与 media，恶意脚本被剔除。
// 6. 严防无关 JSON 数组串入：限制在 bounded validated structural channel，不混合 recommendations/hotList。
import * as cheerio from "cheerio";
import { collapseWhitespace } from "../../lib/text.ts";
import { parseThreadDom, rankReplies, selectorsOf, normalizeLineBreaks, extractTextPreservingBreaks, htmlToTextPreservingBreaks } from "./forum.ts";
import { htmlToBlocks } from "./html-blocks.ts";
import { sanitizeBody } from "../sanitize.ts";
import type { ExtractionInput, ContentExtractor } from "./base.ts";
import type { CanonicalContent, DiscussionContent, DiscussionPost } from "./types.ts";

interface ParsedPost {
  id: string | null;
  author: string | null;
  avatarUrl: string | null;
  text: string;
  html: string | null;
  likes: number | null;
  time: string | null;
  floor: number | null;
  quote: { author?: string | null; text: string } | null;
}

interface ExtractedThreadData {
  title: string | null;
  op: ParsedPost;
  replies: ParsedPost[];
  totalReplies: number | null;
  provenance: "source_api" | "page_dom";
  terminalProof?: boolean;
  nextCursor?: string | null;
}

const AUTHOR_KEYS = ["puname", "nickname", "username", "author", "userName", "name", "authorName"];
const AVATAR_KEYS = ["avatar", "avatarUrl", "header", "userAvatar", "userHeader", "headImg", "face"];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function threadIdOf(url: string): string | null {
  try {
    const u = new URL(url);
    const tidParam = u.searchParams.get("tid") || u.searchParams.get("threadId");
    if (tidParam) return tidParam;
    const m = u.pathname.match(/(?:^|\/)(\d+)(?:-\d+)?(?:\.html)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function explicitTidOf(o: unknown): string | null {
  if (!o || typeof o !== "object") return null;
  const rec = o as Record<string, unknown>;
  const raw = rec.tid ?? rec.threadId
    ?? (rec.thread as Record<string, unknown>)?.tid
    ?? (rec.thread as Record<string, unknown>)?.threadId
    ?? (rec.threadInfo as Record<string, unknown>)?.tid
    ?? (rec.threadInfo as Record<string, unknown>)?.threadId
    ?? rec.topicId
    ?? (rec.threadInfo as Record<string, unknown>)?.topicId;
  if (raw != null && (typeof raw === "string" || typeof raw === "number")) {
    const s = String(raw).trim();
    if (s && s !== "0" && s !== "undefined" && s !== "null") return s;
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function stripHtml(s: string): string {
  return s
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function avatarOf(el: cheerio.Cheerio<any>): string | null {
  const img = el.find("img[src*='avatar'], img[src*='i1.hoopv'], .post-user__avatar img, [class*='avatar'] img, .user-avatar img").first();
  const src = img.attr("data-src") ?? img.attr("data-original") ?? img.attr("src");
  if (!src || src.startsWith("data:")) return null;
  return src.startsWith("//") ? `https:${src}` : src;
}

// ---------------------------------------------------------------------------
// 1. 结构化 JSON 提取（仅限 bounded 渠道，严防无关数组串入）
// ---------------------------------------------------------------------------

function embeddedWindowJson(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /window\.(__INITIAL_STATE__|__NEXT_DATA__|pageData|__NUXT__)\s*=\s*/gi;
  for (const m of html.matchAll(re)) {
    const start = m.index! + m[0].length;
    const ch = html[start];
    if (ch !== "{" && ch !== "[") continue;
    let depth = 0;
    let inStr: string | null = null;
    let esc = false;
    for (let i = start; i < html.length && i < start + 6_000_000; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'") inStr = c;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          try {
            out.push(JSON.parse(html.slice(start, i + 1)));
          } catch {
            // not pure JSON: skip
          }
          break;
        }
      }
    }
  }
  return out;
}

function parseJsonPost(o: Record<string, unknown>, defaultFloor?: number): ParsedPost | null {
  if (!o || typeof o !== "object") return null;

  const rawHtml = typeof o.contentHtml === "string" ? o.contentHtml : null;
  const rawContent = typeof o.content === "string" ? o.content : typeof o.text === "string" ? o.text : null;
  const contentStr = rawHtml ?? rawContent;
  if (!contentStr || !contentStr.trim()) return null;

  let quote: { author?: string | null; text: string } | null = null;
  const quoteObj = (o.quote ?? o.quotePost ?? o.parent ?? o.replyTo) as Record<string, unknown> | null;
  if (quoteObj && typeof quoteObj === "object") {
    let qAuthor: string | null = null;
    const rawAuthor = quoteObj.author ?? quoteObj.user;
    if (typeof rawAuthor === "string") {
      qAuthor = rawAuthor;
    } else if (rawAuthor && typeof rawAuthor === "object") {
      const aRec = rawAuthor as Record<string, unknown>;
      qAuthor = (AUTHOR_KEYS.map((k) => aRec[k]).find((v) => typeof v === "string" && (v as string).trim()) as string | undefined) ?? null;
    }
    if (!qAuthor) {
      qAuthor = (AUTHOR_KEYS.map((k) => quoteObj[k]).find((v) => typeof v === "string" && (v as string).trim()) as string | undefined) ?? null;
    }
    const qText = (quoteObj.content ?? quoteObj.text ?? quoteObj.contentHtml) as string | undefined;
    if (typeof qText === "string" && qText.trim()) {
      quote = {
        author: qAuthor ? collapseWhitespace(qAuthor) || null : null,
        text: htmlToTextPreservingBreaks(qText),
      };
    }
  }

  let cleanText: string;
  let cleanHtml: string | null = null;
  if (/<[a-z][\s\S]*>/i.test(contentStr)) {
    const $ = cheerio.load(contentStr, null, false);
    const quoteEl = $(".quote-content, .quote-box, .bbs-quote, blockquote").first();
    if (quoteEl.length && !quote) {
      const qAuthor = quoteEl.find(".quote-author, [class*='author']").first().text().trim();
      const quoteClone = quoteEl.clone();
      quoteClone.find(".quote-author").remove();
      const rawQText = extractTextPreservingBreaks(quoteClone, $).replace(/^引用\s*@?[^\s:：()]+(?:\s*\([^)]*\))?\s*(?:发表的|的发言)?[：:]\s*/, "");
      if (rawQText) {
        quote = { author: collapseWhitespace(qAuthor) || null, text: rawQText };
      }
    }
    $(".quote-content, .quote-box, .bbs-quote, blockquote").remove();
    cleanText = extractTextPreservingBreaks($.root(), $);
    cleanHtml = sanitizeBody($.html() || "");
  } else {
    cleanText = htmlToTextPreservingBreaks(contentStr);
  }

  if (!cleanText) return null;

  const authorObj = o.author ?? o.user ?? null;
  let author: string | null = null;
  let avatarUrl: string | null = null;
  if (typeof authorObj === "string") {
    author = authorObj;
  } else if (authorObj && typeof authorObj === "object") {
    const aRec = authorObj as Record<string, unknown>;
    author = (AUTHOR_KEYS.map((k) => aRec[k]).find((v) => typeof v === "string" && v.trim()) as string | undefined) ?? null;
    avatarUrl = (AVATAR_KEYS.map((k) => aRec[k]).find((v) => typeof v === "string" && v.trim()) as string | undefined) ?? null;
  } else {
    author = (AUTHOR_KEYS.map((k) => o[k]).find((v) => typeof v === "string" && v.trim()) as string | undefined) ?? null;
  }
  if (!avatarUrl) {
    avatarUrl = (AVATAR_KEYS.map((k) => o[k]).find((v) => typeof v === "string" && v.trim()) as string | undefined) ?? null;
  }
  if (avatarUrl && avatarUrl.startsWith("//")) avatarUrl = `https:${avatarUrl}`;

  const likesRaw = o.lights ?? o.allLightCount ?? o.likenum ?? o.likes ?? o.likeNum ?? o.agree ?? o.praiseNum ?? o.light;
  const likes = typeof likesRaw === "number" && Number.isFinite(likesRaw) ? Math.max(0, likesRaw) : typeof likesRaw === "string" && /^\d+$/.test(likesRaw) ? Number(likesRaw) : null;

  const timeRaw = o.createdAt ?? o.createdAtMs ?? o.time ?? o.publishTime ?? o.createTime ?? o.postdate;
  const time = typeof timeRaw === "number"
    ? new Date(timeRaw > 1e12 ? timeRaw : timeRaw * 1000).toISOString()
    : typeof timeRaw === "string" && Number.isFinite(Date.parse(timeRaw)) ? new Date(Date.parse(timeRaw)).toISOString() : null;

  const floorRaw = o.floor ?? o.floorNum ?? o.index;
  const floor = typeof floorRaw === "number" ? floorRaw : (defaultFloor ?? null);

  const idRaw = o.pid ?? o.id ?? o.postId ?? o.replyId ?? o.commentId;
  const id = idRaw != null ? String(idRaw) : null;

  return {
    id,
    author: author ? collapseWhitespace(author) : null,
    avatarUrl: avatarUrl || null,
    text: cleanText,
    html: cleanHtml,
    likes,
    time,
    floor,
    quote,
  };
}

function parseThreadContainer(c: Record<string, unknown>, url: string): ExtractedThreadData | null {
  if (!c || typeof c !== "object") return null;

  const requestedTid = threadIdOf(url);
  const containerTid = explicitTidOf(c);

  // Bind JSON explicit tid/threadId to requested URL
  if (requestedTid && containerTid && containerTid !== requestedTid) {
    return null;
  }
  const effectiveTid = containerTid ?? requestedTid;

  const titleRaw = c.title ?? c.subject ?? (c.threadInfo as Record<string, unknown>)?.title ?? (c.threadInfo as Record<string, unknown>)?.subject;
  const title = typeof titleRaw === "string" && titleRaw.trim().length >= 2 ? collapseWhitespace(titleRaw) : null;

  const trRaw = c.totalReplies ?? c.repliesCount ?? c.replyCount ?? c.replyNum ?? c.repliesNum ?? c.totalCount ?? c.allReplyNum
    ?? (c.threadInfo as Record<string, unknown>)?.totalReplies
    ?? (c.threadInfo as Record<string, unknown>)?.repliesCount
    ?? (c.threadInfo as Record<string, unknown>)?.replyCount
    ?? (c.threadInfo as Record<string, unknown>)?.replyNum;
  const totalReplies = typeof trRaw === "number" && Number.isFinite(trRaw) && trRaw >= 0
    ? trRaw
    : typeof trRaw === "string" && /^\d+$/.test(trRaw)
      ? Number(trRaw)
      : null;

  let op: ParsedPost | null = null;
  let replies: ParsedPost[] = [];

  const replyFilter = (item: unknown, idx: number): ParsedPost | null => {
    if (!item || typeof item !== "object") return null;
    const rRec = item as Record<string, unknown>;
    const replyTid = explicitTidOf(rRec);
    if (effectiveTid && replyTid && replyTid !== effectiveTid) {
      return null;
    }
    return parseJsonPost(rRec, idx + 2);
  };

  const opCandidate = (c.threadInfo ?? c.post ?? c.originalPost) as Record<string, unknown> | null;
  if (opCandidate && typeof opCandidate === "object" && !Array.isArray(opCandidate)) {
    const opTid = explicitTidOf(opCandidate);
    if (effectiveTid && opTid && opTid !== effectiveTid) {
      return null;
    }
    op = parseJsonPost(opCandidate, 1);
  }

  if (!op && Array.isArray(c.posts) && c.posts.length > 0) {
    const first = c.posts[0];
    if (first && typeof first === "object") {
      const firstTid = explicitTidOf(first);
      if (effectiveTid && firstTid && firstTid !== effectiveTid) {
        return null;
      }
      op = parseJsonPost(first as Record<string, unknown>, 1);
      if (op) {
        replies = (c.posts as unknown[]).slice(1)
          .map((item, idx) => replyFilter(item, idx))
          .filter((p): p is ParsedPost => !!p);
      }
    }
  }

  if (!op && (typeof c.content === "string" || typeof c.contentHtml === "string" || typeof c.text === "string")) {
    op = parseJsonPost(c, 1);
  }

  if (!op || !op.text) return null;

  if (replies.length === 0) {
    const replyArrays = [c.replies, c.replyList, c.repliesList, c.comments, c.commentList];
    for (const arr of replyArrays) {
      if (Array.isArray(arr)) {
        replies = arr
          .map((item, idx) => replyFilter(item, idx))
          .filter((p): p is ParsedPost => !!p);
        break;
      }
    }
  }

  const threadId = threadIdOf(url);
  if (!op.id) op.id = threadId ? `${threadId}-op` : "op";
  for (let i = 0; i < replies.length; i++) {
    const r = replies[i]!;
    if (!r.id) {
      r.id = threadId ? `${threadId}-f${r.floor ?? (i + 2)}` : `reply-${i + 1}`;
    }
  }

  const hasMore = c.hasMore ?? c.has_more ?? (c.threadInfo as Record<string, unknown>)?.hasMore;
  const isEnd = c.isEnd ?? c.is_end ?? (c.threadInfo as Record<string, unknown>)?.isEnd ?? (c.threadInfo as Record<string, unknown>)?.is_end;
  const totalPage = c.totalPage ?? c.pageCount ?? (c.threadInfo as Record<string, unknown>)?.totalPage;
  const page = c.page ?? c.pageNo ?? c.currentPage ?? (c.threadInfo as Record<string, unknown>)?.page;

  let terminalProof = false;
  if (totalReplies === 0 && replies.length === 0) {
    terminalProof = true;
  } else if (hasMore === false || isEnd === true) {
    terminalProof = true;
  } else if (typeof totalPage === "number" && typeof page === "number" && page >= totalPage) {
    terminalProof = true;
  } else if (hasMore === true || isEnd === false) {
    terminalProof = false;
  }

  return {
    title,
    op,
    replies,
    totalReplies,
    provenance: "source_api",
    terminalProof,
  };
}

// ---------------------------------------------------------------------------
// 1. Next.js __NEXT_DATA__ 解析（真实 Hupu BBS 结构真源）
// ---------------------------------------------------------------------------

function extractNextData(html: string): unknown | null {
  const match = html.match(/<script(?:\s+[^>]*?)?\s+id=["']__NEXT_DATA__["'](?:\s+[^>]*?)?>([\s\S]*?)<\/script>/i)
    ?? html.match(/<script(?:\s+[^>]*?)?\s+type=["']application\/json["'](?:\s+[^>]*?)?\s+id=["']__NEXT_DATA__["'](?:\s+[^>]*?)?>([\s\S]*?)<\/script>/i);
  if (!match || !match[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function parseHupuNextData(nextData: unknown, url: string): ExtractedThreadData | null {
  if (!nextData || typeof nextData !== "object") return null;
  const root = nextData as Record<string, unknown>;
  const props = root.props as Record<string, unknown> | undefined;
  const pageProps = props?.pageProps as Record<string, unknown> | undefined;
  const detail = (pageProps?.detail ?? (root.detail as Record<string, unknown> | undefined)) as Record<string, unknown> | undefined;
  if (!detail || typeof detail !== "object") return null;

  const threadObj = detail.thread as Record<string, unknown> | undefined;
  if (!threadObj || typeof threadObj !== "object" || Array.isArray(threadObj)) return null;

  const requestedTid = threadIdOf(url);
  const containerTid = explicitTidOf(threadObj) ?? explicitTidOf(detail);

  // 严格绑定请求 URL 的 thread ID，防跨帖串数
  if (requestedTid && containerTid && containerTid !== requestedTid) {
    return null;
  }
  const effectiveTid = containerTid ?? requestedTid;

  const titleRaw = threadObj.title ?? threadObj.subject;
  const title = typeof titleRaw === "string" && titleRaw.trim().length >= 2 ? collapseWhitespace(titleRaw) : null;

  const repliesObj = detail.replies as Record<string, unknown> | undefined;
  const trRaw = threadObj.replies ?? repliesObj?.count ?? repliesObj?.totalReplies;
  const totalReplies = typeof trRaw === "number" && Number.isFinite(trRaw) && trRaw >= 0
    ? trRaw
    : typeof trRaw === "string" && /^\d+$/.test(trRaw)
      ? Number(trRaw)
      : null;

  let op = parseJsonPost(threadObj, 1);
  if (!op || !op.text) {
    if (title) {
      op = parseJsonPost({ ...threadObj, content: title }, 1);
    }
  }
  if (!op || !op.text) return null;
  if (!op.id) op.id = effectiveTid ? `${effectiveTid}-op` : "op";

  const rawRepliesList = Array.isArray(repliesObj?.list) ? repliesObj.list : [];
  const replyFilter = (item: unknown, idx: number): ParsedPost | null => {
    if (!item || typeof item !== "object") return null;
    const rRec = item as Record<string, unknown>;
    const replyTid = explicitTidOf(rRec);
    if (effectiveTid && replyTid && replyTid !== effectiveTid) {
      return null;
    }
    return parseJsonPost(rRec, idx + 2);
  };

  const replies: ParsedPost[] = rawRepliesList
    .map((item, idx) => replyFilter(item, idx))
    .filter((p): p is ParsedPost => !!p);

  const current = typeof repliesObj?.current === "number" ? repliesObj.current : null;
  const totalPages = typeof repliesObj?.total === "number" ? repliesObj.total : null;

  let terminalProof = false;
  let nextCursor: string | null = null;

  if (totalReplies === 0 && replies.length === 0) {
    terminalProof = true;
    nextCursor = null;
  } else if (typeof current === "number" && typeof totalPages === "number") {
    if (current >= totalPages) {
      terminalProof = true;
      nextCursor = null;
    } else {
      terminalProof = false;
      if (effectiveTid && current < totalPages) {
        nextCursor = `https://bbs.hupu.com/${effectiveTid}-${current + 1}.html`;
      }
    }
  } else if (totalReplies !== null && replies.length === totalReplies) {
    terminalProof = true;
    nextCursor = null;
  }

  return {
    title,
    op,
    replies,
    totalReplies,
    provenance: "source_api",
    terminalProof,
    nextCursor,
  };
}

function findBoundedThreadData(roots: unknown[], url: string): ExtractedThreadData | null {
  const THREAD_KEYS = ["thread", "bbsDetail", "detail", "threadInfo", "pageData", "topic", "postData"];

  for (const root of roots) {
    if (!root || typeof root !== "object" || Array.isArray(root)) continue;

    const nextResult = parseHupuNextData(root, url);
    if (nextResult) return nextResult;
    const r = root as Record<string, unknown>;

    for (const key of THREAD_KEYS) {
      const container = r[key];
      if (container && typeof container === "object" && !Array.isArray(container)) {
        const thread = parseThreadContainer(container as Record<string, unknown>, url);
        if (thread) return thread;
      }
    }

    for (const wrap of ["data", "state", "result"]) {
      const w = r[wrap];
      if (w && typeof w === "object" && !Array.isArray(w)) {
        const wRec = w as Record<string, unknown>;
        for (const key of THREAD_KEYS) {
          const container = wRec[key];
          if (container && typeof container === "object" && !Array.isArray(container)) {
            const thread = parseThreadContainer(container as Record<string, unknown>, url);
            if (thread) return thread;
          }
        }
        if (wRec.threadInfo || wRec.tid || wRec.threadId || (wRec.post && wRec.replies)) {
          const thread = parseThreadContainer(wRec, url);
          if (thread) return thread;
        }
      }
    }

    if (r.threadInfo || r.tid || r.threadId || (r.post && r.replies)) {
      const thread = parseThreadContainer(r, url);
      if (thread) return thread;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 2. 虎扑 DOM 解析（精确楼层、去重、引文分离与头像绑定）
// ---------------------------------------------------------------------------

function cleanQuoteAndText(targetContent: cheerio.Cheerio<any>, url: string, $: cheerio.CheerioAPI): { text: string; html: string; quote: { author?: string | null; text: string } | null } {
  const quoteEl = targetContent.find(".quote-content, .quote-box, .bbs-quote, blockquote").first();
  let quote: { author?: string | null; text: string } | null = null;
  if (quoteEl.length) {
    const quoteAuthorEl = quoteEl.find(".quote-author, [class*='quote-user'], [class*='author']").first();
    let quoteAuthor = quoteAuthorEl.text().trim();
    const quoteClone = quoteEl.clone();
    quoteClone.find(".quote-author, [class*='quote-user']").remove();
    let rawQText = extractTextPreservingBreaks(quoteClone, $);
    if (!quoteAuthor) {
      const m = rawQText.match(/^引用\s*@?([^\s:：()]+)(?:\s*\([^)]*\))?\s*(?:发表的|的发言)?[：:]\s*/);
      if (m && m[1]) {
        quoteAuthor = m[1];
      }
    }
    rawQText = rawQText.replace(/^引用\s*@?[^\s:：()]+(?:\s*\([^)]*\))?\s*(?:发表的|的发言)?[：:]\s*/, "");
    if (rawQText) {
      quote = {
        author: collapseWhitespace(quoteAuthor) || null,
        text: rawQText,
      };
    }
  }

  const cleanContent = targetContent.clone();
  cleanContent.find(".quote-content, .quote-box, .bbs-quote, blockquote").remove();
  const text = extractTextPreservingBreaks(cleanContent, $);
  const html = sanitizeBody(cleanContent.html() || "", url);

  return { text, html, quote };
}

function parseHupuDom(html: string, url: string): ExtractedThreadData | null {
  const $ = cheerio.load(html);
  const threadId = threadIdOf(url);

  let title: string | null = collapseWhitespace($(".post-title, h1").first().text()) || null;
  if (!title) {
    const rawTitle = $("title").first().text();
    title = collapseWhitespace(rawTitle.replace(/\s*[-_|].*$/, "")) || null;
  }

  let totalReplies: number | null = null;
  const replyCountText = $(".post-reply__count, .reply-count, .bbs-head-stat, .reply-num, [class*='reply-count']").first().text();
  if (replyCountText) {
    const m = replyCountText.match(/(\d+)/);
    if (m) totalReplies = Number(m[1]);
  }
  if (totalReplies === null) {
    const metaComments = $('meta[name="comments"], meta[property="og:comments"]').attr("content");
    if (metaComments && /^\d+$/.test(metaComments.trim())) {
      totalReplies = Number(metaComments.trim());
    } else {
      const fullText = $("body").text();
      const m = fullText.match(/(?:共\s*)(\d+)\s*条回复/);
      if (m) totalReplies = Number(m[1]);
    }
  }

  const matched = $(".post-wrapper, .bbs-slots-post, .bbs-post-web, tr.case").toArray();
  const matchedSet = new Set<unknown>(matched);
  const containers = matched.filter((node) => {
    let parent: any = node.parent;
    while (parent) {
      if (matchedSet.has(parent)) return false;
      parent = parent.parent;
    }
    return true;
  });

  if (containers.length === 0) return null;

  const posts: ParsedPost[] = [];

  for (let i = 0; i < containers.length; i++) {
    const el = $(containers[i]!);

    const contentEl = el.find(".post-content, .bbs-content, .content").first();
    const targetContent = contentEl.length ? contentEl : el;
    const { text, html: htmlClean, quote } = cleanQuoteAndText(targetContent, url, $);
    if (!text) continue;

    const authorEl = el.find(".post-user__name, .u-name, .user-name, [class*='author']").first();
    const author = collapseWhitespace(authorEl.text()) || null;
    const avatarUrl = avatarOf(el);

    const likeEl = el.find(".post-like__value, .iliketop, .likes, [class*='like']").first();
    const likeText = collapseWhitespace(likeEl.text());
    const likes = likeText?.match(/\d+/) ? Number(likeText.replace(/\D/g, "")) : null;

    const timeEl = el.find(".post-time, .post-date, time").first();
    const timeRaw = timeEl.attr("datetime") ?? collapseWhitespace(timeEl.text()) ?? null;
    const time = timeRaw && Number.isFinite(Date.parse(timeRaw)) ? new Date(Date.parse(timeRaw)).toISOString() : null;

    const floorEl = el.find(".post-floor, .floor, .floor-num, [class*='floor']").first();
    const floorMatch = floorEl.text().match(/(\d+)/);
    const floor = floorMatch ? Number(floorMatch[1]) : (i + 1);

    const idAttr = el.attr("id") ?? el.attr("data-id") ?? el.attr("data-pid") ?? null;
    const id = idAttr ?? (threadId ? `${threadId}-f${floor}` : (i === 0 ? "op" : `reply-${i}`));

    posts.push({
      id,
      author,
      avatarUrl,
      text,
      html: htmlClean,
      likes,
      time,
      floor,
      quote,
    });
  }

  if (posts.length === 0 || !posts[0]!.text) return null;

  const hasNextPage = $(".pagination .next, [class*='page'] a:contains('下一页'), a.next-page, .pagination a:contains('下一页')").length > 0;
  let terminalProof = false;
  if (totalReplies === 0 && posts.length <= 1) {
    terminalProof = true;
  } else if (!hasNextPage && totalReplies !== null && (posts.length - 1) === totalReplies) {
    terminalProof = true;
  }

  return {
    title,
    op: posts[0]!,
    replies: posts.slice(1),
    totalReplies,
    provenance: "page_dom",
    terminalProof,
  };
}

function dedupReplies(replies: ParsedPost[]): ParsedPost[] {
  const seenIds = new Set<string>();
  const seenFloors = new Set<number>();
  const seenTexts = new Set<string>();
  const result: ParsedPost[] = [];

  for (const r of replies) {
    if (r.id && seenIds.has(r.id)) continue;
    if (r.floor !== null && seenFloors.has(r.floor)) continue;
    const norm = `${r.author ?? ""}:${r.text}`;
    if (seenTexts.has(norm)) continue;

    if (r.id) seenIds.add(r.id);
    if (r.floor !== null) seenFloors.add(r.floor);
    seenTexts.add(norm);
    result.push(r);
  }

  return result;
}

// ---------------------------------------------------------------------------
// 3. Extractor 导出
// ---------------------------------------------------------------------------

export const hupuExtractor: ContentExtractor = {
  id: "hupu",
  version: "1.1.0",

  canHandle(input: ExtractionInput): boolean {
    return /(^|\.)(?:hupu\.com|hoopchina\.com\.cn)$/i.test(hostOf(input.url)) || input.profile.preferredExtractor === "hupu";
  },

  async extract(input: ExtractionInput): Promise<CanonicalContent | null> {
    const html = input.html;
    if (!html) return null;

    const threadId = threadIdOf(input.url);

    // 1) 优先尝试 Next.js __NEXT_DATA__（结构化真实 Hupu BBS 优先）
    let thread = parseHupuNextData(extractNextData(html), input.url);

    // 2) 尝试其他内嵌 window 状态 JSON（bounded 线程容器检索）
    if (!thread) {
      thread = findBoundedThreadData(embeddedWindowJson(html), input.url);
    }

    // 3) 虎扑 DOM 解析
    if (!thread) {
      thread = parseHupuDom(html, input.url);
    }

    // 3) 通用 forum DOM 兜底
    if (!thread) {
      const generic = parseThreadDom(html, input.url, selectorsOf(input));
      if (generic.posts.length >= 1 && generic.posts[0]?.text) {
        const opPost = generic.posts[0]!;
        const replyPosts = generic.posts.slice(1);
        thread = {
          title: generic.title ?? input.title,
          op: {
            id: opPost.id ?? (threadId ? `${threadId}-op` : "op"),
            author: opPost.author.name,
            avatarUrl: opPost.author.avatarUrl ?? null,
            text: opPost.text,
            html: opPost.html ?? null,
            likes: opPost.likes ?? null,
            time: opPost.publishedAt ?? null,
            floor: opPost.floor ?? 1,
            quote: opPost.quote ?? null,
          },
          replies: replyPosts.map((p, i) => ({
            id: p.id ?? (threadId ? `${threadId}-f${p.floor ?? i + 2}` : `reply-${i + 1}`),
            author: p.author.name,
            avatarUrl: p.author.avatarUrl ?? null,
            text: p.text,
            html: p.html ?? null,
            likes: p.likes ?? null,
            time: p.publishedAt ?? null,
            floor: p.floor ?? (i + 2),
            quote: p.quote ?? null,
          })),
          totalReplies: null,
          provenance: "page_dom",
        };
      }
    }

    // 至少需有主帖内容；0 回帖合法
    if (!thread || !thread.op.text) return null;

    const op = thread.op;
    const rawReplies = dedupReplies(thread.replies);
    const opAuthor = op.author;

    const replies: DiscussionPost[] = rawReplies.map((p, i) => ({
      id: p.id ?? (threadId ? `${threadId}-f${p.floor ?? i + 2}` : `reply-${i + 1}`),
      author: { name: p.author, avatarUrl: p.avatarUrl },
      text: p.text,
      html: p.html,
      publishedAt: p.time,
      likes: p.likes,
      floor: p.floor ?? (i + 2),
      isOriginalAuthor: !!opAuthor && p.author === opAuthor,
      platform: "hupu",
      quote: p.quote,
    }));

    const authorFollowups = replies.filter((p) => p.isOriginalAuthor);
    const otherReplies = replies.filter((p) => !p.isOriginalAuthor);
    const highlightLimit = input.profile.highlightLimit ?? 8;
    const highlighted = rankReplies(otherReplies, highlightLimit);

    const totalReplies = thread.totalReplies;
    const fetchedReplies = replies.length;
    // 覆盖度：只有总回帖已知、已抓回帖数与总数一致且具备终末证据时，才为 complete；否则为 partial
    const totalsAgree = totalReplies !== null && fetchedReplies === totalReplies;
    const isComplete = totalsAgree && (thread.terminalProof === true);
    const coverage: "complete" | "partial" = isComplete ? "complete" : "partial";

    const discussion: DiscussionContent = {
      originalPost: {
        id: op.id ?? (threadId ? `${threadId}-op` : "op"),
        author: { name: op.author, avatarUrl: op.avatarUrl },
        text: op.text,
        html: op.html,
        publishedAt: op.time,
        likes: op.likes,
        floor: op.floor ?? 1,
        isOriginalAuthor: true,
        platform: "hupu",
        quote: op.quote ?? null,
      },
      authorFollowups,
      highlightedReplies: highlighted,
      collectedReplies: replies,
      totalReplies,
      fetchedReplies,
      collection: {
        collectedAt: new Date().toISOString(),
        coverage,
        provenance: thread.provenance,
        sourceUrl: input.url,
        nextCursor: thread.nextCursor ?? null,
      },
    };

    // 正文 Blocks 与图片保序提取
    const opBlocks = op.html
      ? htmlToBlocks(op.html, input.url)
      : htmlToBlocks(`<p>${escapeHtml(op.text).replace(/\n\n+/g, "</p><p>").replace(/\n/g, "<br>")}</p>`, input.url);
    const mainBlocks = opBlocks.blocks.length ? opBlocks.blocks : [{ type: "paragraph" as const, text: op.text }];

    const title = thread.title ?? input.title;

    const content: CanonicalContent = {
      kind: "forum_thread",
      title: title ?? null,
      author: { name: op.author, avatarUrl: op.avatarUrl },
      publishedAt: op.time ?? input.publishedAt?.toISOString() ?? null,
      lead: op.text.slice(0, 200),
      main: mainBlocks,
      media: opBlocks.media,
      discussion,
      video: null,
      social: null,
      engagement: {
        comments: totalReplies !== null ? totalReplies : null,
        likes: op.likes,
      },
      extraction: {
        extractor: "hupu",
        version: "1.1.0",
        sourceId: input.sourceId,
        sourceFamily: input.profile.contentFamily,
        fallbackUsed: false,
        bodyProvenance: thread.provenance,
        sourceAuthority: "community",
        mediaCompleteness: opBlocks.media.length > 0 ? "complete" : undefined,
        confidence: thread.provenance === "source_api" ? 0.95 : 0.85,
      },
      quality: { score: 0, completeness: "full", warnings: [] },
    };

    return content;
  },
};

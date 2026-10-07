// HupuExtractor：虎扑 thread 的精确 DOM/JSON 映射，ForumThreadExtractor 的 source adapter。
// 链条：页面内嵌 JSON（__INITIAL_STATE__ / pageData）→ 虎扑 DOM（.post-wrapper 等）→ 通用 forum DOM。
// 评论绝对不混入正文；楼主补充独立成组；高价值回复走统一 Comment Ranking。
import * as cheerio from "cheerio";
import { collapseWhitespace } from "../../lib/text.ts";
import { parseThreadDom, rankReplies, selectorsOf } from "./forum.ts";
import { htmlToBlocks } from "./html-blocks.ts";
import type { ExtractionInput, ContentExtractor } from "./base.ts";
import type { CanonicalContent, DiscussionContent, DiscussionPost } from "./types.ts";

// ---------------------------------------------------------------------------
// 嵌入 JSON：window.__INITIAL_STATE__ / window.pageData / __NUXT__ 的平衡扫描
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

interface JsonPost {
  author: string | null;
  text: string;
  likes: number | null;
  time: string | null;
  floor: number | null;
  quote?: { author?: string | null; text: string } | null;
}

const POST_ARRAY_KEYS = ["posts", "list", "replies", "comments", "threads"];
const TEXT_KEYS = ["content", "text", "contentHtml"];
const AUTHOR_KEYS = ["puname", "nickname", "username", "author", "userName", "name"];

function postFromJson(o: Record<string, unknown>): JsonPost | null {
  const text = TEXT_KEYS.map((k) => o[k]).find((v) => typeof v === "string" && v.trim()) as string | undefined;
  if (!text) return null;
  const authorObj = o.author ?? o.user ?? null;
  const author = typeof authorObj === "string"
    ? authorObj
    : authorObj && typeof authorObj === "object"
      ? (AUTHOR_KEYS.map((k) => (authorObj as Record<string, unknown>)[k]).find((v) => typeof v === "string") as string | undefined) ?? null
      : (AUTHOR_KEYS.map((k) => o[k]).find((v) => typeof v === "string") as string | undefined) ?? null;
  const likesRaw = o.likenum ?? o.likes ?? o.likeNum ?? o.agree ?? o.praiseNum;
  const likes = typeof likesRaw === "number" ? likesRaw : typeof likesRaw === "string" && /^\d+$/.test(likesRaw) ? Number(likesRaw) : null;
  const timeRaw = o.createdAt ?? o.createdAtMs ?? o.time ?? o.publishTime ?? o.createTime;
  const time = typeof timeRaw === "number"
    ? new Date(timeRaw > 1e12 ? timeRaw : timeRaw * 1000).toISOString()
    : typeof timeRaw === "string" && Number.isFinite(Date.parse(timeRaw)) ? new Date(Date.parse(timeRaw)).toISOString() : null;
  const floorRaw = o.floor ?? o.floorNum ?? o.index;
  return {
    author: author ?? null,
    text: collapseWhitespace(stripHtml(String(text))),
    likes,
    time,
    floor: typeof floorRaw === "number" ? floorRaw : null,
  };
}

function stripHtml(s: string): string {
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function postsFromEmbeddedJson(root: unknown, depth = 0): JsonPost[] {
  if (depth > 10 || root === null || typeof root !== "object") return [];
  if (Array.isArray(root)) {
    const asPosts = root.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as Record<string, unknown>).content === "string").map(postFromJson).filter((p): p is JsonPost => !!p);
    if (asPosts.length >= 2) return asPosts;
    return root.flatMap((x) => postsFromEmbeddedJson(x, depth + 1));
  }
  const o = root as Record<string, unknown>;
  for (const key of POST_ARRAY_KEYS) {
    const arr = o[key];
    if (Array.isArray(arr)) {
      const asPosts = arr.map((x) => (x && typeof x === "object" ? postFromJson(x as Record<string, unknown>) : null)).filter((p): p is JsonPost => !!p);
      if (asPosts.length >= 2) return asPosts;
    }
  }
  return Object.values(o).flatMap((v) => postsFromEmbeddedJson(v, depth + 1));
}

function titleFromEmbeddedJson(root: unknown, depth = 0): string | null {
  if (depth > 6 || root === null || typeof root !== "object") return null;
  if (Array.isArray(root)) {
    for (const x of root) {
      const t = titleFromEmbeddedJson(x, depth + 1);
      if (t) return t;
    }
    return null;
  }
  const o = root as Record<string, unknown>;
  const t = o.title ?? o.subject;
  if (typeof t === "string" && t.trim().length >= 6 && t.length <= 200) return collapseWhitespace(t);
  for (const v of Object.values(o)) {
    const found = titleFromEmbeddedJson(v, depth + 1);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 虎扑 DOM：现代 .post-wrapper 结构与旧版 table 结构
// ---------------------------------------------------------------------------

function titleFromDom($: cheerio.CheerioAPI): string | null {
  const t = collapseWhitespace($("h1").first().text())
    || collapseWhitespace($("title").first().text().replace(/[-_|—].*$/, ""));
  return t || null;
}

function avatarOf(el: cheerio.Cheerio<any>): string | null {
  const img = el.find("img[src*='avatar'], img[src*='i1.hoopv'], .post-user__avatar img").first();
  const src = img.attr("data-src") ?? img.attr("src");
  if (!src || src.startsWith("data:")) return null;
  return src.startsWith("//") ? `https:${src}` : src;
}

export const hupuExtractor: ContentExtractor = {
  id: "hupu",
  version: "1.0.0",

  canHandle(input: ExtractionInput): boolean {
    return /(^|\.)(?:hupu\.com|hoopchina\.com\.cn)$/i.test(hostOf(input.url)) || input.profile.preferredExtractor === "hupu";
  },

  async extract(input: ExtractionInput): Promise<CanonicalContent | null> {
    const html = input.html;
    if (!html) return null;

    // 1) 嵌入 JSON（最快的精确映射）。
    let posts: JsonPost[] = [];
    let title: string | null = null;
    for (const root of embeddedWindowJson(html)) {
      posts = postsFromEmbeddedJson(root);
      if (posts.length >= 2) {
        title = titleFromEmbeddedJson(root) ?? input.title;
        break;
      }
    }

    // 2) 虎扑 DOM；3) 通用 forum DOM 兜底。
    let avatars = new Map<number, string | null>();
    if (posts.length < 2) {
      const $ = cheerio.load(html);
      const containers = $(".post-wrapper, .bbs-slots-post, tr.case").toArray();
      posts = [];
      avatars = new Map();
      for (const [i, node] of containers.entries()) {
        const el = $(node);
        const contentEl = el.find(".post-content, .content").first();
        const quoteEl = contentEl.find(".quote-content, blockquote").first();
        // 引用块从正文里剥出去（原话留在 quote 字段），否则回复正文会带上被引用者的文字。
        const quoteAuthor = quoteEl.find(".quote-author, [class*='author']").first().text().trim();
        const quoteText = collapseWhitespace(quoteEl.clone().children(".quote-author").remove().end().text());
        const text = collapseWhitespace(contentEl.clone().find(".quote-content, blockquote").remove().end().text());
        if (!text) continue;
        const author = collapseWhitespace(el.find(".post-user__name, .u-name, .user-name").first().text()) || null;
        const time = collapseWhitespace(el.find(".post-time, .post-date").first().attr("datetime") ?? el.find(".post-time, .post-date").first().text()) || null;
        const likeText = collapseWhitespace(el.find(".post-like__value, .iliketop, .likes").first().text()) || null;
        const timeIso = time && Number.isFinite(Date.parse(time)) ? new Date(Date.parse(time)).toISOString() : null;
        posts.push({
          author,
          text,
          likes: likeText?.match(/\d+/) ? Number(likeText.replace(/\D/g, "")) : null,
          time: timeIso,
          floor: i + 1,
          quote: quoteText ? { author: collapseWhitespace(quoteAuthor) || null, text: quoteText } : null,
        });
        avatars.set(i, avatarOf(el));
      }
    }
    if (posts.length < 2) {
      const generic = parseThreadDom(html, input.url, selectorsOf(input));
      posts = generic.posts.map((p, i) => ({ author: p.author.name, text: p.text, likes: p.likes ?? null, time: p.publishedAt ?? null, floor: p.floor ?? i + 1 }));
      title = generic.title ?? input.title;
    }
    if (posts.length < 2 || !posts[0]!.text) return null;

    title = title ?? titleFromDom(cheerio.load(html)) ?? input.title;
    const op = posts[0]!;
    const replies = posts.slice(1).map((p, i) => ({
      id: null,
      author: { name: p.author, avatarUrl: avatars.get(i + 1) ?? null },
      text: p.text,
      publishedAt: p.time,
      likes: p.likes,
      floor: p.floor ?? i + 2,
      isOriginalAuthor: !!op.author && p.author === op.author,
      quote: p.quote ?? null,
    } satisfies DiscussionPost));
    const authorFollowups = replies.filter((p) => p.isOriginalAuthor);
    const highlighted = rankReplies(replies.filter((p) => !p.isOriginalAuthor), input.profile.highlightLimit ?? 8);
    const discussion: DiscussionContent = {
      originalPost: {
        id: null,
        author: { name: op.author, avatarUrl: avatars.get(0) ?? null },
        text: op.text,
        publishedAt: op.time,
        likes: op.likes,
        floor: 1,
        isOriginalAuthor: true,
        quote: null,
      },
      authorFollowups,
      highlightedReplies: highlighted,
      totalReplies: replies.length,
    };
    const opBlocks = htmlToBlocks(`<p>${op.text}</p>`, input.url);

    const content: CanonicalContent = {
      kind: "forum_thread",
      title: title ?? null,
      author: { name: op.author, avatarUrl: avatars.get(0) ?? null },
      publishedAt: op.time ?? input.publishedAt?.toISOString() ?? null,
      lead: op.text.slice(0, 200),
      main: opBlocks.blocks,
      media: opBlocks.media,
      discussion,
      video: null,
      social: null,
      engagement: { comments: replies.length, likes: op.likes },
      extraction: {
        extractor: "hupu",
        version: "1.0.0",
        sourceId: input.sourceId,
        sourceFamily: input.profile.contentFamily,
        fallbackUsed: false,
        bodyProvenance: "page_dom",
        sourceAuthority: "community",
      },
      quality: { score: 0, completeness: "full", warnings: [] },
    };
    return content;
  },
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

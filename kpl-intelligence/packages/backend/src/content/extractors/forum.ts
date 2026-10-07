// ForumThreadExtractor：论坛/社区的通用 thread 结构（虎扑只是它的一个 adapter）。
// 分离 originalPost / authorFollowups / highlightedReplies，评论永远不混入正文。
// 支持来源 config 的 threadSelectors 覆盖默认选择器：新论坛 ≈ Profile + 可选 selector 配置。
import * as cheerio from "cheerio";
import { collapseWhitespace, stripTags } from "../../lib/text.ts";
import { htmlToBlocks } from "./html-blocks.ts";
import type { ExtractionInput, ContentExtractor } from "./base.ts";
import type { CanonicalContent, DiscussionContent, DiscussionPost } from "./types.ts";

export interface ThreadSelectors {
  /** 每一楼/每一条的容器（第一层视为主帖）。 */
  post: string;
  author?: string;
  content?: string;
  time?: string;
  likes?: string;
  floor?: string;
  quote?: string;
  title?: string;
  avatar?: string;
}

const DEFAULT_SELECTORS: ThreadSelectors = {
  post: "[class*='post'], [id*='post_'], [class*='floor'], [class*='reply-item'], [class*='comment-item']",
  author: "[class*='author'], [class*='user'], [class*='name']",
  content: "[class*='content'], [class*='body'], [class*='text']",
  time: "time, [class*='time'], [class*='date']",
  likes: "[class*='like'], [class*='zan'], [class*='agree']",
  quote: "[class*='quote'], [class*='ref'], blockquote",
};

export function selectorsOf(input: ExtractionInput): ThreadSelectors {
  const cfg = (input.sourceConfig?.threadSelectors ?? null) as Partial<ThreadSelectors> | null;
  return { ...DEFAULT_SELECTORS, ...cfg };
}

// ---------------------------------------------------------------------------
// Comment Ranking：高价值回复不是虎扑专属功能，任何论坛/社区/视频平台通用。
// ---------------------------------------------------------------------------

const SPAM_TEXT = /^(哈+|呵+|6+|666+|草+|牛+|牛逼|nb|nice|好|行|哦|嗯|是的?|同意|支持|顶|不错|厉害|强|双击|关注了|前排|沙发|板凳|路过|打卡)[\s!！.。]*$/i;
const TACTICAL_WORDS = /(阵容|体系|运营|节奏|前期|中期|后期|经济|视野|开团|龙|兵线|反野|gank|bp|禁用|counter|分推|抱团|资源|换线|入侵|蹲草|绕后|开大|切C|保排|双C)/i;

export interface RankInput extends DiscussionPost {
  replyCount?: number | null;
}

/** 综合互动、长度、信息密度、战术词命中、原创程度、是否楼主；垃圾回复直接出局。 */
export function rankReplies(replies: DiscussionPost[], limit: number): DiscussionPost[] {
  const scored = replies
    .map((p) => ({ p, score: replyScore(p) }))
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.p);
}

export function replyScore(p: DiscussionPost): number {
  const text = (p.text ?? "").trim();
  const cleaned = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]/gu, "");
  if (!cleaned || cleaned.length < 8) return 0;
  if (SPAM_TEXT.test(cleaned)) return 0;
  // 复制粘贴（同一长串重复字符/链接堆砌）
  if (/^(https?:\S+\s*){3,}$/.test(cleaned)) return 0;
  let score = 0;
  score += Math.min(30, cleaned.length / 10);
  const likes = p.likes ?? 0;
  score += Math.min(40, Math.log2(1 + likes) * 12);
  if (TACTICAL_WORDS.test(text)) score += 10;
  if (p.quote?.text) score += 5;
  if (p.isOriginalAuthor) score += 8;
  // 无内容玩梗：极短 + 无标点
  if (cleaned.length < 15 && !/[。，、；：？!！]/.test(cleaned)) score -= 8;
  return score;
}

// ---------------------------------------------------------------------------
// DOM thread 解析
// ---------------------------------------------------------------------------

function numberFrom(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, "").match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

export function parseThreadDom(html: string, url: string, selectors: ThreadSelectors): { title: string | null; posts: DiscussionPost[]; likes: (number | null)[] } {
  const $ = cheerio.load(html);
  const title = collapseWhitespace($(selectors.title ?? "h1, .thread-title, [class*='topic-title'], [class*='thread_title']").first().text())
    || collapseWhitespace($("title").first().text().replace(/[-_|].*$/, ""));
  // Only the outermost matched containers are floors: a selector like [class*='post'] also matches
  // the post's own author/content children, which would otherwise masquerade as tiny extra floors.
  const matched = $(selectors.post).toArray();
  const containersSet = new Set(matched);
  const containers = matched.filter((node) => {
    let parent = node.parent;
    while (parent) {
      if (containersSet.has(parent)) return false;
      parent = parent.parent;
    }
    return true;
  });
  const posts: DiscussionPost[] = [];
  const likes: (number | null)[] = [];
  for (const node of containers.slice(0, 400)) {
    const el = $(node);
    const contentEl = selectors.content ? (el.is(selectors.content) ? el : el.find(selectors.content).first()) : el;
    const text = collapseWhitespace(contentEl.text());
    if (!text || text.length < 2) continue;
    const authorEl = selectors.author ? el.find(selectors.author).first() : $();
    const author = collapseWhitespace(authorEl.attr("data-original") ?? authorEl.attr("title") ?? authorEl.text()) || null;
    const timeEl = selectors.time ? el.find(selectors.time).first() : $();
    const time = collapseWhitespace(timeEl.attr("datetime") ?? timeEl.attr("title") ?? timeEl.text()) || null;
    const likeEl = selectors.likes ? el.find(selectors.likes).first() : $();
    const likeText = collapseWhitespace(likeEl.text()) || likeEl.attr("data-num") || likeEl.attr("data-value") || null;
    const floorEl = selectors.floor ? el.find(selectors.floor).first() : $();
    const floor = numberFrom(floorEl.text());
    const quoteEl = selectors.quote ? el.find(selectors.quote).first() : $();
    const quoteAuthor = quoteEl.find(selectors.author ?? "[class*='author']").first().text().trim();
    const quoteText = collapseWhitespace(quoteEl.text());
    posts.push({
      id: el.attr("id") ?? el.attr("data-id") ?? null,
      author: { name: author, avatarUrl: null },
      text,
      publishedAt: time ? maybeIso(time) : null,
      likes: numberFrom(likeText),
      floor: floor ?? (posts.length + 1),
      isOriginalAuthor: false,
      quote: quoteText && quoteText !== text ? { author: collapseWhitespace(quoteAuthor) || null, text: quoteText.slice(0, 400) } : null,
    });
    likes.push(numberFrom(likeText));
  }
  return { title: title || null, posts, likes };
}

function maybeIso(value: string): string | null {
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export const forumExtractor: ContentExtractor = {
  id: "forum",
  version: "1.0.0",

  canHandle(input: ExtractionInput): boolean {
    return input.profile.contentFamily === "forum" || input.profile.preferredExtractor === "forum";
  },

  async extract(input: ExtractionInput): Promise<CanonicalContent | null> {
    const html = input.html;
    if (!html) return null;
    const selectors = selectorsOf(input);
    const { title, posts } = parseThreadDom(html, input.url, selectors);
    if (posts.length === 0) return null;

    const op = posts[0]!;
    const opAuthor = op.author.name;
    const replies = posts.slice(1).map((p) => ({ ...p, isOriginalAuthor: !!opAuthor && p.author.name === opAuthor }));
    const authorFollowups = replies.filter((p) => p.isOriginalAuthor);
    const others = replies.filter((p) => !p.isOriginalAuthor);
    const highlightLimit = input.profile.highlightLimit ?? 6;
    const highlighted = rankReplies(others, highlightLimit);
    const totalReplies = replies.length;

    const discussion: DiscussionContent = { originalPost: op, authorFollowups, highlightedReplies: highlighted, totalReplies };
    const opBlocks = htmlToBlocks(`<p>${stripTags(op.text)}</p>`, input.url);

    const content: CanonicalContent = {
      kind: "forum_thread",
      title: title ?? input.title,
      author: { name: opAuthor, avatarUrl: op.author.avatarUrl ?? null },
      publishedAt: op.publishedAt ?? input.publishedAt?.toISOString() ?? null,
      lead: op.text.slice(0, 200),
      main: opBlocks.blocks,
      media: opBlocks.media,
      discussion,
      video: null,
      social: null,
      engagement: { comments: totalReplies, likes: op.likes ?? null },
      extraction: {
        extractor: "forum",
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

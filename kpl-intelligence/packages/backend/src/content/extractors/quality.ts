// Content Quality Engine：不同内容不用同一把尺子。
// 字数 >= 200 永远不再是主要判断：新闻 500 字正常、官方公告 150 字完整、社交帖 50 字即 100%，
// 论坛主帖 100 字 + 丰富评论区也是成功。输入必须带 contentKind + sourceFamily。
import type { CanonicalContent, ContentCompleteness, ContentKind, ContentQuality, DiscussionContent } from "./types.ts";
import { canonicalMainLength } from "./types.ts";

export interface QualityInput {
  kind: ContentKind;
  sourceFamily: string;
  title: string | null;
  /** 主文本（canonicalMainLength 的分项输入也可，这里直接收 canonical 以复用其口径）。 */
  canonical: Pick<CanonicalContent, "main" | "lead" | "discussion" | "social" | "video" | "media" | "engagement">;
  /** 提取器声称正文已尽力抓取（false → 降级为 partial 而非 failed 的线索）。 */
  fallbackUsed: boolean;
}

/** 段落与句子级别的统计。 */
function textStats(canonical: QualityInput["canonical"]): { paragraphs: number; avgParagraph: number; repeated: number; links: number; shortSentenceRatio: number } {
  const texts: string[] = [];
  for (const b of canonical.main) {
    if (b.type === "paragraph" || b.type === "quote" || b.type === "heading") texts.push(b.text);
    else if (b.type === "list") texts.push(...b.items);
  }
  // lead 通常就是首段（extractor 的约定），只在它确实不在 blocks 里时才计入，避免自重复。
  if (canonical.lead && !texts.some((t) => t.trim() === canonical.lead!.trim())) texts.push(canonical.lead);
  const paragraphs = texts.filter((t) => t.trim().length >= 10).length;
  const total = texts.reduce((n, t) => n + t.length, 0);
  const seen = new Map<string, number>();
  let repeated = 0;
  for (const t of texts) {
    const key = t.trim().slice(0, 60);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const n of seen.values()) if (n > 1) repeated += n - 1;
  const links = canonical.main.reduce((n, b) => (b.type === "paragraph" ? n + (b.text.match(/https?:\/\//g)?.length ?? 0) : n), 0);
  const sentences = texts.flatMap((t) => t.split(/[。！？.!?]/)).filter((s) => s.trim().length > 0);
  const short = sentences.filter((s) => s.trim().length <= 6).length;
  return {
    paragraphs,
    avgParagraph: paragraphs > 0 ? Math.round(total / paragraphs) : total,
    repeated,
    links,
    shortSentenceRatio: sentences.length ? short / sentences.length : 0,
  };
}

/** 评论区的信息量：纯表情/单字/哈哈哈/666 都不算数。 */
export function discussionValue(d: DiscussionContent | null): { count: number; substantial: number } {
  if (!d) return { count: 0, substantial: 0 };
  const posts = [d.originalPost, ...d.authorFollowups, ...d.highlightedReplies];
  const substantial = posts.filter((p) => {
    const t = p.text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]/gu, "");
    if (t.length < 5) return false;
    if (/^(哈+|呵+|6+|草|牛|好|行|哦|嗯|是的?|同意|支持|顶|不错|厉害|强)$/.test(t)) return false;
    return true;
  }).length;
  return { count: posts.length, substantial };
}

interface KindRule {
  /** 完整正文的期望字数下限；低于它进入 partial/summary_only 判断。 */
  fullChars: number;
  /** 只有简介/摘要也成立的内容（公告、视频简介）最短完整字数。 */
  summaryChars: number;
  /** 低于此长度视为抓取失败（垃圾正文防护）。 */
  failChars: number;
}

/** Source-aware 阈值（kind 优先，forum 族按主帖计算）。 */
const KIND_RULES: Record<string, KindRule> = {
  news: { fullChars: 350, summaryChars: 120, failChars: 40 },
  article: { fullChars: 350, summaryChars: 120, failChars: 40 },
  interview: { fullChars: 300, summaryChars: 120, failChars: 40 },
  analysis: { fullChars: 300, summaryChars: 120, failChars: 40 },
  official_announcement: { fullChars: 120, summaryChars: 50, failChars: 20 },
  forum_thread: { fullChars: 80, summaryChars: 40, failChars: 15 },
  social_post: { fullChars: 30, summaryChars: 10, failChars: 2 },
  video_post: { fullChars: 60, summaryChars: 20, failChars: 5 },
  unknown: { fullChars: 200, summaryChars: 80, failChars: 30 },
};

/**
 * 评分（0-100）：主文本量、有效段落、结构、讨论价值、媒体；扣分项为重复、链接密度、
 * 短句密度（导航/口水文本特征）。completeness 是独立于分数的判断（宁显示"不完整"，不显示错误正文）。
 */
export function evaluateContentQuality(input: QualityInput): ContentQuality {
  const warnings: string[] = [];
  const rule = KIND_RULES[input.kind] ?? KIND_RULES.unknown!;
  const chars = canonicalMainLength(input.canonical as CanonicalContent);
  const stats = textStats(input.canonical);
  const discussion = discussionValue(input.canonical.discussion ?? null);

  let score = 0;
  // 主文本量（40 分），论坛以主帖+楼主补充计，评论另算。
  score += Math.min(40, Math.round((chars / rule.fullChars) * 40));
  // 有效段落数（15 分）
  score += Math.min(15, stats.paragraphs * 3);
  // 讨论价值（20 分）：论坛/视频评论区是内容的一部分，不是污染。
  if (input.canonical.discussion) {
    score += Math.min(20, discussion.substantial * 4);
    const tr = input.canonical.discussion.totalReplies;
    if (typeof tr === "number" && tr > (input.canonical.discussion.highlightedReplies.length + input.canonical.discussion.authorFollowups.length)) {
      score += 4;
    }
  } else if (input.kind === "forum_thread") {
    warnings.push("forum_thread_without_replies");
  } else {
    score += 6; // 非讨论内容不因没有评论区被扣
  }
  // 媒体（10 分）
  score += Math.min(10, input.canonical.media.length * 2);
  // engagement（5 分）
  const eng = input.canonical.engagement;
  if (eng && Object.values(eng).some((v) => typeof v === "number" && v > 0)) score += 5;
  // 结构（10 分）：标题存在 + 有 heading/quote/list 或 lead
  if (input.title) score += 4;
  if (input.canonical.lead || input.canonical.main.some((b) => b.type === "heading" || b.type === "quote" || b.type === "list" || b.type === "table")) score += 6;

  // 扣分：重复块、链接密度过高、短句密度过高（口水/导航特征）。
  if (stats.repeated > 0) {
    score -= Math.min(12, stats.repeated * 4);
    warnings.push("repeated_blocks");
  }
  if (chars > 0 && stats.links * 200 > chars) {
    score -= 10;
    warnings.push("link_density_high");
  }
  if (chars > 200 && stats.shortSentenceRatio > 0.5) {
    score -= 8;
    warnings.push("short_sentence_density_high");
  }
  if (chars === 0) {
    score = 0;
    warnings.push("empty_main_text");
  }
  score = Math.max(0, Math.min(100, score));

  const completeness = completenessOf(input, chars, rule, discussion);
  if (hasExplicitTruncation(input)) warnings.push("body_truncated");
  if (completeness === "partial" && !warnings.includes("body_truncated")) warnings.push("body_may_be_incomplete");
  if (completeness === "summary_only") warnings.push("summary_only_content");
  if (completeness === "failed") warnings.push("unusable_body");
  return { score, completeness, warnings };
}

function hasExplicitTruncation(input: QualityInput): boolean {
  const c = input.canonical as any;
  if (!c) return false;
  if (c.extraction?.bodyCompleteness === "partial") return true;
  if (c.extraction?.truncated === true) return true;
  if (c.isTruncated === true || c.truncated === true) return true;
  if (c.discussion?.originalPost?.truncated === true || c.discussion?.originalPost?.isTruncated === true) return true;
  if (Array.isArray(c.extraction?.warnings) && c.extraction.warnings.some((w: string) => /truncat/i.test(w))) return true;
  return false;
}

function hasValidForumStructure(canonical: QualityInput["canonical"]): boolean {
  const d = canonical.discussion;
  if (!d || typeof d !== "object") return false;
  const op = d.originalPost;
  if (!op || typeof op !== "object") return false;
  if (typeof op.text !== "string" || !op.text.trim()) return false;
  if (!op.author || typeof op.author !== "object") return false;
  return true;
}

function completenessOf(input: QualityInput, chars: number, rule: KindRule, discussion: { substantial: number }): ContentCompleteness {
  if (hasExplicitTruncation(input)) {
    return "partial";
  }

  if (input.kind === "forum_thread") {
    const hasValidStructure = hasValidForumStructure(input.canonical);
    if (!hasValidStructure) {
      return (chars >= rule.failChars || discussion.substantial > 0) ? "partial" : "failed";
    }

    // 严谨判定完整度：必须具备明确有效结构，严禁仅以 char>=15 判定为 full
    if (chars >= rule.fullChars) {
      return "full";
    }
    if (discussion.substantial >= 3 && chars >= rule.failChars) {
      return "full";
    }
    if (chars >= rule.summaryChars) {
      return "partial";
    }
    return chars >= rule.failChars ? "partial" : "failed";
  }
  // 官方公告/社交帖：达到最短完整字数即完整（宁少勿错）。
  if (input.kind === "official_announcement" || input.kind === "social_post") {
    return chars >= rule.summaryChars ? "full" : chars >= rule.failChars ? "partial" : "failed";
  }
  // 视频：只有拿到字幕/文案才算完整内容，否则简介就是 summary_only。
  if (input.kind === "video_post") {
    return input.canonical.video?.transcriptSummary ? "full" : chars >= rule.summaryChars ? "summary_only" : chars >= rule.failChars ? "partial" : "failed";
  }
  if (chars >= rule.fullChars) return "full";
  if (chars >= rule.summaryChars) return "partial";
  if (chars >= rule.failChars) return "partial";
  return "failed";
}

// Item detail and Markdown export, both behind the same visibility and licence rules.
import type { OutlineEntry, SiteItemDetail, StoryRef } from "@aihot/contracts/site";
import { SITE } from "@aihot/industry/site";
import { bodyToMarkdown } from "../content/markdown.ts";
import { canonicalToBody } from "../content/canonical.ts";
import { sql } from "../db.ts";
import { proxyBodyImages } from "../media/imgproxy.ts";
import { textToHtml } from "../content/sanitize.ts";
import { exportTranslation, isChineseBody, ITEM_COLUMNS, ITEM_FROM, seatHolders, toContentView, toItemSummary, xView, type ItemRow } from "./items.ts";
import { listedCondition } from "./scope.ts";
import { itemUrl } from "./links.ts";
import { canPublishSignalDetail, hasItemPage, isCommunityFeedbackApproved, isCommunityPublicationEnabled, publicSourceName } from "./rules.ts";
import { topicLinks, topicMembership } from "./topics.ts";
import { sourceGroupExpression } from "./source-groups.ts";

interface DetailRow extends ItemRow {
  enabled?: boolean;
  body_html: string | null;
  body_text: string | null;
  body_status: string;
  tr_html: string | null;
  tr_complete: boolean | null;
  topics: string[];
  canonical_content: Record<string, any> | null;
  content_quality_score: number | null;
  content_completeness: string | null;
  article_revision?: number;
}

export type DetailResult =
  | { kind: "found"; item: SiteItemDetail; row: DetailRow }
  | { kind: "not_found" };

/** Adds stable ids to h2–h4 and returns the outline. */
function withOutline(html: string): { html: string; outline: OutlineEntry[] } {
  const outline: OutlineEntry[] = [];
  let n = 0;
  const out = html.replace(/<h([2-4])(?: id="sec-\d+")?>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    n += 1;
    const id = `sec-${n}`;
    const text = inner.replace(/<[^>]+>/g, "").trim();
    if (text) outline.push({ id, text: text.slice(0, 80), level: Number(level) });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  return { html: out, outline };
}

async function loadRow(id: string): Promise<DetailRow | null> {
  let [row] = await sql<DetailRow[]>`
    SELECT ${ITEM_COLUMNS}, s.enabled, a.body_html, a.body_text, a.body_status, tr.body_html AS tr_html, tr.complete AS tr_complete,
      a.content_quality_score, a.content_completeness, a.revision AS article_revision,
      ${topicMembership()} AS topics
    ${ITEM_FROM}
    WHERE p.article_id = ${id}`;
  if (!row) {
    const [aRow] = await sql<any[]>`
      SELECT a.id, a.title, a.title AS original_title, a.excerpt AS summary, NULL AS reason,
        NULL AS category, '{}'::text[] AS tags, NULL AS score, false AS selected, false AS seat,
        'news' AS channel, a.url, a.published_at, a.discovered_at, a.timeline_at,
        coalesce(eo.visibility, 'public') AS visibility,
        CASE WHEN s.site_fulltext THEN 'full' ELSE 'summary' END AS body_mode,
        false AS indexable, NULL AS fact_id, s.name AS source_name, s.participation_mode AS source_mode,
        s.enabled,
        ${sourceGroupExpression} AS source_group,
        a.x_post, a.author, a.language, a.content_kind, a.body_status, a.canonical_content,
        NULL AS story_public_id, NULL AS story_title, NULL AS zh_text, NULL AS quoted_zh,
        a.body_html, a.body_text, NULL AS tr_html, NULL AS tr_complete,
        a.content_quality_score, a.content_completeness, a.revision AS article_revision,
        '{}'::text[] AS topics
      FROM articles a
      JOIN sources s ON s.id = a.source_id
      LEFT JOIN editorial_overrides eo ON eo.article_id = a.id
      WHERE a.id = ${id}`;
    if (aRow) row = aRow as DetailRow;
  }
  return row ?? null;
}

export async function loadAcceptedRadarMaterial(articleId: string): Promise<{
  state: string;
  inputRevision: number;
  scoreVersion: string;
  inputEvidenceHash: string | null;
  judgment: any;
} | null> {
  const [rm] = await sql<{ state: string; input_revision: number; score_version: string; judgment: any; input_evidence_hash: string | null }[]>`
    SELECT state, input_revision, score_version, judgment, input_evidence_hash
    FROM radar_materials
    WHERE article_id = ${articleId} AND state = 'accepted'`;
  if (!rm) return null;
  return {
    state: rm.state,
    inputRevision: rm.input_revision,
    scoreVersion: rm.score_version,
    inputEvidenceHash: rm.input_evidence_hash,
    judgment: rm.judgment,
  };
}

/**
 * The body a page reads in `language` when it has it, else in the other: Chinese is the article's own text
 * or a translation (shown even before it is complete), the original only the article's own. `page` turns
 * the HTML shown into what is sent, with its outline.
 */
function readingBody(
  language: "zh" | "original",
  zh: { html: string; kind: "translation" | "original" } | null,
  original: string | null,
  complete: boolean,
  page: (html: string) => { html: string; outline: OutlineEntry[] },
): Pick<SiteItemDetail, "body" | "outline" | "hasTranslation" | "bodyLanguage"> {
  const bodyLanguage = language === "original" && original ? "original" : zh?.html ? "zh" : "original";
  const shown = bodyLanguage === "zh" ? zh!.html : original;
  const sent = shown ? page(shown) : { html: shown, outline: [] };
  return {
    body: { zh: bodyLanguage === "zh" ? sent.html : null, original: bodyLanguage === "original" ? sent.html : null, zhKind: zh?.kind ?? null, complete },
    outline: sent.outline,
    hasTranslation: zh?.kind === "translation" && !!zh.html && !!original,
    bodyLanguage,
  };
}

function requiresFeedbackSafetyGate(row: DetailRow): boolean {
  if (row.source_mode !== "editorial") return true;
  return Boolean(row.canonical_content?.discussion?.collection);
}

function sanitizeUnapprovedBody(row: DetailRow): void {
  const canonical = row.canonical_content;
  if (!canonical) return;
  const kind = canonical.kind ?? row.content_kind;
  if (kind === "social_post" || canonical.social || kind === "video_post" || canonical.video) {
    const cloned = { ...canonical, discussion: null };
    const derived = canonicalToBody(cloned as any);
    row.body_html = derived.html;
    row.body_text = derived.text;
  } else if (kind === "forum_thread" || canonical.discussion) {
    const opText = canonical.discussion?.originalPost?.text ?? "";
    const mainBlocks = Array.isArray(canonical.main) && canonical.main.length > 0
      ? canonical.main
      : (opText ? [{ type: "paragraph" as const, text: opText }] : []);
    const cloned = {
      ...canonical,
      discussion: null,
      social: null,
      video: null,
      main: mainBlocks,
      bodyHtmlSource: undefined,
    };
    const derived = canonicalToBody(cloned as any);
    row.body_html = derived.html;
    row.body_text = derived.text;
  }
}

/**
 * Public detail (rules.hasItemPage) in one language, Chinese unless the original is asked for: items the
 * lists leave out (low relevance, merged duplicates, no Chinese summary yet) keep a noindex page;
 * withdrawn and hot_signal items are a 404.
 */
export async function loadItemDetail(id: string, language: "zh" | "original" = "zh", now = new Date()): Promise<DetailResult> {
  const row = await loadRow(id);
  if (!row) return { kind: "not_found" };

  let radarMat: {
    state: string;
    inputRevision: number;
    scoreVersion: string;
    inputEvidenceHash: string | null;
    judgment: any;
  } | null = null;

  if (row.source_mode === "editorial") {
    if (!hasItemPage({ visibility: row.visibility, sourceMode: row.source_mode })) return { kind: "not_found" };
    radarMat = await loadAcceptedRadarMaterial(id);
  } else {
    // Signal item detail: strictly gated by COMMUNITY_PUBLICATION_ENABLED, current accepted radar judgment, and nonfailed sufficient quality
    if (!isCommunityPublicationEnabled() || row.visibility === "withdrawn") return { kind: "not_found" };
    radarMat = await loadAcceptedRadarMaterial(id);
    if (!radarMat) return { kind: "not_found" };
    const canPublish = canPublishSignalDetail({
      visibility: row.visibility,
      sourceMode: row.source_mode,
      enabled: row.enabled,
      articleRevision: row.article_revision ?? 1,
      radarMaterial: radarMat,
      quality: {
        completeness: row.content_completeness ?? row.canonical_content?.quality?.completeness ?? null,
        score: row.content_quality_score ?? row.canonical_content?.quality?.score ?? null,
      },
      canonical: row.canonical_content,
      contentKind: row.content_kind ?? row.canonical_content?.kind ?? null,
      fallbackBody: { title: row.title, bodyText: row.body_text, excerpt: (row as any).summary },
    });
    if (!canPublish) return { kind: "not_found" };
  }

  if (radarMat) {
    row.radar_state = radarMat.state;
    row.radar_input_revision = radarMat.inputRevision;
    row.radar_score_version = radarMat.scoreVersion;
    row.radar_input_evidence_hash = radarMat.inputEvidenceHash;
    row.radar_judgment = radarMat.judgment;
  }

  const needsGate = requiresFeedbackSafetyGate(row);
  const feedbackApproved = needsGate
    ? isCommunityFeedbackApproved({
        articleRevision: row.article_revision ?? 1,
        radarMaterial: radarMat,
        canonical: row.canonical_content,
        fallbackBody: { title: row.title, bodyText: row.body_text, excerpt: (row as any).summary },
      })
    : true;
  row.feedback_approved = feedbackApproved;
  row.feedbackApproved = feedbackApproved;

  if (needsGate && !feedbackApproved) {
    sanitizeUnapprovedBody(row);
  }

  const summary = toItemSummary(row);
  if (row.visibility === "summary-only") {
    const item: SiteItemDetail = {
      ...summary,
      reason: null,
      tags: [],
      x: null,
      content: null,
      readingMode: "summary-only",
      author: null,
      body: null,
      outline: [],
      relatedStories: [],
      topics: [],
      indexable: false,
      markdownAvailable: false,
      group: null,
      hasTranslation: false,
      bodyLanguage: "original",
    };
    return { kind: "found", item, row };
  }

  const related = await sql<StoryRef[]>`
    SELECT DISTINCT st.public_id::text AS "publicId", st.title
    FROM fact_articles fa JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id
    WHERE fa.article_id = ${id} AND fa.role <> 'mention' AND st.merged_into IS NULL
    LIMIT 6`;

  let x: SiteItemDetail["x"] = null;
  let reading: Pick<SiteItemDetail, "body" | "outline" | "hasTranslation" | "bodyLanguage"> = { body: null, outline: [], hasTranslation: false, bodyLanguage: "original" };
  const isFullAllowed = row.body_mode === "full" && (!row.body_status || row.body_status === "ok");
  // An X post's own text and media are its body: shown only where the source allows full text.
  if (row.channel === "x" && isFullAllowed) {
    const post = xView(row, false, true);
    const text = String(row.x_post?.text ?? row.body_text ?? "");
    // A post's text is sent as written: its headings make the outline, without anchors.
    reading = readingBody(language, post?.translation ? { html: textToHtml(post.translation), kind: "translation" } : null, text ? textToHtml(text) : null, true,
      (html) => ({ html, outline: withOutline(html).outline }));
    if (post) {
      const { text: _text, translation: _translation, ...shown } = post;
      x = shown;
    }
  } else if (isFullAllowed && row.body_html) {
    const chinese = isChineseBody(row);
    const zh = chinese ? { html: row.body_html, kind: "original" as const } : row.tr_html ? { html: row.tr_html, kind: "translation" as const } : null;
    reading = readingBody(language, zh, chinese ? null : row.body_html, chinese ? true : row.tr_complete ?? false, (html) => withOutline(proxyBodyImages(html)));
  }

  let group: SiteItemDetail["group"] = null;
  if (row.fact_id) {
    const [g] = await sql<{ public_id: string; reports: number; sources: number }[]>`
      SELECT f.public_id, count(p.article_id) AS reports, count(DISTINCT p.source_id) AS sources
      FROM facts f JOIN publications p ON p.fact_id = f.id
      WHERE f.id = ${row.fact_id} AND ${listedCondition(now)}
      GROUP BY f.public_id`;
    if (g) {
      group = {
        factId: g.public_id,
        reportCount: Number(g.reports),
        additionalSourceCount: Math.max(0, Number(g.sources) - 1),
      };
    }
  }

  // The reason goes with the seat; a report yielding it points to the one holding it.
  const sameEvent = (await seatHolders([row], now)).get(row.id) ?? null;
  const item: SiteItemDetail = {
    ...summary,
    x,
    ...(sameEvent ? { reason: null, sameEvent } : {}),
    // readingMode is the editorial visibility, not the source's fulltext licence.
    // An ordinary public page still allows summary export/navigation when its body is withheld.
    readingMode: "full",
    author: row.author,
    content: toContentView(row, feedbackApproved),
    body: reading.body,
    outline: reading.outline,
    relatedStories: related,
    topics: topicLinks(row.topics),
    indexable: row.indexable,
    markdownAvailable: markdownAvailable(row, radarMat),
    group,
    hasTranslation: reading.hasTranslation,
    bodyLanguage: reading.bodyLanguage,
  };
  return { kind: "found", item, row };
}

/**
 * Same predicate for the export button and the export route: a public page with something to export
 * (a summary, or a post or body whose full text may be shown).
 */
export function markdownAvailable(row: {
  visibility: string; source_mode: string; summary: string | null; body_mode: string; body_html?: string | null; channel: string; x_post: Record<string, any> | null; body_status?: string | null;
  enabled?: boolean;
  article_revision?: number;
  canonical_content?: Record<string, any> | null;
  content_completeness?: string | null;
  content_quality_score?: number | null;
  content_kind?: string | null;
  body_text?: string | null;
  title?: string | null;
}, radarMat?: {
  state: string;
  inputRevision?: number;
  scoreVersion?: string;
  input_revision?: number;
  score_version?: string;
  inputEvidenceHash?: string | null;
  input_evidence_hash?: string | null;
  judgment?: any;
} | null): boolean {
  if (row.visibility !== "public") return false;
  let hasPage = false;
  if (row.source_mode === "editorial") {
    hasPage = hasItemPage({ visibility: row.visibility, sourceMode: row.source_mode });
  } else if (isCommunityPublicationEnabled()) {
    hasPage = canPublishSignalDetail({
      visibility: row.visibility,
      sourceMode: row.source_mode,
      enabled: row.enabled,
      articleRevision: row.article_revision ?? 1,
      radarMaterial: radarMat ? {
        state: radarMat.state,
        inputRevision: radarMat.inputRevision ?? radarMat.input_revision,
        scoreVersion: radarMat.scoreVersion ?? radarMat.score_version,
        inputEvidenceHash: radarMat.inputEvidenceHash ?? radarMat.input_evidence_hash ?? null,
        judgment: radarMat.judgment,
      } : null,
      quality: {
        completeness: row.content_completeness ?? row.canonical_content?.quality?.completeness ?? null,
        score: row.content_quality_score ?? row.canonical_content?.quality?.score ?? null,
      },
      canonical: row.canonical_content,
      contentKind: row.content_kind ?? row.canonical_content?.kind ?? null,
      fallbackBody: { title: row.summary, bodyText: row.body_text, excerpt: row.summary },
    });
  }
  if (!hasPage) return false;
  const isFull = row.body_mode === "full" && (!row.body_status || row.body_status === "ok");
  return !!row.summary || (isFull && ((row.channel === "x" && !!row.x_post?.text) || !!row.body_html || !!row.canonical_content?.discussion?.originalPost?.text));
}

export async function exportMarkdown(id: string): Promise<{ filename: string; body: string } | null> {
  const row = await loadRow(id);
  if (!row) return null;
  const radarMat = await loadAcceptedRadarMaterial(id);
  if (!markdownAvailable(row, radarMat)) return null;

  if (radarMat) {
    row.radar_state = radarMat.state;
    row.radar_input_revision = radarMat.inputRevision;
    row.radar_score_version = radarMat.scoreVersion;
    row.radar_input_evidence_hash = radarMat.inputEvidenceHash;
    row.radar_judgment = radarMat.judgment;
  }

  const needsGate = requiresFeedbackSafetyGate(row);
  const feedbackApproved = needsGate
    ? isCommunityFeedbackApproved({
        articleRevision: row.article_revision ?? 1,
        radarMaterial: radarMat,
        canonical: row.canonical_content,
        fallbackBody: { title: row.title, bodyText: row.body_text, excerpt: (row as any).summary },
      })
    : true;
  row.feedback_approved = feedbackApproved;
  row.feedbackApproved = feedbackApproved;

  if (needsGate && !feedbackApproved) {
    sanitizeUnapprovedBody(row);
  }
  const lines: string[] = [];
  lines.push(`# ${row.title}`, "");
  if (row.original_title) lines.push(`> 原标题：${row.original_title}`, "");
  lines.push(`- 来源：${publicSourceName(row.source_name)}`);
  lines.push(`- 发布时间：${(row.published_at ?? row.discovered_at).toISOString()}`);
  lines.push(`- ${SITE.name}：${itemUrl(row.id)}`);
  lines.push(`- 原文：${row.url}`, "");
  if (row.summary) lines.push("## 摘要", "", row.summary, "");
  if (row.selected && row.seat && row.reason) lines.push("## 推荐理由", "", row.reason, "");
  const isFull = row.body_mode === "full" && (!row.body_status || row.body_status === "ok");
  if (row.channel === "x" && isFull && row.x_post?.text) {
    lines.push("## 正文", "", String(row.x_post.text), "");
    if (row.zh_text) lines.push("## 中文译文", "", row.zh_text, "");
    const q = row.x_post.quoted as { handle?: string; text?: string; url?: string } | null | undefined;
    if (q?.text) lines.push(`## 引用 @${q.handle ?? ""}`, "", ...String(q.text).split("\n").map((l) => `> ${l}`), "", ...(q.url ? [q.url, ""] : []));
    if (q?.text && row.quoted_zh) lines.push("### 引用中文译文", "", ...row.quoted_zh.split("\n").map((l) => `> ${l}`), "");
  } else if (isFull && row.body_html) {
    const translation = exportTranslation(row);
    if (translation) lines.push("## 正文 · 中文译文", "", bodyToMarkdown(translation, row.url), "");
    lines.push(isChineseBody(row) ? "## 正文" : "## 正文 · 原文", "", bodyToMarkdown(row.body_html, row.url), "");
  } else if (isFull && (row.canonical_content?.discussion?.originalPost?.text || row.body_text)) {
    const text = row.canonical_content?.discussion?.originalPost?.text ?? row.body_text;
    if (text) lines.push("## 正文", "", String(text), "");
  }
  return { filename: `${SITE.mcpPrefix}-${row.id}.md`, body: lines.join("\n").replace(/\n{3,}/g, "\n\n") };
}

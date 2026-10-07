// 内容抽取：一切来源的正文经由 Extractor Registry → CanonicalContent → 派生 body 字段落库。
// Readability 只是 generic extractor 的内部兜底；Jina 是整条链的最后 fallback，且如实标注 provenance。
// "unconfirmed" 仍然是失败时的状态：宁可显示"不完整"，不显示错误正文。
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { stripTags } from "../lib/text.ts";
import { jinaRead } from "../providers/jina.ts";
import { BudgetExceededError } from "../providers/receipts.ts";
import { getArticle } from "../providers/socialdata.ts";
import { onlyXArticleLink, xArticleText } from "../sources/x.ts";
import { sanitizeBody, trimTrailingChrome } from "./sanitize.ts";
import { contentHash, reviseMaterial } from "./materials.ts";
import { markdownBody } from "./markdown.ts";
import { canonicalToBody } from "./canonical.ts";
import { extractCanonical, profileFor, type ExtractionInput } from "./extractors/index.ts";
import { socialExtractor } from "./extractors/social.ts";

export interface ExtractedBody {
  html: string;
  text: string;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
  via: "readability" | "jina" | "extractor";
}

const MIN_BODY_CHARS = 200;

export function readable(html: string, url: string): ExtractedBody | null {
  const { document } = parseHTML(html);
  try {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  } catch {
    // no head
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: MIN_BODY_CHARS, keepClasses: false }).parse();
  if (!article?.content) return null;
  const clean = trimTrailingChrome(sanitizeBody(article.content, url));
  const text = stripTags(clean);
  if (text.length < MIN_BODY_CHARS) return null;
  const images: ExtractedBody["images"] = [];
  for (const m of clean.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
    const w = m[0].match(/\bwidth="(\d+)"/);
    const h = m[0].match(/\bheight="(\d+)"/);
    images.push({ kind: "image", url: m[1]!.replace(/&amp;/g, "&"), width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null });
    if (images.length >= 12) break;
  }
  return { html: clean, text, images, via: "readability" };
}

/** extractor 需要的受限 JSON 抓取（B站 view API 等）：直接 HTTP，无付费预算。 */
async function fetchJsonForExtractors(url: string): Promise<unknown> {
  const res = await guardedFetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36", Referer: "https://www.bilibili.com/" },
    timeoutMs: 15_000,
    maxBytes: 2 * 1024 * 1024,
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(res.text());
}

/** 组装 registry 的输入（来源事实 + 已知线索；线索永远不当正文）。 */
function extractionInput(row: {
  url: string; source_id: string; source_kind: string; source_config: Record<string, any> | null;
  title: string; excerpt: string | null; author: string | null; published_at: Date | null; x_post: Record<string, any> | null;
}, html: string | null): ExtractionInput {
  const profile = profileFor({ sourceId: row.source_id, url: row.url, kind: row.source_kind, config: row.source_config });
  return {
    url: row.url,
    html,
    profile,
    sourceId: row.source_id,
    sourceKind: row.source_kind,
    title: row.title,
    excerpt: row.excerpt,
    author: row.author,
    publishedAt: row.published_at,
    xPost: row.x_post,
    raw: null,
    sourceConfig: row.source_config,
    fetchJson: fetchJsonForExtractors,
  };
}

/** Pages extraction can fetch: ordinary web pages (X posts arrive whole or not at all). */
export function pageFetchable(url: string, sourceKind: string): boolean {
  if (sourceKind === "x_search") return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !/(^|\.)(x\.com|twitter\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

async function fetchPageHtml(url: string): Promise<string | null> {
  const res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
  if (res.status !== 200 || !/html/.test(res.headers.get("content-type") ?? "")) return null;
  return res.text();
}

export interface CanonicalSourceContext {
  sourceId: string;
  sourceKind: string;
  sourceConfig: Record<string, any> | null;
}

/**
 * 一次"用已抓到的 HTML 走 registry"的抽取（detail fetch 复用字节、re-extract 脚本共用）。
 * 返回 null 表示整条链（专属→家族→generic→readability）都没有产出，调用方再走 Jina。
 */
export async function extractCanonicalForUrl(
  ctx: CanonicalSourceContext,
  url: string,
  html: string | null,
  hints: { title?: string | null; excerpt?: string | null; author?: string | null; publishedAt?: Date | null; xPost?: Record<string, any> | null } = {},
): Promise<Awaited<ReturnType<typeof extractCanonical>>> {
  const row = {
    url,
    source_id: ctx.sourceId,
    source_kind: ctx.sourceKind,
    source_config: ctx.sourceConfig,
    title: hints.title ?? "",
    excerpt: hints.excerpt ?? null,
    author: hints.author ?? null,
    published_at: hints.publishedAt ?? null,
    x_post: hints.xPost ?? null,
  };
  return extractCanonical(extractionInput(row, html));
}

/**
 * Fetches and stores the body of one article through the extractor registry. The canonical content
 * lands in its own columns; body_html/body_text/media are derived from it. Unconfirmed bodies are
 * recorded as such.
 */
export async function extractArticleBody(articleId: string): Promise<"ok" | "unconfirmed" | "skipped"> {
  const [a] = await sql<{
    id: string; url: string; body_status: string; revision: number; title: string; excerpt: string | null; author: string | null;
    published_at: Date | null; x_post: { tweetId?: string } | null; source_id: string; source_kind: string; source_config: Record<string, any> | null;
  }[]>`
    SELECT a.id, a.url, a.body_status, a.revision, a.title, a.excerpt, a.author, a.published_at, a.x_post,
           s.id AS source_id, s.kind AS source_kind, s.config AS source_config
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!a || a.body_status === "ok") return "skipped";
  if (a.x_post?.tweetId) return extractXArticle(a.id, a.x_post.tweetId, a.revision);

  // registry 管道：先抓页面 HTML，专属/家族/通用 extractor 依次尝试。
  const html = await fetchPageHtml(a.url);
  const input = extractionInput(a, html);
  const got = await extractCanonical(input);
  if (got) return storeCanonical(articleId, a, got);
  if (!html) return markUnconfirmed(articleId, a.revision);

  // generic 也失败：Readability（generic 内部）已经试过，Jina 是最后 fallback。
  try {
    const page = await jinaRead(a.url, { purpose: "body_fallback", subject: `article:${articleId}` });
    const jhtml = markdownBody(page.markdown, a.url);
    if (stripTags(jhtml).length < MIN_BODY_CHARS) return markUnconfirmed(articleId, a.revision);
    const rebuilt = await extractCanonical({ ...input, html: jhtml });
    if (rebuilt) return storeCanonical(articleId, a, rebuilt);
    return markUnconfirmed(articleId, a.revision);
  } catch (error) {
    if (error instanceof BudgetExceededError) return markUnconfirmed(articleId, a.revision);
    throw error;
  }
}

/** canonical + 派生 body 的一次性落库（新 revision，分析重新开始）。 */
async function storeCanonical(articleId: string, a: { title: string; excerpt: string | null; revision: number }, got: { content: Parameters<typeof canonicalToBody>[0]; body: ReturnType<typeof canonicalToBody> }): Promise<"ok" | "skipped"> {
  const { content, body } = got;
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; content_hash: string | null }[]>`
      SELECT title, excerpt, content_hash FROM articles
      WHERE id = ${articleId} AND revision = ${a.revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    const text = body.text;
    const hash = contentHash({ title: row.title, bodyText: text, excerpt: row.excerpt });
    if (hash === row.content_hash) {
      await tx`UPDATE articles SET body_status = ${content.quality.completeness === "failed" ? "unconfirmed" : "ok"}, updated_at = now() WHERE id = ${articleId}`;
      return "ok";
    }
    await reviseMaterial(tx, articleId, {
      set: sql`body_html = ${body.html}, body_text = ${text},
        body_status = ${content.quality.completeness === "failed" ? "unconfirmed" : "ok"},
        media = CASE WHEN jsonb_array_length(media) = 0 THEN ${sql.json(body.images as never)}::jsonb ELSE media END,
        content_kind = ${content.kind},
        content_quality_score = ${content.quality.score},
        content_completeness = ${content.quality.completeness},
        content_extraction_meta = ${sql.json(content.extraction as never)},
        canonical_content = ${sql.json(content as never)}`,
      hash, title: row.title, bodyText: text,
    });
    return "ok";
  });
}

async function markUnconfirmed(articleId: string, revision: number): Promise<"unconfirmed" | "skipped"> {
  const rows = await sql`UPDATE articles SET body_status = 'unconfirmed', updated_at = now()
    WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' RETURNING id`;
  return rows.length ? "unconfirmed" : "skipped";
}

/**
 * The X Article a post published (SocialData, paid, by the post's own id). The article joins the
 * post's body as a new revision; content_kind marks the social view. No article leaves the post
 * "unconfirmed", and the judging steps are told the article was not fetched.
 */
async function extractXArticle(articleId: string, tweetId: string, revision: number): Promise<"ok" | "unconfirmed" | "skipped"> {
  const found = await getArticle(tweetId, { purpose: "x_article", subject: `article:${articleId}` });
  const gotArticle = found ? xArticleText(found) : null;
  if (!gotArticle) {
    // 没有长文：帖子本身已是完整内容时，social canonical 直接从 x_post 映射；
    // 纯长文链接的帖子没有正文可给，维持 unconfirmed（不能让链接文本冒充完整正文）。
    const [row] = await sql<{ url: string; title: string; excerpt: string | null; author: string | null; x_post: Record<string, any> | null; published_at: Date | null; source_id: string; source_kind: string; source_config: Record<string, any> | null }[]>`
      SELECT a.url, a.title, a.excerpt, a.author, a.x_post, a.published_at, s.id AS source_id, s.kind AS source_kind, s.config AS source_config
      FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
    if (row?.x_post && !onlyXArticleLink(String(row.x_post.text ?? ""))) {
      const input = extractionInput(row, null);
      const social = await socialExtractor.extract(input);
      if (social) return storeCanonical(articleId, { title: row.title, excerpt: row.excerpt, revision }, { content: social, body: canonicalToBody(social) });
    }
    return markUnconfirmed(articleId, revision);
  }
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; body_text: string | null; x_post: { text?: string } | null; x_article: { title?: string | null; text?: string } | null }[]>`
      SELECT title, excerpt, body_text, x_post, x_article FROM articles
      WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    const block = (a: { title?: string | null; text?: string } | null) => (a ? [a.title ? `# ${a.title}` : "", a.text ?? ""].filter(Boolean).join("\n\n") : "");
    // The post's own text, without an article appended by an earlier extraction (an admin re-run
    // extracts again from the post; appending once more would repeat the article).
    const previous = block(row.x_article);
    let base = row.body_text ?? "";
    if (previous && base.endsWith(previous)) base = base.slice(0, -previous.length).replace(/\s+$/, "");
    const title = gotArticle.title && onlyXArticleLink(row.x_post?.text) ? gotArticle.title : row.title;
    const bodyText = [base, block(gotArticle)].filter(Boolean).join("\n\n");
    if (bodyText === row.body_text && title === row.title) {
      // The same article again: nothing new, no new revision.
      await tx`UPDATE articles SET body_status = 'ok', x_article = ${tx.json(gotArticle as never)}, updated_at = now() WHERE id = ${articleId}`;
      return "ok";
    }
    await reviseMaterial(tx, articleId, {
      set: sql`title = ${title}, body_text = ${bodyText}, x_article = ${sql.json(gotArticle as never)}, body_status = 'ok',
        content_kind = 'social_post',
        content_quality_score = 70,
        content_completeness = 'full',
        content_extraction_meta = ${sql.json({ extractor: "social", version: "1.0.0", sourceId: null, sourceFamily: "social", fallbackUsed: false, bodyProvenance: "source_api", sourceAuthority: "caster" } as never)}`,
      hash: contentHash({ title, bodyText, excerpt: row.excerpt }), title, bodyText,
    });
    return "ok";
  });
}

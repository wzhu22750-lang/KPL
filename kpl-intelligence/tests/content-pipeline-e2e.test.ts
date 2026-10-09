// CanonicalContent 落库与 Site Contract 的端到端测试：
// collect 的 detail 路径产出 canonical → articles 的 content_* 列 → site API 的 item detail 携带
// content 视图（forum/video/social 分流），并验证正文不完整的如实标注。
import "./setup.ts";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { exportMarkdown, loadItemDetail } from "@aihot/backend/publication/detail";
import { publishArticle } from "@aihot/backend/publication/publish";
import { canonicalEvidenceHash } from "@aihot/backend/publication/rules";
import { toContentView } from "@aihot/backend/publication/items";
import { RADAR } from "@aihot/industry/radar";

const T = tag();
const HUPU_THREAD = `<!DOCTYPE html><html><body>
  <h1 class="post-title">夏季赛决赛前瞻：谁的中野更强？</h1>
  <div class="post-wrapper"><div class="post-user"><span class="post-user__name">数据帝</span></div>
    <div class="post-content">从前三周的样本看，双方中野的前期节奏差距主要体现在第一条大龙的争夺上，胜者组队伍的资源倾斜更果断。</div>
    <div class="post-like"><span class="post-like__value">188</span></div></div>
  <div class="post-wrapper"><div class="post-user"><span class="post-user__name">路人乙</span></div>
    <div class="post-content">关键还是 BP 阶段能不能拿到自己熟悉的中野体系，拿不到就只能打防守反击，节奏会被完全拖住。</div>
    <div class="post-like"><span class="post-like__value">94</span></div></div>
</body></html>`;

const server = http.createServer((req, res) => {
  const path = req.url ?? "";
  if (path.startsWith("/thread/list")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ url: `${base}/thread/1`, title: "夏季赛决赛前瞻：谁的中野更强？", date: "2026-10-01T09:00:00+08:00", summary: "社区讨论帖" }]));
    return;
  }
  if (path.startsWith("/thread/")) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HUPU_THREAD);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>((r) => server.close(() => r())); await stopBoss(); await closeDb(); });

test("collect 的 detail 路径把论坛帖抽成 forum_thread 并落 canonical 列", async () => {
  // 一个 hupu 域名下的来源：Profile 按域名命中论坛形态，抽取走 hupu → forum 链。
  const id = `e2e-hupu-${T}`;
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,site_fulltext,cursor,next_fetch_at)
    VALUES (${id},'端到端论坛来源','json_list',
      ${sql.json({
        url: `${base}/thread/list`,
        titlePaths: ["title"], urlTemplate: "{raw:url}", publishedAtPath: "date", summaryPaths: ["summary"],
        detail: { maxFetches: 3 },
        itemUrlPrefixRewrite: { from: `${base}/thread/`, to: `${base}/thread/` },
      } as never)},'T2','editorial',true,NULL,'2100-01-01')`;
  // 用 hupu 域名不可能命中 127.0.0.1：直接声明家族（这正是"新增论坛来源"的接入方式）。
  await sql`UPDATE sources SET config = config || ${sql.json({ contentFamily: "forum" } as never)} WHERE id = ${id}`;

  const result = await collectSource(id, { force: true });
  assert.equal(result.status, "ok");
  assert.equal(result.created, 1, "the listing offered one thread");

  const [row] = await sql<{ id: string; content_kind: string | null; content_completeness: string | null; content_quality_score: number | null; content_extraction_meta: Record<string, unknown> | null; canonical_content: Record<string, any> | null }[]>`
    SELECT id, content_kind, content_completeness, content_quality_score, content_extraction_meta, canonical_content FROM articles WHERE source_id = ${id}`;
  assert.equal(row!.content_kind, "forum_thread");
  assert.ok(row!.content_completeness === "full" || row!.content_completeness === "partial");
  assert.ok((row!.content_quality_score ?? 0) > 0);
  assert.equal(row!.content_extraction_meta!.sourceFamily, "forum");
  assert.ok(row!.content_extraction_meta!.extractor);
  const canonical = row!.canonical_content!;
  assert.equal(canonical.kind, "forum_thread");
  assert.ok(canonical.discussion.originalPost.text.includes("第一条大龙的争夺"));
  assert.ok(canonical.discussion.highlightedReplies.length >= 1, "the substantial reply is ranked in");
  assert.ok(!canonical.main.some((b: any) => String(b.text ?? "").includes("路人乙")), "replies never mix into the post body");

  // Site Contract：详情页携带内容视图，评论在 community 里、不在正文里。
  await publishArticle(row!.id);

  // 1. 未经审核状态（Pending）：
  // 详情页 200 可访问，主帖与作者保留，评论因待安全审核而扣留，body 与 Markdown 绝不泄露未审核评论。
  const detailPending = await loadItemDetail(row!.id);
  assert.equal(detailPending.kind, "found");
  const itemPending = detailPending.item;
  assert.equal(itemPending.content?.kind, "forum_thread");
  assert.equal(itemPending.content?.community?.originalPost.author, "数据帝");
  assert.ok(itemPending.content?.community?.originalPost.text.includes("第一条大龙的争夺"));
  assert.ok(!itemPending.content?.community?.originalPost.text.includes("路人乙"));
  assert.deepEqual(itemPending.content?.community?.highlightedReplies, [], "未审核评论应扣留");
  assert.equal(itemPending.content?.community?.collection?.coverage, "unavailable");
  assert.equal(itemPending.content?.community?.collection?.error, "pendingSafetyReview");
  assert.ok(!itemPending.body?.zh?.includes("路人乙"), "正文 HTML 绝不泄露未审核社区讨论");
  const mdPending = await exportMarkdown(row!.id);
  assert.ok(mdPending && !mdPending.body.includes("路人乙"), "Markdown 导出绝不泄露未审核讨论");

  // 2. 真实审核通过状态（Approved Assessment）：
  // 经 Radar 审核认定 safe 并写入 accepted 评估及匹配证据哈希后，社区回复安全展示。
  const hash = canonicalEvidenceHash(canonical);
  const safeJudgment = {
    relevant: true,
    safe: true,
    kind: "controversy",
    title: canonical.title,
    summary: "决赛中野对决讨论",
    claimStatus: "opinion",
    stance: "中立",
    evidence: [canonical.title],
    topicKey: null,
    information: 80,
    interpretation: 80,
    distinctiveness: 80,
    timeliness: 85,
    interest: 85,
    noise: 5,
    newDevelopment: false,
    reason: "赛前前瞻讨论",
  };
  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment,
    base_score, official_bonus, noise, score_version, reason, input_evidence_hash)
    VALUES (${row!.id}, 1, 'accepted', 'controversy', ${canonical.title}, '决赛中野对决讨论', 'opinion', '中立',
      ${sql.json([canonical.title])}, ${sql.json(safeJudgment)}, 80, 0, 0, ${RADAR.version}, '赛前前瞻讨论', ${hash})`;

  const detailApproved = await loadItemDetail(row!.id);
  assert.equal(detailApproved.kind, "found");
  const item = detailApproved.item;
  assert.equal(item.content?.kind, "forum_thread");
  assert.equal(item.content?.community?.originalPost.author, "数据帝");
  assert.ok(item.content!.community!.highlightedReplies.some((r) => r.author === "路人乙"), "审核通过后展示高亮评论");
  assert.ok(item.content!.community!.originalPost.likes === 188);
  assert.ok(!item.content!.community!.originalPost.text.includes("路人乙"));
  assert.equal(item.content!.community!.collection?.coverage, "partial");

  // 安全与授权约束：当未授权全文 (body_mode !== 'full') 或正文未确认时，toContentView 绝不泄露社区全文
  const [pubRow] = await sql<any[]>`SELECT * FROM publications WHERE article_id = ${row!.id}`;
  const summaryOnlyView = toContentView({ ...pubRow, body_mode: "summary", canonical_content: canonical });
  assert.equal(summaryOnlyView?.kind, "forum_thread");
  assert.equal(summaryOnlyView?.community, null, "未获得全文授权时，不应向前端暴露帖子与讨论全文");
  assert.equal(summaryOnlyView?.quality.completeness, "summary_only");

  const unconfirmedView = toContentView({ ...pubRow, body_mode: "full", body_status: "unconfirmed", canonical_content: canonical });
  assert.equal(unconfirmedView?.community, null, "正文未确认时，不应向前端暴露帖子与讨论全文");
  assert.equal(unconfirmedView?.quality.completeness, "summary_only");
});
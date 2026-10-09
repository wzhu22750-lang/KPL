// Invariant and unit tests for durable community comments refresh closed loop:
// 1. Guarded global opt-in: disabled by default, requires config.collectEnabled + COMMUNITY_COLLECTION_ENABLED === 'true'
//    force option must NOT bypass global safety valves, source disabled, or source isolated state.
// 2. Source-level opt-in: requires source.enabled === true, participation_mode !== 'isolated', communityComments.enabled === true
// 3. Platform exact URL parse: hostname parsed strictly without substring matching or fallback to Hupu.
// 4. Hupu URL & TID: tid extracted cleanly (not page suffix), actual nextCursor is URL not numeric, resumes from tid-page.html.
// 5. Clamping & Budgets: maxPages clamped to 3 (not 5).
// 6. Respects actual nextCursor / terminal from parsed page; HTTP non-200 fails explicitly.
// 7. No guessed quality 70/full when no canonical (body remains unconfirmed).
// 8. Canonical full base preserved from main; no article body overwritten on failure.
// 9. Atomic transaction FOR UPDATE revision/source recheck avoids races; stale revision aborts write.
// 10. Weibo / Bilibili resumes: correctly merges prior and new replies, dedup, bounded to 100, zero placeholder author/time metrics.
// 11. Sweep: excludes disabled/isolated sources without leaking budget slots.
// 12. Monitoring runs table: appends actual attempts to community_collection_runs without swallowing errors.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { queueCommunityRefresh } from "@aihot/backend/jobs/community";
import { stopBoss } from "@aihot/backend/jobs/queue";
import {
  buildHupuPageUrl,
  detectPlatform,
  isCommunityCollectionEnabled,
  mergeDiscussionReplies,
  parseHupuPageUrl,
  refreshArticleCommunity,
  sanitizeDiscussionPost,
  sweepCommunityRefresh,
  threadIdOfUrl,
  validateHupuThreadUrl,
} from "@aihot/backend/content/community-refresh";
import { hupuExtractor } from "@aihot/backend/content/extractors/hupu";
import type { CanonicalContent, DiscussionContent, DiscussionPost } from "@aihot/backend/content/extractors/types";

const T = tag();
const HUPU_SOURCE = `test-hupu-${T}`;
const WEIBO_SOURCE = `test-weibo-${T}`;
const BILI_SOURCE = `test-bili-${T}`;
const DISABLED_SOURCE = `test-disabled-${T}`;
const ISOLATED_SOURCE = `test-isolated-${T}`;
const TID = "62998877";
const HUPU_URL = `https://bbs.hupu.com/${TID}.html`;
const HUPU_PAGE2_URL = `https://bbs.hupu.com/${TID}-2.html`;

// ---------------------------------------------------------------------------
// HTML Fixtures
// ---------------------------------------------------------------------------

const PAGE1_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>【测试主帖】KPL春季赛BP深度复盘 - 虎扑社区</title>
  <meta name="comments" content="800">
</head>
<body>
  <div class="bbs-head-stat"><span class="reply-count">800</span></div>
  <div class="post-wrapper" data-pid="10001">
    <div class="post-user__name">老李教练</div>
    <div class="post-content">这是主帖正文：总决赛第七局巅峰对决BP深度复盘，双方英雄池博弈。</div>
  </div>
  <div class="post-wrapper" data-pid="20001">
    <div class="post-user__name">网友张三</div>
    <div class="post-content">第一局BP太亮眼了！</div>
  </div>
  <div class="post-wrapper" data-pid="20002">
    <div class="post-user__name">网友李四</div>
    <div class="post-content">老李分析得很专业。</div>
  </div>
</body>
<script>
window.__INITIAL_STATE__ = {
  tid: "${TID}",
  totalReplies: 800,
  replyCount: 800,
  thread: { tid: "${TID}", title: "【测试主帖】KPL春季赛BP深度复盘 - 虎扑社区", replies: 800 },
  posts: [
    { pid: "10001", author: "老李教练", content: "这是主帖正文：总决赛第七局巅峰对决BP深度复盘，双方英雄池博弈。", floor: 1 },
    { pid: "20001", author: "网友张三", content: "第一局BP太亮眼了！", floor: 2 },
    { pid: "20002", author: "网友李四", content: "老李分析得很专业。", floor: 3 }
  ],
  total: 800
};
</script>
</html>`;

const PAGE2_HTML = `<!DOCTYPE html>
<html>
<head><title>【测试主帖】KPL春季赛BP深度复盘 - 虎扑社区 - 第2页</title></head>
<body>
  <div class="post-wrapper" data-pid="20003">
    <div class="post-user__name">网友王五</div>
    <div class="post-content">第二页首楼回复，绝对不能篡位成主帖OP！</div>
  </div>
  <div class="post-wrapper" data-pid="20001">
    <div class="post-user__name">网友张三</div>
    <div class="post-content">第一局BP太亮眼了！(跨页重复回帖)</div>
  </div>
  <div class="post-wrapper" data-pid="20004">
    <div class="post-user__name">老李教练</div>
    <div class="post-content">【楼主补充】补充一下第三局双方打野路线的对比数据。</div>
  </div>
</body>
<script>
window.__INITIAL_STATE__ = {
  tid: "${TID}",
  thread: { tid: "${TID}", title: "【测试主帖】KPL春季赛BP深度复盘 - 虎扑社区", replies: 800 },
  posts: [
    { pid: "20003", author: "网友王五", content: "第二页首楼回复，绝对不能篡位成主帖OP！", floor: 21 },
    { pid: "20001", author: "网友张三", content: "第一局BP太亮眼了！(跨页重复回帖)", floor: 2 },
    { pid: "20004", author: "老李教练", content: "【楼主补充】补充一下第三局双方打野路线的对比数据。", floor: 22 }
  ],
  total: 800
};
</script>
</html>`;

// Test-only administrative policy: no wall-clock waits between local fixture requests.
beforeEach(async () => {
  for (const platform of ['hupu','weibo','bilibili']) await sql`
    INSERT INTO community_platform_controls (platform,min_interval_ms,request_limit)
    VALUES (${platform},0,1000) ON CONFLICT (platform) DO UPDATE SET
      min_interval_ms=0,request_limit=1000,requests_reserved=0,failure_count=0,
      next_allowed_at=now(),lease_until=NULL,last_error=NULL`;
});

// Setup and Teardown
before(async () => {
  // Ensure monitoring table exists in test DB
  await sql`
    CREATE TABLE IF NOT EXISTS community_collection_runs (
      id bigserial PRIMARY KEY,
      article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
      source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      platform text NOT NULL,
      attempted_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL CHECK (status IN ('ok', 'partial', 'unavailable', 'failed')),
      request_count integer NOT NULL DEFAULT 0,
      latency_ms integer,
      fetched_count integer NOT NULL DEFAULT 0,
      total_replies integer,
      extraction_fail boolean NOT NULL DEFAULT false,
      cursor_state jsonb,
      error text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  // Seed test sources
  await sql`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, next_fetch_at, enabled)
    VALUES
      (${HUPU_SOURCE}, 'Hupu Test BBS', 'web_list', ${sql.json({
        communityComments: {
          enabled: true,
          maxPages: 3,
          maxComments: 50,
          normalRefreshMinutes: 120,
          hotRefreshMinutes: 30,
        },
      })}, 'T1', 'editorial', '2100-01-01', true),
      (${WEIBO_SOURCE}, 'Weibo Test Source', 'weibo', ${sql.json({
        communityComments: {
          enabled: false,
        },
      })}, 'T1', 'editorial', '2100-01-01', true),
      (${BILI_SOURCE}, 'Bilibili Test Source', 'json_list', ${sql.json({
        communityComments: {
          enabled: true,
          endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={aid}&pn={pn}&ps={ps}",
          maxPages: 1,
          maxComments: 50,
          normalRefreshMinutes: 120,
          hotRefreshMinutes: 30,
        },
      })}, 'T1', 'editorial', '2100-01-01', true),
      (${DISABLED_SOURCE}, 'Disabled Source', 'web_list', ${sql.json({
        communityComments: {
          enabled: true,
        },
      })}, 'T1', 'editorial', '2100-01-01', false),
      (${ISOLATED_SOURCE}, 'Isolated Source', 'web_list', ${sql.json({
        communityComments: {
          enabled: true,
        },
      })}, 'T1', 'isolated', '2100-01-01', true)
  `;
});

after(async () => {
  delete process.env.COMMUNITY_COLLECTION_ENABLED;
  delete process.env.COLLECT_ENABLED;
  await stopBoss();
  await closeDb();
});

test('shared platform budget defers refresh without requests, history mutation, or fake failed collection; force cannot bypass',async()=>{
  process.env.COMMUNITY_COLLECTION_ENABLED='true';config.collectEnabled=true;
  const id=`art-platform-denied-${T}`;
  await sql`INSERT INTO articles (id,source_id,url,identity_key,title,content_hash,body_text,body_status,discovered_at,timeline_at)
    VALUES (${id},${HUPU_SOURCE},${HUPU_URL},${id},'Offline budget test','stable','Original retained','ok',now(),now())`;
  await sql`UPDATE community_platform_controls SET request_limit=0 WHERE platform='hupu'`;
  const result=await refreshArticleCommunity(id,{force:true,minIntervalMs:0,fetchHtml:async()=>{assert.fail('no budget, no network');}});
  assert.equal(result.status,'skipped');assert.equal(result.requestCount,0);assert.equal(result.preservedPrevious,true);
  assert.match(result.error??'',/budget/);
  const [row]=await sql<{body_text:string;body_status:string;revision:number}[]>`SELECT body_text,body_status,revision FROM articles WHERE id=${id}`;
  assert.deepEqual(row,{body_text:'Original retained',body_status:'ok',revision:1});
  const [attempts]=await sql<{n:number}[]>`SELECT count(*)::int AS n FROM community_collection_runs WHERE article_id=${id}`;
  assert.equal(attempts!.n,0);
});

// ---------------------------------------------------------------------------
// 1. URL Validation & Building Tests (TID Regex First, Not Greedy Page Suffix)
// ---------------------------------------------------------------------------

test("Hupu URL 校验：必须使用 HTTPS、bbs.hupu.com，提取并比对 exact tid，支持解析多页URL", () => {
  const valid = validateHupuThreadUrl(`https://bbs.hupu.com/${TID}.html`);
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.tid, TID);

  const validPage2 = validateHupuThreadUrl(`https://bbs.hupu.com/${TID}-2.html`, TID);
  assert.equal(validPage2.ok, true);
  if (validPage2.ok) assert.equal(validPage2.tid, TID);

  // threadIdOfUrl extracts tid first, not greedy page suffix!
  assert.equal(threadIdOfUrl(`https://bbs.hupu.com/${TID}-2.html`), TID);
  assert.equal(threadIdOfUrl(`https://bbs.hupu.com/${TID}-10.html`), TID);
  assert.equal(threadIdOfUrl(`https://bbs.hupu.com/${TID}.html`), TID);

  // parseHupuPageUrl extracts both tid and page
  assert.deepEqual(parseHupuPageUrl(`https://bbs.hupu.com/${TID}-2.html`), { tid: TID, page: 2 });
  assert.deepEqual(parseHupuPageUrl(`https://bbs.hupu.com/${TID}.html`), { tid: TID, page: 1 });

  // Mismatched tid
  const mismatch = validateHupuThreadUrl(`https://bbs.hupu.com/999999.html`, TID);
  assert.equal(mismatch.ok, false);
  assert.match((mismatch as any).reason, /mismatch/i);

  // Insecure HTTP
  const httpVal = validateHupuThreadUrl(`http://bbs.hupu.com/${TID}.html`);
  assert.equal(httpVal.ok, false);
  assert.match((httpVal as any).reason, /https:/);

  // Non-permitted host
  const wrongHost = validateHupuThreadUrl(`https://evil.com/${TID}.html`);
  assert.equal(wrongHost.ok, false);
  assert.match((wrongHost as any).reason, /permitted/);

  // Page URL Builder
  assert.equal(buildHupuPageUrl(TID, 1), `https://bbs.hupu.com/${TID}.html`);
  assert.equal(buildHupuPageUrl(TID, 2), `https://bbs.hupu.com/${TID}-2.html`);
  assert.equal(buildHupuPageUrl(TID, 3), `https://bbs.hupu.com/${TID}-3.html`);
});

test("平台精确识别：禁止子串匹配，禁止默认回退至 hupu", () => {
  // Attacker domains containing platform substring must NOT be recognized
  assert.equal(detectPlatform({ url: "https://evil-hupu.com/123.html", source_kind: "web_list" }, null), "unknown");
  assert.equal(detectPlatform({ url: "https://attacker.com/?redirect=https://bbs.hupu.com", source_kind: "web_list" }, null), "unknown");
  assert.equal(detectPlatform({ url: "https://example.com/blog/weibo.com-is-cool", source_kind: "web_list" }, null), "unknown");
  assert.equal(detectPlatform({ url: "https://example.com/bilibili-video", source_kind: "web_list" }, null), "unknown");

  // Legitimate platforms
  assert.equal(detectPlatform({ url: "https://bbs.hupu.com/62998877.html", source_kind: "web_list" }, null), "hupu");
  assert.equal(detectPlatform({ url: "https://m.weibo.cn/detail/12345", source_kind: "weibo" }, null), "weibo");
  assert.equal(detectPlatform({ url: "https://www.bilibili.com/video/BV1xx411c7mD", source_kind: "video" }, null), "bilibili");
});

// ---------------------------------------------------------------------------
// 2. Global, Source, and Isolation Safety Valves (force must NOT bypass)
// ---------------------------------------------------------------------------

test("全局门禁：COMMUNITY_COLLECTION_ENABLED 未开启时安全跳过，force 严禁越权绕过", async () => {
  delete process.env.COMMUNITY_COLLECTION_ENABLED;
  assert.equal(isCommunityCollectionEnabled(), false);

  const articleId = `art-gate-global-${T}`;
  await sql`
    INSERT INTO articles (id, source_id, url, identity_key, title, revision, content_hash, discovered_at, timeline_at)
    VALUES (${articleId}, ${HUPU_SOURCE}, ${HUPU_URL}, ${articleId}, 'Gate Test', 1, 'hash-gate-1', now(), now())
  `;

  // Even with force: true, it must NOT bypass the global safety valve!
  const res = await refreshArticleCommunity(articleId, {
    force: true,
    fetchHtml: async () => PAGE1_HTML,
  });

  assert.equal(res.status, "skipped");
  assert.match(res.error ?? "", /globally disabled/i);

  // queueCommunityRefresh must also refuse
  const qRes = await queueCommunityRefresh(articleId, HUPU_SOURCE, { force: true });
  assert.equal(qRes, null, "全局关闭时 queueCommunityRefresh 拒绝入队，即便 force=true");

  // sweep should also be skipped
  const sweepRes = await sweepCommunityRefresh();
  assert.equal(sweepRes.skipped, true);
});

test("来源配置门禁：source disabled / isolated / config enabled=false 时安全跳过，force 严禁越权绕过", async () => {
  process.env.COMMUNITY_COLLECTION_ENABLED = "true";
  process.env.COLLECT_ENABLED = "true";
  config.collectEnabled = true;

  // 1. Source disabled
  const artDisabled = `art-gate-disabled-${T}`;
  await sql`
    INSERT INTO articles (id, source_id, url, identity_key, title, revision, content_hash, discovered_at, timeline_at)
    VALUES (${artDisabled}, ${DISABLED_SOURCE}, ${HUPU_URL}, ${artDisabled}, 'Disabled Source Test', 1, 'hash-d', now(), now())
  `;
  const resDisabled = await refreshArticleCommunity(artDisabled, { force: true });
  assert.equal(resDisabled.status, "skipped");
  assert.match(resDisabled.error ?? "", /source is disabled/i);

  // 2. Source isolated
  const artIsolated = `art-gate-isolated-${T}`;
  await sql`
    INSERT INTO articles (id, source_id, url, identity_key, title, revision, content_hash, discovered_at, timeline_at)
    VALUES (${artIsolated}, ${ISOLATED_SOURCE}, ${HUPU_URL}, ${artIsolated}, 'Isolated Source Test', 1, 'hash-iso', now(), now())
  `;
  const resIsolated = await refreshArticleCommunity(artIsolated, { force: true });
  assert.equal(resIsolated.status, "skipped");
  assert.match(resIsolated.error ?? "", /source is isolated/i);

  // 3. Source communityComments.enabled === false
  const artNoOptIn = `art-gate-optin-${T}`;
  await sql`
    INSERT INTO articles (id, source_id, url, identity_key, title, revision, content_hash, discovered_at, timeline_at)
    VALUES (${artNoOptIn}, ${WEIBO_SOURCE}, 'https://weibo.com/test/12345', ${artNoOptIn}, 'No Opt-in Test', 1, 'hash-no-opt', now(), now())
  `;
  const resNoOptIn = await refreshArticleCommunity(artNoOptIn, { force: true });
  assert.equal(resNoOptIn.status, "skipped");
  assert.match(resNoOptIn.error ?? "", /not enabled for this source/i);
});

// ---------------------------------------------------------------------------
// 3. Total 800 Fetched 2 & Partial True & URL nextCursor
// ---------------------------------------------------------------------------

test("真实总数与保守覆盖：total 800 已知，受预算限制仅抓 2 条回复，totalReplies 严格为 800，nextCursor 为真实 URL 且 coverage 为 partial", async () => {
  process.env.COMMUNITY_COLLECTION_ENABLED = "true";
  process.env.COLLECT_ENABLED = "true";
  config.collectEnabled = true;

  const sourceId = `test-hupu-singlepage-${tag()}`;
  await sql`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, next_fetch_at, enabled)
    VALUES (${sourceId}, 'Hupu Test BBS', 'web_list', ${sql.json({
      communityComments: {
        enabled: true,
        maxPages: 1,
        maxComments: 50,
      },
    })}, 'T1', 'editorial', '2100-01-01', true)
  `;

  const articleId = `art-total800-${T}`;
  const initialCanonical: CanonicalContent = {
    kind: "forum_thread",
    title: "【测试主帖】KPL春季赛BP深度复盘",
    author: { name: "老李教练", avatarUrl: null, profileUrl: null, role: null },
    publishedAt: new Date().toISOString(),
    lead: "这是主帖正文",
    main: [{ type: "paragraph", text: "这是主帖正文" }],
    media: [],
    discussion: null,
    video: null,
    social: null,
    engagement: null,
    extraction: {
      extractor: "hupu",
      version: "1.0.0",
      sourceId,
      sourceFamily: "hupu",
      fallbackUsed: false,
      bodyProvenance: "page_dom",
      sourceAuthority: "community",
    },
    quality: { score: 85, completeness: "full", warnings: [] },
  };

  await sql`
    INSERT INTO articles (id, source_id, url, identity_key, title, revision, content_hash, canonical_content, discovered_at, timeline_at)
    VALUES (${articleId}, ${sourceId}, ${HUPU_URL}, ${articleId}, 'Total 800 Test', 1, 'hash-800', ${sql.json(initialCanonical as never)}, now(), now())
  `;

  let requestedUrl = "";
  const res = await refreshArticleCommunity(articleId, {
    fetchHtml: async (url) => {
      requestedUrl = url;
      return PAGE1_HTML;
    },
    minIntervalMs: 0,
  });

  assert.equal(requestedUrl, HUPU_URL);
  assert.equal(res.status, "partial");
  assert.equal(res.totalReplies, 800, "totalReplies 严格保持 800，绝不替换为已抓数 2");
  assert.equal(res.fetchedReplies, 2, "第 1 页解析出 2 条回复");
  assert.equal(res.nextCursor, HUPU_PAGE2_URL, "nextCursor 必须是真实第 2 页 URL，绝非数字");

  // Verify database record
  const [row] = await sql<{ canonical_content: CanonicalContent; revision: number }[]>`
    SELECT canonical_content, revision FROM articles WHERE id = ${articleId}
  `;
  const disc = row!.canonical_content.discussion!;
  assert.equal(disc.totalReplies, 800);
  assert.equal(disc.fetchedReplies, 2);
  assert.equal(disc.collection?.coverage, "partial", "总数 800 > 已抓 2，标记 partial");
  assert.equal(disc.collection?.nextCursor, HUPU_PAGE2_URL);
  assert.equal(disc.originalPost.author.name, "老李教练");
  assert.equal(row!.revision, 1, "评论刷新绝不自增 revision 版本号");
});

// ---------------------------------------------------------------------------
// 4. URL Resume, OP Preservation, Deduplication, and No Revision Change
// ---------------------------------------------------------------------------

test("游标续抓与主帖保全：从 URL nextCursor 续抓，保留第 1 页 OP，去重跨页回帖，revision 严格不变", async () => {
  process.env.COMMUNITY_COLLECTION_ENABLED = "true";
  process.env.COLLECT_ENABLED = "true";
  config.collectEnabled = true;

  const sourceId = `test-hupu-resume-${tag()}`;
  await sql`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, next_fetch_at, enabled)
    VALUES (${sourceId}, 'Hupu Test BBS', 'web_list', ${sql.json({
      communityComments: {
        enabled: true,
        maxPages: 1,
        maxComments: 50,
      },
    })}, 'T1', 'editorial', '2100-01-01', true)
  `;

  const articleId = `art-resume-${T}`;

  const existingDiscussion: DiscussionContent = {
    originalPost: {
      id: "10001",
      author: { name: "老李教练", avatarUrl: null },
      text: "这是主帖正文：总决赛第七局巅峰对决BP深度复盘，双方英雄池博弈。",
      publishedAt: new Date().toISOString(),
      floor: 1,
      isOriginalAuthor: true,
      platform: "hupu",
      likes: 12,
    },
    authorFollowups: [],
    highlightedReplies: [
      {
        id: "20001",
        author: { name: "网友张三", avatarUrl: null },
        text: "第一局BP太亮眼了！",
        publishedAt: new Date().toISOString(),
        floor: 2,
        isOriginalAuthor: false,
        platform: "hupu",
        likes: 5,
      },
      {
        id: "20002",
        author: { name: "网友李四", avatarUrl: null },
        text: "老李分析得很专业。",
        publishedAt: new Date().toISOString(),
        floor: 3,
        isOriginalAuthor: false,
        platform: "hupu",
        likes: 3,
      },
    ],
    collectedReplies: [
      {
        id: "20001",
        author: { name: "网友张三", avatarUrl: null },
        text: "第一局BP太亮眼了！",
        publishedAt: new Date().toISOString(),
        floor: 2,
        isOriginalAuthor: false,
        platform: "hupu",
        likes: 5,
      },
      {
        id: "20002",
        author: { name: "网友李四", avatarUrl: null },
        text: "老李分析得很专业。",
        publishedAt: new Date().toISOString(),
        floor: 3,
        isOriginalAuthor: false,
        platform: "hupu",
        likes: 3,
      },
    ],
    totalReplies: 800,
    fetchedReplies: 2,
    collection: {
      collectedAt: new Date().toISOString(),
      coverage: "partial",
      provenance: "page_dom",
      sourceUrl: HUPU_URL,
      nextCursor: HUPU_PAGE2_URL, // Previous run left nextCursor at page 2 URL
    },
    communitySummary: "老李教练分析了巅峰对决BP，张三李四一致好评",
  };

  const initialCanonical: CanonicalContent = {
    kind: "forum_thread",
    title: "【测试主帖】KPL春季赛BP深度复盘",
    author: { name: "老李教练", avatarUrl: null, profileUrl: null, role: null },
    publishedAt: new Date().toISOString(),
    lead: "这是主帖正文",
    main: [{ type: "paragraph", text: "这是主帖正文" }],
    media: [],
    discussion: existingDiscussion,
    video: null,
    social: null,
    engagement: null,
    extraction: {
      extractor: "hupu",
      version: "1.0.0",
      sourceId: HUPU_SOURCE,
      sourceFamily: "hupu",
      fallbackUsed: false,
      bodyProvenance: "page_dom",
      sourceAuthority: "community",
    },
    quality: { score: 85, completeness: "full", warnings: [] },
  };

  await sql`
    INSERT INTO articles (id, source_id, url, identity_key, title, revision, content_hash, canonical_content, discovered_at, timeline_at)
    VALUES (${articleId}, ${sourceId}, ${HUPU_URL}, ${articleId}, 'Resume Test', 1, 'hash-resume-init', ${sql.json(initialCanonical as never)}, now(), now())
  `;

  let requestedPageUrl = "";
  const res = await refreshArticleCommunity(articleId, {
    resumeCursor: HUPU_PAGE2_URL,
    fetchHtml: async (url) => {
      requestedPageUrl = url;
      return PAGE2_HTML;
    },
    minIntervalMs: 0,
  });

  assert.equal(requestedPageUrl, HUPU_PAGE2_URL);
  assert.equal(res.status, "partial");
  assert.equal(res.clearedSummary, true, "新增了第2页评论内容，旧 AI 总结被清空");

  const [row] = await sql<{ canonical_content: CanonicalContent; revision: number }[]>`
    SELECT canonical_content, revision FROM articles WHERE id = ${articleId}
  `;

  assert.equal(row!.revision, 1, "刷新回帖严禁修改 revision");
  const disc = row!.canonical_content.discussion!;

  // Page 1 OP preserved!
  assert.equal(disc.originalPost.id, "10001");
  assert.equal(disc.originalPost.author.name, "老李教练");
  assert.notEqual(disc.originalPost.author.name, "网友王五", "第2页首楼网友王五绝不能篡位成为主帖OP！");

  // Dedup: 20001 was on page 1 and page 2
  const ids = disc.collectedReplies!.map((r) => r.id);
  const uniqueIds = new Set(ids);
  assert.equal(ids.length, uniqueIds.size, "所有收集回帖 ID 唯一无重复");

  // Page 2 first post is reply
  const wangwu = disc.collectedReplies!.find((r) => r.id === "20003");
  assert.ok(wangwu, "网友王五成功并入回帖流");
  assert.equal(wangwu!.isOriginalAuthor, false);

  // Author followup
  const opFollowup = disc.authorFollowups.find((r) => r.id === "20004");
  assert.ok(opFollowup, "老李教练在第2页的补充被识别入 authorFollowups");
});

// ---------------------------------------------------------------------------
// 5. Failure Handling: Preserving Previous Comments & Preserving Partial Cursor
// ---------------------------------------------------------------------------

test("容灾鲁棒性：抓取失败时保留旧回帖，保留 partial cursor URL，标记 unavailable，且严禁篡改正文", async () => {
  process.env.COMMUNITY_COLLECTION_ENABLED = "true";
  process.env.COLLECT_ENABLED = "true";
  config.collectEnabled = true;

  const articleId = `art-fail-${T}`;

  const existingDiscussion: DiscussionContent = {
    originalPost: {
      id: "10001",
      author: { name: "老李教练", avatarUrl: null },
      text: "这是不可篡改的真主帖正文",
      floor: 1,
      isOriginalAuthor: true,
      platform: "hupu",
    },
    authorFollowups: [],
    highlightedReplies: [],
    collectedReplies: [
      {
        id: "20001",
        author: { name: "网友张三", avatarUrl: null },
        text: "第一局BP太亮眼了！",
        floor: 2,
        isOriginalAuthor: false,
        platform: "hupu",
      },
    ],
    totalReplies: 800,
    fetchedReplies: 1,
    collection: {
      collectedAt: "2026-05-01T00:00:00.000Z",
      coverage: "partial",
      provenance: "page_dom",
      sourceUrl: HUPU_URL,
      nextCursor: HUPU_PAGE2_URL,
    },
    communitySummary: "原先的有效AI总结",
  };

  const initialCanonical: CanonicalContent = {
    kind: "forum_thread",
    title: "【测试主帖】KPL春季赛BP深度复盘",
    author: { name: "老李教练", avatarUrl: null, profileUrl: null, role: null },
    publishedAt: new Date().toISOString(),
    lead: "这是主帖正文",
    main: [{ type: "paragraph", text: "这是不可篡改的真主帖正文" }],
    media: [],
    discussion: existingDiscussion,
    video: null,
    social: null,
    engagement: null,
    extraction: {
      extractor: "hupu",
      version: "1.0.0",
      sourceId: HUPU_SOURCE,
      sourceFamily: "hupu",
      fallbackUsed: false,
      bodyProvenance: "page_dom",
      sourceAuthority: "community",
    },
    quality: { score: 85, completeness: "full", warnings: [] },
  };

  await sql`
    INSERT INTO articles (id, source_id, url, identity_key, title, revision, content_hash, canonical_content, body_text, body_html, discovered_at, timeline_at)
    VALUES (${articleId}, ${HUPU_SOURCE}, ${HUPU_URL}, ${articleId}, 'Fail Test', 1, 'hash-fail-init', ${sql.json(initialCanonical as never)}, '这是不可篡改的真主帖正文', '<p>这是不可篡改的真主帖正文</p>', now(), now())
  `;

  // Inject HTTP 502 error
  const res = await refreshArticleCommunity(articleId, {
    resumeCursor: HUPU_PAGE2_URL,
    fetchHtml: async () => {
      throw new Error("HTTP 502 Bad Gateway upstream network down");
    },
    minIntervalMs: 0,
  });

  assert.equal(res.status, "unavailable");
  assert.equal(res.preservedPrevious, true, "标记保留了旧回帖");
  assert.equal(res.nextCursor, HUPU_PAGE2_URL, "抓取失败时 partial cursor URL 必须被精准保留");

  // Check database state
  const [row] = await sql<{ canonical_content: CanonicalContent; body_text: string; body_html: string }[]>`
    SELECT canonical_content, body_text, body_html FROM articles WHERE id = ${articleId}
  `;
  const disc = row!.canonical_content.discussion!;

  // Body must NOT be overwritten on failure!
  assert.equal(row!.body_text, "这是不可篡改的真主帖正文", "失败时严禁用评论覆写正文");
  assert.equal(row!.body_html, "<p>这是不可篡改的真主帖正文</p>");

  // Partial cursor URL preserved in DB
  assert.equal(disc.collection?.nextCursor, HUPU_PAGE2_URL);
  assert.equal(disc.collection?.coverage, "unavailable");

  // Run recorded in monitoring table
  const runs = await sql<{ status: string; error: string; cursor_state: any }[]>`
    SELECT status, error, cursor_state FROM community_collection_runs WHERE article_id = ${articleId}
    ORDER BY attempted_at DESC LIMIT 1
  `;
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, "unavailable");
  assert.equal(runs[0]!.cursor_state?.resumeCursor, HUPU_PAGE2_URL);
});

// ---------------------------------------------------------------------------
// 6. Concurrency & Revision Race Guard: Stale Revision Aborts Write
// ---------------------------------------------------------------------------

test("原子事务并发防护：FOR UPDATE 发现 revision 改变时终止写入，严禁脏写覆盖", async () => {
  process.env.COMMUNITY_COLLECTION_ENABLED = "true";
  process.env.COLLECT_ENABLED = "true";
  config.collectEnabled = true;

  const articleId = `art-race-${T}`;
  await sql`
    INSERT INTO articles (id, source_id, url, identity_key, title, revision, content_hash, discovered_at, timeline_at)
    VALUES (${articleId}, ${HUPU_SOURCE}, ${HUPU_URL}, ${articleId}, 'Race Test', 1, 'hash-race', now(), now())
  `;

  // Simulate a concurrent extraction job updating the revision in flight
  const res = await refreshArticleCommunity(articleId, {
    fetchHtml: async () => {
      // While fetch is ongoing, another worker updates the article's revision to 2
      await sql`UPDATE articles SET revision = 2, body_text = 'Freshly Extracted Body from Revision 2' WHERE id = ${articleId}`;
      return PAGE1_HTML;
    },
    minIntervalMs: 0,
  });

  assert.equal(res.status, "failed");
  assert.match(res.error ?? "", /revision changed during refresh.*stale result not written/i);

  // Verify that stale canonical result was NOT written
  const [row] = await sql<{ revision: number; canonical_content: any; body_text: string }[]>`
    SELECT revision, canonical_content, body_text FROM articles WHERE id = ${articleId}
  `;
  assert.equal(row!.revision, 2);
  assert.equal(row!.body_text, "Freshly Extracted Body from Revision 2");
  assert.equal(row!.canonical_content, null, "旧刷新结果未被脏写到新版本上");
});

// ---------------------------------------------------------------------------
// 7. Weibo / Bilibili Resumes: Dedup, Accurate Count, Bounded 100, Zero Placeholder Metrics
// ---------------------------------------------------------------------------

test("Weibo / Bilibili 回帖合并：去重跨页、准确计数、封顶100条限制、消除未知用户与占位时间指标", () => {
  const prior: DiscussionPost[] = [
    {
      id: "p1",
      author: { name: "未知用户", avatarUrl: null }, // placeholder author!
      text: "Prior comment 1",
      publishedAt: "1970-01-01T00:00:00.000Z", // placeholder epoch time!
      floor: 0, // placeholder floor 0!
      likes: -1, // invalid metric!
      replyCount: null,
      isOriginalAuthor: false,
      platform: "weibo",
    },
    {
      id: "p2",
      author: { name: "真实用户A", avatarUrl: null },
      text: "Prior comment 2",
      publishedAt: "2026-05-01T10:00:00.000Z",
      floor: 2,
      likes: 10,
      replyCount: 1,
      isOriginalAuthor: false,
      platform: "weibo",
    },
  ];

  const incoming: DiscussionPost[] = [
    {
      id: "p2", // duplicate ID!
      author: { name: "真实用户A", avatarUrl: null },
      text: "Prior comment 2 (duplicate)",
      publishedAt: "2026-05-01T10:00:00.000Z",
      floor: 2,
      likes: 12,
      replyCount: 1,
      isOriginalAuthor: false,
      platform: "weibo",
    },
    {
      id: "p3",
      author: { name: "真实用户B", avatarUrl: null },
      text: "New comment 3",
      publishedAt: "2026-05-01T11:00:00.000Z",
      floor: 3,
      likes: 5,
      replyCount: 0,
      isOriginalAuthor: false,
      platform: "weibo",
    },
  ];

  const { merged, reachedLimit } = mergeDiscussionReplies(prior, incoming, 100);

  assert.equal(reachedLimit, false);
  assert.equal(merged.length, 3, "p1, p2, p3 三条，重复的 p2 被自动去重");
  assert.deepEqual(merged.map((m) => m.id), ["p1", "p2", "p3"]);

  // Zero placeholder author / time / metrics verification:
  const sanitizedP1 = merged.find((m) => m.id === "p1")!;
  assert.equal(sanitizedP1.author.name, null, "'未知用户' 必须被归一化为 null，绝不冒充有效作者");
  assert.equal(sanitizedP1.publishedAt, null, "1970 占位时间戳必须被归一化为 null");
  assert.equal(sanitizedP1.floor, null, "占位 floor: 0 必须被归一化为 null");
  assert.equal(sanitizedP1.likes, null, "非法 likes: -1 必须被归一化为 null");

  // Latest updates for duplicate IDs verification (not stale first!):
  const sanitizedP2 = merged.find((m) => m.id === "p2")!;
  assert.equal(sanitizedP2.likes, 12, "重复 ID 必须更新为最新的点赞数 12，绝非旧的 10");
  assert.equal(sanitizedP2.text, "Prior comment 2 (duplicate)", "重复 ID 必须更新为最新的文本内容，绝非旧文本");

  // Bounded 100 verification:
  const largeList: DiscussionPost[] = Array.from({ length: 120 }, (_, i) => ({
    id: `large-${i}`,
    author: { name: `User ${i}` },
    text: `Text ${i}`,
    publishedAt: null,
    floor: i + 1,
    isOriginalAuthor: false,
    platform: "weibo",
  }));

  const boundedResult = mergeDiscussionReplies([], largeList, 100);
  assert.equal(boundedResult.merged.length, 100, "最多封顶 100 条评论");
  assert.equal(boundedResult.reachedLimit, true);
});

test("Weibo / Bilibili 回帖合并：达到100条配额时动态优选，新高光回帖不被忽略，同时更新相同ID", () => {
  // 100 prior posts with 0 likes and plain text
  const prior100: DiscussionPost[] = Array.from({ length: 100 }, (_, i) => ({
    id: `prior-${i}`,
    author: { name: `User ${i}` },
    text: `Prior basic comment ${i}`,
    likes: 0,
    floor: i + 1,
    isOriginalAuthor: false,
    platform: "bilibili",
  }));

  // Incoming replies has:
  // 1. Updated duplicate prior-0 with 999 likes and new text
  // 2. New reply with 500 likes and rich tactics discussion
  // 3. New reply with 300 likes
  const incoming: DiscussionPost[] = [
    {
      id: "prior-0",
      author: { name: "User 0" },
      text: "Prior 0 was updated with breaking game analysis!",
      likes: 999,
      floor: 1,
      isOriginalAuthor: false,
      platform: "bilibili",
    },
    {
      id: "new-hot-1",
      author: { name: "Coach Mike" },
      text: "决胜局巅峰对决双方镜像阵容，拆解关键龙坑团战决策与战术执行细节。",
      likes: 500,
      floor: 101,
      isOriginalAuthor: false,
      platform: "bilibili",
    },
    {
      id: "new-hot-2",
      author: { name: "Tactical Analyst" },
      text: "兵线运营非常到位，打野视野压制太强了！",
      likes: 300,
      floor: 102,
      isOriginalAuthor: false,
      platform: "bilibili",
    },
  ];

  const { merged, reachedLimit } = mergeDiscussionReplies(prior100, incoming, 100);

  assert.equal(reachedLimit, true);
  assert.equal(merged.length, 100);

  // Duplicate ID updated!
  const p0 = merged.find((p) => p.id === "prior-0")!;
  assert.ok(p0);
  assert.equal(p0.likes, 999);
  assert.equal(p0.text, "Prior 0 was updated with breaking game analysis!");

  // New text not ignored!
  const new1 = merged.find((p) => p.id === "new-hot-1");
  assert.ok(new1, "达到 100 条配额时，新高光回帖必须进入集合，绝不忽略全新文本");
  assert.equal(new1!.likes, 500);

  const new2 = merged.find((p) => p.id === "new-hot-2");
  assert.ok(new2, "新高质回帖必须进入集合");
  assert.equal(new2!.likes, 300);
});

// ---------------------------------------------------------------------------
// 8. Quality Score: No Guessed 70/full When No Canonical (Unconfirmed Never Auto)
// ---------------------------------------------------------------------------

test("正文质量守卫：无既有 canonical 且未加载主帖时，绝不伪造 quality 70/full，正文保持 unconfirmed", async () => {
  process.env.COMMUNITY_COLLECTION_ENABLED = "true";
  process.env.COLLECT_ENABLED = "true";
  config.collectEnabled = true;

  const articleId = `art-no-canon-${T}`;
  // Article without canonical_content and without body
  await sql`
    INSERT INTO articles (id, source_id, url, identity_key, title, revision, content_hash, body_status, discovered_at, timeline_at)
    VALUES (${articleId}, ${WEIBO_SOURCE}, 'https://weibo.com/detail/998877', ${articleId}, 'No Canon Test', 1, 'h-nc', 'unconfirmed', now(), now())
  `;

  // Enable communityComments on WEIBO_SOURCE for this test
  await sql`
    UPDATE sources SET config = ${sql.json({
      communityComments: { enabled: true, endpointTemplate: "https://m.weibo.cn/comments/hotflow?id={id}&mid={mid}" }
    })} WHERE id = ${WEIBO_SOURCE}
  `;

  const res = await refreshArticleCommunity(articleId, {
    fetchJson: async () => ({
      ok: 1,
      data: {
        data: [{ id: "c1", user: { screen_name: "测试评论员" }, text: "这是一条评论", floor_number: 1 }],
        total_number: 1,
        max_id: 0,
      },
    }),
    minIntervalMs: 0,
  });

  const [row] = await sql<{ canonical_content: CanonicalContent; body_status: string }[]>`
    SELECT canonical_content, body_status FROM articles WHERE id = ${articleId}
  `;

  // Quality must NOT be guessed as { score: 70, completeness: "full" }!
  assert.notEqual(row!.canonical_content.quality?.completeness, "full");
  assert.equal(row!.canonical_content.quality?.completeness, "failed");
  assert.equal(row!.body_status, "unconfirmed", "未确认的正文绝不自动变为 ok");
});

// ---------------------------------------------------------------------------
// 9. Sweep Prioritization & Disabled Source Exclusion (No Budget Leakage)
// ---------------------------------------------------------------------------

test("调度巡检：已禁用和隔离的信源严禁进入候选集，严禁泄露 budget 槽位", async () => {
  process.env.COMMUNITY_COLLECTION_ENABLED = "true";
  process.env.COLLECT_ENABLED = "true";
  config.collectEnabled = true;

  await sql`DELETE FROM articles WHERE id LIKE 'art-leak-%'`;

  // Insert article for disabled source
  const artDis = `art-leak-dis-${T}`;
  await sql`
    INSERT INTO articles (id, source_id, url, identity_key, title, revision, content_hash, created_at, discovered_at, timeline_at)
    VALUES (${artDis}, ${DISABLED_SOURCE}, ${HUPU_URL}, ${artDis}, 'Disabled Leak', 1, 'h-ld', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days')
  `;

  // Insert article for isolated source
  const artIso = `art-leak-iso-${T}`;
  await sql`
    INSERT INTO articles (id, source_id, url, identity_key, title, revision, content_hash, created_at, discovered_at, timeline_at)
    VALUES (${artIso}, ${ISOLATED_SOURCE}, ${HUPU_URL}, ${artIso}, 'Isolated Leak', 1, 'h-li', now() - interval '2 days', now() - interval '2 days', now() - interval '2 days')
  `;

  const enqueuedIds: string[] = [];
  const sweep = await sweepCommunityRefresh({
    budget: 5,
    enqueueFn: async (id) => {
      enqueuedIds.push(id);
      return id;
    },
  });

  assert.ok(!enqueuedIds.includes(artDis), "已禁用信源的文章绝不进入候选集");
  assert.ok(!enqueuedIds.includes(artIso), "已隔离信源的文章绝不进入候选集");
});

test("sweep uses latest observed comments before extraction, respects source budget, and never revives unknown counts", async () => {
  process.env.COMMUNITY_COLLECTION_ENABLED = "true";
  config.collectEnabled = true;
  const sourceId = `test-heat-budget-${T}`;
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,next_fetch_at,enabled)
    VALUES (${sourceId},'Offline heat budget','web_list',${sql.json({communityComments:{enabled:true,maxPostsPerRun:1}})},'T2','hot_signal','2100-01-01',true)`;
  const ids = [`budget-low-${T}`,`budget-high-${T}`,`budget-unknown-${T}`];
  for (const [index,id] of ids.entries()) {
    await sql`INSERT INTO articles (id,source_id,url,identity_key,title,content_hash,created_at,discovered_at,timeline_at)
      VALUES (${id},${sourceId},${`https://bbs.hupu.com/${70000000+index}.html`},${id},'Offline budget test',${id},now()-interval '2 days',now()-interval '2 days',now()-interval '2 days')`;
    if (index === 2) await sql`INSERT INTO engagement_observations (article_id,source_id,platform,observed_at,method,metrics,coverage)
      VALUES (${id},${sourceId},'hupu',now()-interval '1 hour','page_dom',${sql.json({comments:9999})},'observed')`;
    await sql`INSERT INTO engagement_observations (article_id,source_id,platform,observed_at,method,metrics,coverage)
      VALUES (${id},${sourceId},'hupu',now(),'page_dom',${sql.json({comments:index===0?50:index===1?800:null})},'observed')`;
  }
  const enqueued:string[]=[];
  await sweepCommunityRefresh({budget:100,enqueueFn:async(id)=>{enqueued.push(id);return id;}});
  assert.deepEqual(enqueued.filter(id=>ids.includes(id)),[ids[1]]);
});

// ---------------------------------------------------------------------------
// 10. Worker Production Transport & Bilibili Sourcing Guards
// ---------------------------------------------------------------------------

test("Worker 生产链路：不注入 fetchJson，默认走 guardedFetch + MockAgent 本地替身，完成评论刷新闭环", async () => {
  process.env.COMMUNITY_COLLECTION_ENABLED = "true";
  process.env.COLLECT_ENABLED = "true";
  config.collectEnabled = true;

  const articleId = `art-worker-nofetch-${T}`;
  const bvid = "BV1WORKERTEST";
  const aid = 556677;

  await sql`
    INSERT INTO articles (id, source_id, url, identity_key, title, revision, content_hash, raw, discovered_at, timeline_at)
    VALUES (${articleId}, ${BILI_SOURCE}, 'https://www.bilibili.com/video/' || ${bvid}, ${articleId}, 'Worker No Inject Test', 1, 'hash-worker-1', ${sql.json({
      aid,
      bvid,
      owner: { mid: 123 },
    })}, now(), now())
  `;

  const previous = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  const oldPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  setGlobalDispatcher(mock);

  try {
    mock.get("https://api.bilibili.com")
      .intercept({ path: `/x/v2/reply?type=1&oid=${aid}&pn=1&ps=20` })
      .reply(200, JSON.stringify({
        code: 0,
        data: {
          cursor: { all_count: 1, is_end: true },
          replies: [
            {
              rpid: 9901,
              content: { message: "来自生产 guardedFetch 默认链路的评论" },
              like: 88,
              member: { uname: "生产测试员" },
            },
          ],
        },
      }));

    // CRITICAL: Call refreshArticleCommunity WITHOUT options.fetchJson!
    const res = await refreshArticleCommunity(articleId, {
      force: true,
      minIntervalMs: 0,
    });

    assert.equal(res.status, "ok");
    assert.equal(res.fetchedReplies, 1);
    assert.equal(res.totalReplies, 1);

    const [row] = await sql<{ canonical_content: CanonicalContent }[]>`
      SELECT canonical_content FROM articles WHERE id = ${articleId}
    `;
    assert.ok(row?.canonical_content?.discussion);
    assert.equal(row.canonical_content.discussion.collectedReplies?.[0]?.text, "来自生产 guardedFetch 默认链路的评论");
  } finally {
    setGlobalDispatcher(previous);
    config.allowPrivateNetworkFetch = oldPrivate;
    await mock.close();
  }
});

test("Bilibili 真实标识契约：严禁以 canonical.engagement.views 充当 aid；必须源自 raw.aid 或 view API 解析有效有限ID", async () => {
  process.env.COMMUNITY_COLLECTION_ENABLED = "true";
  process.env.COLLECT_ENABLED = "true";
  config.collectEnabled = true;

  const articleId = `art-bili-views-guard-${T}`;
  const bvid = "BV1NOVIEWSAID";

  // Article has engagement.views = 987654321, but raw has NO aid!
  const canonicalWithFakeViews: CanonicalContent = {
    kind: "video_post",
    title: "Views Guard Test",
    author: { name: "UP主", avatarUrl: null, profileUrl: null, role: null },
    publishedAt: new Date().toISOString(),
    lead: null,
    main: [],
    media: [],
    discussion: null,
    video: null,
    social: null,
    engagement: {
      views: 987654321, // This must NEVER be used as aid!
      likes: 100,
      comments: 10,
      shares: null,
      favorites: null,
      coins: null,
      danmaku: null,
    },
    extraction: {
      extractor: "bilibili",
      version: "1.0.0",
      sourceId: BILI_SOURCE,
      sourceFamily: "video",
      fallbackUsed: false,
      bodyProvenance: "source_api",
      sourceAuthority: "community",
    },
    quality: { score: 90, completeness: "full", warnings: [] },
  };

  await sql`
    INSERT INTO articles (id, source_id, url, identity_key, title, revision, content_hash, canonical_content, raw, discovered_at, timeline_at)
    VALUES (${articleId}, ${BILI_SOURCE}, 'https://www.bilibili.com/video/' || ${bvid}, ${articleId}, 'Views Guard Test', 1, 'hash-vg-1', ${sql.json(canonicalWithFakeViews as never)}, ${sql.json({
      bvid, // Notice: raw.aid is missing!
    })}, now(), now())
  `;

  const requestedUrls: string[] = [];
  const fakeFetchJson = async (url: string) => {
    requestedUrls.push(url);
    if (url.includes("/x/web-interface/view")) {
      // view API resolves the real aid 112233
      return {
        code: 0,
        data: {
          aid: 112233,
          bvid,
          title: "Views Guard Test",
          owner: { mid: 88 },
          stat: { view: 987654321, reply: 5 },
        },
      };
    }
    if (url.includes("/x/v2/reply")) {
      return {
        code: 0,
        data: {
          cursor: { all_count: 1, is_end: true },
          replies: [
            { rpid: 501, content: { message: "解析自 view API aid 的评论" }, member: { uname: "观众" } },
          ],
        },
      };
    }
    throw new Error(`Unexpected: ${url}`);
  };

  const res = await refreshArticleCommunity(articleId, {
    fetchJson: fakeFetchJson,
    minIntervalMs: 0,
  });

  assert.equal(res.status, "ok");
  // Verify that views (987654321) was NEVER passed to reply API!
  const replyUrl = requestedUrls.find((u) => u.includes("/x/v2/reply"));
  assert.ok(replyUrl, "必须请求评论 API");
  assert.ok(!replyUrl.includes("oid=987654321"), "views 绝对严禁作为 aid/oid 传入评论 API");
  assert.ok(replyUrl.includes("oid=112233"), "必须使用从 view API 解析出的真实 aid 112233");

  // Part 2: If view API also fails to provide aid, refresh must fail with extractionFail (no views used as ID)
  const failArticleId = `art-bili-fail-noaid-${T}`;
  await sql`
    INSERT INTO articles (id, source_id, url, identity_key, title, revision, content_hash, canonical_content, raw, discovered_at, timeline_at)
    VALUES (${failArticleId}, ${BILI_SOURCE}, 'https://www.bilibili.com/video/BV1FAILVIEW', ${failArticleId}, 'Fail View Test', 1, 'hash-fv-1', ${sql.json(canonicalWithFakeViews as never)}, ${sql.json({
      bvid: "BV1FAILVIEW",
    })}, now(), now())
  `;

  const failFetchJson = async (url: string) => {
    if (url.includes("/x/web-interface/view")) {
      return { code: -404, message: "啥都木有" };
    }
    throw new Error(`Should not call: ${url}`);
  };

  const failRes = await refreshArticleCommunity(failArticleId, {
    fetchJson: failFetchJson,
    minIntervalMs: 0,
  });

  assert.equal(failRes.status, "unavailable");
  assert.match(failRes.error ?? "", /Could not determine Bilibili aid/i);
});

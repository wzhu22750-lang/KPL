// Unit test suite for community observations, engagement, canonical identity hashing, and lifecycle:
// 1. canonicalIdentityText vs canonicalToBody: separates main identity from comments.
// 2. Priority in canonicalIdentityText: social/video prioritized before discussion; body displays comments, hash main only.
// 3. Evidence hash separate: evidence text & evidence hash change on new comments, main identity hash remains stable.
// 4. Extractor engagement metrics: recordEngagement with platform hupu/bilibili, sourceid, timestamp on successful extraction even samehash; coins/danmaku allowed null handling.
// 5. Stale AI communitySummary cleared when actual comment texts change; preserved when comments unchanged (e.g. counter refresh).
// 6. Failed refresh preserves previous collection data but records current failure truthfully (no cache as success).
// 7. Upsert material integration: same main text different likes/comments => no revision (no expensive paid analysis), real main edit => revision.
import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalIdentityText,
  canonicalEvidenceText,
  canonicalEvidenceHash,
  canonicalToBody,
  refreshCanonicalDiscussion,
  mergeCanonicalForRefresh,
} from "@aihot/backend/content/canonical";
import {
  ENGAGEMENT_METRICS,
  observedCounter,
  normalizeObservation,
  resolvePlatformFromCanonical,
  recordCanonicalEngagement,
  type EngagementObservationInput,
} from "@aihot/backend/content/engagement";
import { contentHash, upsertMaterial } from "@aihot/backend/content/materials";
import type { CanonicalContent, DiscussionContent } from "@aihot/backend/content/extractors/types";

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeHupuCanonical(over: {
  title?: string;
  opText?: string;
  opLikes?: number | null;
  comments?: Array<{ id: string; author: string; text: string; likes?: number | null }>;
  communitySummary?: string | null;
  coverage?: "complete" | "partial" | "unavailable";
  error?: string | null;
} = {}): CanonicalContent {
  const opText = over.opText ?? "成都AG超玩会本赛季常规赛表现分析：野核体系与边路兵线压制。";
  const replies = (over.comments ?? [
    { id: "r1", author: "老粉丝", text: "一诺公孙离那一波反开太秀了！", likes: 120 },
    { id: "r2", author: "战术研究员", text: "主要是钟意的大司命控龙节奏极好。", likes: 85 },
  ]).map((r, i) => ({
    id: r.id,
    author: { name: r.author, avatarUrl: null },
    text: r.text,
    likes: r.likes ?? 10,
    floor: i + 2,
    isOriginalAuthor: false,
    platform: "hupu" as const,
  }));

  const discussion: DiscussionContent = {
    originalPost: {
      id: "op-1",
      author: { name: "KPL分析师", avatarUrl: null },
      text: opText,
      likes: over.opLikes ?? 300,
      floor: 1,
      isOriginalAuthor: true,
      platform: "hupu",
    },
    authorFollowups: [],
    highlightedReplies: replies,
    totalReplies: replies.length + 10,
    fetchedReplies: replies.length,
    communitySummary: over.communitySummary ?? null,
    collection: {
      collectedAt: "2026-10-08T12:00:00.000Z",
      coverage: over.coverage ?? "complete",
      provenance: "page_dom",
      sourceUrl: "https://bbs.hupu.com/123456.html",
      error: over.error ?? null,
    },
  };

  return {
    kind: "forum_thread",
    title: over.title ?? "【深度分析】AG本赛季体系拆解",
    author: { name: "KPL分析师", avatarUrl: null, profileUrl: null, role: null },
    publishedAt: "2026-10-08T10:00:00.000Z",
    lead: opText.slice(0, 100),
    main: [{ type: "paragraph", text: opText }],
    media: [],
    discussion,
    video: null,
    social: null,
    engagement: {
      views: null,
      likes: over.opLikes ?? 300,
      comments: replies.length + 10,
      shares: null,
      favorites: null,
      coins: null,
      danmaku: null,
    },
    extraction: {
      extractor: "hupu",
      version: "1.1.0",
      sourceId: "hupu-kpl",
      sourceFamily: "forum",
      fallbackUsed: false,
      bodyProvenance: "page_dom",
      sourceAuthority: "community",
    },
    quality: { score: 85, completeness: "full", warnings: [] },
  };
}

function makeBilibiliCanonical(over: {
  title?: string;
  desc?: string;
  views?: number | null;
  likes?: number | null;
  coins?: number | null;
  danmaku?: number | null;
  comments?: Array<{ id: string; author: string; text: string }>;
} = {}): CanonicalContent {
  const desc = over.desc ?? "2026 KPL春季赛决胜局：全场精彩战术复盘";
  const replies = (over.comments ?? [
    { id: "b1", author: "弹幕观众A", text: "这波团战配合真绝" },
  ]).map((r, i) => ({
    id: r.id,
    author: { name: r.author, avatarUrl: null },
    text: r.text,
    likes: 50,
    floor: i + 1,
    isOriginalAuthor: false,
    platform: "bilibili" as const,
  }));

  const discussion: DiscussionContent = {
    originalPost: {
      id: "bv-op",
      author: { name: "官方赛事频道", avatarUrl: null },
      text: desc,
      likes: over.likes ?? 1000,
      floor: 0,
      isOriginalAuthor: true,
      platform: "bilibili",
    },
    authorFollowups: [],
    highlightedReplies: replies,
    totalReplies: 100,
    fetchedReplies: replies.length,
    collection: {
      collectedAt: "2026-10-08T12:00:00.000Z",
      coverage: "complete",
      provenance: "source_api",
      sourceUrl: "https://api.bilibili.com/x/v2/reply",
    },
  };

  return {
    kind: "video_post",
    title: over.title ?? "【KPL春决】决胜局战术复盘",
    author: { name: "官方赛事频道", avatarUrl: null, profileUrl: null, role: "UP 主" },
    publishedAt: "2026-10-08T10:00:00.000Z",
    lead: null,
    main: [],
    media: [],
    discussion,
    video: {
      description: desc,
      cover: "https://i0.hdslb.com/bfs/cover.jpg",
      durationSeconds: 1200,
      transcriptSummary: null,
    },
    social: null,
    engagement: {
      views: over.views ?? 500000,
      likes: over.likes ?? 25000,
      comments: 100,
      shares: 3000,
      favorites: 8000,
      coins: over.coins ?? 12000,
      danmaku: over.danmaku ?? 4500,
    },
    extraction: {
      extractor: "bilibili",
      version: "1.0.0",
      sourceId: "bilibili-kpl",
      sourceFamily: "video",
      fallbackUsed: false,
      bodyProvenance: "source_api",
      sourceAuthority: "official",
    },
    quality: { score: 90, completeness: "full", warnings: [] },
  };
}

function makeSocialCanonical(over: {
  postText?: string;
  likes?: number | null;
  comments?: Array<{ id: string; author: string; text: string }>;
} = {}): CanonicalContent {
  const postText = over.postText ?? "今日春季赛第一轮分组结果正式出炉！";
  const replies = (over.comments ?? [
    { id: "w1", author: "网友1", text: "第一组简直是死亡之组" },
  ]).map((r, i) => ({
    id: r.id,
    author: { name: r.author, avatarUrl: null },
    text: r.text,
    likes: 15,
    floor: i + 1,
    isOriginalAuthor: false,
    platform: "weibo" as const,
  }));

  const discussion: DiscussionContent = {
    originalPost: {
      id: "weibo-op",
      author: { name: "KPL王者荣耀职业联赛", avatarUrl: null },
      text: postText,
      likes: over.likes ?? 500,
      floor: 0,
      isOriginalAuthor: true,
      platform: "weibo",
    },
    authorFollowups: [],
    highlightedReplies: replies,
    totalReplies: 80,
    fetchedReplies: replies.length,
    collection: {
      collectedAt: "2026-10-08T12:00:00.000Z",
      coverage: "complete",
      provenance: "source_api",
      sourceUrl: "https://m.weibo.cn/comments/hotflow",
    },
  };

  return {
    kind: "social_post",
    title: "KPL常规赛分组动态",
    author: { name: "KPL王者荣耀职业联赛", avatarUrl: null, profileUrl: null, role: null },
    publishedAt: "2026-10-08T10:00:00.000Z",
    lead: null,
    main: [],
    media: [],
    discussion,
    video: null,
    social: {
      postText,
      quoted: null,
    },
    engagement: {
      likes: over.likes ?? 500,
      comments: 80,
    },
    extraction: {
      extractor: "weibo",
      version: "1.0.0",
      sourceId: "weibo-kpl",
      sourceFamily: "social",
      fallbackUsed: false,
      bodyProvenance: "source_api",
      sourceAuthority: "official",
    },
    quality: { score: 80, completeness: "full", warnings: [] },
  };
}

// ---------------------------------------------------------------------------
// 1. canonicalIdentityText vs canonicalToBody & Priority
// ---------------------------------------------------------------------------

test("主体哈希分离：canonicalIdentityText 只提取主帖正文，严禁混入评论；canonicalToBody 保留显示正文", () => {
  const c = makeHupuCanonical({
    opText: "虎扑主帖分析内容，讨论战队BP",
    comments: [
      { id: "r1", author: "网友A", text: "第一局老夫子大闪开团是转折点" },
      { id: "r2", author: "网友B", text: "第二局大司命发挥稳定" },
    ],
  });

  const identityText = canonicalIdentityText(c);
  assert.equal(identityText, "虎扑主帖分析内容，讨论战队BP");
  assert.ok(!identityText.includes("老夫子大闪开团"), "主体身份文本绝不含评论内容");
  assert.ok(!identityText.includes("网友A"), "主体身份文本绝不含回帖作者");

  // canonicalToBody 继续提供展示用完整文本（含评论流供用户与前端阅读）
  const body = canonicalToBody(c);
  assert.ok(body.text.includes("虎扑主帖分析内容"));
  assert.ok(body.text.includes("【社区讨论】"));
  assert.ok(body.text.includes("@网友A：第一局老夫子大闪开团是转折点"));
});

test("优先级规则：social / video 优先于 discussion 提取主体；排在 discussion 前面", () => {
  // Video with discussion
  const video = makeBilibiliCanonical({
    desc: "这是视频的官方简介，概括全场战况",
    comments: [{ id: "c1", author: "观众", text: "这波太帅了" }],
  });
  const videoIdentity = canonicalIdentityText(video);
  assert.equal(videoIdentity, "这是视频的官方简介，概括全场战况", "视频主体优先取 video.description");
  assert.ok(!videoIdentity.includes("这波太帅了"), "视频主体绝不被 discussion 覆盖");

  // Social with discussion
  const social = makeSocialCanonical({
    postText: "这是微博博文正文",
    comments: [{ id: "c2", author: "粉丝", text: "支持支持！" }],
  });
  const socialIdentity = canonicalIdentityText(social);
  assert.equal(socialIdentity, "这是微博博文正文", "社交动态主体优先取 social.postText");
  assert.ok(!socialIdentity.includes("支持支持！"), "动态主体绝不被 discussion 覆盖");
});

// ---------------------------------------------------------------------------
// 2. Evidence Hash Separation
// ---------------------------------------------------------------------------

test("证据哈希隔离：评论变动时证据文本与哈希改变，但主体身份哈希恒定不变", () => {
  const c1 = makeHupuCanonical({
    title: "春决热点讨论",
    opText: "主帖：你觉得本场MVP该给谁？",
    comments: [
      { id: "r1", author: "玩家1", text: "必须给一诺" },
    ],
  });

  const c2 = makeHupuCanonical({
    title: "春决热点讨论",
    opText: "主帖：你觉得本场MVP该给谁？", // OP 文本完全一样
    comments: [
      { id: "r1", author: "玩家1", text: "必须给一诺" },
      { id: "r2", author: "玩家2", text: "我觉得钟意也不错" }, // 新增一条回复
    ],
  });

  // 主体身份文本与内容哈希完全一致
  const idText1 = canonicalIdentityText(c1);
  const idText2 = canonicalIdentityText(c2);
  assert.equal(idText1, idText2);

  const hash1 = contentHash({ title: c1.title!, bodyText: idText1 });
  const hash2 = contentHash({ title: c2.title!, bodyText: idText2 });
  assert.equal(hash1, hash2, "主体内容哈希必须完全一致，绝不触发重新分析");

  // 证据文本与证据哈希因新增评论而发生改变
  const evText1 = canonicalEvidenceText(c1);
  const evText2 = canonicalEvidenceText(c2);
  assert.notEqual(evText1, evText2, "证据链文本必须包含最新评论");

  const evHash1 = canonicalEvidenceHash(c1);
  const evHash2 = canonicalEvidenceHash(c2);
  assert.notEqual(evHash1, evHash2, "证据哈希与主体哈希独立隔离");
});

// ---------------------------------------------------------------------------
// 3. Extractor Engagement Metrics & Coins/Danmaku Null Handling
// ---------------------------------------------------------------------------

test("互动指标规范化：支持 coins 与 danmaku，安全处理 null 与负值/非法值", () => {
  assert.ok(ENGAGEMENT_METRICS.includes("coins" as any));
  assert.ok(ENGAGEMENT_METRICS.includes("danmaku" as any));

  // 正常整数与 0
  assert.equal(observedCounter(100), 100);
  assert.equal(observedCounter(0), 0);

  // 允许 null 与 undefined
  assert.equal(observedCounter(null), null);
  assert.equal(observedCounter(undefined), null);

  // 负值或非整数安全转为 null
  assert.equal(observedCounter(-1), null);
  assert.equal(observedCounter(NaN), null);
  assert.equal(observedCounter("123"), null);
  assert.equal(observedCounter(1.5), null);

  // Bilibili 含有硬币与弹幕
  const biliObs = normalizeObservation({
    platform: "bilibili",
    observedAt: new Date("2026-10-08T12:00:00.000Z"),
    method: "source_api",
    metrics: {
      views: 100000,
      likes: 5000,
      coins: 3000,
      danmaku: 800,
    },
  });
  assert.equal(biliObs.coverage, "observed");
  assert.equal(biliObs.metrics.coins, 3000);
  assert.equal(biliObs.metrics.danmaku, 800);
  assert.equal(biliObs.metrics.shares, null);

  // Hupu 社区允许 coins 与 danmaku 为 null
  const hupuObs = normalizeObservation({
    platform: "hupu",
    observedAt: new Date("2026-10-08T12:00:00.000Z"),
    method: "page_dom",
    metrics: {
      likes: 150,
      comments: 35,
      coins: null,
      danmaku: null,
    },
  });
  assert.equal(hupuObs.coverage, "observed");
  assert.equal(hupuObs.metrics.likes, 150);
  assert.equal(hupuObs.metrics.comments, 35);
  assert.equal(hupuObs.metrics.coins, null, "coins allowed null");
  assert.equal(hupuObs.metrics.danmaku, null, "danmaku allowed null");
});

test("平台标识解析：准确识别 hupu、bilibili、weibo 平台", () => {
  const hupu = makeHupuCanonical();
  assert.equal(resolvePlatformFromCanonical(hupu), "hupu");

  const bili = makeBilibiliCanonical();
  assert.equal(resolvePlatformFromCanonical(bili), "bilibili");

  const weibo = makeSocialCanonical();
  assert.equal(resolvePlatformFromCanonical(weibo), "weibo");
});

test("抽取指标写入：recordCanonicalEngagement 记录时间戳观察，同一主体哈希亦如实写入", async () => {
  const recordedRows: any[] = [];
  const fakeDb: any = async (strings: TemplateStringsArray, ...values: any[]) => {
    recordedRows.push({ sql: strings.join("?"), values });
    return [];
  };
  fakeDb.json = (v: any) => v;

  const bili = makeBilibiliCanonical({ coins: 9999, danmaku: 444 });
  const success = await recordCanonicalEngagement(fakeDb, "art-1", "src-bilibili", bili, new Date("2026-10-08T12:00:00Z"));

  assert.equal(success, true);
  assert.equal(recordedRows.length, 1);
  const row = recordedRows[0]!;
  assert.ok(row.values.includes("bilibili"));
  assert.ok(row.values.includes("src-bilibili"));
  assert.ok(row.values.includes("art-1"));
  // metrics JSON object
  const metricsArg = row.values.find((v: any) => v && typeof v === "object" && "coins" in v);
  assert.equal(metricsArg.coins, 9999);
  assert.equal(metricsArg.danmaku, 444);
});

// ---------------------------------------------------------------------------
// 4. Stale AI communitySummary Lifecycle
// ---------------------------------------------------------------------------

test("AI 总结生命周期：回帖文本实际变动时清空过期的 communitySummary", () => {
  const existing = makeHupuCanonical({
    comments: [
      { id: "c1", author: "A", text: "第一局打得很稳" },
    ],
    communitySummary: "AI 总结：粉丝高度评价第一局战术发挥",
  });

  // 新抓取回帖文本发生实质变化（新增/替换了回复）
  const incoming = makeHupuCanonical({
    comments: [
      { id: "c1", author: "A", text: "第一局打得很稳" },
      { id: "c2", author: "B", text: "第二局BP有点冒进，引发争议" },
    ],
    communitySummary: null, // extractor 不产生 AI 总结
  });

  const refreshed = refreshCanonicalDiscussion(existing, incoming);
  assert.equal(refreshed.clearedSummary, true, "因回帖文本变动，过期的 AI 总结必须被清空");
  assert.equal(refreshed.discussion?.communitySummary, null, "AI 总结重置为 null 待重新生成");
  assert.equal(refreshed.discussion?.highlightedReplies.length, 2);
});

test("AI 总结生命周期：回帖文本未变（仅赞数/计数变动）时保留原 communitySummary", () => {
  const existing = makeHupuCanonical({
    comments: [
      { id: "c1", author: "A", text: "第一局打得很稳", likes: 10 },
    ],
    communitySummary: "AI 总结：粉丝高度评价第一局战术发挥",
  });

  // 回帖文本完全一样，仅赞数从 10 增长到 99
  const incoming = makeHupuCanonical({
    comments: [
      { id: "c1", author: "A", text: "第一局打得很稳", likes: 99 },
    ],
    communitySummary: null,
  });

  const refreshed = refreshCanonicalDiscussion(existing, incoming);
  assert.equal(refreshed.clearedSummary, false);
  assert.equal(refreshed.discussion?.communitySummary, "AI 总结：粉丝高度评价第一局战术发挥", "原有效 AI 总结完好保留");
  assert.equal(refreshed.discussion?.highlightedReplies[0]?.likes, 99, "点赞数更新为最新值");
});

// ---------------------------------------------------------------------------
// 5. Failed Refresh Truthful Recording & Asset Preservation
// ---------------------------------------------------------------------------

test("容灾保全：刷新失败时保留既往采集回帖，但如实记录本次失败（严禁 cache as success）", () => {
  const existing = makeHupuCanonical({
    comments: [
      { id: "c1", author: "老粉丝", text: "AG总决赛BP解析", likes: 88 },
      { id: "c2", author: "分析师", text: "双边野核执行力拉满", likes: 66 },
    ],
    coverage: "complete",
    communitySummary: "既往有效总结",
  });

  // 本次刷新失败：上游接口 503 超时，标记 coverage: "unavailable"
  const failedIncoming = makeHupuCanonical({
    comments: [], // 没有抓到新回帖
    coverage: "unavailable",
    error: "HTTP 503 Upstream Gateway Timeout",
  });

  const refreshed = refreshCanonicalDiscussion(existing, failedIncoming);
  assert.equal(refreshed.preservedPrevious, true);

  // 1. 既往回帖资产不被清空
  assert.equal(refreshed.discussion?.highlightedReplies.length, 2, "既往 2 条回帖完好保留");
  assert.equal(refreshed.discussion?.highlightedReplies[0]?.text, "AG总决赛BP解析");
  assert.equal(refreshed.discussion?.communitySummary, "既往有效总结");

  // 2. 状态如实报告失败，严禁伪装为成功
  assert.equal(refreshed.discussion?.collection?.coverage, "unavailable", "覆盖度真实报告为 unavailable");
  assert.equal(refreshed.discussion?.collection?.error, "HTTP 503 Upstream Gateway Timeout", "真实记录错误原因");
});

test("容灾保全：mergeCanonicalForRefresh 合并失败状态与互动指标", () => {
  const existing = makeHupuCanonical({
    comments: [{ id: "c1", author: "A", text: "已有评论" }],
    coverage: "complete",
  });

  const failedIncoming = makeHupuCanonical({
    comments: [],
    coverage: "unavailable",
    error: "Rate limited: 429 Too Many Requests",
    opLikes: 500, // 互动指标可能依然采集到了
  });

  const { canonical, preservedPrevious } = mergeCanonicalForRefresh(existing, failedIncoming);
  assert.equal(preservedPrevious, true);
  assert.equal(canonical.discussion?.highlightedReplies.length, 1);
  assert.equal(canonical.discussion?.collection?.coverage, "unavailable");
  assert.equal(canonical.discussion?.collection?.error, "Rate limited: 429 Too Many Requests");
  assert.equal(canonical.engagement?.likes, 500);
});

// ---------------------------------------------------------------------------
// 6. Upsert Material Integration Logic
// ---------------------------------------------------------------------------

test("材料判重：相同文本不同点赞/评论数 upsert 判定为未修改 (revised: false)，不触发版本递增", async () => {
  const c1 = makeHupuCanonical({
    title: "【常规赛战报】AG轻取三分",
    opText: "今日赛事成都AG超玩会展现出极强统治力，3:0战胜对手。",
    opLikes: 100,
    comments: [{ id: "c1", author: "粉丝", text: "零封！太强了", likes: 20 }],
  });

  const c2 = makeHupuCanonical({
    title: "【常规赛战报】AG轻取三分", // 相同标题
    opText: "今日赛事成都AG超玩会展现出极强统治力，3:0战胜对手。", // 相同正文
    opLikes: 999, // 点赞增长
    comments: [
      { id: "c1", author: "粉丝", text: "零封！太强了", likes: 200 },
      { id: "c2", author: "观众", text: "状态越来越好", likes: 50 }, // 新增评论
    ],
  });

  // 主体身份文本与内容哈希完全相同
  const hash1 = contentHash({ title: c1.title!, bodyText: canonicalIdentityText(c1) });
  const hash2 = contentHash({ title: c2.title!, bodyText: canonicalIdentityText(c2) });
  assert.equal(hash1, hash2, "主体哈希完全一致");

  // 模拟数据库环境验证 upsertMaterial 行为
  let articleRow: any = null;
  let revisions: any[] = [];
  let engagementObs: any[] = [];

  const fakeDb: any = async (strings: TemplateStringsArray, ...values: any[]) => {
    const rawSql = strings.join("?");
    if (rawSql.includes("INSERT INTO articles")) {
      if (articleRow) {
        return [];
      }
      articleRow = {
        id: "art-test-1",
        source_id: "hupu-kpl",
        identity_key: values[2],
        title: values[4],
        content_hash: values[14],
        revision: 1,
        body_text: values[16],
        canonical_content: values[26],
      };
      return [{ id: "art-test-1" }];
    }
    if (rawSql.includes("SELECT a.id, a.source_id")) {
      return [{
        id: articleRow.id,
        source_id: articleRow.source_id,
        revision: articleRow.revision,
        content_hash: articleRow.content_hash,
        backfill: false,
        title: articleRow.title,
        body_text: articleRow.body_text,
        excerpt: null,
        participation_mode: "editorial",
        canonical_content: articleRow.canonical_content,
      }];
    }
    if (rawSql.includes("INSERT INTO article_revisions")) {
      revisions.push({ article_id: values[0], revision: values[1], hash: values[2] });
      return [];
    }
    if (rawSql.includes("INSERT INTO engagement_observations")) {
      engagementObs.push(values);
      return [];
    }
    if (rawSql.includes("UPDATE articles SET")) {
      articleRow.canonical_content = values[0];
      return [];
    }
    return [];
  };
  fakeDb.json = (v: any) => v;

  // 1. 首次写入
  const res1 = await upsertMaterial({
    sourceId: "hupu-kpl",
    url: "https://bbs.hupu.com/123.html",
    title: c1.title!,
    canonical: c1,
    via: "fetch",
  }, fakeDb);
  assert.equal(res1.created, true);
  assert.equal(res1.revised, false);
  assert.equal(revisions.length, 1);
  assert.equal(engagementObs.length, 1, "首次成功抓取写入互动指标");

  // 2. 二次写入（仅评论与点赞变动，主体文本相同）
  const res2 = await upsertMaterial({
    sourceId: "hupu-kpl",
    url: "https://bbs.hupu.com/123.html",
    title: c2.title!,
    canonical: c2,
    via: "fetch",
  }, fakeDb);
  assert.equal(res2.created, false);
  assert.equal(res2.revised, false, "评论/点赞刷新严禁触发 revision 变更");
  assert.equal(revisions.length, 1, "article_revisions 表绝不新增版本");
  assert.equal(engagementObs.length, 2, "相同哈希下依然如实记录新的互动观察 (samehash engagement recorded)");
});

test("材料判重：主帖正文修改触发版本修订 (revised: true)", async () => {
  const c1 = makeHupuCanonical({
    title: "【战术复盘】队伍选拔",
    opText: "初版正文：队伍前期主打防守反击策略。",
  });

  const c2Edited = makeHupuCanonical({
    title: "【战术复盘】队伍选拔",
    opText: "修改版正文：队伍前期大幅提速，主动侵野反烂野区。", // OP 真实修改
  });

  const hash1 = contentHash({ title: c1.title!, bodyText: canonicalIdentityText(c1) });
  const hash2 = contentHash({ title: c2Edited.title!, bodyText: canonicalIdentityText(c2Edited) });
  assert.notEqual(hash1, hash2, "主帖修改导致主体哈希改变");

  let articleRow: any = null;
  let revisedCalled = false;

  const fakeDb: any = async (strings: TemplateStringsArray, ...values: any[]) => {
    const rawSql = strings.join("?");
    if (rawSql.includes("INSERT INTO articles")) {
      if (articleRow) {
        return [];
      }
      articleRow = {
        id: "art-test-2",
        source_id: "hupu-kpl",
        identity_key: values[2],
        title: values[4],
        content_hash: values[14],
        revision: 1,
        body_text: values[16],
        canonical_content: values[26],
      };
      return [{ id: "art-test-2" }];
    }
    if (rawSql.includes("SELECT a.id, a.source_id")) {
      return [{
        id: articleRow.id,
        source_id: articleRow.source_id,
        revision: articleRow.revision,
        content_hash: articleRow.content_hash,
        backfill: false,
        title: articleRow.title,
        body_text: articleRow.body_text,
        excerpt: null,
        participation_mode: "editorial",
        canonical_content: articleRow.canonical_content,
      }];
    }
    if (rawSql.includes("SELECT 1 FROM article_revisions")) {
      return [];
    }
    if (rawSql.includes("UPDATE articles SET") && rawSql.includes("revision = revision + 1")) {
      revisedCalled = true;
      articleRow.revision = 2;
      articleRow.content_hash = values[values.length - 3] || hash2;
      return [{ revision: 2 }];
    }
    return [];
  };
  fakeDb.json = (v: any) => v;

  // 1. 首次写入
  await upsertMaterial({
    sourceId: "hupu-kpl",
    url: "https://bbs.hupu.com/456.html",
    title: c1.title!,
    canonical: c1,
    via: "fetch",
  }, fakeDb);

  // 2. 主帖正文被作者编辑后再次抓取
  const res2 = await upsertMaterial({
    sourceId: "hupu-kpl",
    url: "https://bbs.hupu.com/456.html",
    title: c2Edited.title!,
    canonical: c2Edited,
    via: "fetch",
  }, fakeDb);

  assert.equal(res2.revised, true, "主帖编辑必须触发版本修订");
  assert.equal(revisedCalled, true, "调用 reviseMaterial 更新版本");
});

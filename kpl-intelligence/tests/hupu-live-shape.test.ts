import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hupuExtractor } from "../packages/backend/src/content/extractors/hupu.ts";
import type { ExtractionInput } from "../packages/backend/src/content/extractors/base.ts";
import { profileFor } from "../packages/backend/src/content/extractors/profiles.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function fixture(name: string): string {
  const p = path.resolve(__dirname, "fixtures/content", name);
  return fs.readFileSync(p, "utf-8");
}

function createInput(overrides: Partial<ExtractionInput> = {}): ExtractionInput {
  return {
    sourceId: "hupu-kog",
    url: overrides.url ?? "https://bbs.hupu.com/642828440.html",
    html: overrides.html ?? "",
    title: overrides.title ?? "",
    profile: profileFor({ url: overrides.url ?? "https://bbs.hupu.com/642828440.html" }),
    sourceKind: "json_list",
    excerpt: null,
    author: null,
    publishedAt: null,
    xPost: null,
    raw: null,
    sourceConfig: null,
    fetchJson: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. 实测验证真字节形状：单页完整帖（642828440.html）
// ---------------------------------------------------------------------------

test("Hupu Live Shape: __NEXT_DATA__ props.pageProps.detail 真实结构主帖、图片保序与楼层提取", async () => {
  const html = fixture("hupu-thread-live-verified.html");
  const input = createInput({ url: "https://bbs.hupu.com/642828440.html", html });

  const result = await hupuExtractor.extract(input);
  assert.ok(result, "extraction must succeed from verified __NEXT_DATA__ shape");

  // 1. 基本元数据
  assert.equal(result.kind, "forum_thread");
  assert.equal(result.title, "[流言板]AG发布赛后返图：面对眼前的坎坷，找到方向大步迈过去");
  assert.equal(result.extraction.extractor, "hupu");
  assert.equal(result.extraction.bodyProvenance, "source_api");
  assert.equal(result.extraction.confidence, 0.95);

  // 2. 主帖作者与发帖时间（author.puname / author.header / createdAt 毫秒戳映射）
  assert.ok(result.author);
  assert.equal(result.author.name, "虎扑游戏电竞资讯");
  assert.equal(result.author.avatarUrl, "https://i3.hoopchina.com.cn/user/81/35904121053081-4744740486745602021.png@150h_150w_2e");
  assert.equal(result.publishedAt, "2026-10-08T13:08:06.000Z");

  // 3. 正文 Blocks 与图片保序（htmlToBlocks 提取 14 个块，10 张图片，图文顺序完全保持）
  assert.equal(result.main.length, 14, "should contain 14 interleaved blocks (paragraphs and images)");
  assert.equal(result.main[0]!.type, "image", "first block is the header image");
  assert.equal(result.main[1]!.type, "paragraph", "second block is intro paragraph");
  assert.equal(result.media.length, 10, "media gallery contains all 10 verified content images");
  assert.ok(result.media[0]!.url.includes("e5bee953c1484e5ac21113694ca666ef"), "first media URL verified");

  // 4. 真实 totalReplies 与 engagement（平台全量统计 11，非采样已抓数，绝不假冒）
  const d = result.discussion!;
  assert.equal(d.totalReplies, 11, "totalReplies is exact platform total (detail.thread.replies)");
  assert.equal(d.fetchedReplies, 11, "all 11 replies fetched on single page");
  assert.equal(d.collection?.coverage, "complete", "coverage is complete when fetchedReplies === totalReplies and terminalProof");
  assert.equal(d.collection?.nextCursor, null, "single page thread has no next page");
  assert.equal(result.engagement?.comments, 11, "engagement.comments matches exact platform total");
  assert.equal(result.engagement?.likes, 2, "engagement.likes matches OP lights");

  // 5. 评论与高光（allLightCount 映射点赞，楼层序号精准绑定，ID 来自 pid）
  assert.equal(d.authorFollowups.length, 0, "no author followup in this thread");
  assert.ok(d.highlightedReplies.length >= 5, "highlighted replies ranked by allLightCount");

  // 验证高赞回复：竹山堂 (pid: 9701, allLightCount: 11)
  const topReply = d.highlightedReplies.find((r) => r.author.name === "竹山堂");
  assert.ok(topReply, "top reply by 竹山堂 must be in highlighted");
  assert.equal(topReply.id, "9701", "ID is derived from reply pid");
  assert.equal(topReply.likes, 11, "likes mapped from allLightCount");
  assert.equal(topReply.floor, 2, "floor correctly assigned as 2 (1 is OP)");
  assert.equal(topReply.publishedAt, "2026-10-08T13:08:56.000Z");
  assert.ok(topReply.text.includes("要是还这种表现，这样的文案也看不了三四次了吧"));

  // 验证次赞回复：用户0772915102 (pid: 14427, allLightCount: 7)
  const secondReply = d.highlightedReplies.find((r) => r.author.name === "用户0772915102");
  assert.ok(secondReply);
  assert.equal(secondReply.likes, 7);
  assert.equal(secondReply.floor, 3);
});

// ---------------------------------------------------------------------------
// 2. 多页回复与引用结构核验（642825525 / 642814669 verified shape）
// ---------------------------------------------------------------------------

test("Hupu Live Shape: 多页分页 nextCursor 续扫链接、引用剥离保全与 partial 覆盖度", async () => {
  const html = fixture("hupu-thread-live-multipage.html");
  const input = createInput({ url: "https://bbs.hupu.com/642825525.html", html });

  const result = await hupuExtractor.extract(input);
  assert.ok(result);

  const d = result.discussion!;
  // 1. 真实全量 116，单页仅抓 2 条 -> partial 覆盖
  assert.equal(d.totalReplies, 116, "totalReplies is platform declared count 116");
  assert.equal(d.fetchedReplies, 2, "fetched replies on page 1 is 2");
  assert.equal(d.collection?.coverage, "partial", "coverage is partial when fetchedReplies < totalReplies");
  assert.equal(result.engagement?.comments, 116, "comments reflects platform declared total 116");

  // 2. 有效分页续扫 URL：current=1, total=6 -> 续扫指向 page 2
  assert.equal(d.collection?.nextCursor, "https://bbs.hupu.com/642825525-2.html", "nextCursor points to reliable next page URL");

  // 3. 引用对象结构提取：quote.author.puname 与 quote.content
  const quotedReply = d.highlightedReplies.find((r) => r.author.name === "41狙康康大魔王");
  assert.ok(quotedReply, "quoted reply should be found");
  assert.equal(quotedReply.likes, 71, "reply likes mapped from allLightCount");
  assert.ok(!quotedReply.text.includes("指挥，那不就是在说小紧"), "quoted text must NOT leak into own text");
  assert.ok(quotedReply.text.includes("重组换人也必须换指挥"), "own text is clean");

  assert.ok(quotedReply.quote, "quote must be preserved");
  assert.equal(quotedReply.quote.author, "特雷西麦麦麦麦迪", "quote author mapped from quote.author.puname");
  assert.ok(quotedReply.quote.text.includes("指挥，那不就是在说小紧"), "quote text preserved");
});

// ---------------------------------------------------------------------------
// 3. 页面身份绑定与逆向防御（Bound page identity & tid mismatch）
// ---------------------------------------------------------------------------

test("Hupu Live Shape: 结构化线程容器显式 tid 必须与 URL 严格匹配，防跨帖串数", async () => {
  const html = fixture("hupu-thread-live-verified.html"); // TID is 642828440
  // 请求 URL 为不相干的另一帖 ID
  const input = createInput({ url: "https://bbs.hupu.com/999999999.html", html });

  const result = await hupuExtractor.extract(input);
  // 由于 TID 不匹配，结构化 JSON 通道拒绝采纳容器数据
  // 并且 DOM 中也无 999999999 的帖子结构，因此返回 null 或 fallback
  if (result) {
    // 即使极端情况下 DOM 产出，也绝不能采纳 642828440 的 JSON
    assert.notEqual(result.discussion?.collection?.provenance, "source_api");
  } else {
    assert.equal(result, null, "mismatched thread ID must reject the JSON container");
  }
});

// ---------------------------------------------------------------------------
// 4. 磁盘真字节直测（如果 /tmp/hupu-642828440.html 存在，则直测真实线上捕获）
// ---------------------------------------------------------------------------

test("Hupu Live Shape: 针对 /tmp/hupu-642828440.html 真实捕获真字节端到端断言", { skip: process.env.HUPU_CAPTURE_VERIFY !== "true" }, async () => {
  const livePath = "/tmp/hupu-642828440.html";
  assert.ok(fs.existsSync(livePath), "explicit capture verification requires captured file");
  const liveHtml = fs.readFileSync(livePath, "utf-8");
  const input = createInput({ url: "https://bbs.hupu.com/642828440.html", html: liveHtml });

  const result = await hupuExtractor.extract(input);
  assert.ok(result);

  assert.equal(result.title, "[流言板]AG发布赛后返图：面对眼前的坎坷，找到方向大步迈过去");
  assert.ok(result.author);
  assert.equal(result.author.name, "虎扑游戏电竞资讯");
  assert.equal(result.discussion?.totalReplies, 11);
  assert.equal(result.discussion?.fetchedReplies, 11);
  assert.equal(result.discussion?.collection?.coverage, "complete");
  assert.equal(result.engagement?.comments, 11);
  assert.equal(result.engagement?.likes, 2);
  assert.equal(result.media.length, 10);
});

// ---------------------------------------------------------------------------
// 5. 公共热点发现路由验证（/kog-hot 与 /kog-postdate）
// ---------------------------------------------------------------------------

test("Hupu Sources: 验证 sources.json 中虎扑王者荣耀版热点发现路由 (/kog-hot) 与最新发布路由 (/kog-postdate)", () => {
  const sourcesPath = path.resolve(__dirname, "../industry/sources.json");
  const content = fs.readFileSync(sourcesPath, "utf-8");
  const data = JSON.parse(content);

  const postdateSource = data.sources.find((s: any) => s.id === "hupu-kog");
  assert.ok(postdateSource, "hupu-kog must exist");
  assert.equal(postdateSource.config.url, "https://bbs.hupu.com/kog-postdate");
  assert.equal(postdateSource.config.sortByPublishedAt, true, "postdate orders by createdAt");

  const hotSource = data.sources.find((s: any) => s.id === "hupu-kog-hot");
  assert.ok(hotSource, "hupu-kog-hot must exist as proven 24h hot entry");
  assert.equal(hotSource.config.url, "https://bbs.hupu.com/kog-hot");
  assert.equal(hotSource.config.sortByPublishedAt, false, "hot orders by 24h heat / high replies, not publish date");
});

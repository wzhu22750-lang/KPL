// M2 Community Intelligence - Hupu Extractor & Forum Processing Tests
// 覆盖：
// 1. 结构化 JSON 渠道：bounded 渠道检索、真实 totalReplies vs fetchedReplies、未证实前 partial、去重、引文分离、头像楼层绑定、防无关 JSON 数组混入
// 2. 0 回帖合法性：无回帖主帖完整提取，totalReplies=0, fetchedReplies=0, coverage='complete'
// 3. DOM 丰富形态：图片保序进 blocks/media、脚本清洗、引文从自身剥离并保全、头像与楼层精准对应
// 4. 未知总数兜底：无总数指标时 totalReplies 为 null，coverage 为 partial
// 5. Index 兜底防线：失败的虎扑页面绝不降级为 generic-article 伪造文章
// 6. rankReplies：去重、作者多元视角（Diversity）、严禁伪造立场、null-safe 点赞、幽默/梗文化不误判为垃圾
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractCanonical, profileFor } from "@aihot/backend/content/extractors/index";
import { hupuExtractor } from "@aihot/backend/content/extractors/hupu";
import { rankReplies, replyScore, forumExtractor } from "@aihot/backend/content/extractors/forum";
import { evaluateContentQuality } from "@aihot/backend/content/extractors/quality";
import type { DiscussionPost } from "@aihot/backend/content/extractors/types";
import type { ExtractionInput } from "@aihot/backend/content/extractors/base";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/content/${name}`, import.meta.url)), "utf8");

function createInput(over: Partial<ExtractionInput> & { html?: string | null; url?: string }): ExtractionInput {
  const url = over.url ?? "https://bbs.hupu.com/67890123.html";
  return {
    url,
    html: over.html ?? null,
    profile: over.profile ?? profileFor({ url }),
    sourceId: over.sourceId ?? "test-hupu-source",
    sourceKind: over.sourceKind ?? "web_list",
    title: over.title ?? null,
    excerpt: over.excerpt ?? null,
    author: over.author ?? null,
    publishedAt: over.publishedAt ?? null,
    xPost: over.xPost ?? null,
    raw: null,
    sourceConfig: over.sourceConfig ?? null,
    fetchJson: over.fetchJson ?? null,
  };
}

// ---------------------------------------------------------------------------
// 1. 结构化 JSON 渠道：Bounded 检索、真实总数、Partial 覆盖、防无关数组
// ---------------------------------------------------------------------------

test("虎扑 JSON：bounded 结构化渠道提取，真实 totalReplies、partial 覆盖，严禁混入无关数组", async () => {
  const html = fixture("hupu-thread-json.html");
  const input = createInput({ url: "https://bbs.hupu.com/89012345.html", html });

  const result = await hupuExtractor.extract(input);
  assert.ok(result, "hupuExtractor should extract valid thread from structured JSON");

  const d = result.discussion;
  assert.ok(d, "discussion structure must exist");

  // 1. 真实 totalReplies 与实际抓取数分离
  assert.equal(d.totalReplies, 42, "totalReplies must be the platform total (42)");
  assert.equal(d.fetchedReplies, 2, "fetchedReplies must reflect deduped fetched reply posts (2)");
  assert.equal(d.collection?.coverage, "partial", "coverage must be partial when fetched < total");
  assert.equal(d.collection?.provenance, "source_api");

  // 2. 防无关 JSON 数组混入（recommendations/hotTopics 严禁出现在回帖或主帖中）
  const allTexts = [d.originalPost.text, ...d.authorFollowups.map((p) => p.text), ...d.highlightedReplies.map((p) => p.text)].join("\n");
  assert.ok(!allTexts.includes("无关推荐资讯"), "unrelated recommendation arrays must not be merged");
  assert.ok(!allTexts.includes("全站热帖榜单"), "unrelated hot topic arrays must not be merged");

  // 3. 主帖与回帖的头像和楼层绑定
  assert.equal(d.originalPost.author.name, "KPL战术大亨");
  assert.equal(d.originalPost.author.avatarUrl, "https://i1.hoopchina.com.cn/user/avatar_1.jpg");
  assert.equal(d.originalPost.floor, 1);
  assert.equal(d.originalPost.likes, 520);

  // 4. 回帖引文剥离与保全
  const replyWithQuote = d.highlightedReplies.find((p) => p.author.name === "AG小迷弟");
  assert.ok(replyWithQuote, "reply by AG小迷弟 should be preserved");
  assert.ok(!replyWithQuote.text.includes("KPL战术大亨"), "quoted author must not leak into own text");
  assert.ok(!replyWithQuote.text.includes("从常规赛后半段的表现来看"), "quoted text must be stripped from own text");
  assert.ok(replyWithQuote.text.includes("确实如此，这轮系列赛的关键就在野区博弈"), "own substantive text survives");
  assert.equal(replyWithQuote.quote?.author, "KPL战术大亨");
  assert.ok(replyWithQuote.quote?.text.includes("从常规赛后半段的表现来看"));

  // 5. 去重：原始 JSON 中包含两个相同 pid 的 AG小迷弟 回帖，结果中只保留一个
  const fanReplies = d.highlightedReplies.filter((p) => p.author.name === "AG小迷弟");
  assert.equal(fanReplies.length, 1, "duplicate replies must be deduplicated");
});

// ---------------------------------------------------------------------------
// 2. 0 回帖合法性：新帖无回帖成功提取
// ---------------------------------------------------------------------------

test("虎扑 0 回帖：无回帖主帖合法完整提取，totalReplies=0, fetchedReplies=0, coverage='complete'", async () => {
  const html = fixture("hupu-thread-zero-replies.html");
  const input = createInput({ url: "https://bbs.hupu.com/90000001.html", html });

  const result = await hupuExtractor.extract(input);
  assert.ok(result, "0-reply thread must succeed and not be discarded");

  assert.equal(result.kind, "forum_thread");
  const d = result.discussion!;
  assert.equal(d.originalPost.author.name, "路人战术狂");
  assert.ok(d.originalPost.text.includes("最后一局巅峰对决双方都拿出了常规阵容"));
  assert.equal(d.originalPost.likes, 15);
  assert.equal(d.authorFollowups.length, 0);
  assert.equal(d.highlightedReplies.length, 0);
  assert.equal(d.totalReplies, 0, "totalReplies is parsed as 0");
  assert.equal(d.fetchedReplies, 0, "fetchedReplies is 0");
  assert.equal(d.collection?.coverage, "complete", "coverage is complete when totalReplies=0 and fetchedReplies=0");
  assert.equal(result.engagement?.comments, 0);
});

// ---------------------------------------------------------------------------
// 3. DOM 丰富形态：图片保序、脚本清洗、引文分离、楼层与头像精准对应
// ---------------------------------------------------------------------------

test("虎扑 DOM：正文图片按序提取、恶意脚本剔除、引文彻底剥离并保全、头像楼层精准绑定", async () => {
  const html = fixture("hupu-thread-dom-rich.html");
  const input = createInput({ url: "https://bbs.hupu.com/90000002.html", html });

  const result = await hupuExtractor.extract(input);
  assert.ok(result);

  const c = result;
  const d = c.discussion!;

  // 1. 正文 blocks 中图片顺序与文本交错保持
  const mainBlocks = c.main;
  assert.ok(mainBlocks.length >= 5, "paragraphs and images should alternate in main blocks");
  assert.equal(mainBlocks[0]!.type, "paragraph");
  assert.equal(mainBlocks[1]!.type, "image");
  assert.equal((mainBlocks[1] as any).url, "https://i1.hoopchina.com.cn/analysis/bp_match1.png");
  assert.equal(mainBlocks[2]!.type, "paragraph");
  assert.equal(mainBlocks[3]!.type, "image");
  assert.equal((mainBlocks[3] as any).url, "https://i1.hoopchina.com.cn/analysis/timeline_gold.png");

  // 2. 媒体库收集到正文图片
  assert.equal(c.media.length, 2);
  assert.ok(c.media.some((m) => m.url.includes("bp_match1.png")));

  // 3. 脚本与注入攻击被严格清洗
  const rawHtml = d.originalPost.html ?? "";
  assert.ok(!rawHtml.includes("<script>"), "script tag must be sanitized");
  assert.ok(!rawHtml.includes("__malicious"), "malicious script payload must be removed");

  // 4. 楼主补充（2楼）
  assert.equal(d.authorFollowups.length, 1);
  assert.ok(d.authorFollowups[0]!.text.includes("补充一张双方辅助对位的承伤与视野贡献对比图"));
  assert.equal(d.authorFollowups[0]!.floor, 2);

  // 5. 回帖引文剥离与保全（3楼）
  const quotedReply = d.highlightedReplies.find((p) => p.author.name === "理智观赛者");
  assert.ok(quotedReply, "quoted reply should be highlighted");
  assert.ok(!quotedReply.text.includes("四分钟暴君处的转线速度"), "quoted text must NOT be in own text");
  assert.ok(quotedReply.text.includes("这波转线真的教科书级别"), "own reply text must be intact");
  assert.equal(quotedReply.quote?.author, "战术分析师老张");
  assert.ok(quotedReply.quote?.text.includes("四分钟暴君处的转线速度"));

  // 6. 幽默回复（4楼）不被误判为水贴，成功入选高光
  const humorReply = d.highlightedReplies.find((p) => p.author.name === "梗王小赵");
  assert.ok(humorReply, "humorous community banter must not be treated as spam");
  assert.ok(humorReply.text.includes("笑死我了"));

  // 7. 纯水贴（5楼）出局
  const spamReply = d.highlightedReplies.find((p) => p.author.name === "刷屏机");
  assert.ok(!spamReply, "pure spam '6666666' must be excluded from highlights");

  // 8. 真实 totalReplies (38) 与 fetchedReplies (3 条非楼主回帖)
  assert.equal(d.totalReplies, 38);
  assert.equal(d.fetchedReplies, 4, "total fetched replies including followup is 4");
  assert.equal(d.collection?.coverage, "partial", "partial coverage without proof of full fetch");

  // 9. 稳定唯一 ID
  assert.equal(d.originalPost.id, "p-1001");
  assert.equal(quotedReply.id, "p-1003");
  assert.equal(humorReply.id, "p-1004");
});

// ---------------------------------------------------------------------------
// 4. 未知总数兜底：无明确总数时 totalReplies 为 null，engagement.comments 严禁冒充已抓数
// ---------------------------------------------------------------------------

test("虎扑未知总数：页面未提供总数时 totalReplies 为 null，engagement.comments 严禁 fallback 冒充已抓数，coverage 为 partial", async () => {
  const html = fixture("hupu-thread.html");
  const input = createInput({ url: "https://bbs.hupu.com/67890123.html", html });

  const result = await hupuExtractor.extract(input);
  assert.ok(result);

  const d = result.discussion!;
  assert.equal(d.totalReplies, null, "totalReplies must be null when unknown");
  assert.equal(d.fetchedReplies, 4, "fetchedReplies is 4");
  assert.equal(d.collection?.coverage, "partial", "coverage must be partial when total is unknown");
  assert.equal(result.engagement?.comments, null, "engagement.comments never fallback fetched when total unknown");
});

// ---------------------------------------------------------------------------
// 5. Index 兜底防线：失败的虎扑页面绝不降级为 generic-article
// ---------------------------------------------------------------------------

test("Index 调度：提取失败的虎扑页面绝不降级为 generic-article 伪造正文", async () => {
  const emptyHupuHtml = `<!DOCTYPE html><html><head><title>虎扑社区 - 页面已删除</title></head><body><div class="header">导航</div><div class="error">该帖子已被删除或不存在</div><div class="footer">Copyright Hupu</div></body></html>`;
  const input = createInput({
    url: "https://bbs.hupu.com/deleted-thread-99999.html",
    html: emptyHupuHtml,
  });

  const result = await extractCanonical(input);
  assert.equal(result, null, "failed hupu thread must return null, never fall back to generic article extraction");
});

// ---------------------------------------------------------------------------
// 6. rankReplies 深度测试：去重、多元视角、无伪造立场、null-safe 点赞、幽默识别
// ---------------------------------------------------------------------------

test("rankReplies：去重有效，多条重复回复只保留一条", () => {
  const replies: DiscussionPost[] = [
    { id: "1", author: { name: "A" }, text: "AG 这个版本野核节奏确实无解，中期控龙率拉满了。", isOriginalAuthor: false, likes: 20 },
    { id: "2", author: { name: "B" }, text: "AG 这个版本野核节奏确实无解，中期控龙率拉满了。", isOriginalAuthor: false, likes: 10 },
    { id: "3", author: { name: "C" }, text: "狼队如果不针对大司命，后面几局只会更难打。", isOriginalAuthor: false, likes: 15 },
  ];
  const ranked = rankReplies(replies, 5);
  assert.equal(ranked.length, 2, "duplicate text must be deduplicated to 1 item");
  assert.equal(ranked[0]!.author.name, "A", "higher scored duplicate is kept");
});

test("rankReplies：多元视角（Diversity），单作者不独占所有高光槽位，且绝不伪造立场字段", () => {
  const replies: DiscussionPost[] = [
    { id: "1", author: { name: "战术大师" }, text: "第一局的运营重心在对抗路换线，AG 的视野把控领先狼队一个身位。", isOriginalAuthor: false, likes: 90 },
    { id: "2", author: { name: "战术大师" }, text: "第二局的野区防守更是教科书级别，直接反掉对面蓝BUFF断了打野发育节奏。", isOriginalAuthor: false, likes: 80 },
    { id: "3", author: { name: "数据帝" }, text: "从赛后伤害占比来看，双C输出占比都超过了30%，团战拉扯非常极致。", isOriginalAuthor: false, likes: 60 },
    { id: "4", author: { name: "路人观点" }, text: "个人觉得狼队的变阵稍微慢了半拍，第三局才调整BP已经晚了。", isOriginalAuthor: false, likes: 50 },
  ];
  const ranked = rankReplies(replies, 3);
  const authors = ranked.map((r) => r.author.name);
  assert.ok(authors.includes("战术大师"));
  assert.ok(authors.includes("数据帝"));
  assert.ok(authors.includes("路人观点"));
  assert.equal(authors.filter((a) => a === "战术大师").length, 1, "same author should not dominate all highlight slots");

  // 严禁伪造立场字段
  for (const r of ranked) {
    assert.equal((r as any).stance, undefined, "no fabricated stance field allowed");
  }
});

test("rankReplies：null-safe 点赞处理（null, undefined, 负数, 超大数均安全不抛错）", () => {
  const replies: DiscussionPost[] = [
    { id: "1", author: { name: "A" }, text: "战术运营非常到位，前中期节奏完全由AG掌握。", isOriginalAuthor: false, likes: null },
    { id: "2", author: { name: "B" }, text: "狼队必须及时调整选手心态，失误有点偏多了。", isOriginalAuthor: false, likes: undefined },
    { id: "3", author: { name: "C" }, text: "双边推塔节奏完全带起来了，压制力肉眼可见。", isOriginalAuthor: false, likes: -5 },
    { id: "4", author: { name: "D" }, text: "大乔体系的运营依然很有统治力，不能轻易放给对面。", isOriginalAuthor: false, likes: 999999 },
  ];
  const ranked = rankReplies(replies, 4);
  assert.ok(ranked.length >= 3, "null-safe likes should rank valid comments smoothly without crashing");
  assert.equal(ranked[0]!.author.name, "D", "highest likes comment ranked first");
});

test("rankReplies：社区幽默/梗文化不被自动当成垃圾过滤，而纯无意义字符坚决过滤", () => {
  const witty: DiscussionPost = {
    id: "w1", author: { name: "乐子人" },
    text: "笑死我了，这波操作直接把我看蚌埠住了，太幽默了",
    isOriginalAuthor: false, likes: 50,
  };
  const spam1: DiscussionPost = {
    id: "s1", author: { name: "水王1" },
    text: "666666",
    isOriginalAuthor: false, likes: 0,
  };
  const spam2: DiscussionPost = {
    id: "s2", author: { name: "水王2" },
    text: "哈哈哈哈哈哈",
    isOriginalAuthor: false, likes: 0,
  };
  const spam3: DiscussionPost = {
    id: "s3", author: { name: "水王3" },
    text: "打卡前排支持",
    isOriginalAuthor: false, likes: 0,
  };

  assert.ok(replyScore(witty) > 0, "humorous community post should score positively");
  assert.equal(replyScore(spam1), 0, "pure number repeat is spam (score 0)");
  assert.equal(replyScore(spam2), 0, "pure laugh repeat is spam (score 0)");
  assert.equal(replyScore(spam3), 0, "pure check-in is spam (score 0)");

  const ranked = rankReplies([witty, spam1, spam2, spam3], 5);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.id, "w1");
});

// ---------------------------------------------------------------------------
// 7. Adverse: JSON 显式 tid/threadId 与请求 URL 绑定，排除容器及回帖记录不匹配项
// ---------------------------------------------------------------------------

test("Adverse: JSON 容器显式 tid 与 URL 不匹配时坚决排除", async () => {
  const mismatchedJsonHtml = `<!DOCTYPE html><html><head><title>测试</title></head><body>
  <script>
    window.__INITIAL_STATE__ = {
      bbsDetail: {
        tid: "99999999",
        title: "错误帖子的标题内容",
        post: { id: "op-1", content: "错误帖子的正文内容", author: "路人" },
        replies: []
      }
    };
  </script>
  </body></html>`;

  const input = createInput({
    url: "https://bbs.hupu.com/89012345.html",
    html: mismatchedJsonHtml,
  });

  const result = await hupuExtractor.extract(input);
  // 容器 tid 99999999 与 URL 89012345 不匹配，严禁错误绑定
  assert.equal(result, null, "mismatched container tid must be excluded");
});

test("Adverse: JSON 回帖记录中显式 tid 与主帖不匹配时逐条剔除", async () => {
  const payload = {
    thread: {
      tid: "89012345",
      title: "正确的帖子标题",
      post: { id: "p-op", content: "正确的楼主分析正文，字数达到充分长度以确保有效解析。", author: "分析师" },
      replies: [
        { pid: "r-1", tid: "89012345", content: "匹配的回帖1，讨论战术细节非常清晰。", author: "用户1", likes: 10 },
        { pid: "r-2", tid: "99999999", content: "来自其他帖子的跨帖推广内容或广告。", author: "外部人员", likes: 999 },
        { pid: "r-3", tid: "89012345", content: "匹配的回帖3，战术分析非常精彩到位。", author: "用户3", likes: 25 },
      ],
      totalReplies: 2,
      hasMore: false,
    },
  };
  const replyMismatchJsonHtml = `<!DOCTYPE html><html><head><title>测试</title></head><body>
  <script>window.__INITIAL_STATE__ = ${JSON.stringify(payload)};</script>
  </body></html>`;

  const input = createInput({
    url: "https://bbs.hupu.com/89012345.html",
    html: replyMismatchJsonHtml,
  });

  const result = await hupuExtractor.extract(input);
  assert.ok(result);
  const replies = result.discussion!.highlightedReplies;
  assert.ok(!replies.some((r) => r.author.name === "外部人员"), "reply with mismatched tid must be excluded");
  assert.ok(replies.some((r) => r.author.name === "用户1" || r.author.name === "用户3"), "matching replies must be preserved");
  assert.equal(result.discussion!.fetchedReplies, 2, "fetched count must reflect filtered matching replies");
});

// ---------------------------------------------------------------------------
// 8. 换行、段落、<br> 与主帖引用 (OP quote) 保全
// ---------------------------------------------------------------------------

test("换行与段落保全：<p> 段落保持双换行，<br> 转换为单换行，主帖 OP 引用保全且从正文剥离", async () => {
  const richBreaksHtml = `<!DOCTYPE html><html><head><title>段落测试</title></head><body>
  <div id="app">
    <h1 class="post-title">段落与换行格式测试帖</h1>
    <div class="post-wrapper" id="post-1">
      <div class="post-user"><span class="post-user__name">格式大师</span></div>
      <div class="post-content">
        <div class="quote-content"><span class="quote-author">赛事官方</span>本场比赛将于今晚七点开打，请各位观众提前就座。</div>
        <p>第一段：关于双方首发名单的调整，教练组做出了重要决定。</p>
        <p>第二段第一行：野区资源的分配策略。<br>第二段第二行：下路兵线的推进节奏。</p>
      </div>
      <div class="post-time">2026-10-08 19:00</div>
      <div class="post-like"><span class="post-like__value">100</span></div>
    </div>
  </div>
  </body></html>`;

  const input = createInput({
    url: "https://bbs.hupu.com/90000005.html",
    html: richBreaksHtml,
  });

  const result = await hupuExtractor.extract(input);
  assert.ok(result);
  const op = result.discussion!.originalPost;

  // 1. OP 引用保全
  assert.ok(op.quote, "OP quote must be preserved");
  assert.equal(op.quote?.author, "赛事官方");
  assert.ok(op.quote?.text.includes("本场比赛将于今晚七点开打"));

  // 2. 引用从自身正文中剥离
  assert.ok(!op.text.includes("赛事官方"), "quote author must be stripped from OP own text");
  assert.ok(!op.text.includes("请各位观众提前就座"), "quote text must be stripped from OP own text");

  // 3. 段落与换行保全
  assert.ok(op.text.includes("第一段：关于双方首发名单的调整，教练组做出了重要决定。"));
  assert.ok(op.text.includes("第二段第一行：野区资源的分配策略。\n第二段第二行：下路兵线的推进节奏。"), "<br> must translate to line break");
  assert.ok(op.text.includes("\n\n"), "paragraphs must be separated by paragraph breaks");
});

// ---------------------------------------------------------------------------
// 9. Adverse: 完整度判定依赖明确有效结构，严禁以 char>=15 判定为 full
// ---------------------------------------------------------------------------

test("Adverse: 论坛完整度必须依赖明确有效结构，严禁 char>=15 单一门槛判定为 full", () => {
  // Case A: 文本超过 15 字（22 字），但缺少有效结构（无 discussion），严禁判 full
  const noDiscussionQuality = evaluateContentQuality({
    kind: "forum_thread",
    sourceFamily: "forum",
    title: "前瞻讨论",
    canonical: {
      main: [{ type: "paragraph", text: "今晚这场比赛到底谁能赢？大家都看好哪支战队呢？" }],
      lead: null,
      discussion: null,
      social: null,
      video: null,
      media: [],
      engagement: null,
    },
    fallbackUsed: false,
  });
  assert.notEqual(noDiscussionQuality.completeness, "full", "forum thread without valid discussion structure must NOT be full");

  // Case B: 具备有效结构，但主帖过短且无丰富讨论（0 回帖），属于短片断，严禁草率判定为 full
  const shortOpQuality = evaluateContentQuality({
    kind: "forum_thread",
    sourceFamily: "forum",
    title: "求问阵容",
    canonical: {
      main: [{ type: "paragraph", text: "大家觉得这套阵容打野谁更合适？求解答一下。" }],
      lead: null,
      discussion: {
        originalPost: { id: "op", author: { name: "楼主" }, text: "大家觉得这套阵容打野谁更合适？求解答一下。", isOriginalAuthor: true },
        authorFollowups: [],
        highlightedReplies: [],
        totalReplies: 0,
      },
      social: null,
      video: null,
      media: [],
      engagement: null,
    },
    fallbackUsed: false,
  });
  assert.equal(shortOpQuality.completeness, "partial", "short forum thread without rich replies must be partial, not full");

  // Case C: 具备有效结构且主帖达到 fullChars (>= 80 字)，合法判定为 full
  const longOpQuality = evaluateContentQuality({
    kind: "forum_thread",
    sourceFamily: "forum",
    title: "深度赛后复盘",
    canonical: {
      main: [{ type: "paragraph", text: "从第三局比赛的数据细节来剖析，AG 在前期野区的入侵策略非常决绝。通过对抗路第一波兵线的强势抢二，辅助快速游走到中路帮助抢下线权，从而形成了三包一针对蓝区打野的包夹战术。狼队在防守时沟通脱节，导致野区经济差在八分钟内被拉开到四千以上。" }],
      lead: null,
      discussion: {
        originalPost: {
          id: "op-long",
          author: { name: "分析员" },
          text: "从第三局比赛的数据细节来剖析，AG 在前期野区的入侵策略非常决绝。通过对抗路第一波兵线的强势抢二，辅助快速游走到中路帮助抢下线权，从而形成了三包一针对蓝区打野的包夹战术。狼队在防守时沟通脱节，导致野区经济差在八分钟内被拉开到四千以上。",
          isOriginalAuthor: true,
        },
        authorFollowups: [],
        highlightedReplies: [],
        totalReplies: 0,
      },
      social: null,
      video: null,
      media: [],
      engagement: null,
    },
    fallbackUsed: false,
  });
  assert.equal(longOpQuality.completeness, "full", "forum thread with substantial OP (>=80 chars) and valid structure is full");
});

// ---------------------------------------------------------------------------
// 10. Adverse: 显式截断元数据必须尊从 partial
// ---------------------------------------------------------------------------

test("Adverse: 显式截断元数据必须将 completeness 降级为 partial 并发出警告", () => {
  const truncatedQuality = evaluateContentQuality({
    kind: "forum_thread",
    sourceFamily: "forum",
    title: "长文截断测试",
    canonical: {
      main: [{ type: "paragraph", text: "长文分析内容即使字数达到数千字且结构齐全，只要标注了截断，就绝不能判定为 full。" }],
      lead: null,
      discussion: {
        originalPost: { id: "op", author: { name: "博主" }, text: "长篇战术分析...", isOriginalAuthor: true },
        authorFollowups: [],
        highlightedReplies: [],
        totalReplies: 10,
      },
      social: null,
      video: null,
      media: [],
      engagement: null,
      extraction: {
        extractor: "hupu",
        version: "1.1.0",
        sourceId: "s1",
        sourceFamily: "forum",
        fallbackUsed: false,
        bodyProvenance: "source_api",
        sourceAuthority: "community",
        bodyCompleteness: "partial", // 显式截断声明
      },
    } as any,
    fallbackUsed: false,
  });

  assert.equal(truncatedQuality.completeness, "partial", "explicit truncation metadata must force partial");
  assert.ok(truncatedQuality.warnings.includes("body_truncated"), "must emit body_truncated warning");
});

// ---------------------------------------------------------------------------
// 11. Adverse: 评论完整性（coverage=complete）严格要求终末证据且与总数一致
// ---------------------------------------------------------------------------

test("Adverse: 未获终末证据或总数不一致时，严禁声称 comments complete", async () => {
  // Case A: 抓取数与总数看似一致 (2 == 2)，但存在 hasMore: true（非终末证据）
  const payloadA = {
    thread: {
      tid: "89012345",
      title: "分页未终结测试帖子",
      post: { id: "op-1", content: "帖子正文足够长，进行分页有效性验证分析。", author: "楼主" },
      replies: [
        { pid: "r-1", tid: "89012345", content: "第一条回帖，战术很到位。", author: "用户A" },
        { pid: "r-2", tid: "89012345", content: "第二条回帖，运营很扎实。", author: "用户B" },
      ],
      totalReplies: 2,
      hasMore: true, // 明确标注还有更多，非终末
    },
  };
  const hasMoreJsonHtml = `<!DOCTYPE html><html><head><title>分页测试</title></head><body>
  <script>window.__INITIAL_STATE__ = ${JSON.stringify(payloadA)};</script>
  </body></html>`;

  const inputA = createInput({
    url: "https://bbs.hupu.com/89012345.html",
    html: hasMoreJsonHtml,
  });
  const resA = await hupuExtractor.extract(inputA);
  assert.ok(resA);
  assert.equal(resA.discussion!.collection?.coverage, "partial", "must be partial when hasMore=true despite fetched==total");

  // Case B: 总数不一致 (totalReplies: 10, fetched: 2)
  const payloadB = {
    thread: {
      tid: "89012345",
      title: "总数不一致测试帖子",
      post: { id: "op-2", content: "帖子正文足够长，进行总数一致性验证分析。", author: "楼主" },
      replies: [
        { pid: "r-1", tid: "89012345", content: "第一条回帖，战术很到位。", author: "用户A" },
      ],
      totalReplies: 10,
      hasMore: false,
    },
  };
  const mismatchCountHtml = `<!DOCTYPE html><html><head><title>总数测试</title></head><body>
  <script>window.__INITIAL_STATE__ = ${JSON.stringify(payloadB)};</script>
  </body></html>`;

  const inputB = createInput({
    url: "https://bbs.hupu.com/89012345.html",
    html: mismatchCountHtml,
  });
  const resB = await hupuExtractor.extract(inputB);
  assert.ok(resB);
  assert.equal(resB.discussion!.collection?.coverage, "partial", "must be partial when totals disagree (1 != 10)");

  // Case C: 通用论坛未提供总数时，forumExtractor coverage 必须为 partial 且 comments 为 null
  const genericForumHtml = `<html><body><h1 class="thread-title">测试帖子标题</h1>
    <div class="post"><span class="author">楼主</span><div class="content">楼主正文内容。</div></div>
    <div class="post"><span class="author">回帖人</span><div class="content">回帖内容。</div></div>
  </body></html>`;
  const inputC = createInput({
    url: "https://forum.example.com/t/1",
    html: genericForumHtml,
    profile: profileFor({ url: "https://forum.example.com/t/1", config: { contentFamily: "forum" } }),
  });
  const resC = await forumExtractor.extract(inputC);
  assert.ok(resC);
  assert.equal(resC.discussion!.totalReplies, null);
  assert.equal(resC.discussion!.collection?.coverage, "partial");
  assert.equal(resC.engagement?.comments, null, "forumExtractor engagement.comments must be null when total is unknown");
});

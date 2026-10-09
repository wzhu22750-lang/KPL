// Multi-source Content Intelligence Pipeline 的测试矩阵（ fixtures 真实 DOM，不 mock 字符串）：
// 微信长文完整 / 新闻站去导航 / 官方公告短文不误判 / 虎扑主帖评论分离 / 通用论坛 schema /
// B站简介不叫正文 / 短社交判 full / 无正文 fallback / 低质量正文不展示。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractCanonical, profileFor } from "@aihot/backend/content/extractors/index";
import { evaluateContentQuality } from "@aihot/backend/content/extractors/quality";
import { canonicalToBody } from "@aihot/backend/content/canonical";
import { wechatExtractor } from "@aihot/backend/content/extractors/wechat";
import { toContentView } from "@aihot/backend/publication/items";
import type { CanonicalContent } from "@aihot/backend/content/extractors/types";
import type { ExtractionInput } from "@aihot/backend/content/extractors/base";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/content/${name}`, import.meta.url)), "utf8");

const UNKNOWN_PROFILE = profileFor({ url: "https://example.org/nope" });

function input(over: Partial<ExtractionInput> & { html?: string | null; url?: string }): ExtractionInput {
  return {
    url: over.url ?? "https://example.org/article",
    html: over.html ?? null,
    profile: over.profile ?? UNKNOWN_PROFILE,
    sourceId: over.sourceId ?? "test-source",
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
// 1. 微信长文：正文完整、噪音剔除、图片顺序、作者/时间
// ---------------------------------------------------------------------------

test("微信长文：正文段落完整，二维码/编辑署名/往期推荐不进正文", async () => {
  const html = fixture("wechat-article.html");
  const result = await extractCanonical(input({ url: "https://mp.weixin.qq.com/s/fixture", html, title: "KPL 秋季赛常规赛第六周观赛指南" }));
  assert.ok(result, "wechat extractor should produce canonical content");
  const c: CanonicalContent = result.content;
  assert.equal(c.kind, "article");
  assert.equal(c.author?.name, "KPL王者荣耀职业联赛");
  const allText = c.main.map((b) => ("text" in b ? b.text : "")).join("\n");
  assert.ok(allText.includes("成都AG超玩会 vs 重庆狼队"), "the lead block survives");
  assert.ok(allText.includes("最后两个季后赛名额"), "the real last paragraph survives (no mechanical truncation)");
  assert.ok(!/编辑：小K/.test(allText), "editor signature is dropped");
  assert.ok(!/商务合作/.test(allText), "business contact is dropped");
  assert.ok(!/往期推荐/.test(allText), "past-article links are dropped");
  assert.ok(!/长按识别二维码/.test(allText), "follow CTA is dropped");
  assert.ok(!c.media.some((m) => /qrcode/.test(m.url)), "the QR image is not in the gallery");
  assert.ok(c.media.some((m) => /fixture-content-1/.test(m.url)), "content images are kept in order");
  assert.ok(c.publishedAt && c.publishedAt.startsWith("2026-10-"), "publish time parsed from the page");
  assert.equal(c.extraction.extractor, "wechat");
  assert.equal(c.extraction.bodyProvenance, "page_dom");
});

// ---------------------------------------------------------------------------
// 2. 新闻站：去导航/侧栏/相关阅读
// ---------------------------------------------------------------------------

test("新闻站：正文来自 article 容器，导航、侧栏与相关阅读不混入", async () => {
  const html = fixture("generic-news.html");
  const result = await extractCanonical(input({ url: "https://news.example-daily.com/kpl/2026-final", html }));
  assert.ok(result);
  const c = result.content;
  const text = result.body.text;
  assert.ok(text.includes("以 4:2 战胜重庆狼队"), "the article's own body is extracted");
  assert.ok(!text.includes("热门文章") && !text.includes("热门一"), "the hot list sidebar stays out");
  assert.ok(!text.includes("相关阅读"), "related links stay out");
  assert.ok(!text.includes("下载 APP"), "the footer stays out");
  assert.ok(c.title?.includes("AG 超玩会捧杯"));
  assert.ok(c.publishedAt?.startsWith("2026-10-01"));
});

// ---------------------------------------------------------------------------
// 3. 官方公告：150 字不误判；不同来源不用同一把尺子
// ---------------------------------------------------------------------------

test("质量引擎：官方公告 150 字即完整，新闻 150 字算不完整，社交帖 50 字即完整", () => {
  const announcement = "经联盟研究决定，2026年度总决赛将于11月1日在深圳举办。赛制沿用全局BP，门票将于10月10日中午12点开售，敬请留意官方渠道公告。";
  const blocks = [{ type: "paragraph" as const, text: announcement }];
  const base = { title: "关于2026年度总决赛的公告", lead: null, media: [], engagement: null, discussion: null, social: null, video: null };
  const qAnnouncement = evaluateContentQuality({ kind: "official_announcement", sourceFamily: "official", title: base.title, canonical: { ...base, main: blocks }, fallbackUsed: false });
  assert.equal(qAnnouncement.completeness, "full");

  const qNews = evaluateContentQuality({ kind: "news", sourceFamily: "publisher", title: base.title, canonical: { ...base, main: blocks }, fallbackUsed: false });
  assert.equal(qNews.completeness, "partial", "150 chars is not a complete news article");

  const socialText = "AG 今天下午的训练赛打得不错，新打野的节奏比上个月明显更快了。";
  const qSocial = evaluateContentQuality({
    kind: "social_post", sourceFamily: "social", title: null,
    canonical: { ...base, main: [], social: { postText: socialText, quoted: null } }, fallbackUsed: false,
  });
  assert.equal(qSocial.completeness, "full");
});

test("质量引擎：论坛主帖短但评论区丰富不算失败；空正文判 failed 并携带警告", () => {
  const discussion = {
    originalPost: { id: null, author: { name: "楼主" }, text: "今晚这场 AG 打狼队，你们更看好谁？", isOriginalAuthor: true, floor: 1, likes: null, publishedAt: null, quote: null },
    authorFollowups: [],
    highlightedReplies: [
      { id: null, author: { name: "A" }, text: "AG 的野核体系这个版本优先级太高了，狼队必须前三手就处理，不然前期节奏完全对不上。", isOriginalAuthor: false, floor: 2, likes: 88, publishedAt: null, quote: null },
      { id: null, author: { name: "B" }, text: "关键在第三局之后的 BP 权变化，狼队拿到大司命的话完全不一样。", isOriginalAuthor: false, floor: 3, likes: 45, publishedAt: null, quote: null },
      { id: null, author: { name: "C" }, text: "看好 AG，运营和执行力都在线。", isOriginalAuthor: false, floor: 4, likes: 12, publishedAt: null, quote: null },
    ],
    totalReplies: 40,
  };
  const q = evaluateContentQuality({
    kind: "forum_thread", sourceFamily: "forum", title: "AG vs 狼队 前瞻",
    canonical: { main: [{ type: "paragraph", text: "今晚这场 AG 打狼队，你们更看好谁？" }], lead: null, discussion, social: null, video: null, media: [], engagement: { comments: 40 } },
    fallbackUsed: false,
  });
  assert.equal(q.completeness, "full");
  assert.ok(q.score >= 40, `a rich discussion scores well (got ${q.score})`);

  const qEmpty = evaluateContentQuality({
    kind: "article", sourceFamily: "publisher", title: "标题",
    canonical: { main: [], lead: null, discussion: null, social: null, video: null, media: [], engagement: null }, fallbackUsed: true,
  });
  assert.equal(qEmpty.completeness, "failed");
  assert.ok(qEmpty.warnings.includes("unusable_body"));
});

// ---------------------------------------------------------------------------
// 4. 虎扑：主帖/楼主补充/高亮回复分离，评论不进正文
// ---------------------------------------------------------------------------

test("虎扑帖子：主帖与评论分离，楼主补充成组，纯水回复被过滤", async () => {
  const html = fixture("hupu-thread.html");
  const result = await extractCanonical(input({ url: "https://bbs.hupu.com/67890123.html", html, profile: profileFor({ url: "https://bbs.hupu.com/67890123.html" }) }));
  assert.ok(result);
  const c = result.content;
  assert.equal(c.kind, "forum_thread");
  assert.equal(c.extraction.extractor, "hupu");
  assert.ok(c.title?.includes("如何评价AG超玩会"));
  assert.equal(c.discussion?.originalPost.text, "第三局狼队直接放出了大司命，AG 顺势拿下镜配张飞体系。个人认为这一手放得过于自信，狼队前期节奏完全断档，八分钟经济差四千。AG 的转线运营这一场堪称教科书，尤其 14 分钟那波四人抱团推中路一塔。");
  assert.equal(c.discussion?.originalPost.author.name, "峡谷观察员");
  assert.equal(c.discussion?.originalPost.likes, 328);
  // 楼主补充 = 同作者的 2 楼
  assert.equal(c.discussion?.authorFollowups.length, 1);
  assert.ok(c.discussion!.authorFollowups[0]!.text.includes("前四手 BP"));
  // 高亮回复：水贴"哈哈哈哈哈"出局，引用回复在场
  const highlightAuthors = c.discussion!.highlightedReplies.map((p) => p.author.name);
  assert.ok(!highlightAuthors.includes("路人甲"), "pure-lurk replies are filtered");
  assert.ok(highlightAuthors.includes("战术板小哥"));
  const quoted = c.discussion!.highlightedReplies.find((p) => p.author.name === "狼队铁粉");
  assert.ok(quoted?.quote?.text.includes("放出了大司命"), "the quoted floor is attached");
  // 主帖正文不含评论文本
  const opHtml = c.main.map((b) => ("text" in b ? b.text : "")).join("");
  assert.ok(!opHtml.includes("狼队铁粉"), "replies never mix into the original post");
  assert.equal(c.engagement?.comments, null, "fixture declares no platform-wide count; sample is not the total");
  assert.equal(c.discussion?.totalReplies, null);
  assert.equal(c.discussion?.fetchedReplies, 4);
  assert.equal(c.discussion?.collection?.coverage, "partial");
});

// ---------------------------------------------------------------------------
// 5. 通用论坛：thread schema 对非虎扑论坛同样成立
// ---------------------------------------------------------------------------

test("通用论坛 extractor：无专用 adapter 也产出 thread schema", async () => {
  const html = `<html><body><h1 class="thread-title">新版本大司命是否过强？</h1>
    <div class="forum-post"><span class="post-author">数据帝</span><div class="post-body">新版本大司命的出场率和禁用率都翻倍了，胜率却没有明显变化，说明强度主要在玩家熟练度上。</div><span class="post-likes">57</span></div>
    <div class="forum-post"><span class="post-author">路过</span><div class="post-body">版本强度还是看运营配合，单英雄的数值不是全部。</div><span class="post-likes">31</span></div>
  </body></html>`;
  const forumProfile = profileFor({ url: "https://bbs.other-game-forum.example/thread-1", config: { contentFamily: "forum" } });
  assert.equal(forumProfile.presentation, "thread");
  const result = await extractCanonical(input({ url: "https://bbs.other-game-forum.example/thread-1", html, profile: forumProfile }));
  assert.ok(result);
  const c = result.content;
  assert.equal(c.kind, "forum_thread");
  assert.equal(c.discussion?.originalPost.author.name, "数据帝");
  assert.ok(c.discussion!.highlightedReplies.length >= 1);
  assert.equal(c.extraction.extractor, "forum");
});

// ---------------------------------------------------------------------------
// 6. B站：description 不叫正文，视频元数据齐全
// ---------------------------------------------------------------------------

test("B站视频：kind=video_post，正文为空，简介放 video.description 且标注 summary_only", async () => {
  const html = fixture("bilibili-video.html");
  const result = await extractCanonical(input({ url: "https://www.bilibili.com/video/BV1FIXTURE01", html, profile: profileFor({ url: "https://www.bilibili.com/video/BV1FIXTURE01" }) }));
  assert.ok(result);
  const c = result.content;
  assert.equal(c.kind, "video_post");
  assert.equal(c.extraction.extractor, "bilibili");
  assert.deepEqual(c.main, [], "a video has no article body");
  assert.equal(c.title, "【赛后复盘】DYG vs eStarPro：运营拉满的教科书局");
  assert.equal(c.author?.name, "战术板研究所");
  assert.ok(c.video?.description?.includes("逐分钟拆解"));
  assert.equal(c.video?.durationSeconds, 924);
  assert.ok(c.video?.cover?.includes("fixture-cover"));
  assert.equal(c.engagement?.views, 182000);
  assert.equal(c.engagement?.comments, 860);
  assert.equal(c.quality.completeness, "summary_only");
  // 派生 body：简介文本进 body_text（供 AI/搜索），但 UI 走视频视图
  assert.ok(result.body.text.includes("逐分钟拆解"));
});

test("B站：页面无 INITIAL_STATE 时通过 view API 取数据", async () => {
  const apiPayload = {
    code: 0,
    data: {
      bvid: "BV1FIXTURE02", title: "KPL 常规赛集锦", desc: "本周五场比赛的精华镜头与关键团战复盘。", pic: "https://i0.hdslb.com/bfs/archive/x.jpg",
      pubdate: 1727800000, duration: 600,
      owner: { mid: 7, name: "赛事速递", face: null },
      stat: { view: 90000, danmaku: 500, reply: 300, favorite: 1200, coin: 2000, share: 400, like: 12000 },
    },
  };
  const html = `<html><head><title>KPL 常规赛集锦 - 哔哩哔哩</title></head><body>player BV1FIXTURE02</body></html>`;
  const result = await extractCanonical(input({
    url: "https://www.bilibili.com/video/BV1FIXTURE02", html,
    profile: profileFor({ url: "https://www.bilibili.com/video/BV1FIXTURE02" }),
    fetchJson: async () => apiPayload,
  }));
  assert.ok(result);
  assert.equal(result.content.kind, "video_post");
  assert.equal(result.content.author?.name, "赛事速递");
  assert.equal(result.content.engagement?.likes, 12000);
});

// ---------------------------------------------------------------------------
// 7. 短社交：50 字即完整
// ---------------------------------------------------------------------------

test("社交动态：X 帖子映射 social_post，短文本判 full，引用分离", async () => {
  const xPost = {
    tweetId: "1790000000000000000",
    authorName: "KPL选手动态", handle: "kpl_player_news", avatarUrl: null,
    text: "今天训练赛的状态回来了，新体系第三套阵容的胜率比预期高很多，下周见分晓。",
    quoted: { authorName: "赛程君", handle: "schedule_bot", text: "下周：AG vs 狼队，周五 19:00", url: "https://x.com/schedule_bot/status/1" },
    media: [{ kind: "image", url: "https://pbs.twimg.com/media/fixture.jpg" }],
  };
  const xProfile = profileFor({ url: "https://x.com/kpl_player_news/status/1790000000000000000" });
  const result = await extractCanonical(input({ url: "https://x.com/kpl_player_news/status/1790000000000000000", html: null, xPost, profile: xProfile }));
  assert.ok(result);
  const c = result.content;
  assert.equal(c.kind, "social_post");
  assert.equal(c.extraction.extractor, "social");
  assert.equal(c.extraction.bodyProvenance, "source_api");
  assert.equal(c.social?.postText, xPost.text);
  assert.equal(c.social?.quoted?.handle, "schedule_bot");
  assert.equal(c.quality.completeness, "full");
});

// ---------------------------------------------------------------------------
// 8. 无正文页面 fallback 链；9. 低质量正文不展示
// ---------------------------------------------------------------------------

test("无正文页面：整条 extractor 链不产出，派生不出正文，绝不伪装", async () => {
  const garbage = `<html><head><title>跳转中</title></head><body><script>location.replace("/login")</script></body></html>`;
  const result = await extractCanonical(input({ url: "https://example.org/redirect-page", html: garbage }));
  assert.equal(result, null, "no extractor invents content for a page without one");

  const readable = await extractCanonical(input({ url: "https://example.org/empty", html: "<html><body><p>太短</p></body></html>" }));
  assert.equal(readable, null);
});

test("低质量正文：completeness=failed 的内容派生不出垃圾 body_text", async () => {
  const c: CanonicalContent = {
    kind: "article", title: "标题", author: null, publishedAt: null, lead: null,
    main: [], media: [], discussion: null, video: null, social: null, engagement: null,
    extraction: { extractor: "generic-article", version: "1.0.0", sourceId: "s", sourceFamily: "unknown", fallbackUsed: true, bodyProvenance: "readability", sourceAuthority: "publisher" },
    quality: { score: 0, completeness: "failed", warnings: ["unusable_body"] },
  };
  const body = canonicalToBody(c);
  assert.equal(body.text, "");
  assert.equal(body.html, "");
});

// ---------------------------------------------------------------------------
// Profiles：来源差异集中在声明处
// ---------------------------------------------------------------------------

test("profileFor：按 hostname 识别虎扑/B站/微信，config 可覆盖家族，transport 与内容类型分离", () => {
  assert.equal(profileFor({ url: "https://bbs.hupu.com/1.html" }).preferredExtractor, "hupu");
  assert.equal(profileFor({ url: "https://www.bilibili.com/video/BV1x" }).preferredExtractor, "bilibili");
  assert.equal(profileFor({ url: "https://mp.weixin.qq.com/s/abc" }).preferredExtractor, "wechat");
  // json_list transport 的虎扑来源 → 同一个 profile
  assert.equal(profileFor({ sourceId: "hupu-kog", url: "https://bbs.hupu.com/1.html", kind: "json_list" }).contentFamily, "forum");
  // 未知域名的论坛型来源：config 一句话接入
  assert.equal(profileFor({ url: "https://forum.example.com/t/1", config: { contentFamily: "forum" } }).preferredExtractor, "forum");
  // 普通 rss 来源默认文章语义
  assert.equal(profileFor({ url: "https://blog.example.org/feed-entry" }).preferredExtractor, "generic-article");
});

// ---------------------------------------------------------------------------
// 安全与 XSS 防护验证
// ---------------------------------------------------------------------------

test("微信域名严格校验：带参数与子域名仿冒无法绕过 canHandle", () => {
  assert.equal(wechatExtractor.canHandle(input({ url: "https://evil.com/?target=mp.weixin.qq.com" })), false);
  assert.equal(wechatExtractor.canHandle(input({ url: "https://mp.weixin.qq.com.evil.com/s/xyz" })), false);
  assert.equal(wechatExtractor.canHandle(input({ url: "https://notmp.weixin.qq.com/s/xyz" })), false);
  assert.equal(wechatExtractor.canHandle(input({ url: "https://mp.weixin.qq.com/s/valid_token" })), true);
});

test("HTML 清洗：canonicalToBody 对 bodyHtmlSource 与派生 HTML 进行严格 sanitizeBody，剔除 onerror/onclick", () => {
  const dirtyHtml = '<p onclick="alert(1)">测试正文<img src="https://example.com/pic.jpg" onerror="alert(2)"></p><script>alert(3)</script>';
  const c: CanonicalContent = {
    kind: "article",
    title: "安全测试",
    author: null,
    publishedAt: null,
    lead: null,
    main: [{ type: "paragraph", text: "测试正文" }],
    media: [],
    bodyHtmlSource: dirtyHtml,
    discussion: null,
    video: null,
    social: null,
    engagement: null,
    extraction: { extractor: "wechat", version: "1.0.0", sourceId: "s", sourceFamily: "official", fallbackUsed: false, bodyProvenance: "page_dom", sourceAuthority: "official" },
    quality: { score: 90, completeness: "full", warnings: [] },
  };

  const derived = canonicalToBody(c);
  // c.bodyHtmlSource 本身已被严格清洗
  assert.ok(!c.bodyHtmlSource?.includes("onerror"));
  assert.ok(!c.bodyHtmlSource?.includes("onclick"));
  assert.ok(!c.bodyHtmlSource?.includes("<script>"));
  // 派生出来的 HTML 同样杜绝 XSS 属性
  assert.ok(!derived.html.includes("onerror"));
  assert.ok(!derived.html.includes("onclick"));
  assert.ok(!derived.html.includes("<script>"));
  assert.ok(derived.html.includes("测试正文"));
});

test("toContentView 权限约束：非 full 授权或 unconfirmed 状态下，不向前端泄露全文未授权数据", () => {
  const dummyRow: any = {
    id: "art-1",
    title: "论坛讨论测试",
    original_title: null,
    summary: "合规摘要内容",
    reason: null,
    category: "kpl",
    tags: [],
    score: 80,
    selected: true,
    seat: true,
    channel: "news",
    url: "https://bbs.example.com/thread/1",
    published_at: new Date(),
    discovered_at: new Date(),
    timeline_at: new Date(),
    visibility: "public",
    body_mode: "summary", // 未获得全文授权
    body_status: "ok",
    indexable: true,
    fact_id: null,
    source_name: "某论坛",
    source_mode: "editorial",
    x_post: null,
    author: "楼主",
    language: "zh",
    content_kind: "forum_thread",
    story_public_id: null,
    story_title: null,
    zh_text: null,
    quoted_zh: null,
    canonical_content: {
      kind: "forum_thread",
      discussion: {
        originalPost: { author: { name: "楼主" }, text: "这是绝密未授权全文内容" },
        authorFollowups: [],
        highlightedReplies: [{ author: { name: "路人" }, text: "这是敏感讨论回复" }],
      },
    },
  };

  // 1. 当 body_mode === "summary" 时，不暴露 community 全文
  const summaryView = toContentView(dummyRow);
  assert.equal(summaryView?.kind, "forum_thread");
  assert.equal(summaryView?.community, null, "未获全文授权时 community 应为 null");
  assert.equal(summaryView?.quality.completeness, "summary_only");

  // 2. 当 body_mode === "full" 但正文为 unconfirmed 时，同样不暴露全文
  const unconfirmedRow = { ...dummyRow, body_mode: "full", body_status: "unconfirmed" };
  const unconfirmedView = toContentView(unconfirmedRow);
  assert.equal(unconfirmedView?.community, null, "正文 unconfirmed 时 community 应为 null");
  assert.equal(unconfirmedView?.quality.completeness, "summary_only");

  // 3. 当获得全文授权 (full) 且状态 ok 时，正常提供完整视图
  const fullRow = { ...dummyRow, body_mode: "full", body_status: "ok" };
  const fullView = toContentView(fullRow);
  assert.ok(fullView?.community !== null);
  assert.equal(fullView?.community?.originalPost.text, "这是绝密未授权全文内容");
});

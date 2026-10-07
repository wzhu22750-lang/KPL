import assert from "node:assert/strict";
import test from "node:test";
import { cleanWechatHtml, parseWechatDate } from "@aihot/backend/sources/wechat2rss/parser";
import { generateRssFeed } from "@aihot/backend/sources/wechat2rss/generator";
import { Wechat2RssBridge, wechatBridge } from "@aihot/backend/sources/wechat2rss/bridge";
import { normalizeAccountName } from "@aihot/backend/sources/wechat2rss/types";
import { fetchRss } from "@aihot/backend/sources/rss";
import type { SourceRow } from "@aihot/backend/sources/types";

test("WeChat2RSS parseWechatDate - 各种时间戳与相对时间解析", () => {
  // 1. timeConvert('1716047117')
  const d1 = parseWechatDate("document.write(timeConvert('1716047117'))");
  assert.equal(d1.getUTCFullYear(), 2024);
  assert.equal(d1.getUTCMonth(), 4); // May

  // 2. 纯 10 位时间戳
  const d2 = parseWechatDate("1684037629");
  assert.equal(d2.getUTCFullYear(), 2023);

  // 3. 相对时间 10分钟前
  const before10m = Date.now() - 10 * 60_000;
  const d3 = parseWechatDate("10分钟前");
  assert.ok(Math.abs(d3.getTime() - before10m) < 5000);

  // 4. 标准日期
  const d4 = parseWechatDate("2023-05-18");
  assert.equal(d4.getFullYear(), 2023);
});

test("WeChat2RSS HTML parser - 防盗链图片清洗与标签规范化", () => {
  const rawHtml = `
    <div id="js_content">
      <script>var x = 1;</script>
      <p>这是第一段文字。</p>
      <img data-src="https://mmbiz.qpic.cn/mmbiz_jpg/test1234/0?wx_fmt=jpeg" data-w="1080" />
      <div class="qr_code_pc_outer">二维码</div>
      <div id="js_toobar">点赞条</div>
    </div>
  `;
  const result = cleanWechatHtml(rawHtml);

  assert.ok(!result.html.includes("<script>"), "应移除 script 脚本");
  assert.ok(!result.html.includes("qr_code_pc_outer"), "应移除二维码区域");
  assert.ok(!result.html.includes("js_toobar"), "应移除底栏赞赏点赞条");
  assert.ok(result.html.includes('src="https://mmbiz.qpic.cn/mmbiz_jpg/test1234/0?wx_fmt=jpeg"'), "应将 data-src 提升为 src");
  assert.ok(result.html.includes('referrerpolicy="no-referrer"'), "图片必须附加防盗链属性 referrerpolicy='no-referrer'");
  assert.ok(result.images.includes("https://mmbiz.qpic.cn/mmbiz_jpg/test1234/0?wx_fmt=jpeg"), "图片列表应包含该图片");
  assert.equal(result.text, "这是第一段文字。");
});

test("WeChat2RSS Generator - 生成标准 RSS 2.0 XML", () => {
  const account = {
    id: "test-mp",
    name: "测试公众号",
    description: "测试公众号描述",
    url: "https://mp.weixin.qq.com",
  };
  const articles = [
    {
      id: "art-1",
      title: "第一篇微信测试文章",
      url: "https://mp.weixin.qq.com/s/art1",
      author: "测试作者",
      description: "第一篇摘要内容",
      contentHtml: "<p>第一篇正文内容</p>",
      contentText: "第一篇正文内容",
      coverUrl: "https://mmbiz.qpic.cn/cover1.jpg",
      publishedAt: new Date("2026-10-01T10:00:00Z"),
    },
  ];

  const xml = generateRssFeed(account, articles);
  assert.ok(xml.includes("<rss version=\"2.0\""), "必须为合法 RSS 2.0 声明");
  assert.ok(xml.includes("<title>测试公众号 - 微信公众号</title>"), "包含正确的 Channel 标题");
  assert.ok(xml.includes("<title>第一篇微信测试文章</title>"), "包含文章标题");
  assert.ok(xml.includes("<link>https://mp.weixin.qq.com/s/art1</link>"), "包含文章链接");
  assert.ok(xml.includes("<content:encoded>"), "包含 content:encoded 正文字段");
  assert.ok(xml.includes("<![CDATA[<p>第一篇正文内容</p>]]>"), "正文必须在 CDATA 中");
});

test("WeChat2RSS Bridge 与 fetchRss 采集集成测试", async () => {
  // 注入测试存根，避免测试阶段触碰真实外部服务（铁律 4）
  const originalFetch = wechatBridge.fetchAccountArticles.bind(wechatBridge);
  wechatBridge.fetchAccountArticles = async () => ({
    account: { id: "test-kpl", name: "KPL王者荣耀职业联赛", url: "https://mp.weixin.qq.com" },
    articles: [
      {
        id: "mock-1",
        title: "2026KPL年度总决赛正式开幕",
        url: "https://mp.weixin.qq.com/s/mock_kpl_1",
        author: "KPL官方",
        contentHtml: "<p>2026年KPL年度总决赛盛大开幕！</p>",
        contentText: "2026年KPL年度总决赛盛大开幕！",
        publishedAt: new Date(),
      },
    ],
  });

  const source: SourceRow = {
    id: "mp-kpl-official",
    name: "KPL王者荣耀职业联赛（官方公众号）",
    kind: "rss",
    tier: "T1",
    participation_mode: "editorial",
    first_party: true,
    interval_minutes: 60,
    enabled: true,
    cursor: null,
    fail_count: 0,
    config: {
      feedUrl: "wechat://KPL王者荣耀职业联赛",
      summaryIsBody: false,
    },
  };

  const read = await fetchRss(source, { force: true });

  assert.equal(read.notModified, false);
  assert.ok(read.candidates.length > 0, "应抓取到至少一条候选文章");

  const first = read.candidates[0]!;
  assert.ok(first.title.length > 0, "文章必须包含标题");
  assert.ok(first.url.startsWith("http"), "文章链接必须有效");
  assert.ok(first.publishedAt instanceof Date, "必须包含解析后的发布时间");
});

// ---------------------------------------------------------------------------
// 桥的降级/身份语义（全部使用假适配器，不访问外部服务）
// ---------------------------------------------------------------------------

const article = {
  id: "a1",
  title: "一篇文章",
  url: "https://mp.weixin.qq.com/s/one",
  author: "官方号",
  contentHtml: "<p>正文</p>",
  contentText: "正文",
  publishedAt: new Date("2026-10-01T00:00:00Z"),
};

function bridgeWith(adapter: { name: string; getArticles: (id: string) => Promise<unknown> }): Wechat2RssBridge {
  const bridge = new Wechat2RssBridge();
  (bridge as unknown as { adapters: unknown[] }).adapters = [adapter];
  return bridge;
}

test("Bridge: 全部失败且无缓存 → getFeed 抛错，不冒充成功", async () => {
  const bridge = bridgeWith({ name: "fail", getArticles: async () => null });
  await assert.rejects(() => bridge.getFeed("测试号", { force: true }), /upstream unavailable/);
});

test("Bridge: 全部失败但有旧缓存 → stale，真实 fetchedAt 不刷新", async () => {
  const ok = bridgeWith({ name: "ok", getArticles: async () => ({ account: { id: "mp1", name: "测试号" }, articles: [article], identity: "mp_id", fetchedAt: 1_700_000_000_000 }) });
  const first = await ok.getFeed("测试号", { force: true });
  assert.equal(first.status, "ok");
  assert.equal(first.fetchedAt, 1_700_000_000_000);

  // 同一实例：注入成功缓存后换成失败适配器
  (ok as unknown as { adapters: unknown[] }).adapters = [{ name: "fail", getArticles: async () => null }];
  const stale1 = await ok.getFeed("测试号", { force: true });
  assert.equal(stale1.status, "stale");
  assert.equal(stale1.degraded, true);
  assert.equal(stale1.fetchedAt, 1_700_000_000_000, "降级不得把旧数据重新标记为新鲜");
  await new Promise((r) => setTimeout(r, 15));
  const stale2 = await ok.getFeed("测试号", { force: true });
  assert.equal(stale2.fetchedAt, 1_700_000_000_000, "反复读取旧缓存不延长真实新鲜度");
});

test("Bridge: 可验证的空结果是 empty，不触发故障", async () => {
  const bridge = bridgeWith({ name: "empty", getArticles: async () => ({ account: { id: "mp1", name: "空号" }, articles: [], status: "empty", identity: "mp_id", fetchedAt: 1_700_000_000_001 }) });
  const feed = await bridge.getFeed("空号", { force: true });
  assert.equal(feed.status, "empty");
  assert.equal(feed.degraded, false);
});

test("Bridge: 仅展示名称匹配（display_name）默认拒收；mp_id 才是可信身份", async () => {
  const displayName = { name: "display_name", getArticles: async () => ({ account: { id: "x", name: "测试号" }, articles: [article], identity: "display_name", droppedUnverified: 0, fetchedAt: 1 }) };
  const bridge = bridgeWith(displayName);
  await assert.rejects(() => bridge.getFeed("测试号", { force: true }), /upstream unavailable/);
  const allowed = await bridge.fetchAccountArticles("测试号", { force: true, allowDisplayNameIdentity: true });
  assert.equal(allowed?.articles.length, 1);
});

test("Bridge: 作者不精确匹配的第三方文章被拒收计数，且不把作者改成目标账号名", async () => {
  const mismatch = bridgeWith({ name: "mismatch", getArticles: async () => ({ account: { id: "x", name: "目标号" }, articles: [article], identity: "display_name", droppedUnverified: 2, fetchedAt: 2 }) });
  const result = await mismatch.fetchAccountArticles("目标号", { force: true, allowDisplayNameIdentity: true });
  assert.equal(result?.droppedUnverified, 2, "第三方文章的拒收计数被保留以便排查");
  assert.equal(result?.articles[0]?.author, "官方号", "保留上游真实作者，不改成目标账号名");
});

test("normalizeAccountName: 相似名/括号备注不相等", () => {
  assert.equal(normalizeAccountName("KPL王者荣耀职业联赛（官方）"), normalizeAccountName("kpl 王者荣耀职业联赛"));
  assert.notEqual(normalizeAccountName("AG超玩会"), normalizeAccountName("AG超玩会官方"));
});

test("Generator: 没有正文时不输出 content:encoded（摘要不冒充正文）", () => {
  const xml = generateRssFeed(
    { id: "mp", name: "测试号" },
    [{ id: "1", title: "标题", url: "https://mp.weixin.qq.com/s/x", author: "号", description: "这是摘要", contentHtml: null, contentText: null, publishedAt: new Date("2026-10-01T00:00:00Z") }]
  );
  assert.ok(xml.includes("<description>"), "摘要仍保留在 description");
  assert.ok(!xml.includes("<content:encoded>"), "没有正文时不得输出 content:encoded");
});

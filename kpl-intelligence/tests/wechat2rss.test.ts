import assert from "node:assert/strict";
import test from "node:test";
import { cleanWechatHtml, parseWechatDate } from "@aihot/backend/sources/wechat2rss/parser";
import { generateRssFeed } from "@aihot/backend/sources/wechat2rss/generator";
import { wechatBridge } from "@aihot/backend/sources/wechat2rss/bridge";
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

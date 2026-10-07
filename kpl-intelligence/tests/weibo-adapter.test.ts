import assert from "node:assert/strict";
import { test } from "node:test";
import type { SourceRow } from "@aihot/backend/sources/types";
import {
  WeiboAdapter,
  cleanWeiboText,
  extractWeiboHeadline,
  parseWeiboDate,
  type WeiboRawMblog,
} from "@aihot/backend/sources/adapters/weibo";
import { findAdapter } from "@aihot/backend/sources/adapters/index";
import { evaluateSocialPost } from "@aihot/backend/editorial/social-analyzer";

// 真实微博返回的 mock 数据（KPL 官方轮换动态）
const mockKplMblog: WeiboRawMblog = {
  id: "5351410289083191",
  bid: "RlzpOC6X5",
  created_at: "Wed Oct 07 15:26:20 +0800 2026",
  text: '【@KSG王者荣耀分部 大师轮换】<a href="/k/KSG对战TES">#KSG对战TES#</a> <a href="/k/2026KPL年度总决赛">#2026KPL年度总决赛#</a> 擂台赛KSG对战长沙TES.A的第三局比赛中，KSG进行发育路、游走位置的轮换，@KSG小屿 替换上场。',
  user: {
    id: 6074356560,
    screen_name: "KPL王者荣耀职业联赛",
    avatar_hd: "https://tvax1.sinaimg.cn/avatar_kpl.jpg",
    followers_count: 9022000,
    verified: true,
  },
  attitudes_count: 55,
  comments_count: 11,
  reposts_count: 6,
  pics: [
    {
      pid: "pic_01",
      url: "https://wx1.sinaimg.cn/thumbnail/pic_01.jpg",
      large: { url: "https://wx1.sinaimg.cn/large/pic_01.jpg", width: 1080, height: 1920 },
    },
  ],
};

// 带有转发原帖引用的 mock 数据（成都AG超玩会转发）
const mockAgRetweetMblog: WeiboRawMblog = {
  id: "5351410289089999",
  bid: "RjafBuXVB",
  created_at: "20分钟前",
  text: "全力以赴新的赛程！心怀荣耀，勇往直前！//@KPL王者荣耀职业联赛:#2026KPL年总赛程# 擂台赛今日打响",
  user: {
    id: 5878848794,
    screen_name: "成都AG超玩会",
    avatar_hd: "https://tvax1.sinaimg.cn/avatar_ag.jpg",
    followers_count: 5765000,
    verified: true,
  },
  attitudes_count: 20873,
  comments_count: 1939,
  reposts_count: 656,
  retweeted_status: {
    id: "5351410289081111",
    bid: "Rj0wCf6fO",
    created_at: "Wed Oct 07 14:00:00 +0800 2026",
    text: "#2026KPL年总赛程# 广州，新的赛事起点！心怀荣耀，勇往直前！",
    user: {
      id: 6074356560,
      screen_name: "KPL王者荣耀职业联赛",
    },
  },
};

const mockWeiboSource: SourceRow = {
  id: "weibo-kpl-official",
  name: "KPL王者荣耀职业联赛（官博）",
  kind: "weibo",
  config: {
    uid: "6074356560",
    platform: "weibo",
    owner_entity_id: "kpl",
    owner_type: "league",
  },
  tier: "T1",
  owner_type: "league",
  owner_entity_id: "kpl",
  participation_mode: "editorial",
  first_party: true,
  interval_minutes: 30,
  enabled: true,
  cursor: null,
  fail_count: 0,
};

const mockAgSource: SourceRow = {
  id: "weibo-ag-club",
  name: "成都AG超玩会（官方微博）",
  kind: "weibo",
  config: {
    uid: "5878848794",
    platform: "weibo",
    owner_entity_id: "ag",
    owner_type: "club",
  },
  tier: "T1_5",
  owner_type: "club",
  owner_entity_id: "ag",
  participation_mode: "editorial",
  first_party: true,
  interval_minutes: 30,
  enabled: true,
  cursor: null,
  fail_count: 0,
};

test("WeiboAdapter 注册与支持检测", () => {
  const adapter = findAdapter(mockWeiboSource);
  assert.ok(adapter, "WeiboAdapter 必须已自动注册到全局注册表");
  assert.equal(adapter.kind, "weibo");
  assert.equal(adapter.supports(mockWeiboSource), true);
  assert.equal(adapter.supports(mockAgSource), true);
});

test("parse(): 官方微博字段解析 (标题/正文/链接/配图)", () => {
  const adapter = new WeiboAdapter();
  const candidate = adapter.parse(mockKplMblog, mockWeiboSource);

  assert.ok(candidate);
  assert.equal(candidate.url, "https://weibo.com/6074356560/RlzpOC6X5");
  assert.equal(candidate.author, "KPL王者荣耀职业联赛");
  assert.equal(candidate.title, "KSG对战TES", "必须优先提取第一个有意义的话题作为标题");
  assert.ok(candidate.bodyText?.includes("KSG进行发育路、游走位置的轮换"));
  assert.equal(candidate.media?.length, 1);
  assert.equal(candidate.media?.[0]?.url, "https://wx1.sinaimg.cn/large/pic_01.jpg", "大图优先");
});

test("normalize(): 转换为高保真 CanonicalContent (social_post)", () => {
  const adapter = new WeiboAdapter();
  const candidate = adapter.parse(mockAgRetweetMblog, mockAgSource)!;
  const material = adapter.normalize(candidate, mockAgRetweetMblog, mockAgSource);

  assert.ok(material.canonical);
  const canonical = material.canonical;
  assert.equal(canonical.kind, "social_post");
  assert.equal(canonical.author?.name, "成都AG超玩会");
  assert.equal(canonical.author?.profileUrl, "https://weibo.com/u/5878848794");
  assert.equal(canonical.social?.postText, candidate.bodyText);

  // 验证转发引用原帖
  assert.ok(canonical.social?.quoted, "必须提取转发的原博引用");
  assert.equal(canonical.social.quoted.author, "KPL王者荣耀职业联赛");
  assert.ok(canonical.social.quoted.text.includes("广州，新的赛事起点"));

  // 验证互动量数据
  assert.equal(canonical.engagement?.likes, 20873);
  assert.equal(canonical.engagement?.comments, 1939);
  assert.equal(canonical.engagement?.shares, 656);
});

test("extractEntities(): 战队主体绑定与文本话题提及提取", () => {
  const adapter = new WeiboAdapter();
  const candidate = adapter.parse(mockAgRetweetMblog, mockAgSource)!;
  const hints = adapter.extractEntities(candidate, mockAgRetweetMblog, mockAgSource);

  assert.ok(hints.length >= 1);
  const teamHint = hints.find((h) => h.entityType === "team" && h.entityId === "ag");
  assert.ok(teamHint, "必须识别出成都AG超玩会所属俱乐部实体");
  assert.equal(teamHint?.confidence, 1.0);
});

test("parseWeiboDate(): 多种时间格式精准解析（不依赖服务器本地时区）", () => {
  const baseTime = new Date("2026-10-07T12:00:00.000Z"); // 北京时间 20:00

  // 1. 标准时间 "Wed Oct 07 15:26:20 +0800 2026" → UTC 07:26:20
  const d1 = parseWeiboDate("Wed Oct 07 15:26:20 +0800 2026", baseTime);
  assert.ok(d1);
  assert.equal(d1.toISOString(), "2026-10-07T07:26:20.000Z");

  // 2. 刚刚
  const d2 = parseWeiboDate("刚刚", baseTime);
  assert.equal(d2?.getTime(), baseTime.getTime());

  // 3. 15分钟前
  const d3 = parseWeiboDate("15分钟前", baseTime);
  assert.equal(d3?.getTime(), baseTime.getTime() - 15 * 60 * 1000);

  // 4. 2小时前
  const d4 = parseWeiboDate("2小时前", baseTime);
  assert.equal(d4?.getTime(), baseTime.getTime() - 2 * 3600 * 1000);

  // 5. 今天/昨天 按 +08:00
  assert.equal(parseWeiboDate("今天 09:30", baseTime)?.toISOString(), "2026-10-07T01:30:00.000Z");
  assert.equal(parseWeiboDate("昨天 23:59", baseTime)?.toISOString(), "2026-10-06T15:59:00.000Z");

  // 6. MM-DD（当年）按 +08:00
  assert.equal(parseWeiboDate("09-30 08:00", baseTime)?.toISOString(), "2026-09-30T00:00:00.000Z");

  // 7. 空/非法日期 → null（绝不能变成当前时间）
  assert.equal(parseWeiboDate("", baseTime), null);
  assert.equal(parseWeiboDate("不是日期", baseTime), null);
});

test("parseWeiboDate(): MM-DD 跨年落到去年，不产生未来时间", () => {
  const now = new Date("2027-01-02T00:00:00.000Z"); // 北京时间 2027-01-02 08:00
  const d = parseWeiboDate("12-31 08:00", now);
  assert.ok(d);
  assert.equal(d.toISOString(), "2026-12-31T00:00:00.000Z");
  assert.ok(d.getTime() < now.getTime(), "跨年日期不得解析为未来发布时间");
});

test("parse/normalize: 空日期保持未知；长微博如实标记为部分内容", () => {
  const adapter = new WeiboAdapter();

  const noDate = adapter.parse({ ...mockKplMblog, created_at: "" }, mockWeiboSource)!;
  assert.equal(noDate.publishedAt, null, "无法解析的发布时间必须保持 null，不能用抓取时间伪造");

  const longRaw: WeiboRawMblog = { ...mockKplMblog, isLongText: true };
  const longCandidate = adapter.parse(longRaw, mockWeiboSource)!;
  const longMaterial = adapter.normalize(longCandidate, longRaw, mockWeiboSource);
  assert.equal(longMaterial.canonical?.quality.completeness, "partial", "长文未补全文时必须标记 partial");
  assert.ok(longMaterial.canonical?.quality.warnings.includes("long_text_truncated"));
  assert.ok(longMaterial.bodyText, "仍保留已取得的短内容");

  const shortMaterial = adapter.normalize(adapter.parse(mockKplMblog, mockWeiboSource)!, mockKplMblog, mockWeiboSource);
  assert.equal(shortMaterial.canonical?.quality.completeness, "full", "短微博标记为完整");
});

test("extractEntities(): 只绑定有效的账号主体，不再做硬编码话题关键词映射", () => {
  const adapter = new WeiboAdapter();
  // 正文提到别的战队，也不能在适配器层产生硬编码提及。
  const raw: WeiboRawMblog = { ...mockKplMblog, text: "#重庆狼队# 今天打得好，AG未来可期" };
  const candidate = adapter.parse(raw, mockWeiboSource)!;
  const hints = adapter.extractEntities(candidate, raw, mockWeiboSource);
  assert.deepEqual(hints, [], "联盟号没有战队主体，正文提及交给 kb/entity-mentions");
  const agHints = adapter.extractEntities(adapter.parse(mockAgRetweetMblog, mockAgSource)!, mockAgRetweetMblog, mockAgSource);
  assert.ok(agHints.some((h) => h.entityType === "team" && h.entityId === "ag"), "俱乐部号绑定其真实实体 id");
});

test("cleanWeiboText(): 彻底消除 '... 全文'、'……全文' 与末尾截断残留", () => {
  // 1. 用户给出的真实案例（纯文本末尾带有 '... 全文'）
  const userCase = "#流星曹操四连超凡# #2026KPL年度总决赛# 擂台赛W1D6 #WB对战EDGM# 【北京WB 1:1 上海EDG.M】 @上海EDGM王者荣耀分部 拿下第二局比赛！ MVP为 @上海EDGM流星 (李星)曹操！ 2分钟，上海EDG.M持续拉扯击杀对面三人。5分钟，上海EDG.M越塔集火击杀女娲。8分钟，双方在野区爆发团战，上海EDG.M完成团战 ... 全文";
  const cleanedUser = cleanWeiboText(userCase);

  assert.ok(!cleanedUser.includes("全文"), "清洗后绝不能带有 '全文'");
  assert.ok(!cleanedUser.endsWith("..."), "清洗后绝不能带有末尾悬空省略号");
  assert.ok(cleanedUser.endsWith("上海EDG.M完成团战"), "正文主干必须完整保留到最后一个字");

  // 2. HTML 带有链接形式的全文
  const htmlCase = '战队今天在比赛中发挥出色！<a href="/status/123456">...全文</a>';
  assert.equal(cleanWeiboText(htmlCase), "战队今天在比赛中发挥出色！");

  // 3. 中文省略号与变体形式
  const dotCase = "选手赛后采访透露了新赛季的战术调整……展开全文";
  assert.equal(cleanWeiboText(dotCase), "选手赛后采访透露了新赛季的战术调整");
});

test("evaluateSocialPost(): 官方赛程轮换动态 vs 粉丝玩梗/抽奖噪声评估", () => {
  const adapter = new WeiboAdapter();

  // 1. 官方轮换动态 -> 高价值，允许进入 RAG 知识库
  const officialCandidate = adapter.parse(mockKplMblog, mockWeiboSource)!;
  const officialMaterial = adapter.normalize(officialCandidate, mockKplMblog, mockWeiboSource);
  const evalOfficial = evaluateSocialPost(officialMaterial, mockWeiboSource);

  assert.ok(evalOfficial.totalScore >= 75, `官方赛事轮换打分应 >= 75，实际: ${evalOfficial.totalScore}`);
  assert.equal(evalOfficial.allowRAG, true, "高价值官方赛事动态必须允许进入 RAG 知识库");
  assert.equal(evalOfficial.allowHotEvent, true, "必须允许参与事件热度");

  // 2. 粉丝抽奖/纯口水噪声 -> 触发噪声扣分，严禁切入 RAG 知识库
  const spamMblog: WeiboRawMblog = {
    id: "999999",
    bid: "Spam123",
    created_at: "刚刚",
    text: "转评赞抽10位小伙伴送出100Q币！包邮送福利红包，快来超话打榜控评！",
    user: { id: 123456, screen_name: "电竞抽奖君" },
    attitudes_count: 5,
    comments_count: 2,
    reposts_count: 1,
  };
  const spamSource: SourceRow = {
    ...mockWeiboSource,
    tier: "T2",
    owner_type: "community",
  };
  const spamCandidate = adapter.parse(spamMblog, spamSource)!;
  const spamMaterial = adapter.normalize(spamCandidate, spamMblog, spamSource);
  const evalSpam = evaluateSocialPost(spamMaterial, spamSource);

  assert.ok(evalSpam.breakdown.noise_penalty >= 35, "抽奖控评博文必须触发噪声惩罚");
  assert.equal(evalSpam.allowRAG, false, "低质玩梗/抽奖博文严禁进入 RAG 向量库");
  assert.ok(evalSpam.grade === "low" || evalSpam.grade === "block");
});

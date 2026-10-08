// mixFeed 纯函数单测：配比、去重、桶空回填、游标分页。无 DB 依赖（node --test 可直接跑）。
import assert from "node:assert/strict";
import test from "node:test";
import { mixFeed, bucketOf, type FeedRatios, type MixItem } from "@aihot/backend/publication/homefeed";

const RATIOS: FeedRatios = { dispute: 0.5, other: 0.2, opinion: 0.15, fun: 0.15 };

function item(key: string, storyKey: string | null, bucket: MixItem["bucket"], priority: number): MixItem {
  return { key, storyKey, bucket, priority };
}

function countBy(out: MixItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of out) counts[m.bucket] = (counts[m.bucket] ?? 0) + 1;
  return counts;
}

test("桶充足时配比大致符合软目标", () => {
  const hot: MixItem[] = [];
  const mk = (bucket: MixItem["bucket"], n: number, prefix: string) => {
    for (let i = 0; i < n; i++) hot.push(item(`${prefix}-${bucket}-${i}`, `s-${prefix}-${bucket}-${i}`, bucket, 1000 - i));
  };
  mk("dispute", 20, "h");
  mk("other", 8, "h");
  mk("opinion", 6, "h");
  mk("fun", 6, "h");
  const out = mixFeed(hot, [], RATIOS);
  assert.equal(out.length, 40);
  const c = countBy(out);
  // 软目标：每桶偏差不超过总数的 10%。
  assert.ok(Math.abs((c.dispute ?? 0) / 40 - 0.5) <= 0.1, JSON.stringify(c));
  assert.ok(Math.abs((c.other ?? 0) / 40 - 0.2) <= 0.1, JSON.stringify(c));
  assert.ok(Math.abs((c.opinion ?? 0) / 40 - 0.15) <= 0.1, JSON.stringify(c));
  assert.ok(Math.abs((c.fun ?? 0) / 40 - 0.15) <= 0.1, JSON.stringify(c));
});

test("热榜已覆盖的 story 在时间线部分跳过，且 key 不重复", () => {
  const hot = [item("hot:1", "story:1", "dispute", 100), item("hot:2", "story:2", "fun", 90)];
  const timeline = [
    item("tl:a", "story:1", "dispute", 1e9), // 同一 story：应被跳过
    item("tl:b", "story:3", "other", 1e9),
    item("tl:b", "story:3", "other", 1e9), // 重复 key：应去重
    item("tl:c", null, "other", 1e8),
  ];
  const out = mixFeed(hot, timeline, RATIOS);
  const keys = out.map((m) => m.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(!keys.includes("tl:a"), "热榜覆盖的 story 不应在时间线重复出现");
  assert.equal(keys.filter((k) => k === "tl:b").length, 1);
});

test("桶空时按其余桶回填，不硬凑", () => {
  const hot = [item("hot:1", "story:1", "dispute", 100), item("hot:2", "story:2", "dispute", 90)];
  const out = mixFeed(hot, [], RATIOS);
  assert.equal(out.length, 2);
  assert.ok(out.every((m) => m.bucket === "dispute"));
});

test("时间线回填：热榜不足时用时间线补齐", () => {
  const hot = [item("hot:1", "story:1", "dispute", 100)];
  const timeline = [
    item("tl:1", "story:2", "dispute", 3e9),
    item("tl:2", "story:3", "other", 2e9),
    item("tl:3", "story:4", "opinion", 1e9),
  ];
  const out = mixFeed(hot, timeline, RATIOS);
  assert.equal(out.length, 4);
  const keys = out.map((m) => m.key);
  assert.ok(keys.includes("hot:1") && keys.includes("tl:1"));
});

test("游标分页：切片无重复、拼接还原全序列", () => {
  const hot: MixItem[] = [];
  for (let i = 0; i < 30; i++) {
    const buckets = ["dispute", "other", "opinion", "fun"] as const;
    hot.push(item(`hot:${i}`, `story:${i}`, buckets[i % 4], 1000 - i));
  }
  const seq = mixFeed(hot, [], RATIOS);
  const page1 = seq.slice(0, 10);
  const page2 = seq.slice(10, 20);
  const page3 = seq.slice(20, 30);
  const all = [...page1, ...page2, ...page3].map((m) => m.key);
  assert.equal(new Set(all).size, all.length, "分页之间不应重复");
  assert.deepEqual(all, seq.map((m) => m.key), "拼接应还原全序列");
});

test("热榜为空时全部由时间线构成，按时间优先", () => {
  const timeline = [
    item("tl:old", "story:1", "other", 1e8),
    item("tl:new", "story:2", "other", 3e9),
  ];
  const out = mixFeed([], timeline, RATIOS);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.key, "tl:new");
});

test("非法配比（全 0）回退到默认配比，不抛错", () => {
  const hot = [item("hot:1", "story:1", "dispute", 100)];
  const out = mixFeed(hot, [], { dispute: 0, other: 0, opinion: 0, fun: 0 });
  assert.equal(out.length, 1);
});

// ── 合成数据端到端（无 DB）：素材 → 分类 → 混排 → 分页 ──────────────────────────────
// 模拟 P3 产出（stories.topic_kind）与热榜/时间线输入，验证整条链路的纯函数部分。
test("合成链路：争议故事进 dispute 桶并优先展示", () => {
  // 素材：5 个故事（topicKind 来自 P3 争议抽取，category 来自模型打标）
  const stories = [
    { id: "s1", topicKind: "dispute" as const, category: "match-result", heat: 900 },
    { id: "s5", topicKind: "dispute" as const, category: "roster", heat: 800 },
    { id: "s2", topicKind: "general" as const, category: "opinion", heat: 100 },
    { id: "s3", topicKind: "fun" as const, category: "match-result", heat: 300 },
    { id: "s4", topicKind: "general" as const, category: "match-result", heat: 200 },
  ];
  // 分类
  assert.equal(bucketOf("dispute", "match-result"), "dispute");
  assert.equal(bucketOf("fun", "match-result"), "fun");
  assert.equal(bucketOf("general", "opinion"), "opinion");
  assert.equal(bucketOf("general", "tactics"), "opinion");
  assert.equal(bucketOf("general", "match-result"), "other");
  assert.equal(bucketOf("general", null), "other");
  // 混排：热榜全部上榜，时间线为空
  const hot = stories.map((s, i) => item(`hot:${i}`, `story:${s.id}`, bucketOf(s.topicKind, s.category), s.heat));
  const out = mixFeed(hot, [], RATIOS);
  assert.equal(out.length, 5);
  // dispute 桶的两个故事都在输出里，且热度最高的排在最前
  const disputes = out.filter((m) => m.bucket === "dispute");
  assert.equal(disputes.length, 2);
  assert.equal(out[0]!.key, "hot:0");
  // 分页：offset 游标切片无重复
  const page1 = out.slice(0, 3).map((m) => m.key);
  const page2 = out.slice(3, 5).map((m) => m.key);
  assert.equal(new Set([...page1, ...page2]).size, 5);
});

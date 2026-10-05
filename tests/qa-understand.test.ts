// QA 意图理解（阶段 4.2）：三种模型输出形态（合法 JSON / markdown 包裹 / 纯文本垃圾）下的行为。
// 模型协议走本地 stub，不触网；receipts 落在每个测试文件独立的数据库副本上。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { understandQuestion } from "@aihot/backend/qa/understand";
import { stub } from "./setup.ts";
import { config } from "@aihot/backend/config";

let nextContent = "";
let closeServer: (() => Promise<void>) | null = null;

before(async () => {
  // 模型协议替身跑在本机回环地址上，测试里放开私有网络阀（与 esports-sync 同款先例）
  config.allowPrivateNetworkFetch = true;
  const server = await stub((_hit, _req) => ({
    choices: [{ message: { content: nextContent }, finish_reason: "stop" }],
    usage: { total_tokens: 10 },
  }));
  process.env.LLM_BASE_URL = `${server.url}/v1`;
  process.env.LLM_API_KEY ??= "test-key";
  process.env.LLM_MODEL ??= "test-model";
  // 注意：after 不能注册在 before 回调里（会被提前触发、关掉 stub）
  closeServer = () => server.close();
});

after(async () => {
  if (closeServer) await closeServer();
  await stopBoss();
  await closeDb();
});

test("合法 JSON 输出：解析出意图与实体", async () => {
  nextContent = JSON.stringify({
    intent: "h2h",
    entities: [
      { kind: "team", name: "成都AG超玩会" },
      { kind: "team", name: "重庆狼队" },
    ],
    season: "2026-summer",
    keywords: ["成都AG超玩会", "重庆狼队", "交手"],
  });
  const r = await understandQuestion("成都AG超玩会和重庆狼队2026夏季赛交手记录怎么样");
  assert.equal(r.degraded, false);
  assert.equal(r.intent, "h2h");
  assert.equal(r.entities.length, 2);
  assert.equal(r.entities[0]!.name, "成都AG超玩会");
  assert.equal(r.season, "2026-summer");
  assert.ok(r.receiptId != null);
});

test("markdown 代码块包裹的 JSON：照常解析，缺失字段兜底", async () => {
  nextContent = "```json\n" + JSON.stringify({ intent: "match-result", season: null }) + "\n```";
  const r = await understandQuestion("2026年夏季赛总决赛的比分是多少");
  assert.equal(r.degraded, false);
  assert.equal(r.intent, "match-result");
  assert.deepEqual(r.entities, []);
  assert.deepEqual(r.keywords, []);
});

test("纯文本垃圾输出：降级为开放问答，不抛异常", async () => {
  nextContent = "抱歉，我无法按要求输出。这是一段完全不是 JSON 的自由文本。";
  const r = await understandQuestion("2026年KPL夏季赛哪个队伍表现最好");
  assert.equal(r.degraded, true);
  assert.equal(r.intent, "open");
  assert.equal(r.receiptId, null);
  assert.deepEqual(r.entities, []);
  assert.ok(r.keywords.length >= 1, "降级时保留原问句作为关键词");
});

test("空白问题：直接降级，不调用模型", async () => {
  nextContent = JSON.stringify({ intent: "roster" });
  const r = await understandQuestion("    ");
  assert.equal(r.degraded, true);
  assert.equal(r.intent, "open");
  assert.deepEqual(r.keywords, []);
});

// QA 回答生成 + 护栏（阶段 4.4）：grounded 校验（编造数字）、张冠李戴、引用缺失重试与降级路径。
// 模型协议走本地 stub，按调用次序返回预设脚本。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { generateAnswer } from "@aihot/backend/qa/answer";
import type { QaMaterialInput } from "@aihot/backend/qa/answer";
import { stub } from "./setup.ts";

const MATERIAL: QaMaterialInput = {
  dataCards: [{ kind: "match-result", title: "测试赛果卡", lines: ["2026-02-01 成都AG超玩会 3 : 1 重庆狼队（常规赛）"] }],
  passages: [{ sourceType: "team", refId: "tag-ag", ord: 0, title: "成都AG超玩会", content: "成都AG超玩会是KPL职业联赛战队，主场位于成都。", score: 0.016 }],
};

const AG_ONLY_MATERIAL: QaMaterialInput = {
  dataCards: [{ kind: "match-result", title: "测试赛果卡", lines: ["成都AG超玩会 3 : 1 获胜"] }],
  passages: [],
};

let script: string[] = [];
let hits = 0;
let closeServer: (() => Promise<void>) | null = null;

before(async () => {
  config.allowPrivateNetworkFetch = true;
  const server = await stub((_hit, _req) => {
    hits += 1;
    const content = script.length > 0 ? script.shift()! : JSON.stringify({ answer: "无话可说", citations: [1] });
    return { choices: [{ message: { content }, finish_reason: "stop" }] };
  });
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

test("正确回答：通过校验，引用与内容原样返回", async () => {
  script = [JSON.stringify({ answer: "成都AG超玩会以 3 : 1 战胜了重庆狼队 [来源1]。", citations: [1] })];
  hits = 0;
  const r = await generateAnswer("成都AG超玩会那场比赛结果如何", MATERIAL);
  assert.equal(r.degraded, false);
  assert.equal(hits, 1);
  assert.deepEqual(r.citations, [1]);
  assert.match(r.answer, /3 : 1/);
  assert.ok(r.receiptId != null);
});

test("编造比分：触发重试，第二次合法则通过", async () => {
  script = [
    JSON.stringify({ answer: "成都AG超玩会 99 : 0 大胜对手 [来源1]。", citations: [1] }),
    JSON.stringify({ answer: "成都AG超玩会 3 : 1 获胜 [来源1]。", citations: [1] }),
  ];
  hits = 0;
  const r = await generateAnswer("比分是多少", MATERIAL);
  assert.equal(r.degraded, false);
  assert.equal(hits, 2, "应恰好调用两次模型（首次编造 + 重试）");
  assert.match(r.answer, /3 : 1/);
});

test("两次编造：降级为只输出数据卡片 + 抱歉文案", async () => {
  script = [
    JSON.stringify({ answer: "净胜 88 分 [来源1]。", citations: [1] }),
    JSON.stringify({ answer: "净胜 99 分 [来源1]。", citations: [1] }),
  ];
  hits = 0;
  const r = await generateAnswer("净胜分是多少", MATERIAL);
  assert.equal(r.degraded, true);
  assert.ok(r.answer.includes("数据卡片") === false, "降级不依赖模型文案");
  assert.match(r.answer, /2026-02-01 成都AG超玩会 3 : 1 重庆狼队/);
  assert.match(r.answer, /抱歉/);
  assert.deepEqual(r.citations, []);
});

test("张冠李戴：回答出现材料中没有的战队 → 重试后仍出现则降级", async () => {
  script = [
    JSON.stringify({ answer: "重庆狼队 3 : 1 获胜 [来源1]。", citations: [1] }),
    JSON.stringify({ answer: "武汉eStarPro 3 : 1 获胜 [来源1]。", citations: [1] }),
  ];
  hits = 0;
  const r = await generateAnswer("谁赢了", AG_ONLY_MATERIAL);
  assert.equal(r.degraded, true);
  assert.equal(hits, 2);
  assert.match(r.answer, /3 : 1 获胜/);
});

test("引用缺失：首次无 citations 触发重试，第二次给出则通过", async () => {
  script = [
    JSON.stringify({ answer: "成都AG超玩会 3 : 1 获胜。", citations: [] }),
    JSON.stringify({ answer: "成都AG超玩会 3 : 1 获胜 [来源1]。", citations: [1] }),
  ];
  hits = 0;
  const r = await generateAnswer("结果如何", MATERIAL);
  assert.equal(r.degraded, false);
  assert.equal(hits, 2);
  assert.deepEqual(r.citations, [1]);
});

test("空材料：不调用模型，直接降级", async () => {
  script = [];
  hits = 0;
  const r = await generateAnswer("随便问问", { dataCards: [], passages: [] });
  assert.equal(r.degraded, true);
  assert.equal(hits, 0);
  assert.match(r.answer, /资料不足/);
});

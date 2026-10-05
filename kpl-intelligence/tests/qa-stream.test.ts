// QA 流式编排（阶段 4.5）：SSE 事件序列、缓存回放（不再调模型）与限流（第 21 次拒绝）。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { rebuildTeamChunks } from "@aihot/backend/kb/chunks";
import { ensureTeam } from "@aihot/backend/kb/upsert";
import { consumeRateLimit, qaStreamEvents } from "@aihot/backend/qa/stream";
import { embeddingsStub, stub } from "./setup.ts";

let hits = 0;
let closeServer: (() => Promise<void>) | null = null;
let embeddings: Awaited<ReturnType<typeof embeddingsStub>>;

before(async () => {
  config.allowPrivateNetworkFetch = true;
  embeddings = await embeddingsStub();
  const server = await stub((_hit, req) => {
    hits += 1;
    // 同一 stub 服务两种能力：按系统提示词区分（意图理解 / 回答生成）
    const body = JSON.parse(req.body) as { messages?: Array<{ content?: string }> };
    const system = String(body.messages?.[0]?.content ?? "");
    const content = system.includes("意图理解")
      ? JSON.stringify({ intent: "open", entities: [{ kind: "team", name: "成都AG超玩会" }], season: null, keywords: ["成都AG超玩会"] })
      : JSON.stringify({ answer: "成都AG超玩会是KPL职业联赛战队 [来源1]。", citations: [1] });
    return { choices: [{ message: { content }, finish_reason: "stop" }] };
  });
  process.env.LLM_BASE_URL = `${server.url}/v1`;
  process.env.LLM_API_KEY ??= "test-key";
  process.env.LLM_MODEL ??= "test-model";
  closeServer = () => server.close();

  const team = await ensureTeam(sql, { externalId: "921", name: "成都AG超玩会", shortName: "AG" });
  await rebuildTeamChunks(team);
});

after(async () => {
  if (embeddings) await embeddings.close();
  if (closeServer) await closeServer();
  await stopBoss();
  await closeDb();
});

test("事件序列：meta → delta → citation → done", async () => {
  hits = 0;
  const events = await qaStreamEvents("成都AG超玩会战队资料", "10.1.1.1");
  assert.deepEqual(events.map((e) => e.event), ["meta", "delta", "citation", "done"]);
  const meta = events[0]!.data as { dataCards: unknown[] };
  assert.ok(Array.isArray(meta.dataCards));
  const delta = events[1]!.data as { text: string };
  assert.match(delta.text, /成都AG超玩会/);
  const citation = events[2]!.data as { citations: number[]; sources: string[] };
  assert.deepEqual(citation.citations, [1]);
  assert.ok(citation.sources.length >= 1);
  assert.equal((events[3]!.data as { status: string }).status, "ok");
  assert.equal(hits, 2, "应调用两次模型（意图理解 + 回答生成）");
});

test("缓存回放：24h 内相同问题直接回放，不再调用模型", async () => {
  const hitsBefore = hits;
  const events = await qaStreamEvents("成都AG超玩会战队资料", "10.1.1.2");
  assert.equal((events[0]!.data as { cached: boolean }).cached, true);
  assert.match((events[1]!.data as { text: string }).text, /成都AG超玩会/);
  assert.equal(hits, hitsBefore, "缓存命中时不得再调模型");
  assert.equal((events[3]!.data as { cached: boolean }).cached, true);
});

test("限流：每日第 21 次起拒绝，返回 429 + error 事件", async () => {
  const ip = "10.9.9.9";
  for (let i = 0; i < 20; i++) {
    assert.equal(await consumeRateLimit(ip), true, `第 ${i + 1} 次应放行`);
  }
  assert.equal(await consumeRateLimit(ip), false, "第 21 次应拒绝");
  const events = await qaStreamEvents("成都AG超玩会资料", ip);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.event, "error");
  assert.equal(events[0]!.status, 429);
});

test("空问题：400 + error 事件", async () => {
  const events = await qaStreamEvents("   ", "10.1.1.3");
  assert.equal(events[0]!.event, "error");
  assert.equal(events[0]!.status, 400);
});

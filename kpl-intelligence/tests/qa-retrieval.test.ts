// QA 三通道检索 + RRF 融合（阶段 4.3）：已知 fixture 下的通道命中、融合去重与空通道容错。
// 意图对象按 understand.ts 的输出手工构造（通道边界是纯函数式输入）。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { rebuildTeamChunks } from "@aihot/backend/kb/chunks";
import { ensurePlayer, ensureSeason, ensureTeam, upsertMatch } from "@aihot/backend/kb/upsert";
import { retrieveMaterial } from "@aihot/backend/qa/retrieval";
import type { UnderstandResult } from "@aihot/backend/qa/understand";
import { embeddingsStub } from "./setup.ts";

const LEAGUE = "20990002";
let agId = "";
let wolvesId = "";
let matchId = "";
let embeddings: Awaited<ReturnType<typeof embeddingsStub>>;

function intent(partial: Partial<UnderstandResult>): UnderstandResult {
  return { intent: "open", entities: [], season: null, keywords: [], receiptId: null, degraded: false, ...partial };
}

before(async () => {
  embeddings = await embeddingsStub();
  const teamA = await ensureTeam(sql, { externalId: "911", name: "成都AG超玩会", shortName: "AG" });
  const teamB = await ensureTeam(sql, { externalId: "912", name: "重庆狼队", shortName: "Wolves" });
  agId = teamA;
  wolvesId = teamB;
  await ensurePlayer(sql, { actualName: "成都AG超玩会.测试一诺", teamId: teamA, seenAt: null });
  const seasonId = await ensureSeason(sql, LEAGUE);
  const match = await upsertMatch(sql, {
    leagueId: LEAGUE,
    matchId: "9911",
    seasonId,
    bo: 5,
    status: "finished",
    teamAId: teamA,
    teamBId: teamB,
    scoreA: 3,
    scoreB: 1,
    winnerId: teamA,
    scheduledAt: new Date("2099-02-01T06:00:00Z"),
    playedAt: new Date("2099-02-01T08:00:00Z"),
  });
  matchId = match.id;
  // 战队档案 chunks（带 embedding，语义通道与关键词通道的命中素材）
  await rebuildTeamChunks(teamA);
  await rebuildTeamChunks(teamB);
});

after(async () => {
  if (embeddings) await embeddings.close();
  await stopBoss();
  await closeDb();
});

test("结构化通道：h2h 意图产出交手数据卡片", async () => {
  const material = await retrieveMaterial("成都AG超玩会和重庆狼队交手记录", intent({
    intent: "h2h",
    entities: [
      { kind: "team", name: "成都AG超玩会" },
      { kind: "team", name: "重庆狼队" },
    ],
  }));
  assert.equal(material.dataCards.length, 1);
  const card = material.dataCards[0]!;
  assert.equal(card.kind, "h2h");
  assert.match(card.title, /成都AG超玩会 vs 重庆狼队/);
  assert.ok(card.lines.some((l) => l.includes("大场交手 1 场")), JSON.stringify(card.lines));
  assert.ok(card.lines.some((l) => l.includes("3 : 1")), JSON.stringify(card.lines));
});

test("结构化通道：match-result 意图产出赛果卡片", async () => {
  const material = await retrieveMaterial("成都AG超玩会最近比赛结果", intent({
    intent: "match-result",
    entities: [{ kind: "team", name: "成都AG超玩会" }],
  }));
  const card = material.dataCards.find((c) => c.kind === "match-result");
  assert.ok(card, "应有赛果卡片");
  assert.ok(card.lines.some((l) => l.includes("3 : 1")), JSON.stringify(card.lines));
});

test("结构化通道：roster 意图产出阵容卡片", async () => {
  const material = await retrieveMaterial("成都AG超玩会现在有哪些选手", intent({
    intent: "roster",
    entities: [{ kind: "team", name: "成都AG超玩会" }],
  }));
  const card = material.dataCards.find((c) => c.kind === "roster");
  assert.ok(card, "应有阵容卡片");
  assert.ok(card.lines.some((l) => l.includes("测试一诺")), JSON.stringify(card.lines));
});

test("语义+关键词通道：命中战队 chunks 且 RRF 去重", async () => {
  const material = await retrieveMaterial("成都AG超玩会战队资料", intent({
    intent: "open",
    keywords: ["成都AG超玩会", "战队"],
  }));
  assert.ok(material.passages.length >= 1, " passages 应非空");
  const agPassages = material.passages.filter((p) => p.refId === agId);
  assert.equal(agPassages.length, 1, "同一 chunk 双通道命中后应只保留一条（RRF 加分）");
  assert.match(agPassages[0]!.content, /成都AG超玩会/);
  const wolvesPassages = material.passages.filter((p) => p.refId === wolvesId);
  if (wolvesPassages.length > 0) {
    assert.ok(agPassages[0]!.score >= wolvesPassages[0]!.score, "双通道命中的 AG 块分数应不低于单通道的狼队块");
  }
  // 比赛综述 chunk 不该混进"战队资料"检索的高位（宽松断言：存在于 passages 之外或分数更低）
  const matchPassage = material.passages.find((p) => p.refId === matchId);
  if (matchPassage) {
    assert.ok(matchPassage.score <= agPassages[0]!.score);
  }
});

test("空通道容错：open 意图且无实体无关键词时数据卡片为空但不崩", async () => {
  const material = await retrieveMaterial("KPL 赛制介绍", intent({ intent: "open" }));
  assert.deepEqual(material.dataCards, []);
  assert.ok(Array.isArray(material.passages));
});

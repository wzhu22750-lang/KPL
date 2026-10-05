// kb chunks（阶段 4.1）：比赛/实体档案切块入库的幂等、边界与维度校验。embedding 走本地 stub。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import {
  chunkText,
  rebuildEntityChunks,
  rebuildHeroChunks,
  rebuildMatchChunks,
  rebuildPlayerChunks,
  rebuildTeamChunks,
} from "@aihot/backend/kb/chunks";
import { ensureHero, ensurePlayer, ensureSeason, ensureTeam, upsertMatch } from "@aihot/backend/kb/upsert";
import { embeddingsStub } from "./setup.ts";

const LEAGUE = "20990001";
let embeddings: Awaited<ReturnType<typeof embeddingsStub>>;

before(async () => {
  // 本地假 embedding 服务（1024 维确定性向量），先于任何重建调用就绪
  embeddings = await embeddingsStub();
});

after(async () => {
  if (embeddings) await embeddings.close();
  await stopBoss();
  await closeDb();
});

test("chunkText:短文本单块、段落组装受控、超长单段硬切", () => {
  assert.deepEqual(chunkText("一段很短的文本。"), ["一段很短的文本。"]);
  // 每段 60 字左右，目标块 200 字符：多段组装成多块
  const medium = Array.from({ length: 20 }, (_, i) => `第${i}段,${"内容".repeat(30)}`).join("\n\n");
  const blocks = chunkText(medium, 200, 300);
  assert.ok(blocks.length > 1, "应切成多块");
  for (const b of blocks) assert.ok(b.length <= 300, `块超限: ${b.length}`);
  // 单段 500 字（> 硬切阈值 300）→ 按目标大小硬切
  const huge = `${"字".repeat(500)}`;
  const sliced = chunkText(huge, 200, 300);
  assert.equal(sliced.length, 3);
  assert.equal(sliced[0]!.length, 200);
  assert.equal(sliced.join("").length, 500);
  // 空文本 → 无块
  assert.deepEqual(chunkText("  \n\n  "), []);
});

test("比赛综述切块:写入、内容含比分与 MVP、重跑幂等", async () => {
  const seasonId = await ensureSeason(sql, LEAGUE);
  const teamA = await ensureTeam(sql, { externalId: "901", name: "测试A队", shortName: "A" });
  const teamB = await ensureTeam(sql, { externalId: "902", name: "测试B队", shortName: "B" });
  const mvp = await ensurePlayer(sql, { actualName: "测试A队.测试MVP", teamId: teamA, seenAt: null });
  const match = await upsertMatch(sql, {
    leagueId: LEAGUE,
    matchId: "9901",
    seasonId,
    bo: 5,
    status: "finished",
    teamAId: teamA,
    teamBId: teamB,
    scoreA: 3,
    scoreB: 1,
    winnerId: teamA,
    scheduledAt: new Date("2099-01-10T06:00:00Z"),
    playedAt: new Date("2099-01-10T08:44:00Z"),
  });
  for (const no of [1, 2]) {
    await sql`
      INSERT INTO games (id, match_id, game_no, mode, winner_id, duration_secs, mvp_player_id, kills_a, kills_b, source)
      VALUES (${`${match.id}-g${no}`}, ${match.id}, ${no}, 'standard', ${teamA}, ${1100 + no}, ${no === 1 ? mvp : null}, ${12 + no}, ${5}, 'test')`;
  }

  const written = await rebuildMatchChunks(match.id);
  assert.ok(written >= 1, "至少写入一块");
  const rows = await sql<{ content: string }[]>`
    SELECT content FROM chunks WHERE source_type = 'match' AND ref_id = ${match.id} ORDER BY ord`;
  const text = rows.map((r) => r.content).join("\n");
  assert.match(text, /【比赛】/);
  assert.match(text, /测试A队 3 : 1 测试B队/);
  assert.match(text, /MVP 测试MVP/);
  assert.match(text, /第2局/);

  // 幂等：重跑块数不变
  const again = await rebuildMatchChunks(match.id);
  assert.equal(again, written);
  const [count] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM chunks WHERE source_type = 'match' AND ref_id = ${match.id}`;
  assert.equal(count!.n, rows.length);
});

test("战队/选手/英雄档案切块:渲染与实体字段", async () => {
  const teamId = await ensureTeam(sql, { externalId: "903", name: "测试C队", shortName: "C" });
  await sql`UPDATE teams SET city = '杭州', history_names = ${["旧名C队"]}, style_notes = '运营稳健' WHERE id = ${teamId}`;
  await ensurePlayer(sql, { actualName: "测试C队.测试选手", teamId, seenAt: null });
  const heroId = await ensureHero(sql, { heroId: 7001, name: "测试英雄" });
  await sql`UPDATE heroes SET roles = ${["刺客"]}, positions = ${["打野"]}, notes = '切入型打野' WHERE id = ${heroId}`;

  await rebuildTeamChunks(teamId);
  const teamText = (
    await sql<{ content: string }[]>`SELECT content FROM chunks WHERE source_type = 'team' AND ref_id = ${teamId} ORDER BY ord`
  ).map((r) => r.content).join("\n");
  assert.match(teamText, /【战队档案】测试C队/);
  assert.match(teamText, /城市:杭州/);
  assert.match(teamText, /现役阵容:.*测试选手/);

  const [player] = await sql<{ id: string }[]>`SELECT id FROM players WHERE nickname = '测试选手'`;
  await rebuildPlayerChunks(player!.id);
  const playerText = (
    await sql<{ content: string }[]>`SELECT content FROM chunks WHERE source_type = 'player' AND ref_id = ${player!.id} ORDER BY ord`
  ).map((r) => r.content).join("\n");
  assert.match(playerText, /【选手档案】测试选手/);
  assert.match(playerText, /战队:测试C队/);

  await rebuildHeroChunks(heroId);
  const heroText = (
    await sql<{ content: string }[]>`SELECT content FROM chunks WHERE source_type = 'hero' AND ref_id = ${heroId} ORDER BY ord`
  ).map((r) => r.content).join("\n");
  assert.match(heroText, /【英雄档案】测试英雄/);
  assert.match(heroText, /定位:刺客/);
  assert.match(heroText, /特征:切入型打野/);

  // rebuildEntityChunks 统一入口与专用函数等价（幂等重跑）
  const entry = await rebuildEntityChunks("hero", heroId);
  const [count] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM chunks WHERE source_type = 'hero' AND ref_id = ${heroId}`;
  assert.equal(count!.n, entry);
});

test("embedding:全部 chunks 均为 1024 维向量（本地 stub）", async () => {
  const [row] = await sql<{ dims: number; nulls: number; total: number }[]>`
    SELECT coalesce(max(vector_dims(embedding)), 0)::int AS dims,
           count(*) FILTER (WHERE embedding IS NULL)::int AS nulls,
           count(*)::int AS total
    FROM chunks WHERE source_type IN ('match', 'team', 'player', 'hero')`;
  assert.ok(row!.total > 0, "前置测试应已写入 chunks");
  assert.equal(row!.dims, 1024);
  assert.equal(row!.nulls, 0);
});

// 动态战队发现与覆盖率（kb/discover.ts）：活跃战队清单来自官方赛事数据（matches），
// 账号缺口进发现队列且幂等，覆盖率看板的数据与真实行一致。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { computeCoverage, discoverActiveTeams, refreshDiscoveryQueue, seedTeamAccounts } from "@aihot/backend/kb/discover";

const T = tag();
const SEASON = `s-${T}`;
const A = `t-a-${T}`;
const B = `t-b-${T}`;
const C = `t-c-${T}`; // 没有比赛的队：不算活跃

async function team(id: string, name: string) {
  await sql`INSERT INTO teams (id, slug, name, league, is_active) VALUES (${id}, ${id}, ${name}, 'KPL', true)`;
}

async function match(key: string, a: string, b: string, days: number) {
  await sql`INSERT INTO matches (id, season_id, team_a_id, team_b_id, status, scheduled_at, played_at, source, source_key)
            VALUES (${`m-${T}-${key}`}, ${SEASON}, ${a}, ${b}, 'finished', now() - make_interval(days => ${days}),
                    now() - make_interval(days => ${days}), 'smoba', ${`mk-${T}-${key}`})`;
}

before(async () => {
  await sql`INSERT INTO seasons (id, name, year, external_id) VALUES (${SEASON}, ${`测试赛季${T}`}, 2026, ${`L-${T}`})`;
  await team(A, `测试队A${T}`);
  await team(B, `测试队B${T}`);
  await team(C, `测试队C${T}`);
  await match("1", A, B, 3);
  await match("2", B, A, 10);
});
after(async () => {
  await stopBoss();
  await closeDb();
});

test("discoverActiveTeams 从官方赛事数据动态发现战队，不靠硬编码名单", async () => {
  const teams = await discoverActiveTeams(120);
  const ids = teams.map((t) => t.id);
  assert.ok(ids.includes(A), "近期有比赛的队算活跃");
  assert.ok(ids.includes(B));
  assert.ok(!ids.includes(C), "没有比赛的队不算活跃");
  const a = teams.find((t) => t.id === A)!;
  assert.equal(a.name, `测试队A${T}`);
  assert.ok(a.lastMatchAt, "有最近的比赛时间");
});

test("seedTeamAccounts 幂等导入已验证账号档案", async () => {
  const first = await seedTeamAccounts();
  assert.ok(first.added >= 10, "种子文件里的联盟与俱乐部账号都要进来");
  const again = await seedTeamAccounts();
  assert.equal(again.added, 0, "重跑不新增");
  const [row] = await sql<{ official_verified: boolean; entity_type: string }[]>`
    SELECT official_verified, entity_type FROM entity_accounts WHERE entity_id = 'kpl' AND platform = 'bilibili'`;
  assert.ok(row?.official_verified, "导入的账号档案是已验证状态");
});

test("refreshDiscoveryQueue 把活跃战队的平台缺口入队，且重复执行幂等", async () => {
  const first = await refreshDiscoveryQueue();
  assert.equal(first.teams, 2, "两支活跃战队");
  assert.ok(first.queued > 0, "无账号档案的战队产生缺口");
  const again = await refreshDiscoveryQueue();
  assert.equal(again.queued, 0, "第二次执行不再新增");
  const rows = await sql<{ entity_id: string; platform: string; status: string }[]>`
    SELECT entity_id, platform, status FROM source_discovery_queue ORDER BY entity_id, platform`;
  assert.ok(rows.every((r) => r.status === "pending"));
  assert.ok(rows.some((r) => r.entity_id === A && r.platform === "weibo"));
  assert.ok(rows.some((r) => r.entity_id === A && r.platform === "wechat"));
});

test("computeCoverage 报告战队覆盖、first-party 事件率与告警", async () => {
  // 给队 A 建一个已验证账号 + 一个健康且近 30 天有产出的俱乐部信源：它应当算已覆盖。
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, owner_type, owner_entity_id, health, enabled, next_fetch_at)
            VALUES (${`src-a-${T}`}, '队A公众号', 'mp_account', '{}', 'T1_5', 'editorial', 'club', ${A}, 'ok', true, '2100-01-01')`;
  await sql`UPDATE entity_accounts SET source_id = ${`src-a-${T}`} WHERE entity_id = ${A} AND platform = 'wechat'`;
  // 队 B 保持无源：它应当是 missing。
  const cov = await computeCoverage();
  const a = cov.teamCoverage.teams.find((t) => t.id === A)!;
  const b = cov.teamCoverage.teams.find((t) => t.id === B)!;
  assert.equal(a.state, "partial", "健康但零产出的通道不算覆盖（区分停更账号）");
  assert.equal(b.state, "missing", "什么都没有的队算未覆盖");
  assert.ok(cov.warnings.some((w) => w.kind === "source-stale" && w.entity.includes("队A")), "零产出的官方源要告警");
  // 源产生一篇近 30 天文章后，才算真正覆盖。
  const { articleId } = await upsertMaterial({
    sourceId: `src-a-${T}`, url: `https://example.com/${T}/cover`, title: `队A官宣${T}`, bodyText: "内容", bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  assert.ok(articleId);
  const cov1 = await computeCoverage();
  assert.equal(cov1.teamCoverage.teams.find((t) => t.id === A)!.state, "covered", "有产出后算已覆盖");
  assert.ok(cov1.teamCoverage.coverage > 0 && cov1.teamCoverage.coverage < 100);
  assert.ok(cov1.warnings.some((w) => w.kind === "discovery"), "发现队列的缺口是常驻告警");
  assert.ok(Array.isArray(cov1.community));
  // 俱乐部信源失联 > 24h（health failing）触发 coverage warning 并降为部分覆盖。
  await sql`UPDATE sources SET health = 'failing' WHERE id = ${`src-a-${T}`}`;
  const cov2 = await computeCoverage();
  assert.ok(cov2.warnings.some((w) => w.kind === "source-stale" && w.entity.includes("队A")), "俱乐部官方源失败要告警");
  assert.equal(cov2.teamCoverage.teams.find((t) => t.id === A)!.state, "partial", "信源失联后从已覆盖降为部分覆盖");
});

// P1 信源与获取策略：
// ① 调度排序按 priority_weight → tier 权重 → next_fetch_at；
// ② source_boosts 生效时下一次到期按 interval_override 计算、过期后恢复；
// ③ boostSourcesForMatch 只给两队的 weibo 源加频、按 reason 幂等；
// ④ adaptIntervals 跳过 auto_tune=false 的源。
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { adaptIntervals, boostSourcesForMatch, getActiveBoosts, scheduleDueSources } from "@aihot/backend/sources/collect";
import { tag } from "./setup.ts";

const T = tag();
const id = (n: string) => `test-sched-${T}-${n}`;
const IDS = [id("t2-weighted"), id("t1-plain"), id("t15-plain"), id("t2-older"), id("t2-newer")];

async function reset() {
  await sql`DELETE FROM sources WHERE id LIKE ${`test-sched-${T}-%`}`;
  await sql`DELETE FROM pgboss.job WHERE data->>'sourceId' LIKE ${`test-sched-${T}-%`}`;
}

after(async () => {
  await reset();
  await stopBoss();
  await closeDb();
});

test("调度排序：priority_weight 优先，其次 tier 权重（T1=3,T1_5=2,T2=1），最后到期时间", async () => {
  await reset();
  // t2-weighted 虽然是 T2 但权重最高；t1-plain 无权重但 tier 最高；t15 在前；
  // t2-older 与 t2-newer 同权重同 tier，到期早的先。
  await sql`
    INSERT INTO sources (id, name, kind, config, tier, priority_weight, participation_mode, interval_minutes, next_fetch_at)
    VALUES
      (${IDS[0]}, 't2 weighted', 'rss', '{}'::jsonb, 'T2', 10, 'editorial', 60, now() - interval '5 minutes'),
      (${IDS[1]}, 't1 plain', 'rss', '{}'::jsonb, 'T1', 0, 'editorial', 60, now() - interval '4 minutes'),
      (${IDS[2]}, 't1_5 plain', 'rss', '{}'::jsonb, 'T1_5', 0, 'editorial', 60, now() - interval '6 minutes'),
      (${IDS[3]}, 't2 older', 'rss', '{}'::jsonb, 'T2', 0, 'editorial', 60, now() - interval '10 minutes'),
      (${IDS[4]}, 't2 newer', 'rss', '{}'::jsonb, 'T2', 0, 'editorial', 60, now() - interval '1 minute')`;
  await scheduleDueSources();
  // pg-boss 按入队顺序记录 created_on：顺序即调度顺序。
  const jobs = await sql<{ sid: string; created_on: Date }[]>`
    SELECT data->>'sourceId' AS sid, created_on FROM pgboss.job
    WHERE data->>'sourceId' IN ${sql(IDS)} AND created_on > now() - interval '1 minute'
    ORDER BY created_on`;
  assert.deepEqual(jobs.map((j) => j.sid), IDS, "weibo 权重 10 > T1 tier 权重 3 > T1_5 权重 2 > 同 tier 到期早的先");
  // 防重入不变：每个源被重新排到约 10 分钟后（无 boost 时）。
  const rearmed = await sql<{ minutes: number }[]>`
    SELECT round(extract(epoch FROM next_fetch_at - now()) / 60)::int AS minutes FROM sources WHERE id = ${IDS[0]}`;
  assert.ok(Math.abs(rearmed[0]!.minutes - 10) <= 1, "无 boost 时 re-arm 仍是 10 分钟");
});

test("boost 生效时下一次到期按 override 计算，过期后恢复", async () => {
  await reset();
  const sid = id("boosted");
  await sql`
    INSERT INTO sources (id, name, kind, config, tier, priority_weight, owner_entity_id, participation_mode, interval_minutes, next_fetch_at)
    VALUES (${sid}, 'boosted', 'weibo', '{}'::jsonb, 'T1_5', 10, 'ag', 'editorial', 30, now() - interval '1 minute')`;
  await sql`INSERT INTO source_boosts (source_id, reason, interval_override_minutes, starts_at, ends_at)
            VALUES (${sid}, 'test-match', 15, now() - interval '5 minutes', now() + interval '3 hours')`;
  const active = await getActiveBoosts();
  assert.equal(active.get(sid)?.intervalOverrideMinutes, 15);
  await scheduleDueSources();
  const boosted = await sql<{ minutes: number }[]>`
    SELECT round(extract(epoch FROM next_fetch_at - now()) / 60)::int AS minutes FROM sources WHERE id = ${sid}`;
  assert.ok(Math.abs(boosted[0]!.minutes - 15) <= 1, "boost 生效时下一次到期按 override（15 分钟）计算");
  const [afterBoost] = await sql<{ iv: number }[]>`SELECT interval_minutes AS iv FROM sources WHERE id = ${sid}`;
  assert.equal(afterBoost!.iv, 30, "sources.interval_minutes 本身不被改写");
  // boost 过期：下一次调度恢复到默认的 10 分钟 re-arm。
  await sql`UPDATE source_boosts SET ends_at = now() - interval '1 minute' WHERE source_id = ${sid}`;
  assert.ok(!(await getActiveBoosts()).has(sid), "过期的 boost 不再有效");
  await sql`UPDATE sources SET next_fetch_at = now() - interval '1 minute' WHERE id = ${sid}`;
  await scheduleDueSources();
  const expired = await sql<{ minutes: number }[]>`
    SELECT round(extract(epoch FROM next_fetch_at - now()) / 60)::int AS minutes FROM sources WHERE id = ${sid}`;
  assert.ok(Math.abs(expired[0]!.minutes - 10) <= 1, "boost 过期后恢复默认 re-arm（10 分钟）");
});

test("boostSourcesForMatch：只给两队的 weibo 源加频，按 reason 幂等", async () => {
  await reset();
  const agWeibo = id("match-ag-weibo"), wolvesWeibo = id("match-wolves-weibo"),
    agRss = id("match-ag-rss"), drgWeibo = id("match-drg-weibo");
  await sql`
    INSERT INTO sources (id, name, kind, config, tier, owner_entity_id, participation_mode, interval_minutes)
    VALUES
      (${agWeibo}, 'ag weibo', 'weibo', '{}'::jsonb, 'T1_5', 'ag', 'editorial', 30),
      (${wolvesWeibo}, 'wolves weibo', 'weibo', '{}'::jsonb, 'T1_5', 'wolves', 'editorial', 30),
      (${agRss}, 'ag rss', 'rss', '{}'::jsonb, 'T1_5', 'ag', 'editorial', 60),
      (${drgWeibo}, 'drg weibo', 'weibo', '{}'::jsonb, 'T1_5', 'drg', 'editorial', 30)`;
  const boosted = await boostSourcesForMatch(sql, { teamSlugs: ["ag", "wolves"], reason: `test-${T}`, minutes: 180 });
  assert.equal(boosted, 2, "只命中两队的 weibo 源");
  const rows = await sql<{ sid: string; iv: number; mins: number }[]>`
    SELECT source_id AS sid, interval_override_minutes AS iv, round(extract(epoch FROM ends_at - starts_at) / 60)::int AS mins
    FROM source_boosts WHERE reason = ${`test-${T}`}`;
  assert.deepEqual(rows.map((r) => r.sid).sort(), [agWeibo, wolvesWeibo].sort());
  assert.ok(rows.every((r) => r.iv === 10 && r.mins === 180), "加频期间 10 分钟一跳、持续 180 分钟");
  const again = await boostSourcesForMatch(sql, { teamSlugs: ["ag", "wolves"], reason: `test-${T}`, minutes: 180 });
  assert.equal(again, 0, "同 reason 再次调用不叠加");
  const n = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM source_boosts WHERE reason = ${`test-${T}`}`;
  assert.equal(n[0]!.n, 2);
});

test("adaptIntervals 跳过 auto_tune=false 的源", async () => {
  await reset();
  const off = id("tune-off"), on = id("tune-on");
  await sql`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, auto_tune)
    VALUES (${off}, 'tune off', 'rss', '{}'::jsonb, 'T2', 'editorial', 15, false),
           (${on}, 'tune on', 'rss', '{}'::jsonb, 'T2', 'editorial', 15, true)`;
  // 两个源近 7 天都无产出（per_day=0）：目标都是 60 分钟；auto_tune=false 的那个必须不动。
  const res = await adaptIntervals();
  assert.equal(res.skipped_auto_tune, 1);
  const rows = await sql<{ sid: string; iv: number }[]>`
    SELECT id AS sid, interval_minutes AS iv FROM sources WHERE id IN ${sql([off, on])}`;
  const byId = Object.fromEntries(rows.map((r) => [r.sid, r.iv]));
  assert.equal(byId[off], 15, "auto_tune=false 的源 interval 不动");
  assert.equal(byId[on], 60, "对照组被调到 60 分钟");
});

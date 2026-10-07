// 采集可靠性与数据新鲜度诊断（只读）。回答：哪些启用源没被调度、哪些在吃旧缓存、哪些有分页/补漏积压、
// 哪些内容或比赛资料不完整、失败类别是什么、付费请求的成本与产出。
// 用法：node --env-file=.env scripts/audit-collection-reliability.ts
// 不改任何数据，不调用任何上游；日志只输出聚合与来源标识，不含密钥。
import { closeDb, sql } from "@aihot/backend/db";

const num = (v: unknown) => Number(v ?? 0);

// 1. 启用但未被调度（超过 3 个采集间隔或 30 分钟没有尝试；mp_account/external 另有调度，不在此列）。
const unscheduled = await sql<{ id: string; name: string; kind: string; health: string; interval_minutes: number; last_fetch_at: Date | null; next_fetch_at: Date | null }[]>`
  SELECT s.id, s.name, s.kind, s.health, s.interval_minutes, s.last_fetch_at, s.next_fetch_at
  FROM sources s
  WHERE s.enabled AND s.kind IN ('rss', 'web_list', 'json_list', 'x_search', 'esports_api', 'weibo')
    AND (s.last_fetch_at IS NULL OR s.last_fetch_at < now() - make_interval(mins => GREATEST(s.interval_minutes * 3, 30)))
  ORDER BY s.last_fetch_at NULLS FIRST`;

// 2. 最近 24 小时吃过旧缓存（降级）的源。
const stale = await sql<{ id: string; name: string; last_degraded: Date; runs: number }[]>`
  SELECT s.id, s.name, max(r.finished_at) AS last_degraded, count(*)::int AS runs
  FROM fetch_runs r JOIN sources s ON s.id = r.source_id
  WHERE r.detail @> '{"wechat":{"status":"stale"}}'::jsonb AND r.finished_at > now() - interval '24 hours'
  GROUP BY s.id, s.name ORDER BY last_degraded DESC`;

// 3. 分页 / 补漏积压：X backlog、微博分页 token、公众号 backlog、赛事回填重试、覆盖受限。
const backlog = await sql<{ id: string; name: string; kind: string; x_backlog: boolean; weibo_page: boolean; mp_backlog: number; esports_retrying: number; coverage_limited: boolean }[]>`
  SELECT s.id, s.name, s.kind,
    (s.cursor ? 'xBacklog') AS x_backlog,
    (s.cursor->>'pageSinceId') IS NOT NULL AS weibo_page,
    jsonb_array_length(coalesce(s.cursor->'mpBacklog', '[]'::jsonb)) AS mp_backlog,
    (SELECT count(*)::int FROM jsonb_each(coalesce(s.cursor->'backfill', '{}'::jsonb)) WHERE (value->>'attempts')::int > 0) AS esports_retrying,
    (s.cursor ? 'coverageLimited') AS coverage_limited
  FROM sources s
  WHERE s.enabled AND (
    (s.cursor ? 'xBacklog') OR (s.cursor->>'pageSinceId') IS NOT NULL
    OR jsonb_array_length(coalesce(s.cursor->'mpBacklog', '[]'::jsonb)) > 0
    OR (s.cursor ? 'coverageLimited')
    OR EXISTS (SELECT 1 FROM jsonb_each(coalesce(s.cursor->'backfill', '{}'::jsonb)) WHERE (value->>'attempts')::int > 0)
  )
  ORDER BY s.kind, s.id`;

// 3b. 最近 24 小时有分页被截断的运行（预算用尽、尚未追平）。
const truncated = await sql<{ id: string; name: string; last_truncated: Date }[]>`
  SELECT s.id, s.name, max(r.finished_at) AS last_truncated
  FROM fetch_runs r JOIN sources s ON s.id = r.source_id
  WHERE r.detail @> '{"truncated": true}'::jsonb AND r.finished_at > now() - interval '24 hours'
  GROUP BY s.id, s.name ORDER BY last_truncated DESC`;

// 4. 内容不完整：缺正文、长文截断（partial）、抽取失败。近 7 天。
const incompleteContent = await sql<{ source_id: string; no_body: number; partial: number; failed: number }[]>`
  SELECT a.source_id,
    count(*) FILTER (WHERE a.body_status IN ('pending', 'none'))::int AS no_body,
    count(*) FILTER (WHERE a.content_completeness = 'partial')::int AS partial,
    count(*) FILTER (WHERE a.content_completeness = 'failed')::int AS failed
  FROM articles a
  WHERE a.discovered_at > now() - interval '7 days'
  GROUP BY a.source_id
  HAVING count(*) FILTER (WHERE a.body_status IN ('pending', 'none') OR a.content_completeness IN ('partial', 'failed')) > 0
  ORDER BY no_body DESC, partial DESC`;

// 5. 缺比赛详情：缺局、缺 BP、缺选手数据、缺 MVP（字段级完整度）。
const incompleteMatches = await sql<{ id: string; source_key: string; played_at: Date | null; games: number; expected: number; missing_fields: boolean }[]>`
  SELECT m.id, m.source_key, m.played_at,
    (SELECT count(*) FROM games g WHERE g.match_id = m.id)::int AS games,
    coalesce(m.games_expected, 0) AS expected,
    EXISTS (
      SELECT 1 FROM games g WHERE g.match_id = m.id AND (
        (g.mode = 'standard' AND (SELECT count(*) FROM bp_actions b WHERE b.game_id = g.id) < 20)
        OR (g.mode = 'pinnacle' AND (SELECT count(*) FROM pinnacle_picks p WHERE p.game_id = g.id) = 0)
        OR (SELECT count(*) FROM player_games pg WHERE pg.game_id = g.id) < 10
        OR g.mvp_player_id IS NULL
      )
    ) AS missing_fields
  FROM matches m
  WHERE m.status = 'finished' AND m.source = 'smoba'
    AND (
      (coalesce(m.games_expected, 0) = 0 AND (SELECT count(*) FROM games g WHERE g.match_id = m.id) = 0)
      OR (SELECT count(*) FROM games g WHERE g.match_id = m.id) < coalesce(m.games_expected, 0)
      OR EXISTS (
        SELECT 1 FROM games g WHERE g.match_id = m.id AND (
          (g.mode = 'standard' AND (SELECT count(*) FROM bp_actions b WHERE b.game_id = g.id) < 20)
          OR (g.mode = 'pinnacle' AND (SELECT count(*) FROM pinnacle_picks p WHERE p.game_id = g.id) = 0)
          OR (SELECT count(*) FROM player_games pg WHERE pg.game_id = g.id) < 10
          OR g.mvp_player_id IS NULL
        )
      )
    )
  ORDER BY m.played_at DESC NULLS LAST LIMIT 50`;

// 6. 失败类别（近 24 小时，错误里的数字归一化以免每个 id 各成一组）。
const failures = await sql<{ id: string; name: string; category: string; n: number; last_at: Date }[]>`
  SELECT s.id, s.name, left(regexp_replace(r.error, '[0-9]+', '#', 'g'), 80) AS category, count(*)::int AS n, max(r.finished_at) AS last_at
  FROM fetch_runs r JOIN sources s ON s.id = r.source_id
  WHERE r.status = 'failed' AND r.finished_at > now() - interval '24 hours'
  GROUP BY s.id, s.name, category ORDER BY n DESC`;

// 7. 付费请求成本与状态（近 24 小时）；有效产出用同窗口新建文章数粗略对照。
const paid = await sql<{ service: string; status: string; calls: number; cost: string | null; currency: string | null }[]>`
  SELECT service, status, count(*)::int AS calls, round(sum(coalesce(cost, 0)), 4) AS cost, max(currency) AS currency
  FROM receipts WHERE created_at > now() - interval '24 hours'
  GROUP BY service, status ORDER BY service, status`;
const [created24h] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE discovered_at > now() - interval '24 hours'`;

console.log("=== 1. 启用但最近没有采集尝试的信源（调度缺口） ===");
console.table(unscheduled.map((s) => ({ id: s.id, name: s.name, kind: s.kind, health: s.health, min: s.interval_minutes, 最近尝试: s.last_fetch_at?.toISOString().slice(0, 16) ?? null, 下次: s.next_fetch_at?.toISOString().slice(0, 16) ?? null })));

console.log("\n=== 2. 最近 24 小时吃过旧缓存（降级，非新鲜数据） ===");
console.table(stale.map((s) => ({ id: s.id, name: s.name, 运行次数: s.runs, 最近: s.last_degraded?.toISOString().slice(0, 16) ?? null })));

console.log("\n=== 3. 分页 / 补漏积压与覆盖受限 ===");
console.table(backlog.map((s) => ({ id: s.id, name: s.name, kind: s.kind, X: s.x_backlog ? "Y" : "", 微博页: s.weibo_page ? "Y" : "", 公众号: num(s.mp_backlog), 赛事重试: num(s.esports_retrying), 覆盖受限: s.coverage_limited ? "Y" : "" })));
if (truncated.length) {
  console.log("最近 24 小时被预算截断、尚未追平的运行：");
  console.table(truncated.map((s) => ({ id: s.id, name: s.name, 最近截断: s.last_truncated?.toISOString().slice(0, 16) ?? null })));
}

console.log("\n=== 4. 近 7 天内容不完整（按来源） ===");
console.table(incompleteContent.map((s) => ({ source: s.source_id, 缺正文: num(s.no_body), 部分内容: num(s.partial), 抽取失败: num(s.failed) })));

console.log("\n=== 5. 缺比赛详情（字段级完整度，最近 50 场） ===");
console.table(incompleteMatches.map((m) => ({ match: m.id, 官方id: m.source_key, 时间: m.played_at?.toISOString().slice(0, 16) ?? null, 小局: `${num(m.games)}/${num(m.expected)}`, 缺字段: m.missing_fields ? "Y" : "" })));

console.log("\n=== 6. 失败类别（近 24 小时） ===");
console.table(failures.map((f) => ({ id: f.id, name: f.name, 类别: f.category, 次数: num(f.n), 最近: f.last_at?.toISOString().slice(0, 16) ?? null })));

console.log("\n=== 7. 付费请求（近 24 小时） ===");
console.table(paid.map((p) => ({ service: p.service, status: p.status, 次数: num(p.calls), 成本: p.cost == null ? null : Number(p.cost), 币种: p.currency })));
console.log(`同窗口新建文章（全部来源）：${num(created24h?.n)} 篇`);

await closeDb();

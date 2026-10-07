// 信源审计：对生产库跑只读统计，输出每个信源的运行状态与最近 7 天产出/入事件/被采用计数，
// 以及集中度（Top1/3/5）、first-party 占比、俱乐部占比、社区占比、跨源重复比例。
// 用法：node --env-file=.env scripts/audit-sources.ts
import { closeDb, sql } from "@aihot/backend/db";

interface SourceStat {
  id: string; name: string; kind: string; tier: string; participation_mode: string;
  first_party: boolean; enabled: boolean; interval_minutes: number; health: string;
  last_ok_at: Date | null; fail_count: number; owner_entity_id: string | null;
  articles_7d: number; in_events_7d: number; selected_7d: number; total_articles: number;
}

const stats = await sql<SourceStat[]>`
  SELECT s.id, s.name, s.kind, s.tier, s.participation_mode, s.first_party, s.enabled,
    s.interval_minutes, s.health, s.last_ok_at, s.fail_count, s.owner_entity_id,
    (SELECT count(*) FROM articles a WHERE a.source_id = s.id AND a.discovered_at > now() - interval '7 days' AND NOT a.backfill) AS articles_7d,
    (SELECT count(DISTINCT fa.article_id) FROM fact_articles fa JOIN articles a ON a.id = fa.article_id
       WHERE a.source_id = s.id AND a.discovered_at > now() - interval '7 days' AND NOT a.backfill) AS in_events_7d,
    (SELECT count(*) FROM publications p WHERE p.source_id = s.id AND p.selected AND p.published_at > now() - interval '7 days') AS selected_7d,
    (SELECT count(*) FROM articles a WHERE a.source_id = s.id) AS total_articles
  FROM sources s ORDER BY s.first_party DESC, articles_7d DESC`;

const [totals7d] = await sql<{ total: number; backfill: number }[]>`
  SELECT count(*) AS total, count(*) FILTER (WHERE backfill) AS backfill
  FROM articles WHERE discovered_at > now() - interval '7 days'`;

// 跨源重复：同一 article 被 ≥2 个 source 发现过（article_discoveries），最近 7 天发现的部分。
const [dupes] = await sql<{ dup_articles: number; dup_discoveries: number }[]>`
  WITH recent AS (
    SELECT article_id, count(DISTINCT source_id) AS srcs, count(*) AS disc
    FROM article_discoveries WHERE discovered_at > now() - interval '7 days'
    GROUP BY article_id HAVING count(DISTINCT source_id) > 1)
  SELECT count(*) AS dup_articles, coalesce(sum(disc), 0) AS dup_discoveries FROM recent`;

const [discovered7d] = await sql<{ total: number }[]>`
  SELECT count(*) AS total FROM article_discoveries WHERE discovered_at > now() - interval '7 days'`;

const [events7d] = await sql<{ stories: number; facts: number }[]>`
  SELECT (SELECT count(*) FROM stories WHERE first_report_at > now() - interval '7 days') AS stories,
         (SELECT count(*) FROM facts WHERE created_at > now() - interval '7 days') AS facts`;

console.log("=== 信源清单（按 first_party 与 7 天产出排序） ===");
console.table(stats.map((s) => ({
  id: s.id, name: s.name, kind: s.kind, tier: s.tier, mode: s.participation_mode,
  fp: s.first_party ? "Y" : "n", on: s.enabled ? "Y" : "n", min: s.interval_minutes,
  health: s.health, fails: s.fail_count, owner: s.owner_entity_id,
  "7d文章": s.articles_7d, "7d入事件": s.in_events_7d, "7d被选": s.selected_7d, 总文章: s.total_articles,
  最近OK: s.last_ok_at ? s.last_ok_at.toISOString().slice(0, 16) : null,
})));

const active = stats.filter((s) => s.articles_7d > 0);
const sum7d = active.reduce((a, s) => a + s.articles_7d, 0);
const byDesc = [...active].sort((a, b) => b.articles_7d - a.articles_7d);
const share = (n: number) => byDesc.slice(0, n).reduce((a, s) => a + s.articles_7d, 0) / (sum7d || 1);
console.log(`\n=== 集中度（最近 7 天非 backfill 文章 ${totals7d?.total ?? 0} 篇，其中 backfill ${totals7d?.backfill ?? 0}） ===`);
console.log(`有产出的信源 ${active.length} 个；Top1 ${(share(1) * 100).toFixed(1)}%、Top3 ${(share(3) * 100).toFixed(1)}%、Top5 ${(share(5) * 100).toFixed(1)}%`);
console.log(`事件：7 天新 story ${events7d?.stories ?? 0}、新 fact ${events7d?.facts ?? 0}`);
console.log(`跨源重复：7 天发现的 ${discovered7d?.total ?? 0} 条 discovery 中，被 ≥2 源命中的文章 ${dupes?.dup_articles ?? 0} 篇（discovery ${dupes?.dup_discoveries ?? 0} 条）`);
await closeDb();

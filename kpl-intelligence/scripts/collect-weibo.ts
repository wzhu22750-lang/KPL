// 批量执行微博 KPL 官方与俱乐部动态采集
// 用法：
//   全量批量采集：node --env-file=.env scripts/collect-weibo.ts
//   单个账号采集：node --env-file=.env scripts/collect-weibo.ts --source=weibo-ag-club
import { closeDb, sql } from "@aihot/backend/db";
import { collectSource } from "@aihot/backend/sources/collect";
import type { SourceRow } from "@aihot/backend/sources/types";

function parseArgs(): { sourceId?: string } {
  const args = process.argv.slice(2);
  let sourceId: string | undefined;
  for (const a of args) {
    if (a.startsWith("--source=")) {
      sourceId = a.slice("--source=".length).trim();
    }
  }
  return { sourceId };
}

const { sourceId } = parseArgs();

console.log("==================================================");
console.log("  KPL Intelligence - 微博官方与俱乐部动态批量采集");
console.log("==================================================");

let sources: SourceRow[];
if (sourceId) {
  sources = await sql<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
    FROM sources WHERE id = ${sourceId}`;
  if (!sources.length) {
    console.error(`未找到指定的微博信源 ID: ${sourceId}`);
    process.exit(1);
  }
} else {
  sources = await sql<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
    FROM sources WHERE kind = 'weibo' AND enabled = true
    ORDER BY CASE tier WHEN 'T1' THEN 1 WHEN 'T1_5' THEN 2 ELSE 3 END, id`;
}

console.log(`准备调度 ${sources.length} 个微博信源账号...\n`);

let totalFound = 0;
let totalCreated = 0;
let totalRevised = 0;
let totalFailed = 0;

for (const s of sources) {
  const uid = s.config?.uid || "未知";
  process.stdout.write(`正在采集 [${s.name}] (UID: ${uid})... `);
  const start = Date.now();
  try {
    const res = await collectSource(s.id, { force: true });
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    if (res.status === "ok") {
      console.log(`✅ 成功 (${duration}s) | 发现: ${res.found} 篇, 新增入库: ${res.created} 篇, 更新: ${res.revised} 篇`);
      totalFound += res.found;
      totalCreated += res.created;
      totalRevised += res.revised;
    } else {
      console.log(`⚠️ 跳过/失败: ${res.error || res.status}`);
      totalFailed++;
    }
  } catch (error) {
    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`❌ 异常 (${duration}s): ${error instanceof Error ? error.message : error}`);
    totalFailed++;
  }
  // 间隔 1.5 秒，避免高频连续请求
  await new Promise((r) => setTimeout(r, 1500));
}

console.log("\n==================================================");
console.log("  采集任务汇总结果");
console.log("==================================================");
console.log(`总信源数: ${sources.length} 个`);
console.log(`成功采集: ${sources.length - totalFailed} 个`);
console.log(`失败/跳过: ${totalFailed} 个`);
console.log(`共发现博文: ${totalFound} 条`);
console.log(`新增入库博文: ${totalCreated} 条`);
console.log(`修订更新博文: ${totalRevised} 条`);

// 检查当前库中微博总数与实体关联统计
const [socialStats] = await sql<{ count: number }[]>`
  SELECT count(*)::int AS count FROM articles WHERE content_kind = 'social_post'`;
const [mentionStats] = await sql<{ count: number }[]>`
  SELECT count(*)::int AS count FROM entity_mentions em
  JOIN articles a ON a.id = em.article_id
  WHERE a.content_kind = 'social_post'`;

console.log(`当前库中累计微博动态总数: ${socialStats?.count ?? 0} 条`);
console.log(`当前微博与战队/选手实体关联数: ${mentionStats?.count ?? 0} 条`);
console.log("==================================================\n");

await closeDb();

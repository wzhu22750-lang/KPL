#!/usr/bin/env node
/**
 * 一键全量信源文章聚合采集脚本
 * 抓取所有已启用的信源（官方公众号、战队公众号、B站、社区等）并入库聚合
 *
 * 用法:
 *   node --env-file=.env scripts/collect-all.ts
 */
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  tier: string;
}

async function main() {
  console.log("🚀 开始执行全量信源聚合采集...\n");
  const sources = await sql<SourceRow[]>`
    SELECT id, name, kind, tier FROM sources
    WHERE enabled = true AND kind != 'esports_api'
    ORDER BY CASE tier WHEN 'T1' THEN 1 WHEN 'T1_5' THEN 2 ELSE 3 END, id
  `;

  console.log(`📋 待采集信源共 ${sources.length} 个:\n`);
  for (const s of sources) {
    console.log(`  - [${s.tier}] ${s.name} (${s.id}, ${s.kind})`);
  }
  console.log("\n------------------------------------------------------------\n");

  let totalFound = 0;
  let totalCreated = 0;
  let totalRevised = 0;

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i]!;
    const idx = `[${i + 1}/${sources.length}]`;
    console.log(`${idx} 正在采集: ${s.name} ...`);
    const started = Date.now();
    try {
      const res = await collectSource(s.id, { force: true });
      const ms = Date.now() - started;
      if (res.status === "ok") {
        totalFound += res.found;
        totalCreated += res.created;
        totalRevised += res.revised;
        console.log(`    ✅ 状态: 成功 | 发现: ${res.found} 篇 | 新入库: ${res.created} 篇 | 更新: ${res.revised} 篇 | 耗时: ${ms}ms`);
      } else {
        console.log(`    ⚠️ 状态: ${res.status} | 错误: ${res.error || "未知"} | 耗时: ${ms}ms`);
      }
    } catch (err) {
      console.log(`    ❌ 采集异常: ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log("");
  }

  console.log("============================================================");
  console.log(`🎉 全量采集完成！`);
  console.log(`📊 统计结果: 累计发现 ${totalFound} 篇 | 新增入库 ${totalCreated} 篇 | 更新修订 ${totalRevised} 篇`);

  // 查询最新入库的 10 篇文章
  const latestArticles = await sql<{ id: string; title: string; source_name: string; published_at: Date; created_at: Date }[]>`
    SELECT a.id, a.title, s.name as source_name, a.published_at, a.created_at
    FROM articles a
    LEFT JOIN sources s ON a.source_id = s.id
    ORDER BY a.created_at DESC
    LIMIT 10
  `;

  if (latestArticles.length > 0) {
    console.log("\n📰 最新入库文章示例 (前 10 篇):");
    for (let i = 0; i < latestArticles.length; i++) {
      const a = latestArticles[i]!;
      console.log(`  ${i + 1}. [${a.source_name || "未知来源"}] ${a.title}`);
      console.log(`     发布时间: ${a.published_at ? new Date(a.published_at).toLocaleString("zh-CN") : "未知"}`);
      console.log(`     系统ID: ${a.id}`);
    }
  }
}

try {
  await main();
} finally {
  await stopBoss();
  await closeDb();
}

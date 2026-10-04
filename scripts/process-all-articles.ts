#!/usr/bin/env node
/**
 * 批量处理并发布文章到前端展示层（publications）
 *
 * 逐篇复用 worker 的分析任务（jobs/content.ts 的 processArticle）：分析成功才发布；分析失败时
 * 记录 processing_error 并按仓库的重试机制等待重试，不写任何固定分数，也不发布未评分的内容。
 * 存在失败时进程以非零码退出，供调度方感知。
 *
 * 用法:
 *   node --env-file-if-exists=.env scripts/process-all-articles.ts
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { closeDb, sql } from "@aihot/backend/db";
import { processArticle } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";

export interface BatchFailure {
  articleId: string;
  title: string;
  state: string;
  error: string | null;
}

export interface BatchReport {
  total: number;
  /** 分析完成、发布投影已重建（对外可见性仍由 pool/精选规则决定）。 */
  completed: number;
  /** 终态失败（failed / unknown-receipt），已记录 processing_error。 */
  failed: number;
  /** 供应商暂时不可用等，等待自动重试。 */
  deferred: number;
  /** 无需处理（缺失、过期、非编辑信源）。 */
  skipped: number;
  failures: BatchFailure[];
}

const TERMINAL_FAILURES = new Set(["failed", "unknown-receipt"]);
const DEFERRED = new Set(["retrying", "waiting", "fetching-body"]);
const SKIPPED = new Set(["missing", "stale", "skipped"]);

export async function runBatch(): Promise<BatchReport> {
  // 查询所有待处理或尚未发布的文章
  const pendingArticles = await sql<{ id: string; title: string; source_id: string; source_name: string; tier: string }[]>`
    SELECT a.id, a.title, a.source_id, s.name as source_name, s.tier
    FROM articles a
    JOIN sources s ON s.id = a.source_id
    WHERE a.id NOT IN (SELECT article_id FROM publications)
       OR a.processing_state = 'new'
    ORDER BY CASE s.tier WHEN 'T1' THEN 1 WHEN 'T1_5' THEN 2 ELSE 3 END, a.created_at DESC
  `;
  console.log(`🚀 开始处理并发布文章到前端展示层 (publications)...`);
  console.log(`📋 共有 ${pendingArticles.length} 篇待处理/发布的文章\n`);

  const report: BatchReport = { total: pendingArticles.length, completed: 0, failed: 0, deferred: 0, skipped: 0, failures: [] };

  for (let i = 0; i < pendingArticles.length; i++) {
    const art = pendingArticles[i]!;
    console.log(`[${i + 1}/${pendingArticles.length}] 处理: [${art.source_name}] ${art.title.slice(0, 30)}...`);
    const result = await processArticle(art.id);
    if (TERMINAL_FAILURES.has(result.state)) {
      const [row] = await sql<{ processing_error: string | null }[]>`SELECT processing_error FROM articles WHERE id = ${art.id}`;
      report.failed += 1;
      report.failures.push({ articleId: art.id, title: art.title, state: result.state, error: row?.processing_error ?? null });
      console.log(`    ❌ 分析失败 (${result.state}): ${row?.processing_error ?? "原因未知"} —— 未发布，保留失败状态可重试`);
    } else if (DEFERRED.has(result.state)) {
      report.deferred += 1;
      console.log(`    ⏳ 稍后自动重试 (${result.state})`);
    } else if (SKIPPED.has(result.state)) {
      report.skipped += 1;
      console.log(`    ⏭️ 跳过 (${result.state})`);
    } else {
      report.completed += 1;
      console.log(`    ✅ 分析完成并发布 (${result.state})`);
    }
  }

  console.log("\n============================================================");
  console.log(`📊 统计: 完成 ${report.completed} | 失败 ${report.failed} | 待重试 ${report.deferred} | 跳过 ${report.skipped} (共 ${report.total})`);
  for (const f of report.failures) console.log(`  ❌ ${f.articleId} [${f.title.slice(0, 40)}]: ${f.error ?? "原因未知"}`);
  return report;
}

export async function main(): Promise<void> {
  const report = await runBatch();
  const [totalPub] = await sql<{ count: string }[]>`SELECT count(*) as count FROM publications`;
  console.log(`\n🌐 前端 publications 展示层现有文章总数: ${totalPub?.count || 0} 篇\n`);
  if (report.failed > 0) process.exitCode = 1;
}

// 仅在作为脚本直接执行时运行；被测试导入时只提供 main/runBatch。
const isCli = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isCli) {
  try {
    await main();
  } finally {
    await stopBoss();
    await closeDb();
  }
}

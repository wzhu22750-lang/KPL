#!/usr/bin/env node
/**
 * 历史内容修复脚本：按条件批量重跑内容抽取（Extractor Registry → CanonicalContent → 质量评估），
 * 可选继续排队分析。三条链路分开：fetch（重新抓页面）→ extract（重新解析）→ analyze（重新评估）。
 *
 * 用法:
 *   node --env-file=.env scripts/re-extract-content.ts [flags]
 *
 * 筛选（可组合）:
 *   --source <id>          只处理某个信源（如 hupu-kog）
 *   --kind <contentKind>   只处理某个内容类型（forum_thread / video_post / article …）
 *   --body-status <status> body_status 筛选（pending / unconfirmed / ok）
 *   --quality-below <n>    content_quality_score < n 的内容
 *   --after  <ISO|date>    discovered_at 之后
 *   --before <ISO|date>    discovered_at 之前
 *   --id <articleId>       只处理这一条
 *   --limit <n>            最多处理多少条（默认 50）
 *   --dry-run              只列出命中项，不执行
 *
 * 模式:
 *   --mode extract         重置 body 后重新抓取+解析（默认；fetch+extract 一体）
 *   --mode analyze         不重新抓取，只带着 attemptTag 重新评估（付费）
 *   --mode both            先 extract 再排队 analyze（默认排队由 extract 后的 queueProcessing 自动发生）
 *
 * 例:
 *   node --env-file=.env scripts/re-extract-content.ts --quality-below 60 --limit 100
 *   node --env-file=.env scripts/re-extract-content.ts --source hupu-kog
 */
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";

interface Args {
  source?: string;
  kind?: string;
  bodyStatus?: string;
  qualityBelow?: number;
  after?: string;
  before?: string;
  id?: string;
  limit: number;
  dryRun: boolean;
  mode: "extract" | "analyze" | "both";
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 50, dryRun: false, mode: "extract" };
  const take = (i: number) => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`flag ${argv[i]} 需要一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--source": args.source = take(i); i++; break;
      case "--kind": args.kind = take(i); i++; break;
      case "--body-status": args.bodyStatus = take(i); i++; break;
      case "--quality-below": args.qualityBelow = Number(take(i)); i++; break;
      case "--after": args.after = take(i); i++; break;
      case "--before": args.before = take(i); i++; break;
      case "--id": args.id = take(i); i++; break;
      case "--limit": args.limit = Number(take(i)); i++; break;
      case "--dry-run": args.dryRun = true; break;
      case "--mode": {
        const m = take(i); i++;
        if (m !== "extract" && m !== "analyze" && m !== "both") throw new Error(`--mode 只支持 extract | analyze | both（收到 ${m}）`);
        args.mode = m;
        break;
      }
      default: throw new Error(`未知参数 ${a}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const conditions: ReturnType<typeof sql>[] = [];
  if (args.id) conditions.push(sql`a.id = ${args.id}`);
  if (args.source) conditions.push(sql`s.id = ${args.source}`);
  if (args.kind) conditions.push(sql`a.content_kind = ${args.kind}`);
  if (args.bodyStatus) conditions.push(sql`a.body_status = ${args.bodyStatus}`);
  if (args.qualityBelow !== undefined) conditions.push(sql`a.content_quality_score < ${args.qualityBelow}`);
  if (args.after) conditions.push(sql`a.discovered_at >= ${args.after}`);
  if (args.before) conditions.push(sql`a.discovered_at < ${args.before}`);

  // postgres.js 没有 sql.join：条件片段用 AND 折叠拼装（片段各自带参数绑定）。
  const where = conditions.length
    ? sql`WHERE ${conditions.reduce((left, right) => sql`${left} AND ${right}`)}`
    : sql``;
  const rows = await sql<{ id: string; url: string; title: string; source_id: string; body_status: string; content_kind: string | null; content_quality_score: number | null }[]>`
    SELECT a.id, a.url, a.title, s.id AS source_id, a.body_status, a.content_kind, a.content_quality_score
    FROM articles a JOIN sources s ON s.id = a.source_id
    ${where}
    ORDER BY a.discovered_at DESC
    LIMIT ${args.limit}`;

  console.log(`命中 ${rows.length} 条（mode=${args.mode}${args.dryRun ? "，dry-run" : ""}）`);
  if (args.dryRun) {
    for (const r of rows) {
      console.log(`  [${r.source_id}] ${r.id} kind=${r.content_kind ?? "-"} quality=${r.content_quality_score ?? "-"} body=${r.body_status} :: ${r.title.slice(0, 60)}`);
    }
    await closeDb();
    return;
  }

  let ok = 0;
  let unconfirmed = 0;
  let skipped = 0;
  let failed = 0;
  for (const [i, r] of rows.entries()) {
    try {
      if (args.mode === "analyze") {
        // 重新评估：新的 attemptTag 让分析步骤发起（可复用收据以外的）新请求。
        await queueProcessing(r.id, { step: "analyze", attemptTag: `reanalyze:${Date.now()}` });
        ok++;
      } else {
        // 重置后重跑抽取：extractArticleBody 只处理 body_status <> 'ok' 的行。
        await sql`UPDATE articles SET body_status = 'pending' WHERE id = ${r.id} AND body_status <> 'pending'`;
        const state = await extractArticleBody(r.id);
        if (state === "ok") {
          ok++;
          if (args.mode === "both") await queueProcessing(r.id);
        } else if (state === "unconfirmed") unconfirmed++;
        else skipped++;
      }
      if ((i + 1) % 20 === 0) console.log(`  … ${i + 1}/${rows.length}`);
    } catch (error) {
      failed++;
      console.warn(`  ✖ ${r.id}: ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(`\n完成：ok=${ok} unconfirmed=${unconfirmed} skipped=${skipped} failed=${failed}`);
  await stopBoss();
  await closeDb();
}

main().catch(async (error) => {
  console.error(error);
  await closeDb();
  process.exit(1);
});

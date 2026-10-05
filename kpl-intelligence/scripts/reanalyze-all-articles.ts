#!/usr/bin/env node
/**
 * 清理假分析与假发布，并调用原生流水线（Qwen 3.8 Flash）重新分析与发布所有文章
 *
 * 用法:
 *   node --env-file=.env scripts/reanalyze-all-articles.ts
 */
import { closeDb, sql } from "@aihot/backend/db";
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { publishArticle } from "@aihot/backend/publication/publish";

async function main() {
  console.log("============================================================");
  console.log("🚀 开始 KPL 文章数据清洗治理与 LLM 智能评分重写流水线");
  console.log("============================================================\n");

  // 1. 释放之前中断留下的 pending/unknown receipts
  const released = await sql`
    UPDATE receipts SET status = 'failed', error = 'interrupted' WHERE status IN ('pending', 'unknown') RETURNING id;
  `;
  if (released.length > 0) {
    console.log(`🧹 释放了 ${released.length} 个中断未结的调用收据 (receipts)`);
  }

  // 2. 清除历史硬编码假分析（model = 'kpl-processor'）与假精选
  console.log("🧹 正在清理历史硬编码假分析（model = 'kpl-processor'）与假精选...");
  const deletedPubs = await sql`
    DELETE FROM publications WHERE article_id IN (
      SELECT article_id FROM analyses WHERE model = 'kpl-processor'
    ) RETURNING article_id;
  `;
  const deletedAnalyses = await sql`
    DELETE FROM analyses WHERE model = 'kpl-processor' RETURNING id;
  `;
  const updatedArticles = await sql`
    UPDATE articles SET processing_state = 'new' WHERE processing_state = 'analyzed' AND id NOT IN (
      SELECT article_id FROM analyses WHERE model != 'kpl-processor'
    ) RETURNING id;
  `;
  console.log(`   - 清理假精选 publications: ${deletedPubs.length} 条`);
  console.log(`   - 清理假分析 analyses: ${deletedAnalyses.length} 条`);
  console.log(`   - 重置待处理文章状态: ${updatedArticles.length} 条\n`);

  // 3. 拦截过滤无意义灌水垃圾（如标题 <= 4 字符且无正文的纯水帖）
  const blockedSpam = await sql`
    UPDATE articles
    SET processing_state = 'blocked', processing_error = '预筛自动拦截：无正文且标题为单字/灌水字符'
    WHERE length(trim(title)) <= 4 AND (body_text IS NULL OR length(trim(body_text)) <= 5)
    RETURNING id;
  `;
  if (blockedSpam.length > 0) {
    console.log(`🚫 自动拦截纯水帖/乱码帖: ${blockedSpam.length} 篇\n`);
  }

  // 4. 将微信公众号历史未确认正文标记为 unconfirmed，允许模型依据标题与摘要进行评估
  await sql`
    UPDATE articles 
    SET body_status = 'unconfirmed' 
    WHERE body_status = 'pending' AND (url LIKE '%weixin.sogou.com%' OR source_id LIKE 'mp-%');
  `;

  // 5. 查询所有需要处理的有效文章（优先处理官方一手源 T1 -> 俱乐部源 T1.5 -> 优质社区源 T2）
  const articles = await sql<{
    id: string;
    title: string;
    source_id: string;
    source_name: string;
    tier: string;
    published_at: Date | null;
    discovered_at: Date;
  }[]>`
    SELECT a.id, a.title, a.source_id, s.name as source_name, s.tier, a.published_at, a.discovered_at
    FROM articles a
    JOIN sources s ON s.id = a.source_id
    WHERE s.participation_mode = 'editorial'
      AND a.processing_state <> 'blocked'
    ORDER BY CASE s.tier WHEN 'T1' THEN 1 WHEN 'T1_5' THEN 2 ELSE 3 END, a.created_at DESC
  `;

  console.log(`📋 共找到 ${articles.length} 篇需同步与分析的文章\n`);

  let countPass = 0;
  let countBlock = 0;
  let countSelected = 0;
  let countDiscarded = 0;
  let countFail = 0;

  const CONCURRENCY = 2;
  let cursor = 0;

  async function worker(workerId: number) {
    while (cursor < articles.length) {
      const idx = cursor++;
      const art = articles[idx]!;
      const prefix = `[${idx + 1}/${articles.length}]`;
      const titleSnippet = art.title.trim().slice(0, 30);

      try {
        const [existing] = await sql<{
          relevance: string;
          selected: boolean;
          score: number | null;
          reason_zh: string | null;
        }[]>`
          SELECT relevance, selected, score, reason_zh 
          FROM analyses 
          WHERE article_id = ${art.id} AND model != 'kpl-processor'
          ORDER BY id DESC LIMIT 1
        `;

        if (existing) {
          if (existing.relevance === "block") {
            countBlock++;
          } else {
            countPass++;
            if (existing.selected) {
              countSelected++;
              console.log(`${prefix} [${art.source_name}] "${titleSnippet}" -> 🌟 精选入选! 得分:${existing.score}分`);
            } else {
              countDiscarded++;
            }
          }
          await publishArticle(art.id, {
            releasedAt: art.published_at ?? art.discovered_at ?? new Date(),
          });
          continue;
        }

        const result = await analyzeArticle(art.id);

        if (!result || !result.output) {
          console.log(`${prefix} [${art.source_name}] "${titleSnippet}" -> ⚠️ 无输出 (needsBody: ${result?.needsBody})`);
          continue;
        }

        const out = result.output;

        if (out.relevance === "block") {
          countBlock++;
          console.log(`${prefix} [${art.source_name}] "${titleSnippet}" -> 🚫 预筛拦截垃圾 (block)`);
        } else {
          countPass++;
          if (out.selected) {
            countSelected++;
            console.log(`${prefix} [${art.source_name}] "${titleSnippet}" -> 🌟 新分析精选入选! 得分:${out.score}分 (门槛:${out.threshold})`);
            if (out.reasonZh) {
              console.log(`      💡 理由: ${out.reasonZh}`);
            }
          } else {
            countDiscarded++;
            console.log(`${prefix} [${art.source_name}] "${titleSnippet}" -> 📉 淘汰未入选 (得分:${out.score ?? "无"}, 门槛:${out.threshold ?? "无"})`);
          }
        }

        // 同步写入 publications 发布展示层
        await publishArticle(art.id, {
          releasedAt: art.published_at ?? art.discovered_at ?? new Date(),
        });
      } catch (err) {
        countFail++;
        console.log(`${prefix} [${art.source_name}] "${titleSnippet}" -> ❌ 失败: ${(err as Error).message?.slice(0, 80)}`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i));
  await Promise.all(workers);

  console.log("\n============================================================");
  console.log("🎉 LLM 智能评分重写与数据清洗治理全部完成！");
  console.log("============================================================");
  console.log(`📊 流水线统计:`);
  console.log(`   - 尝试处理总数: ${articles.length}`);
  console.log(`   - 预筛拦截垃圾数: ${countBlock}`);
  console.log(`   - 通过预筛进入评分: ${countPass}`);
  console.log(`   - 评分淘汰低质数: ${countDiscarded}`);
  console.log(`   - 最终精选上架数: ${countSelected}`);
  console.log(`   - 异常失败数: ${countFail}`);

  // 验证 publications 状态
  const [totalPub] = await sql<{ count: string }[]>`SELECT count(*) FROM publications`;
  const [selectedPub] = await sql<{ count: string }[]>`SELECT count(*) FROM publications WHERE selected = true`;
  const [scoreStats] = await sql<{ min_score: number; max_score: number; avg_score: number }[]>`
    SELECT min(score) as min_score, max(score) as max_score, round(avg(score), 1) as avg_score
    FROM publications WHERE selected = true
  `;

  console.log(`\n🌐 数据库清洗结果核验:`);
  console.log(`   - publications 总上架数: ${totalPub?.count || 0}`);
  console.log(`   - selected = true 精选展示数: ${selectedPub?.count || 0}`);
  console.log(`   - 精选评分真实梯度分布: 最低 ${scoreStats?.min_score} 分, 最高 ${scoreStats?.max_score} 分, 平均 ${scoreStats?.avg_score} 分`);

  const sampleSelected = await sql<{
    title: string;
    score: number;
    reason: string | null;
    summary: string | null;
    source_name: string;
  }[]>`
    SELECT p.title, p.score, p.reason, p.summary, s.name as source_name
    FROM publications p
    JOIN sources s ON s.id = p.source_id
    WHERE p.selected = true
    ORDER BY p.score DESC, p.timeline_at DESC
    LIMIT 5
  `;

  console.log(`\n🔎 精选文章样本抽检 (Top 5):`);
  for (const s of sampleSelected) {
    console.log(`   - [${s.source_name}] [${s.score}分] ${s.title}`);
    console.log(`     入选理由: ${s.reason ?? "【无】"}`);
    console.log(`     摘要片段: ${(s.summary || "").slice(0, 80)}...`);
  }
  console.log("\n============================================================\n");

  await closeDb();
}

main().catch(async (e) => {
  console.error("Fatal error:", e);
  await closeDb();
  process.exit(1);
});

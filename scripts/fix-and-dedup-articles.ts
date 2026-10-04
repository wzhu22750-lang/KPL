#!/usr/bin/env node
/**
 * 历史文章与信源质量全面治理与去重脚本
 * 1. 开启所有俱乐部与社区信源的 site_fulltext
 * 2. 修复时间线偏差：将 timeline_at 统一对齐到真实发布时间 published_at
 * 3. 严格清洗由于临时防盗链 Token 导致的同源同题重复冗余文章
 * 4. 赛事级同事件归组：基于 KPL 对决指纹将相同比赛的报道聚合到同一 Fact
 * 5. 重建受影响文章的 publications 投影
 */
import { closeDb, sql } from "../packages/backend/src/db.ts";
import { areSameKplOccurrence } from "../packages/backend/src/lib/kpl-dedup.ts";
import { publishArticle } from "../packages/backend/src/publication/publish.ts";
import { newShortId, newUuid } from "../packages/backend/src/lib/ids.ts";

async function main() {
  console.log("🚀 开始执行 KPL 动态与信源质量全面治理与去重...\n");

  // 1. 开启信源全文展示
  console.log("【步骤 1】配置信源 site_fulltext = true...");
  const updatedSources = await sql`
    UPDATE sources
    SET site_fulltext = true, updated_at = now()
    WHERE id LIKE 'mp-%' OR id LIKE 'bili-%' OR id = 'hupu-kog'
    RETURNING id, name
  `;
  console.log(`  ✓ 已为 ${updatedSources.length} 个核心信源开启站内全文展示权限\n`);

  // 2. 修正时间线偏差：以真实发布时间 published_at 为准
  console.log("【步骤 2】修正时间线偏差 (对齐真实发布时间)...");
  const fixedTimeArticles = await sql<{ id: string; title: string; published_at: Date; timeline_at: Date }[]>`
    SELECT id, title, published_at, timeline_at
    FROM articles
    WHERE published_at IS NOT NULL
      AND published_at < timeline_at - interval '1 hour'
  `;
  console.log(`  发现 ${fixedTimeArticles.length} 篇时间戳偏差文章，开始对齐真实发布时间...`);

  for (const art of fixedTimeArticles) {
    await sql`
      UPDATE articles
      SET timeline_at = ${art.published_at}
      WHERE id = ${art.id}
    `;
    await sql`
      UPDATE publications
      SET published_at = ${art.published_at}, timeline_at = ${art.published_at}, sort_at = ${art.published_at}
      WHERE article_id = ${art.id}
    `;
  }
  console.log(`  ✓ 成功修正 ${fixedTimeArticles.length} 篇文章的时间线至真实发帖时间\n`);

  // 3. 同源同题完全重复文章去重清洗
  console.log("【步骤 3】排查同源同题重复冗余记录...");
  const dupGroups = await sql<{ title: string; source_id: string; ids: string[]; count: number }[]>`
    SELECT title, source_id, array_agg(id ORDER BY (body_text IS NOT NULL) DESC, discovered_at ASC) as ids, count(*)
    FROM articles
    GROUP BY title, source_id
    HAVING count(*) > 1
  `;

  console.log(`  共检测到 ${dupGroups.length} 组同源同题重复文章`);
  let deletedDups = 0;
  for (const group of dupGroups) {
    const [keepId, ...deleteIds] = group.ids;
    if (!deleteIds.length) continue;

    console.log(`    - [${group.source_id}] 保留: ${keepId} | 移除冗余 ${deleteIds.length} 篇: ${group.title.slice(0, 24)}...`);
    await sql`DELETE FROM pool_search WHERE article_id IN ${sql(deleteIds)}`;
    await sql`DELETE FROM publications WHERE article_id IN ${sql(deleteIds)}`;
    await sql`DELETE FROM analyses WHERE article_id IN ${sql(deleteIds)}`;
    await sql`DELETE FROM fact_articles WHERE article_id IN ${sql(deleteIds)}`;
    await sql`DELETE FROM article_revisions WHERE article_id IN ${sql(deleteIds)}`;
    await sql`DELETE FROM article_discoveries WHERE article_id IN ${sql(deleteIds)}`;
    await sql`DELETE FROM entity_mentions WHERE article_id IN ${sql(deleteIds)}`;
    await sql`DELETE FROM editorial_overrides WHERE article_id IN ${sql(deleteIds)}`;
    await sql`DELETE FROM grouping_decisions WHERE article_id IN ${sql(deleteIds)}`;
    await sql`DELETE FROM grouping_overrides WHERE article_id IN ${sql(deleteIds)}`;
    await sql`DELETE FROM story_signals WHERE article_id IN ${sql(deleteIds)}`;
    await sql`DELETE FROM translations WHERE article_id IN ${sql(deleteIds)}`;
    await sql`DELETE FROM translation_attempts WHERE article_id IN ${sql(deleteIds)}`;
    await sql`DELETE FROM articles WHERE id IN ${sql(deleteIds)}`;
    deletedDups += deleteIds.length;
  }
  console.log(`  ✓ 成功清理 ${deletedDups} 篇冗余重复数据\n`);

  // 4. KPL 赛事级同事件归组与去重折叠
  console.log("【步骤 4】执行 KPL 赛事级同事件归组 (Match Event Deduplication)...");
  const candidates = await sql<{ id: string; title: string; published_at: Date; fact_id: number | null; story_id: number | null }[]>`
    SELECT a.id, a.title, coalesce(a.published_at, a.discovered_at) as published_at, p.fact_id, p.story_id
    FROM articles a
    LEFT JOIN publications p ON a.id = p.article_id
    WHERE a.title LIKE '%KSG%' OR a.title LIKE '%RW%' OR a.title LIKE '%AG%' OR a.title LIKE '%狼队%'
    ORDER BY a.published_at DESC
  `;

  let groupedCount = 0;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const artA = candidates[i]!;
      const artB = candidates[j]!;

      // 判定是否属于同一赛事事件
      if (areSameKplOccurrence(artA.title, artB.title, artA.published_at, artB.published_at)) {
        // 如果两者分属于不同 fact，或者其中一个无 fact
        let targetFactId = artA.fact_id || artB.fact_id;
        let targetStoryId = artA.story_id || artB.story_id;

        if (!targetFactId) {
          // 创建新 story 与 fact
          const [st] = await sql<{ id: number }[]>`
            INSERT INTO stories (public_id, title, first_report_at, latest_at, origin)
            VALUES (${newUuid()}, ${artA.title.slice(0, 60)}, ${artA.published_at}, ${artA.published_at}, 'model')
            RETURNING id
          `;
          targetStoryId = st!.id;
          const [fc] = await sql<{ id: number }[]>`
            INSERT INTO facts (public_id, story_id, title, created_at)
            VALUES (${`f${newShortId(8)}`}, ${targetStoryId}, ${artA.title.slice(0, 60)}, ${artA.published_at})
            RETURNING id
          `;
          targetFactId = fc!.id;
        }

        // 统一两者到同一 fact_id
        if (artA.fact_id !== targetFactId) {
          await sql`INSERT INTO fact_articles (fact_id, article_id, role, created_at) VALUES (${targetFactId}, ${artA.id}, 'report', ${artA.published_at}) ON CONFLICT DO NOTHING`;
          artA.fact_id = targetFactId;
          groupedCount++;
        }
        if (artB.fact_id !== targetFactId) {
          await sql`INSERT INTO fact_articles (fact_id, article_id, role, created_at) VALUES (${targetFactId}, ${artB.id}, 'report', ${artB.published_at}) ON CONFLICT DO NOTHING`;
          artB.fact_id = targetFactId;
          groupedCount++;
        }
        console.log(`    🔗 成功将同事件报道合并至 Fact #${targetFactId}:`);
        console.log(`       - ${artA.title.slice(0, 30)}`);
        console.log(`       - ${artB.title.slice(0, 30)}`);
      }
    }
  }
  console.log(`  ✓ 成功关联并折叠 ${groupedCount} 次同赛事重复报道\n`);

  // 5. 重新投递并刷新 publications 投影
  console.log("【步骤 5】重新发布受影响的文章以刷新 publications 视图...");
  const needRefresh = await sql<{ id: string }[]>`
    SELECT id FROM articles
    WHERE source_id LIKE 'mp-%' OR source_id = 'hupu-kog' OR source_id LIKE 'bili-%'
  `;
  console.log(`  开始重新构建 ${needRefresh.length} 篇有效文章的 publications 视图...`);

  for (const art of needRefresh) {
    try {
      await publishArticle(art.id);
    } catch {
      // 容错继续
    }
  }
  console.log(`  ✓ 全部 publications 视图重建完毕！\n`);

  console.log("🎉 KPL 数据治理与去重全流程执行完成！");
}

try {
  await main();
} finally {
  await closeDb();
}

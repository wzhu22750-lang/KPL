#!/usr/bin/env node
/**
 * 清洗 12:47 批次时间戳解析异常的微信文章
 * 1. 重新解析真实的发布时间（2020-2024 年历史时间）
 * 2. 同步更新 articles 和 publications 表
 * 3. 清理无法匹配或非 KPL 相关的无效文章
 */
import { closeDb, sql } from "@aihot/backend/db";
import { wechatBridge } from "@aihot/backend/sources/wechat2rss/bridge";

async function main() {
  console.log("🧹 开始清洗 12:47 批次的受污染微信公众号文章...\n");

  const sources = [
    { id: "mp-ag", query: "成都AG超玩会" },
    { id: "mp-drg", query: "佛山DRG电子竞技俱乐部" },
    { id: "mp-estar", query: "武汉eStarPro" },
    { id: "mp-hero", query: "南京Hero久竞俱乐部" },
    { id: "mp-kpl-official", query: "KPL王者荣耀职业联赛" },
    { id: "mp-ksg", query: "苏州KSG" },
    { id: "mp-ttg", query: "广州TTG" },
    { id: "mp-wb", query: "北京WB王者荣耀分部" },
    { id: "mp-wolves", query: "重庆狼队" },
  ];

  // 1. 查询 100 篇异常文章
  const bads = await sql<{ id: string; source_id: string; title: string; url: string; published_at: Date }[]>`
    SELECT id, source_id, title, url, published_at FROM articles
    WHERE source_id LIKE 'mp-%'
      AND published_at >= '2026-10-04 04:47:00+00'
      AND published_at <= '2026-10-04 05:00:00+00'
  `;

  console.log(`📋 待处理异常文章共 ${bads.length} 篇\n`);

  const updatedIds = new Set<string>();

  // 2. 重新获取真实时间戳并匹配更新
  for (const s of sources) {
    const res = await wechatBridge.fetchAccountArticles(s.query, 20);
    if (!res) continue;

    for (const art of res.articles) {
      const prefix = art.title.slice(0, 15);
      const matched = bads.filter(
        b => b.source_id === s.id && (b.url === art.url || b.title.startsWith(prefix) || art.title.startsWith(b.title.slice(0, 15)))
      );

      for (const b of matched) {
        if (updatedIds.has(b.id)) continue;
        const realDate = art.publishedAt;

        await sql`
          UPDATE articles
          SET published_at = ${realDate}, timeline_at = ${realDate}
          WHERE id = ${b.id}
        `;
        await sql`
          UPDATE publications
          SET published_at = ${realDate}, timeline_at = ${realDate}, sort_at = ${realDate}
          WHERE article_id = ${b.id}
        `;
        updatedIds.add(b.id);
        console.log(`  ✅ 修正时间 [${s.id}] ${b.title.slice(0, 24)} -> ${realDate.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
      }
    }
  }

  console.log(`\n🎉 成功修正 ${updatedIds.size} 篇文章的历史发布时间！\n`);

  // 3. 找出未匹配到的剩余异常文章（如非 KPL 游戏攻略文章）
  const toDelete = bads.filter(b => !updatedIds.has(b.id));
  console.log(`🗑️ 待清理无效/无法确认时间的文章共 ${toDelete.length} 篇:`);
  for (const td of toDelete) {
    console.log(`  - [${td.source_id}] ${td.title.slice(0, 30)}`);
  }

  if (toDelete.length > 0) {
    const deleteIds = toDelete.map(d => d.id);
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
    console.log(`✅ 已成功清理全部 ${toDelete.length} 篇残留异常数据！\n`);
  }

  console.log("✨ 数据库清洗与修正完毕！");
}

try {
  await main();
} finally {
  await closeDb();
}

// 给库里已有的文章批量补全 entity_mentions（新闻↔实体桥）。
// 幂等：ON CONFLICT DO NOTHING，可重复运行。运行：node --env-file-if-exists=.env scripts/backfill-entity-mentions.ts
import { closeDb, sql } from "@aihot/backend/db";
import { recordArticleEntityMentions } from "@aihot/backend/kb/entity-mentions";

const BATCH = 50;

let cursor = "";
let articleCount = 0;
let mentionCount = 0;
for (;;) {
  const rows = await sql<{ id: string; title: string; body_text: string | null; excerpt: string | null; x_post: Record<string, unknown> | null; title_zh: string | null; summary_zh: string | null }[]>`
    SELECT a.id, a.title, a.body_text, a.excerpt, a.x_post, an.title_zh, an.summary_zh
    FROM articles a
    LEFT JOIN analyses an ON an.article_id = a.id AND an.id = (SELECT max(id) FROM analyses WHERE article_id = a.id)
    WHERE a.id > ${cursor}
    ORDER BY a.id
    LIMIT ${BATCH}`;
  if (rows.length === 0) break;
  cursor = rows[rows.length - 1]!.id;
  for (const r of rows) {
    // 标题与 AI 中文标题权重最高的信息都在这里；正文兜底。
    const text = [r.title_zh, r.summary_zh, r.title, r.body_text ?? r.excerpt ?? "", r.x_post ? String(r.x_post.text ?? "") : ""]
      .filter(Boolean).join("\n");
    mentionCount += await recordArticleEntityMentions(r.id, text);
    articleCount += 1;
  }
  console.log(`processed ${articleCount} articles, ${mentionCount} new mention rows`);
}
console.log(`backfill done: ${articleCount} articles, ${mentionCount} new entity_mentions rows`);
await closeDb();

// 存量文章的事实类型回填：claim_type / origin_type / origin_entity（sources/claims.ts 的纯规则分类）。
// 新文章的这两列在 analyze.ts 里随分析写入；这个脚本让改造前已入库的文章立即获得同样的标注，
// 无需重新调用模型。幂等：可重复运行，只写变化过的行。
// 用法：node --env-file=.env scripts/backfill-claim-types.ts [--limit N]
import { closeDb, sql } from "@aihot/backend/db";
import { classifyClaim } from "@aihot/backend/sources/claims";

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : 20_000;

const rows = await sql<{ id: string; title: string; excerpt: string | null; body_text: string | null; category: string | null; tags: string[] | null; title_zh: string | null; summary_zh: string | null; owner_type: string | null }[]>`
  SELECT a.id, a.title, a.excerpt, left(a.body_text, 2000) AS body_text, an.category, an.tags, an.title_zh, an.summary_zh, s.owner_type
  FROM articles a JOIN sources s ON s.id = a.source_id
  LEFT JOIN LATERAL (SELECT category, tags, title_zh, summary_zh FROM analyses x WHERE x.article_id = a.id ORDER BY input_revision DESC, id DESC LIMIT 1) an ON true
  WHERE a.claim_type IS NULL
  ORDER BY a.discovered_at DESC LIMIT ${limit}`;

let updated = 0;
const counts = new Map<string, number>();
for (const r of rows) {
  const claim = classifyClaim({
    title: r.title_zh ?? r.title,
    excerpt: [r.summary_zh, r.excerpt, r.body_text].filter(Boolean).join("\n") || null,
    category: r.category,
    tags: r.tags,
    community: r.owner_type === "community",
  });
  await sql`UPDATE articles SET claim_type = ${claim.claimType}, origin_type = ${claim.originType}, origin_entity = ${claim.originEntity}
            WHERE id = ${r.id} AND claim_type IS NULL`;
  updated += 1;
  counts.set(claim.claimType, (counts.get(claim.claimType) ?? 0) + 1);
}
console.log(`backfilled ${updated} articles of ${rows.length} candidates`);
console.log([...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
await closeDb();
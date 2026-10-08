// P3 migration 0067: score_formula_version / score_components on analyses & publications,
// topic_kind / positions / dispute_status on stories.
// NOTE: 本地无 Postgres，本文件已写好但未执行（跑测试需要 DATABASE_URL 指向 *_test 库）。
// 执行：DATABASE_URL=postgres://127.0.0.1:5432/<名字>_test npm test -- tests/scoring-v2-db.test.ts
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";

const T = `scoring-v2-${tag()}`;

after(closeDb);

async function seedArticle() {
  const sourceId = `${T}-src`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, created_at, next_fetch_at)
            VALUES (${sourceId}, ${sourceId}, 'rss', 'T2', 'editorial', now(), now() + interval '1 hour')
            ON CONFLICT (id) DO NOTHING`;
  const articleId = randomUUID();
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
            VALUES (${articleId}, ${sourceId}, ${articleId}, ${"https://example.invalid/" + articleId},
                    '测试标题', now(), now())`;
  return { sourceId, articleId };
}

test("scoring-v2 db - 旧 analyses 行默认 v1，分量可写 v2", async () => {
  const { articleId } = await seedArticle();
  // 不写新列：旧数据语义
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, score, selected)
            VALUES (${articleId}, 1, 'model', 'pass', 62, false)`;
  const [old] = await sql<{ score_formula_version: string; score_components: unknown }[]>`
    SELECT score_formula_version, score_components FROM analyses WHERE article_id = ${articleId}`;
  assert.equal(old!.score_formula_version, "v1", "旧行默认 v1");
  assert.equal(old!.score_components, null);
  // v2 行：版本 + 分量 round-trip
  const components = { base: 55, official: 8, heat: 6, noise: 5, coverage: "unknown", noiseFlags: ["ad_tail"], heatEvidence: null, reasons: "核心赛果", contentKind: "announcement", needsReview: false, blocked: false };
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, score, selected, score_formula_version, score_components)
            VALUES (${articleId}, 2, 'model', 'pass', 64, true, 'v2', ${sql.json(components as never)})`;
  const [row] = await sql<{ score_formula_version: string; score_components: typeof components }[]>`
    SELECT score_formula_version, score_components FROM analyses WHERE article_id = ${articleId} ORDER BY input_revision DESC LIMIT 1`;
  assert.equal(row!.score_formula_version, "v2");
  assert.deepEqual(row!.score_components, components);
});

test("scoring-v2 db - publications 新列默认 v1", async () => {
  const { articleId } = await seedArticle();
  await sql`INSERT INTO publications (article_id, visibility, eligible, title, url, discovered_at, timeline_at)
            VALUES (${articleId}, 'public', true, '测试标题', 'https://example.invalid/x', now(), now())`;
  const [p] = await sql<{ score_formula_version: string; score_components: unknown }[]>`
    SELECT score_formula_version, score_components FROM publications WHERE article_id = ${articleId}`;
  assert.equal(p!.score_formula_version, "v1");
  assert.equal(p!.score_components, null);
});

test("scoring-v2 db - stories 话题列默认 general/未抽取", async () => {
  const [s] = await sql<{ id: number; topic_kind: string; positions: unknown; dispute_status: unknown }[]>`
    INSERT INTO stories (public_id, title) VALUES (${randomUUID()}, '测试事件') RETURNING id`;
  const [row] = await sql<{ topic_kind: string; positions: unknown; dispute_status: unknown }[]>`
    SELECT topic_kind, positions, dispute_status FROM stories WHERE id = ${s!.id}`;
  assert.equal(row!.topic_kind, "general");
  assert.equal(row!.positions, null, "NULL=尚未抽取");
  assert.equal(row!.dispute_status, null);
  // 争议写入 round-trip
  const positions = [{ stance: "认为判罚有误", holders: ["解说瓶子"], evidence: "第三局回放", source: "官博" }];
  await sql`UPDATE stories SET topic_kind = 'dispute', positions = ${sql.json(positions as never)}, dispute_status = 'ongoing'
            WHERE id = ${s!.id}`;
  const [d] = await sql<{ topic_kind: string; positions: unknown; dispute_status: string }[]>`
    SELECT topic_kind, positions, dispute_status FROM stories WHERE id = ${s!.id}`;
  assert.equal(d!.topic_kind, "dispute");
  assert.deepEqual(d!.positions, positions);
  assert.equal(d!.dispute_status, "ongoing");
});

// Regression for the wave of hardcoded 85-point "AI" analyses. The batch runner
// (scripts/process-all-articles.ts) must send every article through the worker's own pipeline
// (processArticle): no fixed fallback scores, failures observable and retryable, nothing published
// on a failed analysis, existing model analyses and editorial overrides preserved. And
// scripts/publish-all-wechat-articles.ts — whose only write path deleted real analyses and
// re-inserted them as fake origin='model' rows with a tier-based score and a forced 精选 — must
// stay deleted. Each script runs in a worker thread (tests/batch-run-worker.mjs): a fresh module
// registry and database pool against this file's throwaway copy, with every provider stubbed locally.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { stopBoss } from "@aihot/backend/jobs/queue";

const ROOT = path.resolve(import.meta.dirname, "..");
const BATCH_SCRIPT = path.join(ROOT, "scripts", "process-all-articles.ts");
const LEGACY_SCRIPT = path.join(ROOT, "scripts", "publish-all-wechat-articles.ts");
const RUN_WORKER = fileURLToPath(new URL("./batch-run-worker.mjs", import.meta.url));
const QUEUE_MODULE = pathToFileURL(path.join(ROOT, "packages", "backend", "src", "jobs", "queue.ts")).href;
const DB_MODULE = pathToFileURL(path.join(ROOT, "packages", "backend", "src", "db.ts")).href;

const T = tag();
const SOURCE = `test-batch-${T}`;

type Step = "prefilter" | "score" | "understand" | "structure" | "summarize";
const MARKERS = ["BATCHOK", "BATCHFAIL", "BATCHRETRY", "BATCHEXIST", "BATCHLEGACY"];
const scoreAnswers: Record<string, number[]> = { BATCHOK: [78, 72] };

const stepOf = (system: string): Step =>
  system.includes("KPL相关性预筛") ? "prefilter" : system.includes("事件注意力评分器") ? "score"
  : system.includes("内容理解编辑") ? "understand" : system.includes("资料结构化助手") ? "structure" : "summarize";

// Every fixture except BATCHOK sees a provider outage, so its analysis fails.
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const step = stepOf(system);
  const marker = MARKERS.find((m) => user.includes(m)) ?? "";
  const answer = (content: unknown) => ({
    id: `stub-${provider.hits()}`, model: "stub",
    choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  if (marker !== "BATCHOK") return new Reply(500, { error: "provider outage" });
  if (step === "prefilter") return answer({ label: "PASS", reason: "测试" });
  if (step === "score") return answer({ attentionScore: scoreAnswers.BATCHOK!.shift() });
  if (step === "understand") return answer({ itemType: "roster_move", authorRole: "principal", tags: ["阵容转会"], editorialJudgment: "阵容变动", titleZh: `理解标题 ${marker}`, summaryZh: `理解摘要 ${marker}。第二句补充一个关键数字。` });
  if (step === "structure") return answer({ scope: "single", category: "roster", tags: ["阵容转会"], subjects: [], fact: null });
  return answer(`title_zh: 翻译标题 ${marker}\nsummary_zh: 翻译摘要 ${marker}。第二句补充影响。`);
});
for (const name of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[name] = `${provider.url}/v1`;
for (const name of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[name] = "test-key";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, site_fulltext, syndicate_fulltext, next_fetch_at)
            VALUES (${SOURCE}, 'Test batch 公众号', 'mp_account', 'T1', 'editorial', true, true, '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});
afterEach(async () => {
  // The queue schema only exists once a run actually enqueues; tolerate its absence.
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId' IN (SELECT id FROM articles WHERE source_id = ${SOURCE})`.catch(() => {});
});

interface ScriptRun { exit: number; lines: string[]; crash?: string }

/** Runs one of the two fixed repository scripts (never caller input) in its own worker thread. */
function runScript(which: "batch" | "legacy"): Promise<ScriptRun> {
  const url = pathToFileURL(which === "batch" ? BATCH_SCRIPT : LEGACY_SCRIPT).href;
  return new Promise((resolve, reject) => {
    const worker = new Worker(RUN_WORKER, { workerData: { url, queueUrl: QUEUE_MODULE, dbUrl: DB_MODULE } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`${which} script run timed out`));
    }, 120_000);
    worker.once("message", (message: ScriptRun) => {
      clearTimeout(timer);
      resolve(message);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function material(marker: string): Promise<string> {
  return (await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${T}/${marker}`, title: `${marker} 战队发布新阵容 ${T}`,
    bodyText: `${marker}: 官方公众号发布了阵容与赛果说明。`.repeat(6), bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  })).articleId;
}

const count = async (query: PromiseLike<{ n: number }[]>): Promise<number> =>
  (await query)[0]!.n;

test("the batch runner publishes a genuinely analyzed article under the normal scoring rule", async () => {
  const id = await material("BATCHOK");
  const run = await runScript("batch");
  assert.equal(run.exit, 0, `batch exited ${run.exit}${run.crash ? `: ${run.crash}` : ""}\n${run.lines.join("\n")}`);
  const [analysis] = await sql<{ origin: string; model: string | null; score: string | null; selected: boolean | null }[]>`
    SELECT origin, model, score, selected FROM analyses WHERE article_id = ${id} ORDER BY id DESC LIMIT 1`;
  assert.equal(analysis!.origin, "model");
  assert.notEqual(analysis!.model, "kpl-processor");
  assert.equal(Number(analysis!.score), 75, "floor((78+72)/2): the normal two-call mean rule, untouched");
  assert.equal(analysis!.selected, true);
  const [pub] = await sql<{ eligible: boolean; selected: boolean; selection_candidate: boolean; score: string | null }[]>`
    SELECT eligible, selected, selection_candidate, score FROM publications WHERE article_id = ${id}`;
  assert.equal(pub!.eligible, true);
  assert.equal(pub!.selection_candidate, true, "精选 comes from the real scores behind the grouping gate, not from the tier");
  assert.equal(Number(pub!.score), 75);
});

test("an exhausted analysis failure writes no score, publishes nothing and stays observable", async () => {
  const id = await material("BATCHFAIL");
  await sql`UPDATE articles SET processing_attempts = 8 WHERE id = ${id}`; // the next failure exhausts the retries
  const run = await runScript("batch");
  assert.equal(run.exit, 1, `a batch with a failed analysis must exit non-zero${run.crash ? `: ${run.crash}` : ""}\n${run.lines.join("\n")}`);
  assert.ok(run.lines.join("\n").includes(id), "the failure summary must name the failed article");
  assert.equal(await count(sql`SELECT count(*)::int AS n FROM analyses WHERE article_id = ${id}`), 0,
    "no fixed 85/70 or any other fabricated score may be written for a failed analysis");
  assert.equal(await count(sql`SELECT count(*)::int AS n FROM publications WHERE article_id = ${id}`), 0,
    "a failed analysis must not be published");
  const [article] = await sql<{ processing_state: string; processing_error: string | null }[]>`
    SELECT processing_state, processing_error FROM articles WHERE id = ${id}`;
  assert.equal(article!.processing_state, "failed");
  assert.ok(article!.processing_error, "the failure must be observable in processing_error");
});

test("a first analysis failure schedules a retry instead of faking or publishing a score", async () => {
  const id = await material("BATCHRETRY");
  await runScript("batch");
  const [article] = await sql<{ processing_state: string; processing_error: string | null; processing_retry_at: Date | null }[]>`
    SELECT processing_state, processing_error, processing_retry_at FROM articles WHERE id = ${id}`;
  assert.ok(article!.processing_error, "the error must be recorded");
  assert.ok(article!.processing_retry_at, "a retry must be scheduled");
  assert.equal(article!.processing_state, "new", "the repo's retryable state, not a published 'analyzed'");
  assert.equal(await count(sql`SELECT count(*)::int AS n FROM analyses WHERE article_id = ${id}`), 0);
  assert.equal(await count(sql`SELECT count(*)::int AS n FROM publications WHERE article_id = ${id}`), 0);
});

test("a batch run preserves the existing analysis, its publication and the editorial override", async () => {
  const id = await material("BATCHEXIST");
  const [genuine] = await sql<{ id: number }[]>`
    INSERT INTO analyses (article_id, input_revision, origin, model, prompt_version, receipt_ids, relevance, category, title_zh, summary_zh, score, selected, output)
    VALUES (${id}, 1, 'model', 'glm-5.3-flash-selection', 'test', '{1,2}', 'pass', 'match', '真实标题', '真实摘要', 61, false,
            ${sql.json({ scores: [61, 60], scoreModel: "glm-5.3-flash-selection" } as never)})
    RETURNING id`;
  await publishArticle(id);
  await sql`INSERT INTO editorial_overrides (article_id, fields, reason, updated_by) VALUES (${id}, ${sql.json({ score: 88 } as never)}, 'test', 'test')`;
  await publishArticle(id); // re-derive so the stored projection carries the override
  const [before] = await sql<{ analysis_id: number | null }[]>`SELECT analysis_id FROM publications WHERE article_id = ${id}`;
  await runScript("batch");
  const rows = await sql<{ id: number; origin: string; model: string | null; score: string | null }[]>`
    SELECT id, origin, model, score FROM analyses WHERE article_id = ${id}`;
  assert.equal(rows.length, 1, "the existing model analysis must not be deleted or overwritten");
  assert.equal(rows[0]!.id, genuine!.id);
  assert.equal(Number(rows[0]!.score), 61);
  const [pub] = await sql<{ analysis_id: number | null; score: string | null }[]>`
    SELECT analysis_id, score FROM publications WHERE article_id = ${id}`;
  assert.equal(pub!.analysis_id, before!.analysis_id);
  assert.equal(Number(pub!.score), 88, "the editorial override still wins");
  assert.equal((await sql<{ s: string }[]>`SELECT fields->>'score' AS s FROM editorial_overrides WHERE article_id = ${id}`)[0]!.s, "88");
  assert.ok((await sql<{ processing_error: string | null }[]>`SELECT processing_error FROM articles WHERE id = ${id}`)[0]!.processing_error,
    "the failed re-analysis stays observable");
});

test("the legacy bulk publisher stays deleted and nothing fakes model analyses for wechat articles", async () => {
  const id = await material("BATCHLEGACY");
  const [genuine] = await sql<{ id: number }[]>`
    INSERT INTO analyses (article_id, input_revision, origin, model, prompt_version, receipt_ids, relevance, category, title_zh, summary_zh, score, selected, output)
    VALUES (${id}, 1, 'model', 'glm-5.3-flash-selection', 'test', '{1,2}', 'pass', 'match', '真实标题', '真实摘要', 61, false,
            ${sql.json({ scores: [61, 60], scoreModel: "glm-5.3-flash-selection" } as never)})
    RETURNING id`;
  if (existsSync(LEGACY_SCRIPT)) {
    // While the legacy script exists, running it must neither fake nor destroy analyses (it fails this run).
    await runScript("legacy");
  }
  assert.equal(await count(sql`SELECT count(*)::int AS n FROM analyses WHERE model = 'kpl-processor'`), 0,
    "no analysis may impersonate a model that never ran");
  const rows = await sql<{ id: number }[]>`SELECT id FROM analyses WHERE article_id = ${id}`;
  assert.equal(rows.length, 1, "the genuine analysis must survive a bulk run");
  assert.equal(rows[0]!.id, genuine!.id);
  assert.equal(existsSync(LEGACY_SCRIPT), false,
    "scripts/publish-all-wechat-articles.ts (tier-hardcoded 85s, DELETE+re-INSERT, forced 精选, fake origin='model') must stay deleted");
});

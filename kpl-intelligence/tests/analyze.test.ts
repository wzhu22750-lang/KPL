// The judging and writing steps (editorial/analyze.ts): the prefilter decides relevance, the v2 score
// (two independent component calls: base 0-70 + noise flags; the code adds source authority and the
// unknown-heat placeholder, then clamps) decides 精选 against the tier threshold, selected and
// near-selected items are written by the content understanding and the rest by the title/summary
// translation, a structure step gives the category, subjects and fact. Material with only a feed
// summary has its page fetched first. Every prompt in the pack renders.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, buildMaterial, loadAnalyzeInput, normalizeStructure, StructureSchema, tierThreshold } from "@aihot/backend/editorial/analyze";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { compactAnswerFirstSummary, enforceIdentity, MAX_BODY_CHARS, parseTranslateOutput, PREFILTER_SYSTEM } from "@aihot/backend/editorial/writing";
import { promptText } from "@aihot/backend/editorial/prompts";
import { SITE } from "@aihot/industry/site";

const T = tag();
const SOURCE = `test-analyze-${T}`;
const X_SOURCE = `test-analyze-x-${T}`;

type Step = "prefilter" | "score" | "understand" | "summarize" | "structure";
interface Req { step: Step; marker: string; system: string; user: string }
const requests: Req[] = [];
const MARKERS = ["CLEAR", "RESCUE", "LOW", "OFFTOPIC", "BARE", "VAGUE", "THIN", "SENSITIVE", "推文"];
// v2 score bases; each final adds official 8 (T1) + heat 6 (unknown placeholder):
// CLEAR [92,86]→89 ✓ · RESCUE [58,54]→56 near-miss · LOW [44,40]→42 · THIN [84,84]→84 ✓
// SENSITIVE [94,94]→94 ✓ · 推文 verbatim · BARE [44,48]→46 · VAGUE [74,76]→75 ✓
const scoreBases: Record<string, number[]> = { CLEAR: [78, 72], RESCUE: [44, 40], LOW: [30, 26], THIN: [70, 70], SENSITIVE: [80, 80], 推文: [40, 40], BARE: [30, 34], VAGUE: [60, 62] };

const stepOf = (system: string, user: string): Step =>
  system.includes("宽召回") ? "prefilter" : system.includes("评分器") ? "score"
  : system.includes("内容理解编辑") ? "understand" : system.includes("资料结构化助手") ? "structure"
  : user.includes("title_zh") ? "summarize" : (() => { throw new Error("unknown request"); })();

// One stub stands in for DashScope (prefilter, structure), Zhipu (score, understand) and DeepSeek (summarize).
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ role: string; content: unknown }> };
  const system = body.messages[0]!.role === "system" ? String(body.messages[0]!.content) : "";
  const last = body.messages[body.messages.length - 1]!.content;
  const user = typeof last === "string" ? last : JSON.stringify(last);
  const step = stepOf(system, user);
  const marker = MARKERS.find((m) => user.includes(m)) ?? "";
  requests.push({ step, marker, system, user });
  const answer = (content: unknown) => ({ id: `stub-${requests.length}`, model: "stub", choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  if (step === "prefilter") return answer({ label: marker === "OFFTOPIC" || marker === "BARE" ? "BLOCK" : marker === "VAGUE" ? "UNKNOWN" : "PASS", reason: "测试" });
  if (step === "score") return answer({ content_kind: "announcement", base: scoreBases[marker]!.shift(), heat_evidence: "", noise_flags: [], reasons: "测试" });
  if (step === "understand") {
    if (marker === "SENSITIVE") return new Reply(400, { contentFilter: [{ level: 1, role: "user" }], error: { code: "1301", message: "系统检测到输入或生成内容可能包含不安全或敏感内容" } });
    return answer({ itemType: "match_report", authorRole: "principal", tags: ["赛果战报", "成都AG超玩会"], editorialJudgment: `理由 ${marker}`, titleZh: `理解标题 ${marker}`, summaryZh: `理解摘要 ${marker}。第二句补充一个关键数字。` });
  }
  if (step === "structure") return answer({ category: "match-result", tags: ["赛果战报"], subjects: ["ag"], scope: "single", fact: { title: `事实 ${marker}`, subject: "成都AG超玩会", action: "战胜", object: "重庆狼队", occurredAt: null, evidence: "a lab released a model", conditions: [] } });
  return answer(`title_zh: 翻译标题 ${marker}\nsummary_zh: 翻译摘要 ${marker}。第二句补充影响。`);
});
for (const env of ["DASHSCOPE_BASE_URL", "ZHIPU_BASE_URL", "DEEPSEEK_BASE_URL"]) process.env[env] = `${provider.url}/v1`;
for (const env of ["DASHSCOPE_API_KEY", "ZHIPU_API_KEY", "DEEPSEEK_API_KEY"]) process.env[env] = "test-key";

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${SOURCE}, 'Test analyze source', 'rss', 'T1', 'editorial', '2100-01-01'),
    (${X_SOURCE}, 'Test X account', 'x_search', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

// The tag keeps each material unique: identical input would reuse an earlier run's paid answers.
const LONG = "a lab released a model with a benchmark table and pricing details. ".repeat(8);
const article = async (marker: string, extra: Record<string, unknown> = {}) =>
  (await upsertMaterial({
    sourceId: SOURCE, url: `https://example.com/${marker}-${T}`, title: `${marker} model release ${T}`, bodyText: `${marker}: ${LONG} (${T})`,
    bodyStatus: "ok", via: "fetch", publishedAt: new Date("2026-09-28T01:02:03Z"), ...extra,
  } as never)).articleId;
const calls = (marker: string) => requests.filter((r) => r.marker === marker).map((r) => r.step);
const row = async (id: string) =>
  (await sql<{ selected: boolean; relevance: string; score: string | null; title_zh: string; reason_zh: string | null; category: string | null; tags: string[]; subjects: string[]; receipt_ids: string[]; score_formula_version: string; score_components: Record<string, any> | null; output: Record<string, any> }[]>`
    SELECT selected, relevance, score, title_zh, reason_zh, category, tags, subjects, receipt_ids, score_formula_version, score_components, output FROM analyses WHERE article_id = ${id} ORDER BY id DESC LIMIT 1`)[0]!;

test("every prompt in the pack renders, with the site's own name", () => {
  const dir = new URL("../industry/prompts/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  // Every value any prompt asks for, so each renders on its own.
  const names = new Set(files.flatMap((f) => [...readFileSync(new URL(f, dir), "utf8").matchAll(/\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g)].map((m) => m[1]!)));
  const values = Object.fromEntries([...names].map((n) => [n, "x"]));
  for (const file of files) {
    const text = promptText(file.slice(0, -3), values);
    assert.ok(text.length > 20 && !/\{\{/.test(text), file);
  }
  assert.ok(PREFILTER_SYSTEM.startsWith(`为${SITE.name}做宽召回的KPL相关性预筛`));
});

test("a selected item: prefilter, two scores, the content understanding and the structure", async () => {
  assert.equal(tierThreshold("T1"), 58);
  const id = await article("CLEAR");
  const res = await analyzeArticle(id);
  assert.deepEqual([res!.output!.selected, res!.output!.score], [true, 89], "v2 finals 92 + 86 = 178 >= 116");
  assert.deepEqual(calls("CLEAR").sort(), ["prefilter", "score", "score", "structure", "understand"]);
  const r = await row(id);
  assert.deepEqual([r.title_zh, r.reason_zh, r.category, r.receipt_ids.length], ["理解标题 CLEAR", "理由 CLEAR", "match-result", 5]);
  assert.equal(r.score_formula_version, "v2");
  assert.deepEqual([r.score_components!.base, r.score_components!.official, r.score_components!.heat, r.score_components!.noise, r.score_components!.coverage],
    [75, 8, 6, 0, "unknown"], "averaged v2 components on the row");
  assert.equal(res!.output!.scoreFormulaVersion, "v2");
  // Failure case: the writer's independent labels contradict the structural category.
  assert.deepEqual(r.tags, ["赛果战报", "AG"], "category and tags come from the same structural judgement, plus the verified subject tag");
  assert.deepEqual(r.subjects, ["ag"]);
  assert.deepEqual([r.output.writer, r.output.itemType, r.output.prefilter.label, r.output.fact.title], ["understand", "match_report", "PASS", "事实 CLEAR"]);
  assert.equal(r.output.scope, "single");
  assert.equal(r.output.fact.evidence, "a lab released a model");
  const score = requests.find((q) => q.marker === "CLEAR" && q.step === "score")!;
  assert.match(score.user, /【标题】\nCLEAR model release/, "the score reads the original title, before any writing");
  const understand = requests.find((q) => q.marker === "CLEAR" && q.step === "understand")!;
  assert.ok(understand.user.startsWith("请按系统规则理解以下单篇材料，一次返回全部六个字段。"));
  assert.ok(understand.system.includes("【摘要答案前置规则") && understand.system.includes("【标题自洽规则"));
  const prefilter = requests.find((q) => q.marker === "CLEAR" && q.step === "prefilter")!;
  assert.ok(JSON.parse(prefilter.user).includes("【材料质量】"), "the material context, sent as a JSON string");
});

test("structure retains grounded conditions, rejects invented or unseen quotes, and does not infer missing scope", async () => {
  const input = (await loadAnalyzeInput(await article("CONDITIONS", {
    bodyText: "Preview is free for Pro users until October 10.\n" + "x".repeat(11000) + "\nOnly available in the US. " + "x".repeat(MAX_BODY_CHARS) + "This late detail was not sent.",
  })))!;
  input.translationZh = "仅中文译文中出现的限制";
  const frame = { title: "预览上线", evidence: "Preview is free for Pro users until October 10.", conditions: [
    { text: "仅Pro用户，免费至10月10日", quote: "Preview is free for Pro users until October 10." },
    { text: "仅限美国", quote: "Only available in the US." },
    { text: "无限免费", quote: "Unlimited free access for everyone." },
    { text: "不在模型输入里的句子", quote: "This late detail was not sent." },
  ] };
  const base = { category: "match-result", tags: [], subjects: [], fact: frame };
  const out = normalizeStructure(StructureSchema.parse(base), input);
  assert.ok(buildMaterial(input).includes("Only available in the US."), "a condition after the old 7000-character cutoff reaches the model");
  assert.ok(buildMaterial(input).includes("后文未提供"));
  assert.equal(out.scope, "unknown", "an older result with a fact is not proof of single scope");
  assert.deepEqual(out.fact?.conditions, frame.conditions.slice(0, 2));
  assert.equal(out.fact?.evidence, frame.evidence);
  const partial = normalizeStructure(StructureSchema.parse({ ...base, fact: { ...frame, conditions: [
    { quote: "x".repeat(401) },
    { quote: "Preview is free... until October 10." },
    { quote: "Only available in the US." },
  ] } }), input);
  assert.deepEqual(partial.fact?.conditions, [{ text: "Only available in the US.", quote: "Only available in the US." }],
    "an invalid sibling cannot discard a valid original condition; spliced quotes remain rejected");
  const invented = normalizeStructure(StructureSchema.parse({ ...base, fact: { ...frame, evidence: input.source.name, conditions: [{ text: "翻译限制", quote: input.translationZh }] } }), input);
  assert.equal(invented.fact?.evidence, null, "source metadata is not original evidence");
  assert.deepEqual(invented.fact?.conditions, [], "a translation does not count as an original quote");
  assert.equal(normalizeStructure(StructureSchema.parse({ ...base, scope: "composite" }), input).fact, null, "composite output cannot also claim one fact");
  const titleOnly = normalizeStructure(StructureSchema.parse({ ...base, scope: "single" }), { ...input, bodyText: null, excerpt: null });
  assert.equal(titleOnly.scope, "unknown", "a confident model cannot supply the missing original material");
  assert.equal(titleOnly.fact, null);
});

test("a near-selected item is written like a selected one; below the floor it is translated", async () => {
  const near = await analyzeArticle(await article("RESCUE"));
  assert.deepEqual([near!.output!.selected, near!.output!.reasonZh], [false, "理由 RESCUE"], "v2 finals 58 + 54 = 112 < 116 but > 100: near-selected, written like selected");
  const lowId = await article("LOW");
  const low = await analyzeArticle(lowId);
  assert.deepEqual([low!.output!.selected, low!.output!.titleZh, low!.output!.reasonZh], [false, "翻译标题 LOW", null]);
  assert.deepEqual(calls("LOW").sort(), ["prefilter", "score", "score", "structure", "summarize"]);
  assert.deepEqual((await row(lowId)).tags, ["赛果战报", "AG"], "structure tags");
});

test("the prefilter's BLOCK stops everything; UNKNOWN goes on like PASS", async () => {
  const off = await analyzeArticle(await article("OFFTOPIC"));
  assert.deepEqual([off!.output!.relevance, off!.output!.selected], ["block", false]);
  assert.deepEqual(calls("OFFTOPIC"), ["prefilter"]);
  // An UNKNOWN with material is judged and written like a PASS, up to 精选 (v2 finals 74 + 76 ≥ 2 × 58).
  const vagueId = await article("VAGUE");
  const vague = await analyzeArticle(vagueId);
  assert.deepEqual([vague!.output!.relevance, vague!.output!.selected, vague!.output!.titleZh], ["pass", true, "理解标题 VAGUE"]);
  assert.equal((await row(vagueId)).output.prefilter.label, "UNKNOWN", "the prefilter's own answer stays on record");
  // Nothing but a title and no page to fetch: the BLOCK counts as UNKNOWN and is scored, but the
  // translation writes nothing from a bare title, so it waits for material instead of being published.
  const bare = await analyzeArticle(await article("BARE", { bodyText: null, excerpt: null, bodyStatus: "none" }));
  assert.deepEqual([bare!.output!.relevance, bare!.output!.selected, bare!.output!.score], ["unknown", false, 46]);
  assert.deepEqual(calls("BARE").sort(), ["prefilter", "score", "score", "structure"]);
});

test("a feed summary alone: the article page is fetched first, then the whole article is judged", async () => {
  const id = await article("THIN", { bodyText: null, bodyStatus: "pending", excerpt: `THIN: a short feed summary (${T}).` });
  // The queue sends it to extraction although its source does not ask for full text (the sweep does
  // the same after a failed fetch, so extraction failures add up to "unconfirmed" and end).
  await queueProcessing(id);
  const [job] = await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE data->>'articleId' = ${id}`;
  assert.equal(job?.name, QUEUES.extractBody);
  const first = await analyzeArticle(id);
  assert.deepEqual([first!.needsBody, first!.output], [true, null]);
  assert.deepEqual(calls("THIN"), [], "no model call before the page");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${id}`).length, 0, "nothing committed");
  // What extraction does: the body lands as a new revision.
  await sql`UPDATE articles SET body_text = ${`THIN: ${LONG} (${T}) full page`}, body_status = 'ok', revision = revision + 1 WHERE id = ${id}`;
  const second = await analyzeArticle(id);
  assert.deepEqual([second!.needsBody ?? false, second!.output!.selected], [false, true]);
});

test("a short post in Chinese is its own copy; a content-filter refusal is translated instead", async () => {
  // The tag rides as a hashtag, which the language check strips.
  const text = `推文：今天把智能体接进了工作流，效果不错。#t${T}`;
  const { articleId } = await upsertMaterial({
    sourceId: X_SOURCE, url: `https://x.com/test/status/1${Date.now()}`, title: text, via: "fetch", publishedAt: new Date(),
    xPost: { tweetId: `1${Date.now()}`, authorName: "测试", handle: "test", text },
  });
  const post = await analyzeArticle(articleId);
  assert.deepEqual([post!.output!.titleZh, post!.output!.summaryZh], [text, text]);
  assert.ok(!calls("推文").includes("summarize"), "no translation call");
  const sensitive = await analyzeArticle(await article("SENSITIVE"));
  assert.deepEqual([sensitive!.output!.selected, sensitive!.output!.titleZh], [true, "翻译标题 SENSITIVE"]);
  assert.deepEqual(calls("SENSITIVE").filter((s) => s === "understand" || s === "summarize"), ["understand", "summarize"]);
});

test("guards: a company the input does not name is not written in; long summaries are cut at sentences", () => {
  const input = { title: "某战队发布新公告", text: "某战队发布了一个新公告，名单和赛程都有说明。", sourceKind: "rss" };
  const guarded = enforceIdentity(input, { titleZh: "重庆狼队发布新公告", summaryZh: "某战队发布新公告。" });
  assert.deepEqual([guarded.titleZh, guarded.summaryZh, guarded.identityGuard.outcome], ["某战队发布新公告", "某战队发布新公告。", "fallback"]);
  // The identity lexicon: a Chinese rendering of a company the input names in English is no invention.
  const ag = { title: "AG ships a new roster", text: "AG released a new roster with player details.", sourceKind: "rss" };
  assert.equal(enforceIdentity(ag, { titleZh: "成都AG超玩会公布大名单", summaryZh: "成都AG超玩会公布了大名单并确认首发。" }).identityGuard.outcome, "pass");
  const long = "第一句交代了谁做了什么以及关键结果，这一句本身已经足够说明核心事件的来龙去脉。".repeat(3) + "第二句补充数字。".repeat(20);
  assert.ok(compactAnswerFirstSummary(long).length <= 190);
  assert.deepEqual(parseTranslateOutput("title_zh: 标题\nsummary_zh: 第一句。\n第二句。"), { titleZh: "标题", summaryZh: "第一句。\n第二句。", bodyZh: "" });
  assert.equal(parseTranslateOutput("title_zh: 标题\nbody_zh: 我们懂你。\n\n来源：X：PixVerse (@PixVerse)").bodyZh, "我们懂你。", "a repeated prompt line is dropped");
});

test("analysing the same revision again reuses every paid answer", async () => {
  scoreBases.CLEAR = [80, 70];
  const id = await article("CLEAR", { url: `https://example.com/CLEAR-again-${T}`, title: `CLEAR model release again ${T}` });
  const first = await analyzeArticle(id);
  assert.equal(first!.reused, false);
  const hits = provider.hits();
  const again = await analyzeArticle(id);
  assert.equal(provider.hits(), hits, "no new requests");
  assert.deepEqual([again!.reused, again!.receiptIds], [true, first!.receiptIds]);
});

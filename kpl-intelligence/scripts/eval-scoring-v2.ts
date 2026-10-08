// v1/v2 scoring comparison for the P3 recalibration: the same gold samples run through the old
// formula (industry/prompts/selection-score-v1.md → attentionScore, two calls, mean) and the new
// one (editorial/analyze.ts runSelectionScores → v2 finals, two calls, mean), then the scores,
// decisions and rankings are diffed with reasons. Heat is the 'unknown' placeholder on both
// sides here — the post-grouping heat refinement is not part of this comparison.
// Usage: MODEL_CALLS_ENABLED=true node --env-file=.env scripts/eval-scoring-v2.ts --gold .data/gold.jsonl [--models glm-5.3-flash-selection] [--n 200] [--label "..."]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";
import {
  buildScoreInput, runSelectionScores, tierThreshold, type AnalyzeInputArticle,
} from "@aihot/backend/editorial/analyze";
import { HEAT_UNKNOWN_VALUE, type ScoreComponents } from "@aihot/backend/editorial/scoring-v2";
import { modelFor } from "@aihot/backend/editorial/models";
import { chatJson } from "@aihot/backend/providers/llm";
import { promptText, promptVersion } from "@aihot/backend/editorial/prompts";

const { values } = parseArgs({
  options: {
    gold: { type: "string", default: ".data/gold.jsonl" },
    models: { type: "string" },
    n: { type: "string", default: "200" },
    concurrency: { type: "string", default: "6" },
    seed: { type: "string", default: "7" },
    label: { type: "string" },
  },
});

interface GoldRow {
  caseId: string;
  material: { title: string; originalTitle: string | null; publishedAt: string | null; sourceName: string; bodyZh: string | null; bodyOriginal: string | null };
  sourceFacts: { sourceKind: string; sourceTier?: string; firstParty?: boolean; language?: string | null; sourceRole?: string; ownerType?: string; isRelay?: boolean };
  samplingContext?: { benchmarkSplit?: string; samplingStratum?: string };
  gold: { decision: "select" | "reject" | "either" };
}

const rows: GoldRow[] = readFileSync(path.resolve(REPO_ROOT, values.gold!), "utf8")
  .split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).map((l) => JSON.parse(l));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const rand = rng(Number(values.seed));
const sample = rows.map((r) => ({ r, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.r).slice(0, Number(values.n));

function toInput(r: GoldRow): AnalyzeInputArticle {
  const m = r.material;
  const isX = r.sourceFacts.sourceKind === "x_search";
  const body = m.bodyOriginal || m.bodyZh || null;
  return {
    id: `gold-${r.caseId}`,
    revision: 1,
    bodyStatus: "ok",
    title: m.originalTitle || m.title,
    url: "https://example.invalid/" + r.caseId,
    author: null,
    publishedAt: m.publishedAt ? new Date(m.publishedAt) : null,
    bodyText: isX ? null : body,
    excerpt: null,
    xPost: isX ? { authorName: m.sourceName, handle: "", text: body ?? m.title } : null,
    media: [],
    source: {
      name: m.sourceName, kind: r.sourceFacts.sourceKind, tier: r.sourceFacts.sourceTier ?? "T2",
      firstParty: r.sourceFacts.firstParty ?? false, role: r.sourceFacts.sourceRole ?? null,
      ownerType: r.sourceFacts.ownerType ?? null, isRelay: r.sourceFacts.isRelay ?? false,
    },
  };
}

async function pmap<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  }));
  return out;
}

// ---- v1: the archived prompt, two attentionScore calls, mean decides ----
const V1_SYSTEM = promptText("selection-score-v1");
const V1_VERSION = promptVersion("selection-score-v1");
const V1Schema = z.object({ attentionScore: z.coerce.number().int().min(0).max(100) });

async function runV1(a: AnalyzeInputArticle, model: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < 2; i++) {
    const res = await chatJson({
      model, purpose: "score_article", subject: `article:${a.id}@${a.revision}`, promptVersion: V1_VERSION,
      system: V1_SYSTEM, user: buildScoreInput(a), schema: V1Schema,
      temperature: 0.2, maxTokens: 1024, timeoutMs: 120_000, attemptTag: `v1-score-${i + 1}`,
    });
    out.push(res.data.attentionScore);
  }
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

interface CaseResult {
  caseId: string;
  title: string;
  gold: string;
  tier: string;
  threshold: number | null;
  v1mean: number | null;
  v1decision: boolean | null;
  v2mean: number | null;
  v2decision: boolean | null;
  v2blocked: boolean;
  v2needsReview: boolean;
  components: ScoreComponents | null;
  error: string | null;
}

const models = values.models
  ? values.models.split(",").map((m) => m.trim()).filter(Boolean)
  : [await modelFor("score")];
if (!models.length) throw new Error("--models did not name any models");

const all: Record<string, { cases: CaseResult[] }> = {};
for (const model of models) {
  const cases = await pmap(sample, Number(values.concurrency), async (r): Promise<CaseResult> => {
    const input = toInput(r);
    const threshold = tierThreshold(input.source.tier);
    const base: CaseResult = {
      caseId: r.caseId, title: r.material.title, gold: r.gold.decision, tier: input.source.tier, threshold,
      v1mean: null, v1decision: null, v2mean: null, v2decision: null,
      v2blocked: false, v2needsReview: false, components: null, error: null,
    };
    try {
      const v1 = await runV1(input, model);
      base.v1mean = mean(v1);
      base.v1decision = threshold !== null && mean(v1) >= threshold;
      const v2 = await runSelectionScores(input, { scoreModel: model });
      if (v2 && !v2.refused && v2.values.length === 2) {
        base.v2mean = mean(v2.values);
        base.v2decision = threshold !== null && !v2.components?.blocked && mean(v2.values) >= threshold;
        base.v2blocked = v2.components?.blocked ?? false;
        base.v2needsReview = v2.components?.needsReview ?? false;
        base.components = v2.components ?? null;
      } else {
        base.error = v2?.refused ? "v2 refused by content filter" : "v2 failed";
      }
    } catch (error) {
      base.error = String(error).slice(0, 200);
    }
    return base;
  });
  all[model] = { cases };
}

function rankOf(cases: CaseResult[], key: "v1mean" | "v2mean"): Map<string, number> {
  const sorted = cases.filter((c) => c[key] !== null).sort((a, b) => (b[key] as number) - (a[key] as number));
  return new Map(sorted.map((c, i) => [c.caseId, i + 1]));
}

const label = values.label?.trim() || "all";
const outDir = path.join(REPO_ROOT, ".data/eval");
mkdirSync(outDir, { recursive: true });

for (const model of models) {
  const cases = all[model]!.cases;
  const ok = cases.filter((c) => !c.error);
  const r1 = rankOf(ok, "v1mean");
  const r2 = rankOf(ok, "v2mean");
  let rankMoves = 0, decisionFlips = 0, sumAbsScoreDiff = 0, nDiff = 0;
  for (const c of ok) {
    if (c.v1mean !== null && c.v2mean !== null) { sumAbsScoreDiff += Math.abs(c.v1mean - c.v2mean); nDiff++; }
    if ((r1.get(c.caseId) ?? 0) !== (r2.get(c.caseId) ?? 0)) rankMoves++;
    if (c.v1decision !== c.v2decision) decisionFlips++;
  }
  const summary = {
    model, label, n: cases.length, ok: ok.length, errors: cases.length - ok.length,
    meanAbsScoreDiff: nDiff ? +(sumAbsScoreDiff / nDiff).toFixed(2) : null,
    rankMoves, decisionFlips,
    heatNote: `heat is the unknown placeholder (${HEAT_UNKNOWN_VALUE}) on both sides; post-grouping refinement not compared`,
    thresholds: "SELECTION 58/64/74 unchanged (v1 scale); v2 thresholds pending recalibration",
  };
  console.log(JSON.stringify(summary));
  const md = [
    `# 评分 v1/v2 对照（${label}）`, ``,
    `- 模型：${model}；样本：${cases.length}（有效 ${ok.length}，失败 ${cases.length - ok.length}）`,
    `- 平均绝对分差：${summary.meanAbsScoreDiff}；排序变动：${rankMoves}；精选决策翻转：${decisionFlips}`,
    `- heat 说明：两侧均为 unknown 占位（${HEAT_UNKNOWN_VALUE}），归组后的热度修正不在本次对照内`,
    `- 阈值：SELECTION 58/64/74（v1 尺度）暂保留；v2 阈值待重校准`, ``,
    `| case | 标题 | gold | tier | v1 均分 | v2 均分 | 分差 | v1 决策 | v2 决策 | base/official/heat/noise | 内容类型 | 噪声旗标 | v2 理由 |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...ok.map((c) => {
      const k = c.components;
      const comp = k ? `${k.base}/${k.official}/${k.heat}/${k.noise}` : "-";
      return `| ${c.caseId} | ${c.title.slice(0, 24)} | ${c.gold} | ${c.tier} | ${c.v1mean?.toFixed(1) ?? "-"} | ${c.v2mean?.toFixed(1) ?? "-"} | ${c.v1mean !== null && c.v2mean !== null ? (c.v2mean - c.v1mean).toFixed(1) : "-"} | ${c.v1decision ? "入选" : "落选"} | ${c.v2blocked ? "拦截" : c.v2needsReview ? "待复核" : c.v2decision ? "入选" : "落选"} | ${comp} | ${k?.contentKind ?? "-"} | ${(k?.noiseFlags ?? []).join(",") || "-"} | ${(k?.reasons ?? "").slice(0, 40)} |`;
    }),
  ].join("\n");
  const outPath = path.join(outDir, `scoring-v2-${label.replace(/[^A-Za-z0-9_-]+/g, "-")}.md`);
  writeFileSync(outPath, md);
  writeFileSync(outPath.replace(/\.md$/, ".json"), JSON.stringify({ summary, cases }, null, 1));
  console.log(`report: ${outPath}`);
}

await closeDb();

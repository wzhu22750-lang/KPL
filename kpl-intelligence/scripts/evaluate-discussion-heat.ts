#!/usr/bin/env node
/**
 * Offline Evaluation Script for DiscussionHeatScore
 *
 * Reads labelled JSONL snapshots (supports synthetic benchmark fixtures), uses NO model, and outputs:
 * 1. Rankings (sorted by DiscussionHeatScore)
 * 2. Metrics:
 *    - Missing coverage (observed vs missing snapshots)
 *    - Pairwise ranking metrics (concordant/discordant order vs ground truth)
 * 3. Error on empty set
 * 4. Optional Markdown report (--report <path>)
 *
 * Offline only: never deploy production weights without calibrated holdout.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  calculateDiscussionHeatScore,
  type DiscussionItemInput,
  type DiscussionHeatResult,
} from '../packages/backend/src/editorial/discussion-heat.ts';
import {
  DISCUSSION_HEAT_CONFIG,
  assertOfflineUsage,
  type DiscussionHeatConfig,
} from '../industry/discussion-heat.ts';

export interface LabelledDiscussionRecord extends DiscussionItemInput {
  goldScore?: number | null;
  goldRank?: number | null;
  label?: string | number | null;
  labelType?: string | null;
}

export interface PairwiseMetrics {
  totalPairs: number;
  concordantPairs: number;
  discordantPairs: number;
  tiedPairs: number;
  pairwiseAccuracy: number;
  kendallsTau: number;
}

export interface CoverageMetrics {
  totalItems: number;
  observedCount: number;
  observedPercentage: number;
  missingCount: number;
  missingPercentage: number;
  partialCount: number;
  partialPercentage: number;
  anomalyCount: number;
  anomalyPercentage: number;
}

export interface EvaluationOptions {
  reportPath?: string | null;
  topCount?: number;
  configOverrides?: Partial<DiscussionHeatConfig>;
  silent?: boolean;
  synthetic?: boolean;
  at?: Date | string | null;
}

export interface EvaluationOutput {
  results: DiscussionHeatResult[];
  rankings: Array<{ rank: number; item: DiscussionHeatResult; goldRank?: number | null; goldScore?: number | null }>;
  coverage: CoverageMetrics;
  pairwise: PairwiseMetrics | null;
  reportMarkdown?: string;
  referenceTime: Date;
  isSynthetic: boolean;
}

export function parseJsonlRecords(content: string): LabelledDiscussionRecord[] {
  const lines = content.split('\n');
  const records: LabelledDiscussionRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]?.trim();
    if (!raw || raw.startsWith('//') || raw.startsWith('#')) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      records.push(parsed);
    } catch (err) {
      throw new Error(`JSONL syntax error on line ${i + 1}: ${(err as Error).message}`);
    }
  }

  return records;
}

function extractGoldPreference(record: LabelledDiscussionRecord): number | null {
  if (typeof record.goldScore === 'number' && Number.isFinite(record.goldScore)) {
    return record.goldScore;
  }
  if (typeof record.goldRank === 'number' && Number.isFinite(record.goldRank)) {
    return -record.goldRank; // lower rank number means higher preference
  }
  if (typeof record.label === 'number' && Number.isFinite(record.label)) {
    return record.label;
  }
  if (typeof record.label === 'string') {
    const lower = record.label.toLowerCase();
    if (lower === 'hot' || lower === 'high' || lower === 'tier1' || lower === 'select') return 3;
    if (lower === 'warm' || lower === 'medium' || lower === 'tier2') return 2;
    if (lower === 'cold' || lower === 'low' || lower === 'tier3' || lower === 'reject') return 1;
  }
  return null;
}

export function evaluateDiscussionHeatRecords(
  records: LabelledDiscussionRecord[],
  options: EvaluationOptions = {}
): EvaluationOutput {
  if (!records || records.length === 0) {
    throw new Error('Evaluation error: Empty set. Input JSONL has no records.');
  }

  const config: DiscussionHeatConfig = {
    ...DISCUSSION_HEAT_CONFIG,
    ...options.configOverrides,
  };
  assertOfflineUsage(config);

  // Determine deterministic reference time for historical samples (NO Date.now!)
  let referenceTime: Date;
  if (options.at) {
    referenceTime = new Date(options.at);
  } else {
    let maxTime = -1;
    for (const r of records) {
      for (const s of r.snapshots ?? []) {
        const t = new Date(s.observedAt).getTime();
        if (!Number.isNaN(t) && t > maxTime) maxTime = t;
      }
      if (r.publishedAt) {
        const t = new Date(r.publishedAt).getTime();
        if (!Number.isNaN(t) && t > maxTime) maxTime = t;
      }
    }
    if (maxTime > 0) {
      referenceTime = new Date(maxTime);
    } else {
      referenceTime = new Date('2026-10-09T14:00:00Z');
    }
  }

  const isSynthetic = Boolean(
    options.synthetic || records.some((r) => r.labelType === 'synthetic')
  );

  const results: DiscussionHeatResult[] = [];
  const goldMap = new Map<string, { goldScore?: number | null; goldRank?: number | null }>();

  for (const record of records) {
    const res = calculateDiscussionHeatScore(record, config, referenceTime);
    results.push(res);
    goldMap.set(record.id, {
      goldScore: typeof record.goldScore === 'number' ? record.goldScore : null,
      goldRank: typeof record.goldRank === 'number' ? record.goldRank : null,
    });
  }

  // 1. Missing coverage metrics
  let observedCount = 0;
  let missingCount = 0;
  let partialCount = 0;
  let anomalyCount = 0;

  for (const r of results) {
    if (r.heatCoverage === 'observed') observedCount++;
    else if (r.heatCoverage === 'missing') missingCount++;
    else if (r.heatCoverage === 'partial') partialCount++;

    if (r.hasAnomaly) anomalyCount++;
  }

  const total = results.length;
  const coverage: CoverageMetrics = {
    totalItems: total,
    observedCount,
    observedPercentage: Math.round((observedCount / total) * 1000) / 10,
    missingCount,
    missingPercentage: Math.round((missingCount / total) * 1000) / 10,
    partialCount,
    partialPercentage: Math.round((partialCount / total) * 1000) / 10,
    anomalyCount,
    anomalyPercentage: Math.round((anomalyCount / total) * 1000) / 10,
  };

  // 2. Rankings (score descending, missing heat placed at end)
  const sorted = [...results].sort((a, b) => {
    if (a.totalScore === null && b.totalScore === null) return 0;
    if (a.totalScore === null) return 1;
    if (b.totalScore === null) return -1;
    return b.totalScore - a.totalScore;
  });

  const rankings = sorted.map((item, idx) => ({
    rank: idx + 1,
    item,
    goldRank: goldMap.get(item.id)?.goldRank ?? null,
    goldScore: goldMap.get(item.id)?.goldScore ?? null,
  }));

  // 3. Pairwise ranking metrics (if labels provided)
  const labeledItems: Array<{ id: string; predictedScore: number; goldPref: number }> = [];
  for (const record of records) {
    const goldPref = extractGoldPreference(record);
    const evalRes = results.find((r) => r.id === record.id);
    if (goldPref !== null && evalRes && evalRes.totalScore !== null) {
      labeledItems.push({
        id: record.id,
        predictedScore: evalRes.totalScore,
        goldPref,
      });
    }
  }

  let pairwise: PairwiseMetrics | null = null;
  if (labeledItems.length >= 2) {
    let concordant = 0;
    let discordant = 0;
    let tied = 0;
    let totalPairs = 0;

    for (let i = 0; i < labeledItems.length; i++) {
      for (let j = i + 1; j < labeledItems.length; j++) {
        const a = labeledItems[i]!;
        const b = labeledItems[j]!;

        // Ground truth strictly prefers one over the other
        if (a.goldPref !== b.goldPref) {
          totalPairs++;
          const actualOrder = a.goldPref > b.goldPref ? 1 : -1;
          const predOrder = a.predictedScore > b.predictedScore ? 1 : a.predictedScore < b.predictedScore ? -1 : 0;

          if (predOrder === 0) {
            tied++;
          } else if (actualOrder === predOrder) {
            concordant++;
          } else {
            discordant++;
          }
        }
      }
    }

    if (totalPairs > 0) {
      pairwise = {
        totalPairs,
        concordantPairs: concordant,
        discordantPairs: discordant,
        tiedPairs: tied,
        pairwiseAccuracy: Math.round(((concordant + 0.5 * tied) / totalPairs) * 1000) / 1000,
        kendallsTau: Math.round(((concordant - discordant) / totalPairs) * 1000) / 1000,
      };
    }
  }

  // 4. Generate Markdown report
  const reportMarkdown = generateMarkdownReport({
    config,
    coverage,
    pairwise,
    rankings,
    topCount: options.topCount ?? 20,
    referenceTime,
    isSynthetic,
  });

  if (options.reportPath) {
    writeFileSync(options.reportPath, reportMarkdown, 'utf8');
  }

  return {
    results,
    rankings,
    coverage,
    pairwise,
    reportMarkdown,
    referenceTime,
    isSynthetic,
  };
}

export function evaluateDiscussionHeatFile(
  filePath: string,
  options: EvaluationOptions = {}
): EvaluationOutput {
  if (!existsSync(filePath)) {
    throw new Error(`Evaluation error: File not found: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf8');
  const records = parseJsonlRecords(content);
  return evaluateDiscussionHeatRecords(records, options);
}

function generateMarkdownReport(data: {
  config: DiscussionHeatConfig;
  coverage: CoverageMetrics;
  pairwise: PairwiseMetrics | null;
  rankings: Array<{ rank: number; item: DiscussionHeatResult; goldRank?: number | null; goldScore?: number | null }>;
  topCount: number;
  referenceTime: Date;
  isSynthetic: boolean;
}): string {
  const { config, coverage, pairwise, rankings, topCount, referenceTime, isSynthetic } = data;
  const topItems = rankings.slice(0, topCount);

  let md = `# DiscussionHeatScore Offline Evaluation Report\n\n`;
  md += `> **Offline Experimental Model**: Version \`${config.version}\`\n`;
  md += `> Evaluation Reference Time: \`${referenceTime.toISOString()}\` (deterministic)\n`;
  md += `> Benchmark Ground Truth: **${isSynthetic ? 'SYNTHETIC BENCHMARK FIXTURE (NOT ACTUAL USER LABELS)' : 'Empirical Dataset'}**\n`;
  md += `> Production Rollout: **DISABLED** (Never deploy without calibrated holdout)\n\n`;

  md += `## 1. Coverage Metrics\n\n`;
  md += `| Metric | Count | Percentage |\n`;
  md += `| :--- | :--- | :--- |\n`;
  md += `| Total Snapshots Evaluated | ${coverage.totalItems} | 100% |\n`;
  md += `| Observed Interaction Heat | ${coverage.observedCount} | ${coverage.observedPercentage}% |\n`;
  md += `| Partial Interaction Metrics | ${coverage.partialCount} | ${coverage.partialPercentage}% |\n`;
  md += `| Missing Heat (Unobserved / Null) | ${coverage.missingCount} | ${coverage.missingPercentage}% |\n`;
  md += `| Metric Anomaly Detected | ${coverage.anomalyCount} | ${coverage.anomalyPercentage}% |\n\n`;

  if (pairwise) {
    const labelHeader = isSynthetic
      ? '## 2. Pairwise Ranking Evaluation (Synthetic Benchmark Labels)\n\n'
      : '## 2. Pairwise Ranking Evaluation (Labelled Ground Truth)\n\n';
    md += labelHeader;
    md += `| Pairwise Metric | Value |\n`;
    md += `| :--- | :--- |\n`;
    md += `| Evaluated Labelled Pairs | ${pairwise.totalPairs} |\n`;
    md += `| Concordant Pairs (Correct Order) | ${pairwise.concordantPairs} |\n`;
    md += `| Discordant Pairs (Inverted Order) | ${pairwise.discordantPairs} |\n`;
    md += `| Tied Predictions | ${pairwise.tiedPairs} |\n`;
    md += `| **Pairwise Ranking Accuracy** | **${(pairwise.pairwiseAccuracy * 100).toFixed(1)}%** |\n`;
    md += `| **Kendall's Tau Correlation** | **${pairwise.kendallsTau.toFixed(3)}** |\n\n`;
  } else {
    md += `## 2. Pairwise Ranking Evaluation\n\n*No preference labels detected in dataset. Pairwise ranking metrics skipped.*\n\n`;
  }

  md += `## 3. Top Ranked Discussions (Top ${topItems.length})\n\n`;
  md += `| Rank | Score | Platform | Heat | Growth | Value | Quality | Rel | Conf | Title | Anomalies |\n`;
  md += `| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- | :--- |\n`;

  for (const r of topItems) {
    const it = r.item;
    const scoreText = it.totalScore === null ? '*NULL*' : it.totalScore.toString();
    const heatText = it.factors.heat === null ? '*null*' : it.factors.heat.toString();
    const growthText = it.factors.growth === null ? '*null*' : it.factors.growth.toString();
    const valueText = it.factors.value === null ? '*null*' : it.factors.value.toString();
    const anomaliesText = it.anomalies.length > 0 ? it.anomalies.map((a) => a.split(':')[0]).join(',') : '-';
    const cleanTitle = it.title.replace(/\|/g, '-').slice(0, 40);

    md += `| ${r.rank} | ${scoreText} | ${it.platform} | ${heatText} | ${growthText} | ${valueText} | ${it.factors.quality} | ${it.factors.relevance} | ${it.factors.confidence} | ${cleanTitle} | ${anomaliesText} |\n`;
  }

  return md;
}

// CLI Execution entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { values, positionals } = parseArgs({
      options: {
        file: { type: 'string', short: 'f' },
        report: { type: 'string', short: 'r' },
        top: { type: 'string', short: 'n', default: '20' },
        config: { type: 'string', short: 'c' },
        silent: { type: 'boolean', default: false },
        synthetic: { type: 'boolean', default: false },
        at: { type: 'string' },
      },
      allowPositionals: true,
    });

    const targetFile = values.file || positionals[0];
    if (!targetFile) {
      console.error('Error: Please specify an input JSONL file via --file <path> or positional argument.');
      console.error('Usage: node scripts/evaluate-discussion-heat.ts --file data/snapshots.jsonl [--report report.md] [--synthetic] [--at <ISO-time>]');
      process.exit(1);
    }

    let configOverrides: Partial<DiscussionHeatConfig> | undefined;
    if (values.config) {
      const cfgRaw = readFileSync(values.config, 'utf8');
      configOverrides = JSON.parse(cfgRaw);
    }

    const output = evaluateDiscussionHeatFile(path.resolve(targetFile), {
      reportPath: values.report ? path.resolve(values.report) : null,
      topCount: parseInt(values.top || '20', 10),
      configOverrides,
      silent: values.silent,
      synthetic: values.synthetic,
      at: values.at ? new Date(values.at) : null,
    });

    if (!values.silent) {
      console.log('\n======================================================');
      console.log('       DiscussionHeatScore Offline Evaluation');
      console.log('======================================================');
      console.log(`Reference Time: ${output.referenceTime.toISOString()} (deterministic)`);
      console.log(`Labels Source:  ${output.isSynthetic ? 'SYNTHETIC BENCHMARK FIXTURE (NOT USER LABELS)' : 'User / Empirical Labels'}`);
      console.log(`Evaluated ${output.coverage.totalItems} items:`);
      console.log(`  - Observed Heat: ${output.coverage.observedCount} (${output.coverage.observedPercentage}%)`);
      console.log(`  - Missing Heat:  ${output.coverage.missingCount} (${output.coverage.missingPercentage}%)`);
      console.log(`  - Partial Keys:  ${output.coverage.partialCount} (${output.coverage.partialPercentage}%)`);
      console.log(`  - Anomalies:     ${output.coverage.anomalyCount} (${output.coverage.anomalyPercentage}%)`);

      if (output.pairwise) {
        console.log(`\nPairwise ${output.isSynthetic ? 'Synthetic' : 'Ground Truth'} Ranking Metrics:`);
        console.log(`  - Evaluated Pairs:   ${output.pairwise.totalPairs}`);
        console.log(`  - Pairwise Accuracy: ${(output.pairwise.pairwiseAccuracy * 100).toFixed(1)}%`);
        console.log(`  - Kendall's Tau:     ${output.pairwise.kendallsTau.toFixed(3)}`);
      }

      console.log('\nTop Ranked Items:');
      for (const r of output.rankings.slice(0, 10)) {
        const s = r.item.totalScore !== null ? `${r.item.totalScore} pts` : '[MISSING HEAT]';
        console.log(`  #${r.rank} [${s}] (${r.item.platform}) ${r.item.title.slice(0, 50)}`);
      }

      if (values.report) {
        console.log(`\nMarkdown report saved to: ${values.report}`);
      }
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

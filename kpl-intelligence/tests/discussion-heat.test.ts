import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateDiscussionHeatScore,
  DiscussionHeatScore,
  type DiscussionItemInput,
} from '../packages/backend/src/editorial/discussion-heat.ts';
import {
  DISCUSSION_HEAT_CONFIG,
  assertOfflineUsage,
  interpolateQuantile,
} from '../industry/discussion-heat.ts';
import {
  evaluateDiscussionHeatRecords,
  evaluateDiscussionHeatFile,
  parseJsonlRecords,
  type LabelledDiscussionRecord,
} from '../scripts/evaluate-discussion-heat.ts';
import { fileURLToPath } from 'node:url';

const FIXED_REF_TIME = new Date('2026-10-09T14:00:00Z');

test('official promotional post receives no authority or followers bonus over ordinary post', () => {
  const commonSnapshots = [
    {
      platform: 'weibo',
      observedAt: new Date('2026-10-09T10:00:00Z'),
      metrics: { likes: 20, comments: 5, shares: 2 },
    },
  ];

  // Official promotional post with 10,000,000 followers and official verification
  const officialPromo: DiscussionItemInput = {
    id: 'official-promo-01',
    title: '【官方公告】KPL秋季赛总决赛门票预售开启',
    platform: 'weibo',
    publishedAt: new Date('2026-10-09T09:50:00Z'),
    isOfficial: true,
    author: {
      name: 'KPL王者荣耀职业联赛',
      isOfficial: true,
      followers: 10_000_000,
      tier: 'T1',
    },
    snapshots: commonSnapshots,
  };

  // Ordinary community post with 0 followers and no official status
  const ordinaryPost: DiscussionItemInput = {
    id: 'ordinary-post-01',
    title: '普通水友讨论：今天门票开抢了吗',
    platform: 'weibo',
    publishedAt: new Date('2026-10-09T09:50:00Z'),
    isOfficial: false,
    author: {
      name: '电竞路人乙',
      isOfficial: false,
      followers: 0,
      tier: 'T3',
    },
    snapshots: commonSnapshots,
  };

  const scoreOfficial = calculateDiscussionHeatScore(officialPromo, undefined, FIXED_REF_TIME);
  const scoreOrdinary = calculateDiscussionHeatScore(ordinaryPost, undefined, FIXED_REF_TIME);

  // Both MUST have identical heat factor and total score: NO authority/followers bonus
  assert.equal(scoreOfficial.factors.heat, scoreOrdinary.factors.heat);
  assert.equal(scoreOfficial.totalScore, scoreOrdinary.totalScore);
  assert.equal(scoreOfficial.factors.confidence, scoreOrdinary.factors.confidence);
});

test('hupu 800 replies thread reaches top-tier heat and high discussion value on hupu baseline', () => {
  const hupuThread: DiscussionItemInput = {
    id: 'hupu-ag-800',
    title: '【热线】AG vs WB 巅峰对决第五局赛后讨论帖',
    platform: 'hupu',
    publishedAt: new Date('2026-10-09T12:00:00Z'),
    snapshots: [
      {
        platform: 'hupu',
        observedAt: new Date('2026-10-09T13:00:00Z'),
        metrics: { comments: 800, likes: 250, shares: 30 },
      },
    ],
  };

  const result = calculateDiscussionHeatScore(hupuThread, undefined, new Date('2026-10-09T13:10:00Z'));

  // On Hupu baseline, 800 replies represents top-tier discussion heat and depth
  assert.ok(result.factors.heat !== null, 'Heat should not be null');
  assert.ok(result.factors.heat >= 85, `Expected heat >= 85, got ${result.factors.heat}`);
  assert.ok(result.factors.value !== null && result.factors.value >= 70, `Expected discussion value >= 70, got ${result.factors.value}`);
  assert.ok(result.totalScore !== null && result.totalScore >= 60, `Expected totalScore >= 60, got ${result.totalScore}`);
  assert.equal(result.admission, 'accepted');
});

test('weibo 500 interactions is recognized as moderate heat on weibo broadcast baseline', () => {
  const weiboPost: DiscussionItemInput = {
    id: 'weibo-post-500',
    title: '选手今日赛前采访花絮',
    platform: 'weibo',
    publishedAt: new Date('2026-10-09T10:00:00Z'),
    snapshots: [
      {
        platform: 'weibo',
        observedAt: new Date('2026-10-09T11:00:00Z'),
        metrics: { likes: 300, comments: 150, shares: 50 },
      },
    ],
  };

  const result = calculateDiscussionHeatScore(weiboPost, undefined, new Date('2026-10-09T11:15:00Z'));

  // Weibo platform baseline saturation is 10,000: 500 interactions is moderate
  assert.ok(result.factors.heat !== null, 'Heat should not be null');
  assert.ok(result.factors.heat >= 40 && result.factors.heat <= 75, `Expected moderate heat ~40-75, got ${result.factors.heat}`);
});

test('bilibili creations integrate multi-dimensional video engagement metrics', () => {
  const biliVideo: DiscussionItemInput = {
    id: 'bili-creation-01',
    title: '【赛事复盘】总决赛关键团战深度战术拆解',
    platform: 'bilibili',
    publishedAt: new Date('2026-10-09T08:00:00Z'),
    text: '详细解析本场比赛中野联动眼位布置、经济分配以及决胜团站位细节。',
    snapshots: [
      {
        platform: 'bilibili',
        observedAt: new Date('2026-10-09T12:00:00Z'),
        metrics: {
          views: 50_000,
          danmaku: 1_200,
          comments: 800,
          coins: 2_500,
          likes: 6_000,
          shares: 400,
        },
      },
    ],
  };

  const result = calculateDiscussionHeatScore(biliVideo, undefined, new Date('2026-10-09T12:30:00Z'));

  assert.ok(result.factors.heat !== null && result.factors.heat >= 60, `Bili video heat should be >= 60, got ${result.factors.heat}`);
  assert.ok(result.factors.value !== null && result.factors.value >= 50, `Bili video value should be >= 50, got ${result.factors.value}`);
  assert.equal(result.admission, 'accepted');
});

test('small growth velocity is correctly distinguished from rapid viral growth', () => {
  const baseTime = new Date('2026-10-09T10:00:00Z');

  // Small growth: +5 comments in 2 hours
  const smallGrowthItem: DiscussionItemInput = {
    id: 'small-growth-01',
    title: '常规话题缓慢发酵',
    platform: 'hupu',
    snapshots: [
      {
        platform: 'hupu',
        observedAt: baseTime,
        metrics: { comments: 100, likes: 20 },
      },
      {
        platform: 'hupu',
        observedAt: new Date(baseTime.getTime() + 2 * 3600000), // +2h
        metrics: { comments: 105, likes: 22 },
      },
    ],
  };

  // Rapid growth: +400 comments in 1 hour
  const rapidGrowthItem: DiscussionItemInput = {
    id: 'rapid-growth-01',
    title: '突发热议重大事件',
    platform: 'hupu',
    snapshots: [
      {
        platform: 'hupu',
        observedAt: baseTime,
        metrics: { comments: 100, likes: 20 },
      },
      {
        platform: 'hupu',
        observedAt: new Date(baseTime.getTime() + 1 * 3600000), // +1h
        metrics: { comments: 500, likes: 150 },
      },
    ],
  };

  const refTime = new Date(baseTime.getTime() + 3 * 3600000);
  const smallRes = calculateDiscussionHeatScore(smallGrowthItem, undefined, refTime);
  const rapidRes = calculateDiscussionHeatScore(rapidGrowthItem, undefined, refTime);

  assert.ok(smallRes.factors.growth !== null, 'Small growth should not be null');
  assert.ok(rapidRes.factors.growth !== null, 'Rapid growth should not be null');
  assert.ok(smallRes.factors.growth < rapidRes.factors.growth, 'Rapid growth score must exceed small growth');
  assert.ok(smallRes.factors.growth <= 30, `Small growth factor should be <= 30, got ${smallRes.factors.growth}`);
  assert.ok(rapidRes.factors.growth >= 60, `Rapid growth factor should be >= 60, got ${rapidRes.factors.growth}`);
});

test('negative counter triggers anomaly and forces growth to zero', () => {
  const baseTime = new Date('2026-10-09T10:00:00Z');

  const anomalousItem: DiscussionItemInput = {
    id: 'anomaly-negative-01',
    title: '异常帖子计数回落',
    platform: 'hupu',
    snapshots: [
      {
        platform: 'hupu',
        observedAt: baseTime,
        metrics: { comments: 200, likes: 50 },
      },
      {
        platform: 'hupu',
        observedAt: new Date(baseTime.getTime() + 1 * 3600000),
        metrics: { comments: 170, likes: 52 }, // 200 -> 170 comments dropped!
      },
    ],
  };

  const res = calculateDiscussionHeatScore(anomalousItem, undefined, FIXED_REF_TIME);

  assert.equal(res.hasAnomaly, true);
  assert.ok(res.anomalies.some((a) => a.includes('negative_counter')));
  assert.equal(res.factors.growth, 0);
  assert.equal(res.metricsSummary.growthVelocityPerHour, 0);
  assert.equal(res.admission, 'review');
});

test('old or same timestamp snapshots are flagged and discarded for growth calculation', () => {
  const sameTime = new Date('2026-10-09T10:00:00Z');

  const sameTimestampItem: DiscussionItemInput = {
    id: 'same-timestamp-01',
    title: '时间戳重复快照',
    platform: 'weibo',
    snapshots: [
      {
        platform: 'weibo',
        observedAt: sameTime,
        metrics: { comments: 50, likes: 100 },
      },
      {
        platform: 'weibo',
        observedAt: sameTime, // Exactly same timestamp!
        metrics: { comments: 80, likes: 150 },
      },
    ],
  };

  const res = calculateDiscussionHeatScore(sameTimestampItem, undefined, FIXED_REF_TIME);

  // Must detect timestamp collision anomaly and not divide by zero
  assert.ok(res.anomalies.some((a) => a.includes('timestamp_collision')));
  assert.equal(res.factors.growth, null);
});

test('missing snapshots or unobserved metrics result in null heat and are never faked', () => {
  // Completely empty snapshots
  const noSnapshots: DiscussionItemInput = {
    id: 'missing-snaps-01',
    title: '无任何快照的空数据',
    platform: 'hupu',
    snapshots: [],
  };

  // Snapshot exists but all metrics are null/undefined
  const nullMetrics: DiscussionItemInput = {
    id: 'null-metrics-01',
    title: '所有快照计数全为空',
    platform: 'weibo',
    snapshots: [
      {
        platform: 'weibo',
        observedAt: new Date('2026-10-09T10:00:00Z'),
        metrics: { comments: null, likes: null, shares: null },
      },
    ],
  };

  const resA = calculateDiscussionHeatScore(noSnapshots, undefined, FIXED_REF_TIME);
  const resB = calculateDiscussionHeatScore(nullMetrics, undefined, FIXED_REF_TIME);

  assert.equal(resA.factors.heat, null);
  assert.equal(resA.heatCoverage, 'missing');
  assert.equal(resA.totalScore, null);
  assert.equal(resA.factors.value, null);
  assert.equal(resA.factors.growth, null);
  assert.equal(resA.admission, 'review');

  assert.equal(resB.factors.heat, null);
  assert.equal(resB.heatCoverage, 'missing');
  assert.equal(resB.totalScore, null);
  assert.equal(resB.factors.value, null);
  assert.equal(resB.factors.growth, null);
  assert.equal(resB.admission, 'review');
});

test('spam content is strictly rejected and quality zeroed', () => {
  const spamItem: DiscussionItemInput = {
    id: 'spam-item-01',
    title: '代练刷星兼职招募看头像加V',
    platform: 'hupu',
    isSpam: true,
    safe: true,
    snapshots: [
      {
        platform: 'hupu',
        observedAt: new Date('2026-10-09T10:00:00Z'),
        metrics: { comments: 200, likes: 50 },
      },
    ],
  };

  const res = calculateDiscussionHeatScore(spamItem, undefined, FIXED_REF_TIME);

  assert.equal(res.factors.quality, 0);
  assert.equal(res.totalScore, 0);
  assert.equal(res.admission, 'rejected');
  assert.ok(res.reason.includes('spam'));
});

test('unsafe content has quality zeroed and admission rejected', () => {
  const unsafeItem: DiscussionItemInput = {
    id: 'unsafe-item-01',
    title: '包含违规违法信息的讨论',
    platform: 'weibo',
    safe: false,
    snapshots: [
      {
        platform: 'weibo',
        observedAt: new Date('2026-10-09T10:00:00Z'),
        metrics: { comments: 500, likes: 1000 },
      },
    ],
  };

  const res = calculateDiscussionHeatScore(unsafeItem, undefined, FIXED_REF_TIME);

  assert.equal(res.factors.quality, 0);
  assert.equal(res.totalScore, 0);
  assert.equal(res.admission, 'rejected');
  assert.ok(res.reason.includes('safety') || res.reason.includes('Safety'));
});

test('offline-only guardrail blocks production rollout without holdout calibration', () => {
  assert.equal(DISCUSSION_HEAT_CONFIG.offlineOnly, true);
  assert.equal(DISCUSSION_HEAT_CONFIG.allowProductionRollout, false);

  assert.throws(() => {
    assertOfflineUsage(DISCUSSION_HEAT_CONFIG, true);
  }, /DiscussionHeatScore guardrail violation/);

  assert.throws(() => {
    assertOfflineUsage({
      ...DISCUSSION_HEAT_CONFIG,
      offlineOnly: false,
    });
  }, /guardrail violation/);
});

test('external configuration custom weights and quantiles override default without code changes', () => {
  const customConfig = {
    factorWeights: {
      heat: 0.80,
      growth: 0.05,
      value: 0.05,
      quality: 0.05,
      relevance: 0.05,
      confidence: 1.0,
    },
    platforms: {
      hupu: {
        platform: 'hupu',
        saturation: 1000,
        growthSaturation: 250,
        commentWeight: 3.0,
        shareWeight: 2.0,
        likeWeight: 1.0,
        quantiles: {
          p25: 10,
          p50: 50,
          p75: 200,
          p90: 500,
          p95: 800,
          p99: 1500,
        },
      },
    },
  };

  const item: DiscussionItemInput = {
    id: 'custom-config-01',
    title: '外部权重覆盖测试',
    platform: 'hupu',
    snapshots: [
      {
        platform: 'hupu',
        observedAt: new Date('2026-10-09T10:00:00Z'),
        metrics: { comments: 500, likes: 100 },
      },
    ],
  };

  const defaultRes = calculateDiscussionHeatScore(item, undefined, FIXED_REF_TIME);
  const customRes = calculateDiscussionHeatScore(item, customConfig, FIXED_REF_TIME);

  assert.ok(defaultRes.totalScore !== null);
  assert.ok(customRes.totalScore !== null);
});

test('evaluator throws error on empty set', () => {
  assert.throws(() => {
    evaluateDiscussionHeatRecords([]);
  }, /Evaluation error: Empty set/);

  assert.throws(() => {
    const records = parseJsonlRecords('\n\n// comment\n# comment\n');
    evaluateDiscussionHeatRecords(records);
  }, /Evaluation error: Empty set/);
});

// =========================================================================
// SOUND INVARIANT TESTS (Task Core Requirements)
// =========================================================================

test('SOUND INVARIANT: latest snapshot unknown must stay unknown (not skip back to earlier known snapshot)', () => {
  // Snapshot 1 is known and observed at 10:00
  // Snapshot 2 is observed at 12:00, but metrics were missing / unobserved (scrape failed)
  const item: DiscussionItemInput = {
    id: 'unknown-latest-01',
    title: '最新快照采集缺失的讨论',
    platform: 'hupu',
    publishedAt: new Date('2026-10-09T09:00:00Z'),
    snapshots: [
      {
        platform: 'hupu',
        observedAt: new Date('2026-10-09T10:00:00Z'),
        metrics: { comments: 400, likes: 100 },
      },
      {
        platform: 'hupu',
        observedAt: new Date('2026-10-09T12:00:00Z'),
        metrics: null, // Scrape failed, metrics unobserved!
      },
    ],
  };

  const res = calculateDiscussionHeatScore(item, undefined, FIXED_REF_TIME);

  // Latest snapshot must stay unknown! Must NOT skip back to 10:00 snapshot to fake heat!
  assert.equal(res.factors.heat, null, 'Latest snapshot is unknown; heat factor MUST be null');
  assert.equal(res.heatCoverage, 'missing', 'Heat coverage must be missing');
  assert.equal(res.totalScore, null, 'Total score must be null');
  assert.equal(res.admission, 'review');
  assert.ok(res.anomalies.some((a) => a.includes('latest_snapshot_unknown')));
});

test('SOUND INVARIANT: reject wrong platform snapshots and future times', () => {
  const item: DiscussionItemInput = {
    id: 'platform-time-sanitization-01',
    title: '快照平台与未来时间戳清洗',
    platform: 'hupu',
    publishedAt: new Date('2026-10-09T09:00:00Z'),
    snapshots: [
      {
        platform: 'weibo', // WRONG platform for a hupu post!
        observedAt: new Date('2026-10-09T10:00:00Z'),
        metrics: { comments: 9999, likes: 9999 },
      },
      {
        platform: 'hupu',
        observedAt: new Date('2026-10-09T15:00:00Z'), // FUTURE time relative to refTime (14:00)!
        metrics: { comments: 8888, likes: 8888 },
      },
      {
        platform: 'hupu',
        observedAt: new Date('2026-10-09T11:00:00Z'), // Valid platform and valid past time
        metrics: { comments: 200, likes: 50 },
      },
    ],
  };

  const res = calculateDiscussionHeatScore(item, undefined, FIXED_REF_TIME);

  // Wrong platform and future snapshots must be rejected and flagged
  assert.ok(res.anomalies.some((a) => a.includes('wrong_platform')), 'Must record wrong_platform anomaly');
  assert.ok(res.anomalies.some((a) => a.includes('future_snapshot')), 'Must record future_snapshot anomaly');

  // Only the valid 11:00 snapshot is accepted: comments=200, likes=50 -> 650 weighted interactions
  assert.equal(res.metricsSummary.snapshotCount, 1, 'Only 1 valid snapshot should survive sanitization');
  assert.equal(res.metricsSummary.latestInteractions, 650, 'Latest interactions must be calculated solely from valid snapshot (650), not leaked wrong platform or future snapshots');
  assert.ok(res.factors.heat !== null);
  assert.equal(res.factors.heat, 81, 'Heat factor must match decayed value of 200 comments / 50 likes on Hupu baseline');
});

test('SOUND INVARIANT: valid safe nonnegative ints and alias comparable keys without unknown key leakage', () => {
  const baseTime = new Date('2026-10-09T10:00:00Z');

  const item: DiscussionItemInput = {
    id: 'metric-validation-01',
    title: '指标整数校验与别名无泄漏比较',
    platform: 'weibo',
    snapshots: [
      {
        platform: 'weibo',
        observedAt: baseTime,
        metrics: {
          replies: 40, // Alias for 'comments'
          shares: 10,
          likes: -5, // Invalid negative integer!
          unknown_secret_leak: 999999, // Unknown key leakage!
        },
      },
      {
        platform: 'weibo',
        observedAt: new Date(baseTime.getTime() + 1 * 3600000),
        metrics: {
          comments: 70, // Canonical 'comments' (pairs with 'replies')
          shares: 25,
          likes: 50,
          views: 3.14159, // Invalid float!
        },
      },
    ],
  };

  const res = calculateDiscussionHeatScore(item, undefined, FIXED_REF_TIME);

  // 1. Invalid values flagged as anomalies
  assert.ok(res.anomalies.some((a) => a.includes('invalid_metric') && a.includes('likes')));
  assert.ok(res.anomalies.some((a) => a.includes('invalid_metric') && a.includes('views')));

  // 2. Unknown keys flagged and NEVER leaked to commonMetricKeys
  assert.ok(res.anomalies.some((a) => a.includes('unknown_metric_key') && a.includes('unknown_secret_leak')));
  assert.ok(!res.metricsSummary.commonMetricKeys.includes('unknown_secret_leak'), 'Unknown key leaked into commonMetricKeys!');

  // 3. Aliases ('replies' <-> 'comments') successfully compared under canonical key 'comments'
  assert.equal(res.metricsSummary.comparablePairFound, true);
  assert.ok(res.metricsSummary.commonMetricKeys.includes('comments'), 'Canonical comments must be compared across aliases');
  assert.ok(res.metricsSummary.commonMetricKeys.includes('shares'));
  assert.ok(res.factors.growth !== null && res.factors.growth > 0);
});

test('SOUND INVARIANT: no default 50 communityValue if missing evidence, unknown growth nullable', () => {
  // Case A: Missing snapshots -> communityValue must be null (never default 50!)
  const itemNoEvidence: DiscussionItemInput = {
    id: 'no-evidence-01',
    title: '无互动证据的帖子',
    platform: 'hupu',
    snapshots: [],
  };

  const resNoEvidence = calculateDiscussionHeatScore(itemNoEvidence, undefined, FIXED_REF_TIME);
  assert.equal(resNoEvidence.factors.heat, null);
  assert.equal(resNoEvidence.factors.value, null, 'communityValue MUST be null when missing evidence, not 50');
  assert.equal(resNoEvidence.factors.growth, null, 'unknown growth MUST be null, not 0');

  // Case B: Single snapshot -> growth cannot be observed, must be null
  const itemSingleSnapshot: DiscussionItemInput = {
    id: 'single-snapshot-01',
    title: '仅单次快照的帖子',
    platform: 'hupu',
    snapshots: [
      {
        platform: 'hupu',
        observedAt: new Date('2026-10-09T10:00:00Z'),
        metrics: { comments: 200, likes: 50 },
      },
    ],
  };

  const resSingle = calculateDiscussionHeatScore(itemSingleSnapshot, undefined, FIXED_REF_TIME);
  assert.ok(resSingle.factors.heat !== null);
  assert.ok(resSingle.factors.value !== null);
  assert.equal(resSingle.factors.growth, null, 'growth velocity across single snapshot is unknown, must be null');
  assert.equal(resSingle.metricsSummary.comparablePairFound, false);
});

test('SOUND INVARIANT: quality, relevance, and safety gates: uncertain status routes admission to review', () => {
  const commonSnapshots = [
    {
      platform: 'hupu',
      observedAt: new Date('2026-10-09T10:00:00Z'),
      metrics: { comments: 800, likes: 300 },
    },
  ];

  // 1. High heat item with safety uncertain
  const uncertainSafetyItem: DiscussionItemInput = {
    id: 'uncertain-safety-01',
    title: '高热但安全性未确定的帖子',
    platform: 'hupu',
    safe: 'uncertain',
    snapshots: commonSnapshots,
  };
  const resSafety = calculateDiscussionHeatScore(uncertainSafetyItem, undefined, FIXED_REF_TIME);
  assert.equal(resSafety.admission, 'review', 'Uncertain safety MUST route to review');
  assert.ok(resSafety.reason.includes('safety') || resSafety.reason.includes('gate'));

  // 2. High heat item with relevance uncertain
  const uncertainRelevanceItem: DiscussionItemInput = {
    id: 'uncertain-relevance-01',
    title: '高热但相关性未确定的帖子',
    platform: 'hupu',
    relevance: 'uncertain',
    snapshots: commonSnapshots,
  };
  const resRelevance = calculateDiscussionHeatScore(uncertainRelevanceItem, undefined, FIXED_REF_TIME);
  assert.equal(resRelevance.admission, 'review', 'Uncertain relevance MUST route to review');

  // 3. High heat item with quality gate uncertain
  const uncertainQualityItem: DiscussionItemInput = {
    id: 'uncertain-quality-01',
    title: '高热但质量门禁未确定的帖子',
    platform: 'hupu',
    quality: 'uncertain',
    snapshots: commonSnapshots,
  };
  const resQuality = calculateDiscussionHeatScore(uncertainQualityItem, undefined, FIXED_REF_TIME);
  assert.equal(resQuality.admission, 'review', 'Uncertain quality MUST route to review');
});

test('SOUND INVARIANT: default config contains no fabricated empirical quantiles and uses log baseline', () => {
  // Baseline config must NOT contain fabricated quantiles
  assert.equal(DISCUSSION_HEAT_CONFIG.platforms.hupu.quantiles, undefined);
  assert.equal(DISCUSSION_HEAT_CONFIG.platforms.weibo.quantiles, undefined);
  assert.equal(DISCUSSION_HEAT_CONFIG.platforms.bilibili.quantiles, undefined);

  // Check log baseline formula for a known input:
  // Hupu: saturation = 1000, commentWeight = 3.0, likeWeight = 1.0
  // comments = 200, likes = 50 -> raw volume = 650
  // log baseline = (ln(651) / ln(1001)) * 100 = (6.4785 / 6.9087) * 100 = ~93.77
  const item: DiscussionItemInput = {
    id: 'log-baseline-check',
    title: '对数基准测试',
    platform: 'hupu',
    snapshots: [
      {
        platform: 'hupu',
        observedAt: new Date('2026-10-09T10:00:00Z'),
        metrics: { comments: 200, likes: 50 },
      },
    ],
  };

  const res = calculateDiscussionHeatScore(item, undefined, new Date('2026-10-09T10:00:00Z'));
  assert.equal(res.factors.heat, 94);
});

test('SOUND INVARIANT: evaluator deterministic reference time and synthetic benchmark fixture labeling', () => {
  const goldPath = fileURLToPath(new URL('../industry/discussion-heat-gold.example.jsonl', import.meta.url));
  const output = evaluateDiscussionHeatFile(goldPath, {
    silent: true,
    synthetic: true,
    at: '2026-10-09T14:00:00Z',
  });

  // Coverage checks
  assert.equal(output.coverage.totalItems, 8);
  assert.equal(output.coverage.missingCount, 1);
  assert.equal(output.isSynthetic, true);
  assert.equal(output.referenceTime.toISOString(), '2026-10-09T14:00:00.000Z');

  // Pairwise ranking check
  assert.ok(output.pairwise !== null);
  assert.ok(output.pairwise.totalPairs > 0);
  assert.ok(output.pairwise.pairwiseAccuracy >= 0.85);

  // Report must explicitly state synthetic benchmark labels, not actual user labels
  assert.ok(output.reportMarkdown?.includes('SYNTHETIC BENCHMARK FIXTURE'));
  assert.ok(output.reportMarkdown?.includes('Evaluation Reference Time: `2026-10-09T14:00:00.000Z` (deterministic)'));

  // Missing heat item has null value and null growth in rankings
  const missingHeatResult = output.rankings.find((r) => r.item.id === 'case-07-missing-heat')?.item;
  assert.ok(missingHeatResult !== undefined);
  assert.equal(missingHeatResult.factors.value, null);
  assert.equal(missingHeatResult.factors.growth, null);
});

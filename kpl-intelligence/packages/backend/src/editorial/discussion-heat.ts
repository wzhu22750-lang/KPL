import {
  DISCUSSION_HEAT_CONFIG,
  interpolateQuantile,
  assertOfflineUsage,
  type DiscussionHeatConfig,
  type PlatformBaseline,
} from '@aihot/industry/discussion-heat';

export interface MetricCounters {
  likes?: number | null;
  comments?: number | null;
  replies?: number | null;
  shares?: number | null;
  reposts?: number | null;
  views?: number | null;
  danmaku?: number | null;
  coins?: number | null;
  favorites?: number | null;
  [key: string]: number | null | undefined;
}

export interface DiscussionSnapshot {
  platform: string;
  observedAt: Date | string;
  metrics?: MetricCounters | null;
}

export type GateDecision = 'pass' | 'fail' | 'uncertain';

export interface DiscussionItemInput {
  id: string;
  title: string;
  platform: string;
  publishedAt?: Date | string | null;
  author?: {
    name?: string | null;
    followers?: number | null;
    isOfficial?: boolean | null;
    tier?: string | null;
  } | null;
  text?: string | null;
  summary?: string | null;
  safe?: boolean | 'uncertain' | null;
  isSpam?: boolean | 'uncertain' | null;
  noise?: number | null;
  relevance?: number | boolean | 'uncertain' | null;
  quality?: number | 'uncertain' | null;
  isOfficial?: boolean;
  snapshots?: DiscussionSnapshot[];
  gates?: {
    safety?: GateDecision | null;
    relevance?: GateDecision | null;
    quality?: GateDecision | null;
  } | null;
}

export interface DiscussionHeatFactors {
  /** Absolute heat volume (null when observation is missing or latest is unknown; never faked) */
  heat: number | null;
  /** Growth velocity across valid consecutive snapshots (0..100, or null when unknown/missing evidence) */
  growth: number | null;
  /** Discussion depth / value (null when observation is missing / no evidence; never default 50) */
  value: number | null;
  /** Content safety, non-spam hygiene, and low noise */
  quality: number;
  /** Relevance to discussion topic / domain */
  relevance: number;
  /** Data observation confidence score (0..100) */
  confidence: number;
}

export interface DiscussionHeatResult {
  id: string;
  title: string;
  platform: string;
  version: string;
  offlineOnly: boolean;
  /** Final calculated score (0..100), or null if heat is missing */
  totalScore: number | null;
  heatCoverage: 'observed' | 'missing' | 'partial';
  factors: DiscussionHeatFactors;
  metricsSummary: {
    latestInteractions: number | null;
    growthVelocityPerHour: number | null;
    snapshotCount: number;
    comparablePairFound: boolean;
    commonMetricKeys: string[];
  };
  anomalies: string[];
  hasAnomaly: boolean;
  admission: 'accepted' | 'rejected' | 'review';
  reason: string;
}

const CANONICAL_METRIC_KEYS = ['comments', 'shares', 'likes', 'views', 'danmaku', 'coins', 'favorites'] as const;
type CanonicalMetricKey = typeof CANONICAL_METRIC_KEYS[number];

const RECOGNIZED_RAW_KEYS = new Set<string>([
  'comments',
  'replies',
  'shares',
  'reposts',
  'likes',
  'views',
  'danmaku',
  'coins',
  'favorites',
]);

function isNumeric(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val);
}

/**
 * Validates that a counter value is a safe, non-negative integer.
 */
function isValidMetricValue(val: unknown): val is number {
  return typeof val === 'number' && Number.isSafeInteger(val) && val >= 0;
}

/**
 * Normalizes aliases into canonical metrics, rejects invalid non-integers/negative values,
 * and intercepts unknown key leakage.
 */
function extractCanonicalMetrics(
  rawMetrics: MetricCounters | null | undefined,
  recordAnomaly: (msg: string) => void
): { canonical: Partial<Record<CanonicalMetricKey, number>>; hasAny: boolean } {
  if (!rawMetrics) return { canonical: {}, hasAny: false };

  // Detect and intercept unknown key leakage
  for (const k of Object.keys(rawMetrics)) {
    if (!RECOGNIZED_RAW_KEYS.has(k)) {
      recordAnomaly(`unknown_metric_key: Discarded unrecognized metric key '${k}'.`);
    }
  }

  const canonical: Partial<Record<CanonicalMetricKey, number>> = {};

  // comments / replies alias
  const rawComments = rawMetrics.comments;
  const rawReplies = rawMetrics.replies;
  if (rawComments !== undefined && rawComments !== null) {
    if (isValidMetricValue(rawComments)) {
      canonical.comments = rawComments;
    } else {
      recordAnomaly(`invalid_metric: Metric 'comments' has invalid value ${rawComments}; expected safe non-negative integer.`);
    }
  } else if (rawReplies !== undefined && rawReplies !== null) {
    if (isValidMetricValue(rawReplies)) {
      canonical.comments = rawReplies;
    } else {
      recordAnomaly(`invalid_metric: Metric 'replies' has invalid value ${rawReplies}; expected safe non-negative integer.`);
    }
  }

  // shares / reposts alias
  const rawShares = rawMetrics.shares;
  const rawReposts = rawMetrics.reposts;
  if (rawShares !== undefined && rawShares !== null) {
    if (isValidMetricValue(rawShares)) {
      canonical.shares = rawShares;
    } else {
      recordAnomaly(`invalid_metric: Metric 'shares' has invalid value ${rawShares}; expected safe non-negative integer.`);
    }
  } else if (rawReposts !== undefined && rawReposts !== null) {
    if (isValidMetricValue(rawReposts)) {
      canonical.shares = rawReposts;
    } else {
      recordAnomaly(`invalid_metric: Metric 'reposts' has invalid value ${rawReposts}; expected safe non-negative integer.`);
    }
  }

  // likes
  if (rawMetrics.likes !== undefined && rawMetrics.likes !== null) {
    if (isValidMetricValue(rawMetrics.likes)) {
      canonical.likes = rawMetrics.likes;
    } else {
      recordAnomaly(`invalid_metric: Metric 'likes' has invalid value ${rawMetrics.likes}; expected safe non-negative integer.`);
    }
  }

  // views
  if (rawMetrics.views !== undefined && rawMetrics.views !== null) {
    if (isValidMetricValue(rawMetrics.views)) {
      canonical.views = rawMetrics.views;
    } else {
      recordAnomaly(`invalid_metric: Metric 'views' has invalid value ${rawMetrics.views}; expected safe non-negative integer.`);
    }
  }

  // danmaku
  if (rawMetrics.danmaku !== undefined && rawMetrics.danmaku !== null) {
    if (isValidMetricValue(rawMetrics.danmaku)) {
      canonical.danmaku = rawMetrics.danmaku;
    } else {
      recordAnomaly(`invalid_metric: Metric 'danmaku' has invalid value ${rawMetrics.danmaku}; expected safe non-negative integer.`);
    }
  }

  // coins
  if (rawMetrics.coins !== undefined && rawMetrics.coins !== null) {
    if (isValidMetricValue(rawMetrics.coins)) {
      canonical.coins = rawMetrics.coins;
    } else {
      recordAnomaly(`invalid_metric: Metric 'coins' has invalid value ${rawMetrics.coins}; expected safe non-negative integer.`);
    }
  }

  // favorites
  if (rawMetrics.favorites !== undefined && rawMetrics.favorites !== null) {
    if (isValidMetricValue(rawMetrics.favorites)) {
      canonical.favorites = rawMetrics.favorites;
    } else {
      recordAnomaly(`invalid_metric: Metric 'favorites' has invalid value ${rawMetrics.favorites}; expected safe non-negative integer.`);
    }
  }

  const hasAny = Object.keys(canonical).length > 0;
  return { canonical, hasAny };
}

function calculateWeightedInteractions(
  canonical: Partial<Record<CanonicalMetricKey, number>>,
  baseline: PlatformBaseline,
  keysToConsider?: CanonicalMetricKey[]
): number {
  const allowed = (k: CanonicalMetricKey) => !keysToConsider || keysToConsider.includes(k);

  let sum = 0;
  if (allowed('comments') && isNumeric(canonical.comments)) {
    sum += canonical.comments * baseline.commentWeight;
  }
  if (allowed('shares') && isNumeric(canonical.shares)) {
    sum += canonical.shares * baseline.shareWeight;
  }
  if (allowed('likes') && isNumeric(canonical.likes)) {
    sum += canonical.likes * baseline.likeWeight;
  }
  if (allowed('views') && isNumeric(canonical.views) && baseline.viewWeight) {
    sum += canonical.views * baseline.viewWeight;
  }
  if (allowed('danmaku') && isNumeric(canonical.danmaku) && baseline.danmakuWeight) {
    sum += canonical.danmaku * baseline.danmakuWeight;
  }
  if (allowed('coins') && isNumeric(canonical.coins) && baseline.coinWeight) {
    sum += canonical.coins * baseline.coinWeight;
  }
  return sum;
}

export function calculateDiscussionHeatScore(
  item: DiscussionItemInput,
  configOverrides?: Partial<DiscussionHeatConfig>,
  referenceTimeInput?: Date
): DiscussionHeatResult {
  const config: DiscussionHeatConfig = {
    ...DISCUSSION_HEAT_CONFIG,
    ...configOverrides,
    factorWeights: {
      ...DISCUSSION_HEAT_CONFIG.factorWeights,
      ...(configOverrides?.factorWeights ?? {}),
    },
    platforms: {
      ...DISCUSSION_HEAT_CONFIG.platforms,
      ...(configOverrides?.platforms ?? {}),
    },
    decay: {
      ...DISCUSSION_HEAT_CONFIG.decay,
      ...(configOverrides?.decay ?? {}),
    },
  };

  assertOfflineUsage(config);

  const platformKey = item.platform ? item.platform.toLowerCase().trim() : 'default';
  const baseline: PlatformBaseline = config.platforms[platformKey] || config.platforms.default!;

  const anomalies: string[] = [];
  const recordAnomaly = (msg: string) => anomalies.push(msg);

  // Parse raw snapshots
  const rawSnapshots = (item.snapshots ?? []).filter((s) => Boolean(s && s.observedAt));

  // Determine deterministic reference time:
  // If not passed explicitly, use the latest observed snapshot timestamp or publishedAt
  let referenceTime: Date;
  if (referenceTimeInput) {
    referenceTime = referenceTimeInput;
  } else {
    let maxTime = -1;
    for (const s of rawSnapshots) {
      const t = new Date(s.observedAt).getTime();
      if (!Number.isNaN(t) && t > maxTime) maxTime = t;
    }
    if (maxTime > 0) {
      referenceTime = new Date(maxTime);
    } else if (item.publishedAt && !Number.isNaN(new Date(item.publishedAt).getTime())) {
      referenceTime = new Date(item.publishedAt);
    } else {
      referenceTime = new Date('2026-10-09T12:00:00Z');
    }
  }

  if (item.publishedAt && new Date(item.publishedAt).getTime() > referenceTime.getTime()) {
    recordAnomaly(`future_publication: Published time ${new Date(item.publishedAt).toISOString()} is in the future relative to reference time ${referenceTime.toISOString()}.`);
  }

  // Reject wrong platform snapshots and future times
  interface ValidatedSnapshot {
    platform: string;
    observedAt: Date;
    metrics: MetricCounters | null;
  }

  const validSnapshotsContext: ValidatedSnapshot[] = [];

  for (let idx = 0; idx < rawSnapshots.length; idx++) {
    const s = rawSnapshots[idx]!;
    const obsDate = new Date(s.observedAt);
    if (Number.isNaN(obsDate.getTime())) {
      recordAnomaly(`invalid_date: Snapshot at index ${idx} has invalid observedAt date.`);
      continue;
    }

    const snapPlatform = (s.platform ? s.platform.toLowerCase().trim() : platformKey);
    // Reject wrong platform snapshots
    if (platformKey !== 'default' && snapPlatform !== platformKey) {
      recordAnomaly(`wrong_platform: Snapshot platform '${s.platform}' does not match item platform '${item.platform}'.`);
      continue;
    }

    // Reject future times relative to referenceTime
    if (obsDate.getTime() > referenceTime.getTime()) {
      recordAnomaly(`future_snapshot: Snapshot observedAt ${obsDate.toISOString()} is in the future relative to reference time ${referenceTime.toISOString()}.`);
      continue;
    }

    validSnapshotsContext.push({
      platform: snapPlatform,
      observedAt: obsDate,
      metrics: s.metrics ?? null,
    });
  }

  // Sort chronologically
  validSnapshotsContext.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());

  // Check timestamp collisions / non-strictly increasing timestamps
  for (let i = 1; i < validSnapshotsContext.length; i++) {
    const prev = validSnapshotsContext[i - 1]!;
    const curr = validSnapshotsContext[i]!;
    if (curr.observedAt.getTime() <= prev.observedAt.getTime()) {
      recordAnomaly(`timestamp_collision: Snapshot at index ${i} has same or earlier timestamp than predecessor.`);
    }
  }

  // Extract canonical metrics for all valid context snapshots and record anomalies
  const extractedSnapshots = validSnapshotsContext.map((s) => ({
    snapshot: s,
    ...extractCanonicalMetrics(s.metrics, recordAnomaly),
  }));

  // SOUND INVARIANT: "latest snapshot unknown must stay unknown (not skip back to known)"
  // The latest snapshot chronologically is validSnapshotsContext[last]
  const lastSnapshotEntry = extractedSnapshots.length > 0 ? extractedSnapshots[extractedSnapshots.length - 1]! : null;

  let heatFactor: number | null = null;
  let latestInteractions: number | null = null;
  let latestCanonical: Partial<Record<CanonicalMetricKey, number>> = {};
  let latestSnapshotKnown = false;

  if (lastSnapshotEntry) {
    if (lastSnapshotEntry.hasAny) {
      latestSnapshotKnown = true;
      latestCanonical = lastSnapshotEntry.canonical;
    } else {
      // Latest snapshot exists chronologically, but has NO valid metrics (e.g. scrape failed / null metrics).
      // MUST stay unknown! Do NOT skip back to earlier known snapshots.
      latestSnapshotKnown = false;
      recordAnomaly(`latest_snapshot_unknown: Chronologically latest snapshot at ${lastSnapshotEntry.snapshot.observedAt.toISOString()} contains no valid observed metrics; latest state stays unknown.`);
    }
  }

  if (latestSnapshotKnown && lastSnapshotEntry) {
    latestInteractions = calculateWeightedInteractions(latestCanonical, baseline);

    let rawHeat: number;
    if (baseline.quantiles) {
      rawHeat = interpolateQuantile(latestInteractions, baseline.quantiles);
    } else {
      rawHeat = Math.min(100, (Math.log1p(latestInteractions) / Math.log1p(baseline.saturation)) * 100);
    }

    // Relative time decay based on referenceTime
    const refDate = item.publishedAt ? new Date(item.publishedAt) : lastSnapshotEntry.snapshot.observedAt;
    const ageHours = Math.max(0, (referenceTime.getTime() - refDate.getTime()) / 3600000);
    const decayFactor = Math.max(
      config.decay.floorDecay,
      Math.exp(-Math.LN2 * (ageHours / config.decay.halfLifeHours))
    );

    heatFactor = Math.min(100, Math.max(0, Math.round(rawHeat * decayFactor)));
  }

  // 2. Growth calculation across valid comparable snapshots
  // "unknown growth nullable preferably"
  let growthFactor: number | null = null;
  let growthVelocityPerHour: number | null = null;
  let comparablePairFound = false;
  let commonMetricKeys: string[] = [];
  let negativeCounterDetected = false;

  const snapshotsWithMetrics = extractedSnapshots.filter((entry) => entry.hasAny);

  if (latestSnapshotKnown && snapshotsWithMetrics.length >= 2) {
    for (let i = snapshotsWithMetrics.length - 1; i >= 1; i--) {
      const prev = snapshotsWithMetrics[i - 1]!;
      const curr = snapshotsWithMetrics[i]!;

      // Comparable conditions: same platform and strictly chronological
      if (prev.snapshot.platform === curr.snapshot.platform && curr.snapshot.observedAt.getTime() > prev.snapshot.observedAt.getTime()) {
        const keysInBoth = (CANONICAL_METRIC_KEYS as readonly CanonicalMetricKey[]).filter(
          (k) => prev.canonical[k] !== undefined && curr.canonical[k] !== undefined
        );

        if (keysInBoth.length > 0) {
          comparablePairFound = true;
          commonMetricKeys = [...keysInBoth];

          // Check for negative counter anomaly
          for (const k of keysInBoth) {
            const prevVal = prev.canonical[k]!;
            const currVal = curr.canonical[k]!;
            if (currVal < prevVal) {
              negativeCounterDetected = true;
              recordAnomaly(`negative_counter: Metric '${k}' dropped from ${prevVal} to ${currVal}.`);
            }
          }

          if (!negativeCounterDetected) {
            const prevVolume = calculateWeightedInteractions(prev.canonical, baseline, keysInBoth);
            const currVolume = calculateWeightedInteractions(curr.canonical, baseline, keysInBoth);
            const deltaVolume = Math.max(0, currVolume - prevVolume);
            const hours = Math.max(0.05, (curr.snapshot.observedAt.getTime() - prev.snapshot.observedAt.getTime()) / 3600000);
            growthVelocityPerHour = deltaVolume / hours;

            const ratio = Math.log1p(growthVelocityPerHour) / Math.log1p(baseline.growthSaturation);
            growthFactor = Math.min(100, Math.round(100 * Math.pow(Math.min(1.0, ratio), 1.4)));
          } else {
            // Negative counter -> anomaly no growth
            growthVelocityPerHour = 0;
            growthFactor = 0;
          }
          break;
        }
      }
    }
  }

  // 3. Discussion value / depth factor
  // SOUND INVARIANT: "no default 50 communityValue if missing evidence"
  let valueFactor: number | null = null;
  if (latestSnapshotKnown) {
    const comments = latestCanonical.comments ?? 0;
    const danmaku = latestCanonical.danmaku ?? 0;
    const likes = latestCanonical.likes ?? 0;
    const hasDiscussionEvidence =
      latestCanonical.comments !== undefined ||
      latestCanonical.danmaku !== undefined ||
      latestCanonical.likes !== undefined;

    if (hasDiscussionEvidence) {
      const discussionItems = comments + Math.round(danmaku * 0.5);
      const debateRatio = (discussionItems * 2.5) / Math.max(1, likes);
      valueFactor = Math.min(100, Math.round(100 * (Math.log1p(debateRatio * 6 + discussionItems * 0.05) / Math.log1p(35))));

      // Extra depth bonus if discussion has substantial text
      if (item.text && item.text.length > 25) {
        valueFactor = Math.min(100, valueFactor + 10);
      }
    }
  }

  // 4. Quality factor & gate checks
  // SOUND INVARIANT: "Require quality/relevance/safety gates uncertain -> review"
  let qualityFactor = 80;
  let isUnsafe = false;
  let isSpam = false;
  let isQualityUncertain = false;
  let isSafetyUncertain = false;

  if (item.safe === false || item.gates?.safety === 'fail') {
    qualityFactor = 0;
    isUnsafe = true;
    recordAnomaly('unsafe_content: Flagged as unsafe.');
  } else if (item.safe === 'uncertain' || item.safe === null || item.gates?.safety === 'uncertain') {
    isSafetyUncertain = true;
    recordAnomaly('safety_uncertain: Safety gate status is uncertain.');
  }

  if (item.isSpam === true) {
    qualityFactor = 0;
    isSpam = true;
    recordAnomaly('spam_content: Flagged as spam.');
  } else if (item.isSpam === 'uncertain') {
    isSafetyUncertain = true;
    recordAnomaly('spam_uncertain: Spam gate status is uncertain.');
  }

  if (!isUnsafe && !isSpam) {
    if (item.quality === 'uncertain' || item.gates?.quality === 'uncertain') {
      isQualityUncertain = true;
      recordAnomaly('quality_uncertain: Quality gate status is uncertain.');
    } else if (item.gates?.quality === 'fail') {
      qualityFactor = 0;
    } else {
      if (isNumeric(item.noise)) {
        qualityFactor = Math.max(0, 100 - item.noise);
      }
      if (isNumeric(item.quality)) {
        qualityFactor = Math.round((qualityFactor + item.quality) / 2);
      }
    }
  }

  // 5. Relevance factor & gate checks
  let relevanceFactor = 80;
  let isRelevanceUncertain = false;

  if (item.relevance === false || item.relevance === 0 || item.gates?.relevance === 'fail') {
    relevanceFactor = 0;
  } else if (item.relevance === 'uncertain' || item.relevance === null || item.gates?.relevance === 'uncertain') {
    isRelevanceUncertain = true;
    recordAnomaly('relevance_uncertain: Relevance gate status is uncertain.');
  } else if (item.relevance === true) {
    relevanceFactor = 100;
  } else if (isNumeric(item.relevance)) {
    relevanceFactor = Math.min(100, Math.max(0, item.relevance));
  }

  // 6. Confidence factor
  let confidenceFactor = 0;
  if (heatFactor !== null) {
    confidenceFactor = 50;

    if (comparablePairFound) {
      confidenceFactor += 25;
    }

    const hasCore = latestCanonical.comments !== undefined && latestCanonical.likes !== undefined;
    if (hasCore) {
      confidenceFactor += 25;
    } else {
      confidenceFactor -= 15;
    }

    if (negativeCounterDetected) {
      confidenceFactor -= 30;
    }

    if (anomalies.some((a) => a.startsWith('timestamp_collision'))) {
      confidenceFactor -= 20;
    }

    if (anomalies.some((a) => a.startsWith('wrong_platform') || a.startsWith('future_snapshot') || a.startsWith('unknown_metric_key') || a.startsWith('invalid_metric'))) {
      confidenceFactor -= 15;
    }

    confidenceFactor = Math.min(100, Math.max(10, confidenceFactor));
  }

  // STRICT GUARANTEE: NO authority / followers bonus!
  // Neither item.isOfficial nor item.author?.followers adds any points or multiplier.

  // 7. Overall total score combination
  let totalScore: number | null = null;
  let heatCoverage: 'observed' | 'missing' | 'partial' = 'missing';

  if (heatFactor === null) {
    heatCoverage = 'missing';
    totalScore = null;
  } else {
    heatCoverage = (commonMetricKeys.length >= 2 || Object.keys(latestCanonical).length >= 2) ? 'observed' : 'partial';

    if (qualityFactor === 0 || relevanceFactor === 0) {
      totalScore = 0;
    } else {
      const weights = config.factorWeights;
      const activeWeights = {
        heat: weights.heat,
        growth: growthFactor !== null ? weights.growth : 0,
        value: valueFactor !== null ? weights.value : 0,
        quality: weights.quality,
        relevance: weights.relevance,
      };
      const weightSum =
        activeWeights.heat +
        activeWeights.growth +
        activeWeights.value +
        activeWeights.quality +
        activeWeights.relevance;

      const weightedRaw =
        (activeWeights.heat * heatFactor +
          (growthFactor !== null ? activeWeights.growth * growthFactor : 0) +
          (valueFactor !== null ? activeWeights.value * valueFactor : 0) +
          activeWeights.quality * qualityFactor +
          activeWeights.relevance * relevanceFactor) /
        weightSum;

      const confidenceMultiplier = 0.4 + 0.6 * (confidenceFactor / 100);
      totalScore = Math.min(100, Math.max(0, Math.round(weightedRaw * confidenceMultiplier)));
    }
  }

  // Admission decision
  let admission: 'accepted' | 'rejected' | 'review' = 'rejected';
  let reason = '';

  if (heatFactor === null) {
    admission = 'review';
    reason = 'Missing interaction snapshots or latest snapshot unknown; heat cannot be verified.';
  } else if (isUnsafe || isSpam) {
    admission = 'rejected';
    reason = isSpam ? 'Rejected due to spam classification.' : 'Rejected due to safety violation.';
  } else if (relevanceFactor === 0) {
    admission = 'rejected';
    reason = 'Irrelevant to target domain.';
  } else if (isSafetyUncertain || isQualityUncertain || isRelevanceUncertain) {
    admission = 'review';
    reason = `Flagged for editorial review: uncertain gate (${[
      isSafetyUncertain ? 'safety' : null,
      isQualityUncertain ? 'quality' : null,
      isRelevanceUncertain ? 'relevance' : null,
    ].filter(Boolean).join(', ')}).`;
  } else if (anomalies.length > 0 || (isNumeric(item.noise) && item.noise >= 75)) {
    admission = 'review';
    reason = `Flagged for editorial review: ${anomalies.join('; ')}`;
  } else if (totalScore !== null && totalScore >= config.admissionThreshold) {
    admission = 'accepted';
    reason = `Qualified discussion: heat ${heatFactor}, growth ${growthFactor ?? 'n/a'}, value ${valueFactor ?? 'n/a'}, total ${totalScore}.`;
  } else {
    admission = 'rejected';
    reason = `Score ${totalScore ?? 0} did not meet admission threshold ${config.admissionThreshold}.`;
  }

  return {
    id: item.id,
    title: item.title,
    platform: platformKey,
    version: config.version,
    offlineOnly: config.offlineOnly,
    totalScore,
    heatCoverage,
    factors: {
      heat: heatFactor,
      growth: growthFactor,
      value: valueFactor,
      quality: qualityFactor,
      relevance: relevanceFactor,
      confidence: confidenceFactor,
    },
    metricsSummary: {
      latestInteractions,
      growthVelocityPerHour,
      snapshotCount: validSnapshotsContext.length,
      comparablePairFound,
      commonMetricKeys,
    },
    anomalies,
    hasAnomaly: anomalies.length > 0,
    admission,
    reason,
  };
}

export const DiscussionHeatScore = {
  compute: calculateDiscussionHeatScore,
  evaluateBatch(items: DiscussionItemInput[], config?: Partial<DiscussionHeatConfig>, referenceTime?: Date): DiscussionHeatResult[] {
    return items.map((item) => calculateDiscussionHeatScore(item, config, referenceTime));
  },
};

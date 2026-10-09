/**
 * Experimental Offline DiscussionHeatScore Configuration & External Weights
 *
 * CRITICAL GUARDRAIL:
 * This model is strictly offline and experimental.
 * Never deploy production weights without labelled holdout calibration.
 */

export interface FactorWeights {
  /** Weight for absolute heat / volume factor */
  heat: number;
  /** Weight for interaction growth / velocity factor */
  growth: number;
  /** Weight for discussion depth / value (comment density vs passive upvotes) */
  value: number;
  /** Weight for content quality, safety, and spam cleanliness */
  quality: number;
  /** Weight for domain / topic relevance */
  relevance: number;
  /** Modifier / gate for data completeness and observation confidence */
  confidence: number;
}

export interface EmpiricalQuantiles {
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface PlatformBaseline {
  platform: string;
  /** Interaction saturation point for log normalization fallback */
  saturation: number;
  /** Growth velocity (interactions/hour) saturation */
  growthSaturation: number;
  /** Relative weight of comments / replies */
  commentWeight: number;
  /** Relative weight of shares / reposts */
  shareWeight: number;
  /** Relative weight of likes / favorites */
  likeWeight: number;
  /** Relative weight of views (for video/media platforms) */
  viewWeight?: number;
  /** Relative weight of danmaku (e.g. bilibili) */
  danmakuWeight?: number;
  /** Relative weight of coins (e.g. bilibili) */
  coinWeight?: number;
  /** Empirical interaction quantiles (if calibrated) */
  quantiles?: EmpiricalQuantiles;
}

export interface DecayConfig {
  /** Half-life in hours for time decay */
  halfLifeHours: number;
  /** Maximum age in hours considered */
  maxAgeHours: number;
  /** Minimum decay factor floor */
  floorDecay: number;
}

export interface DiscussionHeatConfig {
  version: string;
  /** Strict offline experimental flag */
  offlineOnly: boolean;
  /** Production rollout gate */
  allowProductionRollout: boolean;
  /** Minimum holdout sample size required before any production calibration */
  minHoldoutSamples: number;
  admissionThreshold: number;
  factorWeights: FactorWeights;
  platforms: Record<string, PlatformBaseline>;
  decay: DecayConfig;
  interactionWeights: {
    comments: number;
    shares: number;
    likes: number;
    views: number;
    danmaku?: number;
    coins?: number;
  };
}

/**
 * Default externalized configuration.
 * All weights, baselines, and quantiles can be externally configured and overridden.
 */
export const DISCUSSION_HEAT_CONFIG: DiscussionHeatConfig = {
  version: 'discussion-heat-v1-offline-exp',
  offlineOnly: true,
  allowProductionRollout: false,
  minHoldoutSamples: 200,
  admissionThreshold: 45,
  factorWeights: {
    heat: 0.35,
    growth: 0.25,
    value: 0.15,
    quality: 0.15,
    relevance: 0.10,
    confidence: 1.0,
  },
  platforms: {
    hupu: {
      platform: 'hupu',
      // Hupu is reply-heavy: experimental log baseline (no fabricated empirical quantiles)
      saturation: 1000,
      growthSaturation: 250,
      commentWeight: 3.0,
      shareWeight: 2.0,
      likeWeight: 1.0,
    },
    weibo: {
      platform: 'weibo',
      // Weibo has broadcast scale: experimental log baseline (no fabricated empirical quantiles)
      saturation: 10000,
      growthSaturation: 2500,
      commentWeight: 2.5,
      shareWeight: 2.5,
      likeWeight: 1.0,
    },
    bilibili: {
      platform: 'bilibili',
      // Bilibili creations incorporate views, comments, danmaku, and coins (no fabricated empirical quantiles)
      saturation: 30000,
      growthSaturation: 6000,
      commentWeight: 4.0,
      shareWeight: 2.5,
      likeWeight: 1.0,
      viewWeight: 0.05,
      danmakuWeight: 2.5,
      coinWeight: 3.0,
    },
    default: {
      platform: 'default',
      saturation: 5000,
      growthSaturation: 1000,
      commentWeight: 2.5,
      shareWeight: 2.0,
      likeWeight: 1.0,
      viewWeight: 0.02,
    },
  },
  decay: {
    halfLifeHours: 24,
    maxAgeHours: 168,
    floorDecay: 0.10,
  },
  interactionWeights: {
    comments: 2.5,
    shares: 2.0,
    likes: 1.0,
    views: 0.05,
    danmaku: 2.0,
    coins: 2.5,
  },
};

/**
 * Piecewise linear interpolation across empirical quantiles mapping raw volume to [0, 100].
 */
export function interpolateQuantile(value: number, quantiles: EmpiricalQuantiles): number {
  if (value <= 0) return 0;
  if (value < quantiles.p25) {
    return (value / quantiles.p25) * 25;
  }
  if (value < quantiles.p50) {
    return 25 + ((value - quantiles.p25) / (quantiles.p50 - quantiles.p25)) * 25;
  }
  if (value < quantiles.p75) {
    return 50 + ((value - quantiles.p50) / (quantiles.p75 - quantiles.p50)) * 25;
  }
  if (value < quantiles.p90) {
    return 75 + ((value - quantiles.p75) / (quantiles.p90 - quantiles.p75)) * 15;
  }
  if (value < quantiles.p95) {
    return 90 + ((value - quantiles.p90) / (quantiles.p95 - quantiles.p90)) * 5;
  }
  if (value < quantiles.p99) {
    return 95 + ((value - quantiles.p95) / (quantiles.p99 - quantiles.p95)) * 4;
  }
  const excess = value - quantiles.p99;
  const tail = Math.min(1.0, Math.log1p(excess / quantiles.p99) / Math.log1p(10));
  return Math.min(100, 99 + tail);
}

/**
 * Validates that the current usage is offline experimental only.
 * Throws if attempted to be rolled out into production without holdout.
 */
export function assertOfflineUsage(config: DiscussionHeatConfig = DISCUSSION_HEAT_CONFIG, isProductionContext: boolean = false): void {
  if (isProductionContext || !config.offlineOnly || config.allowProductionRollout) {
    throw new Error(
      `DiscussionHeatScore guardrail violation: Version ${config.version} is an offline experimental model. ` +
      `Never use production weights without a calibrated holdout dataset of at least ${config.minHoldoutSamples} samples.`
    );
  }
}

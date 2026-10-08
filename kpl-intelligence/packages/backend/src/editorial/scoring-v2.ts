// Selection scoring v2 (P3): the formula lives here, in code, so it stays reviewable.
//
// The LLM only judges the material's own content: `base` (0–70) against the content-kind
// rubric plus `noise_flags[]` it observed. Everything about the source and the story's heat is
// computed here, never fed to the model ("评分输入不暴露信源").
//
//   final = clamp(base + official + heat − noise, 0, 100)
//     base      0–70  model, per the five content-kind rubrics in industry/prompts/selection-score.md
//     official  0–10  code, from the source's tier/owner_type/role (a relay inherits nothing)
//     heat      0–20  code, from the story's story_signals; unknown coverage degrades instead of scoring 0
//     noise     0–30  code, deduction from noise_flags (the hard caps clean-noise used to imply,
//                     now explicit; scoring sees the already-cleaned text, so pruned tail noise is
//                     never penalized twice)
//
// Two independent model calls are averaged per component ("打两次"防抖） before the formula runs.
// Gates: unrelated/drainage/abuse are blocked outright; severe misinformation, privacy violations
// and out-of-context quotes go to 待复核 (score capped, never published on that score);
// a failed model call throws (no score is fabricated — the article stays pending for review).
// SELECTION thresholds (58/64/74) are unchanged until scripts/eval-scoring-v2.ts recalibrates them.

export const SCORE_FORMULA_VERSION = "v2";

/** Heat placeholder while the article has no story (or the story has no signals yet). */
export const HEAT_UNKNOWN_VALUE = 6;
/** 待复核内容的分数上限：不发布，但保留分量供人工复核。 */
export const REVIEW_SCORE_CAP = 15;

export type ScoreContentKind = "announcement" | "dispute" | "analysis" | "fun" | "daily";
export type HeatCoverage = "ok" | "unknown";

export interface SourceAuthorityInput {
  tier: string;
  ownerType?: string | null;
  role?: string | null;
  firstParty?: boolean;
}

/** The model's per-call output (industry/prompts/selection-score.md). */
export interface ModelScoreOutput {
  contentKind: ScoreContentKind;
  base: number;
  heatEvidence: string;
  noiseFlags: string[];
  reasons: string;
}

/** The stored v2 components (analyses/publications.score_components). */
export interface ScoreComponents {
  base: number;
  official: number;
  heat: number;
  noise: number;
  coverage: HeatCoverage;
  noiseFlags: string[];
  heatEvidence: string | null;
  reasons: string | null;
  contentKind: ScoreContentKind;
  /** 待复核：严重失实/隐私/断章，分数被压到 REVIEW_SCORE_CAP 以下。 */
  needsReview: boolean;
  /** 拦截：无关/引流/辱骂，不参与精选。 */
  blocked: boolean;
}

export const clampScore = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

// Official (0–10): source identity only, never model input.
// T1 联盟/俱乐部一手公告 +8–10；官方采访/原创 +3–6；普通应援/重复海报/纯商务 +0–2；搬运不继承。
export function officialScore(source: SourceAuthorityInput, isRelay = false): number {
  if (isRelay) return 0; // 搬运不继承一手分的加成
  const tier = source.tier;
  const role = source.role ?? "";
  const owner = source.ownerType ?? "";
  if (tier === "T1") {
    if (role === "league_official" && owner === "league") return 10;
    if (role === "club_official" && owner === "club") return 9;
    return 8; // T1 一手：当事人账号与其他官方渠道
  }
  if (tier === "T1_5") {
    if (role === "principal") return 6;
    if (role === "league_official" || role === "club_official") return 5;
    if (role === "caster" || role === "media") return 4;
    return 3;
  }
  if (tier === "T2") {
    if (role === "principal") return 3;
    if (role === "caster" || role === "media") return 3;
    return 2;
  }
  if (role === "community") return 1;
  return 1; // 未知分级：保守给最低分档
}

// Heat (0–20) from the story's signals: independent participants, growth, cross-community.
// All bands are public and re-checkable against story_signals.
export interface HeatEvidence {
  /** Distinct participant_key count (an operator's matrix / a company's channels count once). */
  participants: number;
  /** Participants first seen in the last 6 hours. */
  newParticipants6h: number;
  /** Distinct participant communities (group:/owner:/source: prefixes). */
  communities: number;
}

export function heatScore(e: HeatEvidence): number {
  const participantBand = e.participants >= 8 ? 10 : e.participants >= 5 ? 6 : e.participants >= 3 ? 4 : e.participants >= 2 ? 2 : e.participants >= 1 ? 1 : 0;
  const growthBand = e.newParticipants6h >= 3 ? 6 : e.newParticipants6h >= 1 ? 3 : 0;
  const communityBand = e.communities >= 3 ? 4 : e.communities >= 2 ? 2 : 0;
  return Math.max(0, Math.min(20, participantBand + growthBand + communityBand));
}

// Noise flags the model may report (industry/prompts/selection-score.md). The deduction is
// capped at 30; some flags also impose a hard cap on the final score (the caps the old prompt
// implied, now explicit). Scoring reads the already-cleaned text, so tail noise clean-noise.ts
// pruned never reaches the model and is never deducted twice.
export const NOISE_DEDUCTIONS: Record<string, number> = {
  ad_tail: 6,          // 正文/尾部广告、商务挂靠
  lottery_hook: 5,     // 抽奖、红包封面、点赞在看引导
  promo_poster: 10,    // 无竞技事实的宣传海报/口号
  fan_war: 8,          // 饭圈互撕、引战
  betting: 12,         // 挂靠赛事的博彩
  rumor_unverified: 6, // 无事实依据的八卦传闻
  title_bait: 8,       // 标题党、标题与正文核心不符
  thin_content: 8,     // 只有预告/海报、无确定事实
  repost_chain: 4,     // 纯转发、无信息增量
};

/** Flags that cap the final score no matter the other components. */
export const NOISE_HARD_CAPS: Record<string, number> = {
  title_bait: 30,
  betting: 30,
};

/** 资格门：先行拦截（不参与精选）。 */
export const BLOCK_FLAGS = ["unrelated", "drainage", "abuse"] as const;
/** 资格门：待复核（压分不发布）。 */
export const REVIEW_FLAGS = ["severe_misinformation", "privacy_violation", "out_of_context"] as const;

export interface NoiseResult {
  flags: string[];
  deduction: number;
  hardCap: number | null;
  needsReview: boolean;
  blocked: boolean;
}

export function noiseResult(rawFlags: string[]): NoiseResult {
  const flags = [...new Set(rawFlags.map((f) => String(f).trim()).filter((f) => f in NOISE_DEDUCTIONS || (BLOCK_FLAGS as readonly string[]).includes(f) || (REVIEW_FLAGS as readonly string[]).includes(f)))];
  const deduction = Math.min(30, flags.reduce((sum, f) => sum + (NOISE_DEDUCTIONS[f] ?? 0), 0));
  const caps = flags.map((f) => NOISE_HARD_CAPS[f]).filter((c): c is number => typeof c === "number");
  return {
    flags,
    deduction,
    hardCap: caps.length ? Math.min(...caps) : null,
    needsReview: flags.some((f) => (REVIEW_FLAGS as readonly string[]).includes(f)),
    blocked: flags.some((f) => (BLOCK_FLAGS as readonly string[]).includes(f)),
  };
}

/** Average the two independent model calls per component, then the formula runs once. */
export function averageModelOutputs(calls: ModelScoreOutput[]): Omit<ModelScoreOutput, "heatEvidence" | "reasons"> & { heatEvidence: string | null; reasons: string | null } {
  const base = calls.length ? Math.round(calls.reduce((s, c) => s + c.base, 0) / calls.length) : 0;
  const noiseFlags = [...new Set(calls.flatMap((c) => c.noiseFlags))];
  // The kind both calls agreed on wins; a split falls back to the first call's.
  const kinds = calls.map((c) => c.contentKind);
  const contentKind = kinds[0] === kinds[1] ? kinds[0]! : kinds[0]!;
  const heatEvidence = calls.map((c) => c.heatEvidence.trim()).find(Boolean) ?? null;
  const reasons = calls.map((c) => c.reasons.trim()).find(Boolean) ?? null;
  return { contentKind, base, heatEvidence, noiseFlags, reasons };
}

export interface FinalizeInput {
  base: number;
  official: number;
  /** Null while the article has no story heat: degraded placeholder, coverage 'unknown'. */
  heat: number | null;
  noiseFlags: string[];
  contentKind: ScoreContentKind;
  heatEvidence?: string | null;
  reasons?: string | null;
}

export interface FinalizedScore {
  final: number;
  components: ScoreComponents;
}

/** The v2 formula: clamp(base + official + heat − noise), then gates. */
export function finalizeScore(input: FinalizeInput): FinalizedScore {
  const noise = noiseResult(input.noiseFlags);
  const heat = input.heat ?? HEAT_UNKNOWN_VALUE;
  const coverage: HeatCoverage = input.heat === null ? "unknown" : "ok";
  let final = clampScore(input.base + input.official + heat - noise.deduction);
  if (noise.hardCap !== null) final = Math.min(final, noise.hardCap);
  if (noise.needsReview) final = Math.min(final, REVIEW_SCORE_CAP);
  if (noise.blocked) final = 0;
  return {
    final,
    components: {
      base: clampScore(input.base), official: input.official, heat, noise: noise.deduction, coverage,
      noiseFlags: noise.flags, heatEvidence: input.heatEvidence ?? null, reasons: input.reasons ?? null,
      contentKind: input.contentKind, needsReview: noise.needsReview && !noise.blocked, blocked: noise.blocked,
    },
  };
}

/**
 * Ranking order for v2 scores: higher final first; on a tie, an item whose heat is actually
 * observed ('ok') outranks one still on the degraded unknown placeholder ("缺失降级").
 */
export function compareRanked(a: { final: number; coverage: HeatCoverage }, b: { final: number; coverage: HeatCoverage }): number {
  if (a.final !== b.final) return b.final - a.final;
  if (a.coverage !== b.coverage) return a.coverage === "ok" ? -1 : 1;
  return 0;
}

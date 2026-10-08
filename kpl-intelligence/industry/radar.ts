// Versioned initial settings. Real-model accuracy and traffic impact require a labelled holdout.
export const RADAR = {
  // Keep rollout closed until a user-labelled holdout calibrates the proposed threshold/weights.
  // Tests explicitly enable the complete pipeline; enabling adds one budget-protected judgment per new revision.
  enabled: false,
  version: 'radar-v1-70-10-20',
  admissionThreshold: 45,
  weights: {
    official: [0.50, 0.05, 0.10, 0.30, 0.05],
    match: [0.40, 0.15, 0.10, 0.25, 0.10],
    controversy: [0.25, 0.25, 0.15, 0.15, 0.20],
    analysis: [0.25, 0.35, 0.20, 0.05, 0.15],
    fun: [0.10, 0.05, 0.25, 0.10, 0.50],
    activity: [0.30, 0.10, 0.10, 0.25, 0.25],
  },
  // Within-platform saturation points, not cross-platform comparable raw interaction totals.
  heatSaturation: { weibo: 10000, hupu: 1000, bilibili: 10000 } as Record<string, number>,
  mix: { controversy: 0.50, official: 0.20, analysis: 0.15, fun: 0.15 },
};

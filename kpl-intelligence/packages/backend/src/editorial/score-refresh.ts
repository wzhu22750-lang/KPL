// v2 score heat refinement: at score time the article has no story, so heat is the degraded
// 'unknown' placeholder. After grouping, the story's story_signals exist — recompute the heat
// component from them and update the same analysis row (a refinement of the same judgement,
// not a recompute of history; v1 rows are never touched). Idempotent: only rows still on
// coverage 'unknown' are updated.
import { sql } from "../db.ts";
import { currentSignals } from "../events/hot.ts";
import { finalizeScore, heatScore, type HeatEvidence, type ScoreComponents } from "./scoring-v2.ts";

export interface HeatRefreshResult {
  updated: boolean;
  reason: "ok" | "no-signals" | "no-v2-pending" | "failed";
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export async function refreshScoreHeat(articleId: string, storyId: number): Promise<HeatRefreshResult> {
  const rows = await sql<{ participant_key: string; first_at: Date }[]>`
    SELECT participant_key, min(observed_at) AS first_at FROM ${currentSignals()} cs
    WHERE story_id = ${storyId} GROUP BY participant_key`;
  if (rows.length === 0) return { updated: false, reason: "no-signals" };
  const sixHoursAgo = Date.now() - 6 * 3600_000;
  const evidence: HeatEvidence = {
    participants: rows.length,
    newParticipants6h: rows.filter((r) => r.first_at.getTime() > sixHoursAgo).length,
    communities: new Set(rows.map((r) => String(r.participant_key).split(":")[0] ?? "")).size,
  };
  const heat = heatScore(evidence);
  const [an] = await sql<{ id: number; score_components: ScoreComponents | null }[]>`
    SELECT id, score_components FROM analyses
    WHERE article_id = ${articleId} AND score_formula_version = 'v2'
      AND coalesce(score_components->>'coverage', 'unknown') = 'unknown'
    ORDER BY input_revision DESC, id DESC LIMIT 1`;
  if (!an?.score_components) return { updated: false, reason: "no-v2-pending" };
  const prev = an.score_components;
  const { final, components } = finalizeScore({
    base: prev.base, official: prev.official, heat,
    noiseFlags: prev.noiseFlags, contentKind: prev.contentKind,
    heatEvidence: `${evidence.participants} 个独立参与者 / 近 6 小时新增 ${evidence.newParticipants6h} / 跨 ${evidence.communities} 个社区`,
    reasons: prev.reasons,
  });
  await sql.begin(async (tx) => {
    await tx`UPDATE analyses SET score = ${final}, score_components = ${tx.json(components as never)}
             WHERE id = ${an.id} AND score_formula_version = 'v2'`;
    await tx`UPDATE publications SET score = ${round1(final)}, score_formula_version = 'v2',
               score_components = ${tx.json(components as never)} WHERE article_id = ${articleId}`;
  });
  return { updated: true, reason: "ok" };
}

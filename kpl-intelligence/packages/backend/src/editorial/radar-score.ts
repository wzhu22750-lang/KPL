import { z } from 'zod';
import { RADAR } from '@aihot/industry/radar';
import type { Engagement } from '../content/extractors/types.ts';
import type { RadarKind, RadarScore } from '@aihot/contracts/radar';

const dimension = z.number().int().min(0).max(100);
export const RadarJudgment = z.object({
  relevant: z.boolean(), safe: z.boolean(), kind: z.enum(['official','match','controversy','analysis','fun','activity']),
  title: z.string().trim().min(1).max(100), summary: z.string().trim().min(1).max(600),
  claimStatus: z.enum(['fact','opinion','rumor','joke']), stance: z.string().max(300).nullable(),
  evidence: z.array(z.string().min(1).max(300)).max(4), topicKey: z.string().min(3).max(160).nullable(),
  information: dimension, interpretation: dimension, distinctiveness: dimension, timeliness: dimension, interest: dimension,
  noise: dimension, newDevelopment: z.boolean(), reason: z.string().min(1).max(400),
});
export type RadarJudgmentData = z.infer<typeof RadarJudgment>;
export interface HeatObservation { platform: string; observedAt: Date; metrics: Engagement }
const interactions = (m: Engagement) => (m.likes ?? 0) + 2 * (m.comments ?? 0) + 3 * (m.shares ?? 0);

export function radarScore(j: RadarJudgmentData, verifiedOfficial: boolean, latest?: HeatObservation, previous?: HeatObservation): RadarScore {
  const weights = RADAR.weights[j.kind];
  const dims = [j.information,j.interpretation,j.distinctiveness,j.timeliness,j.interest];
  const base = Math.round(0.7 * dims.reduce((sum,v,i) => sum + v * weights[i]!, 0));
  const official = verifiedOfficial && j.claimStatus === 'fact' ? j.kind === 'official' || j.kind === 'match' ? 10 : j.kind === 'activity' ? 2 : 5 : 0;
  const known = latest && ['likes','comments','shares'].some(k => typeof latest.metrics[k as keyof Engagement] === 'number');
  let heat: number | null = null;
  if (known && latest) {
    const total = interactions(latest.metrics);
    const saturation = RADAR.heatSaturation[latest.platform];
    if (saturation) {
      heat = Math.min(12, Math.round(12 * Math.log1p(total) / Math.log1p(saturation)));
      // Only comparable consecutive snapshots can demonstrate growth; missing counters stay unknown.
      const keys = (['likes','comments','shares'] as const).filter(k =>
        typeof latest.metrics[k] === 'number' && typeof previous?.metrics[k] === 'number');
      const comparable = previous && previous.platform === latest.platform && latest.observedAt > previous.observedAt
        && keys.length > 0 && keys.every(k => latest.metrics[k]! >= previous.metrics[k]!);
      if (comparable && previous) {
        const hours = (latest.observedAt.getTime()-previous.observedAt.getTime()) / 3600000;
        const weights = { likes: 1, comments: 2, shares: 3 };
        const delta = keys.reduce((sum,k) => sum + weights[k] * (latest.metrics[k]! - previous.metrics[k]!), 0);
        const growth = delta / Math.max(hours, 0.25);
        heat += Math.min(8, Math.round(8 * Math.log1p(growth) / Math.log1p(saturation / 4)));
      }
    }
  }
  const noise = Math.round(0.3*j.noise);
  return { version: RADAR.version, base, official, heat, noise,
    total: Math.max(0,Math.min(100,base+official+(heat ?? 0)-noise)),
    heatCoverage: heat === null ? 'unknown' : 'observed', observedAt: latest?.observedAt.toISOString() ?? null, reason: j.reason,
    heatPlatform: latest?.platform ?? null, metrics: Object.fromEntries(Object.entries(latest?.metrics ?? {}).map(([key,value])=>[key,value ?? null])) };
}
export function radarAdmission(j: RadarJudgmentData, score: RadarScore): 'accepted' | 'rejected' | 'review' {
  if (!j.relevant) return 'rejected';
  if (!j.safe || j.noise >= 80) return 'review';
  return score.total >= RADAR.admissionThreshold ? 'accepted' : 'rejected';
}

export function chooseRadarMix<T extends { kind: RadarKind; score: number }>(rows: T[], limit: number): T[] {
  const sorted = [...rows].sort((a,b) => b.score-a.score);
  const picked: T[] = [];
  for (const [kind, ratio] of Object.entries(RADAR.mix)) {
    picked.push(...sorted.filter(r => r.kind === kind).slice(0, Math.floor(limit*ratio)));
  }
  for (const row of sorted) if (picked.length < limit && !picked.includes(row)) picked.push(row);
  return picked.sort((a,b) => b.score-a.score).slice(0,limit);
}

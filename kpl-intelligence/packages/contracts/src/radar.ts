import type { DiscussionPostView } from "./site.ts";

export type RadarKind = 'official' | 'match' | 'controversy' | 'analysis' | 'fun' | 'activity';
export interface RadarScore {
  version: string; base: number; official: number; heat: number | null; noise: number; total: number;
  heatCoverage: 'observed' | 'unknown'; observedAt: string | null; reason: string;
  heatPlatform: string | null; metrics: Record<string, number | null>;
}
export interface RadarMaterial {
  id: string; title: string; summary: string; source: string; url: string;
  itemUrl?: string | null;
  publishedAt: string | null; kind: RadarKind; score: RadarScore;
  claimStatus: 'fact' | 'opinion' | 'rumor' | 'joke';
  stance: string | null; evidence: string[]; matchId: string | null; gameNo: number | null;
  commentPreview?: DiscussionPostView | null;
  platform?: 'weibo' | 'bilibili' | 'hupu' | string | null;
}
export interface RadarTopic {
  id: number; title: string; updatedAt: string; score: number; materials: RadarMaterial[];
}
export interface RadarMatch {
  id: string; title: string; bo: number | null; status: string; scheduledAt: string | null;
  home: { slug: string; name: string; shortName: string | null; logo: string | null };
  away: { slug: string; name: string; shortName: string | null; logo: string | null };
  homeScore: number; awayScore: number; materials: RadarMaterial[];
  games: Array<{ gameNo: number; winner: string | null; mvp: string | null }>;
}
/** Canonical match cards; available even when experimental radar judgment is disabled. */
export interface MatchOverviewResponse { matches: RadarMatch[]; }
export interface RadarResponse {
  day: string; matches: RadarMatch[]; topics: RadarTopic[]; standalone: RadarMaterial[];
  coverage: { reviewed: number; pending: number; note: string };
}

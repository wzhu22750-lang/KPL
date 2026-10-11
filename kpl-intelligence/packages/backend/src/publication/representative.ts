// A source's T1 label and its authority to speak for an event are separate inputs.
import { sql } from "../db.ts";
import { entityIdentity } from "../editorial/vocabulary.ts";

export interface RepresentativeIdentity {
  source_tier: string;
  publisher_role: string | null;
  owner_entity_id: string | null;
  fact_subject: string | null;
  /** Editorial priority only; does not overwrite structured match data or confirm a claim. */
  preferred_match_report?: boolean;
}

export const REPRESENTATIVE_COLUMNS = sql`s.tier AS source_tier, s.config->>'publisherRole' AS publisher_role,
  s.owner_entity_id, f.subject AS fact_subject,
  (f.claim_type = 'match_result' AND s.kind = 'weibo' AND s.owner_type = 'league'
    AND s.owner_entity_id = 'kpl' AND s.config->>'uid' = '6074356560') AS preferred_match_report`;

export function representativePriority(row: Partial<RepresentativeIdentity>): number {
  // Within an already grouped result, the league's Weibo report leads; Bilibili is supporting video.
  if (row.preferred_match_report === true) return -1;
  if (row.source_tier === "T1") return 0;
  const owner = entityIdentity(row.owner_entity_id);
  const subjects = row.fact_subject?.split(/[,，、;；+＋&＆/]/u).map((subject) => entityIdentity(subject)) ?? [];
  if (!owner || subjects.some((subject) => !subject) || !subjects.includes(owner)) return 3;
  if (row.publisher_role === "organization") return 1;
  if (row.publisher_role === "person") return 2;
  return 3;
}

export type RepresentativeRow = Partial<RepresentativeIdentity> & {
  id?: string;
  article_id?: string;
  body_mode: "full" | "summary";
  score: number | null;
  timeline_at: Date;
};

/** Within the existing fact/candidate scope: league Weibo result, T1, publisher, body, score, time. */
export function pickRepresentative<T extends RepresentativeRow>(rows: T[]): T {
  return [...rows].sort((a, b) => representativePriority(a) - representativePriority(b)
    || Number(b.body_mode === "full") - Number(a.body_mode === "full")
    || Number(b.score ?? 0) - Number(a.score ?? 0)
    || a.timeline_at.getTime() - b.timeline_at.getTime()
    || (a.article_id ?? a.id ?? "").localeCompare(b.article_id ?? b.id ?? ""))[0]!;
}

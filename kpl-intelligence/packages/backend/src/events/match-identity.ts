// Match identity is a hard constraint, not a similarity score. Check every primary/report member:
// an erroneous group must not become safe merely because its representative was replaced.
import { sql, type Db } from "../db.ts";
import { kplOccurrenceConflict } from "../lib/kpl-dedup.ts";
import { latestCompositeCondition } from "../publication/scope.ts";

export interface MatchReport { title: string; at: Date | null }
export interface FactMatchReport extends MatchReport { fact_id: number; article_id: string; manual: boolean }

export async function factMatchReports(ids: number[], db: Db = sql): Promise<FactMatchReport[]> {
  if (!ids.length) return [];
  return db<FactMatchReport[]>`
    SELECT fa.fact_id, fa.article_id, fa.manual, coalesce(an.title_zh, a.title) AS title,
      a.published_at AS at
    FROM fact_articles fa JOIN articles a ON a.id = fa.article_id
    LEFT JOIN LATERAL (SELECT title_zh FROM analyses WHERE article_id=a.id ORDER BY input_revision DESC,id DESC LIMIT 1) an ON true
    WHERE fa.fact_id = ANY(${ids}::bigint[]) AND fa.role IN ('primary','report')
      AND NOT ${latestCompositeCondition(sql`a.id`)}`;
}

export function matchConflict(a: MatchReport, b: MatchReport): string | null {
  return kplOccurrenceConflict(a.title, b.title, a.at, b.at);
}

export async function conflictingMatchFacts(query: MatchReport, ids: number[], db: Db = sql): Promise<Map<number, string>> {
  const reports = await factMatchReports(ids, db);
  const conflicts = new Map<number, string>();
  for (const id of ids) {
    const members = reports.filter(r => r.fact_id === id);
    for (let i = 0; i < members.length; i++) {
      const conflict = matchConflict(query, members[i]!)
        ?? members.slice(i + 1).map(other => matchConflict(members[i]!, other)).find(Boolean);
      if (conflict) { conflicts.set(id, conflict); break; }
    }
  }
  return conflicts;
}

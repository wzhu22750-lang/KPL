// Match identity is a hard constraint, not a similarity score. Check every primary/report member:
// an erroneous group must not become safe merely because its representative was replaced.
import { sql, type Db } from "../db.ts";
import { areSameSeriesDifferentGame, kplOccurrenceConflict } from "../lib/kpl-dedup.ts";
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

/**
 * P2 SAME_SERIES：与 query 的唯一分歧是小局粒度（conflict 只有 "different game scope"，
 * 且同两队+同日期+同赛事/轮次、局次不同）的 fact id。这些 fact 不触发硬 veto：
 * 新报道进同一个 story、另起一个 fact（按局次），两篇都走 match-link 链接器。
 * 其余 veto（不同对手/日期/赛事/轮次）保持不动。
 */
export async function sameSeriesDifferentGameFacts(query: MatchReport, ids: number[], db: Db = sql): Promise<number[]> {
  const reports = await factMatchReports(ids, db);
  const out: number[] = [];
  for (const id of ids) {
    const members = reports.filter((r) => r.fact_id === id);
    if (!members.length) continue;
    let series = false;
    let ok = true;
    for (const m of members) {
      const conflict = matchConflict(query, m);
      if (conflict === null) continue;
      if (conflict === "different game scope" && areSameSeriesDifferentGame(query.title, m.title, query.at, m.at)) {
        series = true;
        continue;
      }
      ok = false;
      break;
    }
    if (ok && series) out.push(id);
  }
  return out;
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

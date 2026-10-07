// Read-only inspection by default. A confirmed split preserves articles, analyses and publication
// decisions; membership, signals, projections and the audit snapshot commit in one transaction.
import { audit } from "../audit.ts";
import { sql } from "../db.ts";
import { newShortId, newUuid, stableJson } from "../lib/ids.ts";
import { extractMatchFingerprint } from "../lib/kpl-dedup.ts";
import { publishArticleTx } from "../publication/publish.ts";
import { factMatchReports, matchConflict, type FactMatchReport } from "./match-identity.ts";

export function partitionMatchReports(reports: FactMatchReport[]): FactMatchReport[][] {
  const groups: FactMatchReport[][] = [];
  for (const report of [...reports].sort((a, b) => +(a.at ?? 0) - +(b.at ?? 0) || a.article_id.localeCompare(b.article_id))) {
    const fp = extractMatchFingerprint(report.title, report.at);
    // Unknowns cannot bridge two matches. They become standalone, never guessed into a partition.
    const group = fp?.dateKey && groups.find(g => {
      const other = extractMatchFingerprint(g[0]!.title, g[0]!.at);
      return !!other && other.dateKey === fp.dateKey && other.teams.join() === fp.teams.join()
        && g.every(r => !matchConflict(report, r));
    });
    if (group) group.push(report); else groups.push([report]);
  }
  return groups;
}

export async function inspectMatchGroups() {
  const facts = await sql<{ id: number; public_id: string }[]>`
    SELECT f.id,f.public_id FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id
    WHERE fa.role IN ('primary','report') GROUP BY f.id HAVING count(*)>1 ORDER BY f.id`;
  const rows = await factMatchReports(facts.map(f => f.id));
  return facts.flatMap(f => {
    const reports = rows.filter(r => r.fact_id === f.id);
    const conflicts = reports.flatMap((a, i) => reports.slice(i + 1).flatMap(b => {
      const reason = matchConflict(a, b);
      return reason ? [{ a: a.article_id, b: b.article_id, reason }] : [];
    }));
    return conflicts.length ? [{ ...f, reports, conflicts, manual: reports.some(r => r.manual), partitions: partitionMatchReports(reports) }] : [];
  });
}

export async function repairMatchGroup(factId: number, expected: FactMatchReport[], actor: string) {
  return sql.begin(async tx => {
    const ids = expected.map(r => r.article_id).sort();
    await tx`SELECT id FROM articles WHERE id=ANY(${ids}) ORDER BY id FOR UPDATE`;
    const [fact] = await tx`SELECT * FROM facts WHERE id=${factId} FOR UPDATE`;
    if (!fact) throw new Error("Fact disappeared");
    const current = await factMatchReports([factId], tx);
    const signature = (rows: FactMatchReport[]) => stableJson([...rows].sort((a, b) => a.article_id.localeCompare(b.article_id)));
    if (signature(current) !== signature(expected)) throw new Error("Group changed since inspection; run dry-run again");
    const memberships = await tx`SELECT * FROM fact_articles WHERE fact_id=${factId}`;
    const reports = memberships.filter(r => r.role === 'primary' || r.role === 'report');
    if (reports.some(r => r.manual) || reports.length !== current.length) throw new Error("Manual/composite membership requires editorial review");
    const conflicts = current.some((a, i) => current.slice(i + 1).some(b => matchConflict(a, b)));
    if (!conflicts) return { changed: false, groups: [] as number[] };
    const overlapping = await tx`SELECT 1 FROM fact_articles WHERE article_id=ANY(${ids}) AND fact_id<>${factId} AND role IN ('primary','report') LIMIT 1`;
    if (overlapping.length) throw new Error("Multiple memberships require editorial review");
    const before = {
      fact, memberships,
      publications: await tx`SELECT * FROM publications WHERE article_id=ANY(${ids})`,
      signals: await tx`SELECT * FROM story_signals WHERE article_id=ANY(${ids})`,
      stories: fact.story_id ? await tx`SELECT * FROM stories WHERE id=${fact.story_id}` : [],
    };
    const groups: number[] = [];
    await tx`DELETE FROM fact_articles WHERE fact_id=${factId} AND role IN ('primary','report')`;
    await tx`DELETE FROM story_signals WHERE article_id=ANY(${ids})`;
    for (const partition of partitionMatchReports(current)) {
      const first = partition[0]!;
      const fp = extractMatchFingerprint(first.title, first.at);
      if (!fp?.dateKey) {
        await tx`INSERT INTO grouping_overrides (article_id,reason,actor) VALUES (${first.article_id},'Conflicting match group: insufficient identity; keep standalone',${actor}) ON CONFLICT (article_id) DO NOTHING`;
        continue;
      }
      const title = first.title.slice(0, 120);
      const [story] = await tx`INSERT INTO stories (public_id,title,first_report_at,latest_at,origin)
        VALUES (${newUuid()},${title},${first.at},${partition.at(-1)!.at},'manual') RETURNING id`;
      const [created] = await tx`INSERT INTO facts (public_id,story_id,title,subject,occurred_at,claim_type)
        VALUES (${`f${newShortId(8)}`},${story!.id},${title},${fp.teams.join(',')},${new Date(`${fp.dateKey.slice(0,4)}-${fp.dateKey.slice(4,6)}-${fp.dateKey.slice(6,8)}T00:00:00+08:00`)},${fact.claim_type}) RETURNING id`;
      const newFactId = Number(created!.id);
      groups.push(newFactId);
      for (const [index, r] of partition.entries()) {
        const old = memberships.find(m => m.article_id === r.article_id)!;
        await tx`INSERT INTO fact_articles (fact_id,article_id,role,evidence,created_at)
          VALUES (${newFactId},${r.article_id},${index === 0 ? 'primary' : 'report'},${old.evidence},${old.created_at})`;
        await tx`INSERT INTO story_signals (story_id,article_id,participant_key,source_id,kind,observed_at)
          SELECT ${story!.id},a.id,CASE WHEN s.signal_group_id IS NULL THEN 'source:'||s.id ELSE 'group:'||s.signal_group_id END,s.id,'editorial',coalesce(a.published_at,a.discovered_at)
          FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=${r.article_id}`;
      }
      await tx`UPDATE facts SET primary_source_id=(SELECT source_id FROM articles WHERE id=${first.article_id}) WHERE id=${newFactId}`;
    }
    await tx`UPDATE facts SET primary_source_id=NULL,updated_at=now() WHERE id=${factId}`;
    // The old generated digest may repeat the false identity. Invalidate rather than buy a rewrite.
    if (fact.story_id) await tx`UPDATE stories SET digest=NULL,updated_at=now() WHERE id=${fact.story_id}`;
    // Rebuild all public projections.
    for (const id of ids) await publishArticleTx(tx, id);
    await audit(actor, 'content.split-match-group', `fact:${fact.public_id}`,
      'Split conflicting opponents/dates/competition/game scope; no model calls or article deletion', before,
      { groups, articleIds: ids }, { db: tx });
    return { changed: true, groups };
  });
}

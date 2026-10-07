// Dry-run is the default. --apply requires an explicit list of fact public ids printed by dry-run.
// Never invokes collectors/models; audit_log stores the pre-repair memberships and projections.
import { sql, closeDb } from "../packages/backend/src/db.ts";
import { inspectMatchGroups, repairMatchGroup } from "../packages/backend/src/events/repair-match-groups.ts";

const apply = process.argv.includes('--apply');
const selected = new Set((process.argv.find(a => a.startsWith('--facts='))?.slice(8) ?? '').split(',').filter(Boolean));
try {
  if (apply && !selected.size) throw new Error('--apply requires --facts=<public-id,...> from a reviewed dry-run');
  const plans = await inspectMatchGroups();
  for (const plan of plans) {
    console.log(JSON.stringify({ fact: plan.public_id, manual: plan.manual, conflicts: plan.conflicts,
      partitions: plan.partitions.map(g => g.map(r => ({ id: r.article_id, title: r.title, at: r.at }))) }));
    if (apply && selected.has(plan.public_id)) {
      if (plan.manual) throw new Error(`Manual membership in ${plan.public_id}; requires review`);
      console.log(JSON.stringify({ fact: plan.public_id, result: await repairMatchGroup(plan.id, plan.reports, 'ops:match-identity-repair') }));
    }
  }
  if (apply) {
    const remaining = await inspectMatchGroups();
    if (remaining.some(p => selected.has(p.public_id))) throw new Error('Requested groups still conflict');
    const auditCount = await sql`SELECT count(*) AS count FROM audit_log WHERE action='content.split-match-group'`;
    console.log(JSON.stringify({ remainingConflictingGroups: remaining.length, auditRecords: auditCount[0]?.count }));
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', conflictingGroups: plans.length }));
} finally { await closeDb(); }

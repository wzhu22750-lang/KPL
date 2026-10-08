import { collectionDefaults } from "@aihot/industry/collection";
import type { Db } from "../db.ts";

export interface CadenceSource {
  id: string;
  kind: string;
  config: Record<string, unknown>;
  interval_minutes: number;
  last_fetch_at: Date | null;
  next_fetch_at: Date | null;
}

export function planCollectionChange(source: CadenceSource, now = new Date()) {
  const desired = collectionDefaults(source);
  if (!desired) return null;
  const oldPolicy = source.config.collectionPolicy ?? null;
  const mode = oldPolicy && typeof oldPolicy === "object" ? (oldPolicy as Record<string, unknown>).mode : null;
  if (source.interval_minutes === desired.intervalMinutes && mode === desired.mode) return null;
  // Slow down relative to the last attempted read. Preserve a longer existing cooldown.
  // A never-read source may run once immediately; then its daily cadence applies.
  const next = source.last_fetch_at
    ? Math.max(now.getTime(), source.last_fetch_at.getTime() + desired.intervalMinutes * 60_000)
    : source.next_fetch_at?.getTime() ?? now.getTime();
  const nextFetchAt = new Date(source.interval_minutes <= desired.intervalMinutes
    ? Math.max(next, source.next_fetch_at?.getTime() ?? 0) : next);
  return { id: source.id, reason: desired.reason,
    before: { intervalMinutes: source.interval_minutes, collectionPolicy: oldPolicy, nextFetchAt: source.next_fetch_at },
    after: { intervalMinutes: desired.intervalMinutes, collectionPolicy: { mode: desired.mode }, nextFetchAt } };
}

/** Dry-run is read-only; application updates only cadence and policy, not source identity/enablement.
 * Caller owns the transaction when apply=true, so its row locks span planning and updating.
 */
export async function applyCollectionDefaults(db: Db, opts: { apply?: boolean; ids?: string[]; now?: Date } = {}) {
  const rows = await db<CadenceSource[]>`SELECT id, kind, config, interval_minutes, last_fetch_at, next_fetch_at FROM sources
    WHERE ${opts.ids?.length ? db`id IN ${db(opts.ids)}` : db`true`} ORDER BY id ${opts.apply ? db`FOR UPDATE` : db``}`;
  const changes = rows.flatMap((row) => {
    const change = planCollectionChange(row, opts.now);
    return change ? [change] : [];
  });
  if (opts.apply) {
    for (const c of changes) {
      await db`UPDATE sources SET interval_minutes = ${c.after.intervalMinutes},
        config = jsonb_set(config, '{collectionPolicy}', ${db.json(c.after.collectionPolicy)}, true),
        next_fetch_at = ${c.after.nextFetchAt}, updated_at = now() WHERE id = ${c.id}`;
    }
  }
  return { applied: opts.apply === true, changes,
    missing: (opts.ids ?? []).filter((id) => !rows.some((row) => row.id === id)) };
}

// Seeds a fresh site from the industry pack: the demo sources (industry/sources.json, only the ones not
// there yet, so admin edits are never undone) and, with the leaderboard on, its model directory (only
// models, names and scales not there yet). Topics need no seeding: they are read from industry/topics.json.
// Re-runnable:  node --env-file=.env scripts/seed.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { FEATURES } from "@aihot/industry/features";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { importModelDirectory } from "@aihot/backend/leaderboard/directory";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";

interface SeedSource {
  id: string;
  name: string;
  kind: "rss" | "web_list" | "json_list" | "x_search" | "mp_account" | "external" | "esports_api" | "weibo";
  config: Record<string, unknown>;
  tier?: string;
  role?: string;
  owner_type?: string | null;
  owner_entity_id?: string | null;
  claim_types?: string[];
  participation_mode?: string;
  interval_minutes?: number;
  priority_weight?: number;
  auto_tune?: boolean;
  tags?: string[];
  site_fulltext?: boolean;
  syndicate_fulltext?: boolean;
  enabled?: boolean;
}

interface TeamAccount {
  sourceId?: string;
  verifiedEvidence?: string;
}

const teamAccounts = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/team-accounts.json"), "utf8")) as {
  league?: TeamAccount[];
  teams?: TeamAccount[];
};
/** Verified account archives (industry/team-accounts.json): sourceId → verifiedEvidence. */
const evidenceBySource = new Map<string, string>();
for (const a of [...(teamAccounts.league ?? []), ...(teamAccounts.teams ?? [])]) {
  if (a.sourceId && a.verifiedEvidence && !evidenceBySource.has(a.sourceId)) evidenceBySource.set(a.sourceId, a.verifiedEvidence);
}

const { sources } = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources: SeedSource[] };
let added = 0;
for (const s of sources) {
  assertSupportedConfig(s.kind, s.config);
  const tier = s.tier ?? "T2";
  const evidence = evidenceBySource.get(s.id) ?? null;
  // First-party means a T1 source, as the admin sets it.
  const inserted = await sql`
    INSERT INTO sources (id, name, kind, config, tier, first_party, role, owner_type, owner_entity_id, claim_types, participation_mode, interval_minutes, priority_weight, auto_tune, verified_evidence, last_verified_at, tags, site_fulltext, syndicate_fulltext, enabled, next_fetch_at)
    VALUES (${s.id}, ${s.name}, ${s.kind}, ${sql.json(s.config as never)}, ${tier}, ${tier === "T1"}, ${s.role ?? "media"}, ${s.owner_type ?? null}, ${s.owner_entity_id ?? null}, ${s.claim_types ?? []},
            ${s.participation_mode ?? "editorial"}, ${s.interval_minutes ?? 60}, ${s.priority_weight ?? 0}, ${s.auto_tune ?? true},
            ${evidence}, ${evidence ? sql`now()` : null}, ${s.tags ?? []}, ${s.site_fulltext ?? false}, ${s.syndicate_fulltext ?? false},
            ${s.enabled ?? true}, now())
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      kind = EXCLUDED.kind,
      config = EXCLUDED.config,
      tier = EXCLUDED.tier,
      role = EXCLUDED.role,
      owner_type = EXCLUDED.owner_type,
      owner_entity_id = EXCLUDED.owner_entity_id,
      claim_types = EXCLUDED.claim_types,
      participation_mode = EXCLUDED.participation_mode,
      interval_minutes = EXCLUDED.interval_minutes,
      priority_weight = EXCLUDED.priority_weight,
      auto_tune = EXCLUDED.auto_tune,
      verified_evidence = EXCLUDED.verified_evidence,
      -- Re-verify time only moves when the evidence text changed: a re-seed that only repeats the
      -- same evidence keeps the original verification time.
      last_verified_at = CASE WHEN EXCLUDED.verified_evidence IS DISTINCT FROM sources.verified_evidence THEN now() ELSE sources.last_verified_at END,
      tags = EXCLUDED.tags,
      site_fulltext = EXCLUDED.site_fulltext,
      syndicate_fulltext = EXCLUDED.syndicate_fulltext,
      enabled = EXCLUDED.enabled,
      updated_at = now()
    RETURNING id`;
  added += inserted.length;
}
console.log(`sources: ${added} added, ${sources.length - added} already there`);
if (FEATURES.leaderboard) {
  const { models, aliases, calibrations } = await importModelDirectory();
  console.log(`leaderboard directory: ${models} models, ${aliases} names, ${calibrations} calibrations added`);
}
await closeDb();

// Seeds a site from the industry pack. Source entries are UPSERTED, including admin-editable fields;
// use apply-source-policy.ts (dry-run by default) to change only collection cadence on an existing site.
// With leaderboard enabled, also seed its model directory. Topics are read from industry/topics.json.
// Re-runnable:  node --env-file=.env scripts/seed.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { FEATURES } from "@aihot/industry/features";
import { collectionDefaults } from "@aihot/industry/collection";
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
  owner_type?: string | null;
  owner_entity_id?: string | null;
  claim_types?: string[];
  participation_mode?: string;
  interval_minutes?: number;
  tags?: string[];
  site_fulltext?: boolean;
  syndicate_fulltext?: boolean;
  enabled?: boolean;
}

const { sources } = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")) as { sources: SeedSource[] };
let added = 0;
for (const entry of sources) {
  const policy = collectionDefaults(entry);
  const s = policy ? { ...entry, interval_minutes: policy.intervalMinutes,
    config: { ...entry.config, collectionPolicy: { mode: policy.mode } } } : entry;
  assertSupportedConfig(s.kind, s.config);
  const tier = s.tier ?? "T2";
  // First-party means a T1 source, as the admin sets it.
  const inserted = await sql`
    INSERT INTO sources (id, name, kind, config, tier, first_party, owner_type, owner_entity_id, claim_types, participation_mode, interval_minutes, tags, site_fulltext, syndicate_fulltext, enabled, next_fetch_at)
    VALUES (${s.id}, ${s.name}, ${s.kind}, ${sql.json(s.config as never)}, ${tier}, ${tier === "T1"}, ${s.owner_type ?? null}, ${s.owner_entity_id ?? null}, ${s.claim_types ?? []},
            ${s.participation_mode ?? "editorial"}, ${s.interval_minutes ?? 60}, ${s.tags ?? []}, ${s.site_fulltext ?? false}, ${s.syndicate_fulltext ?? false},
            ${s.enabled ?? true}, now())
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      kind = EXCLUDED.kind,
      config = EXCLUDED.config,
      tier = EXCLUDED.tier,
      owner_type = EXCLUDED.owner_type,
      owner_entity_id = EXCLUDED.owner_entity_id,
      claim_types = EXCLUDED.claim_types,
      participation_mode = EXCLUDED.participation_mode,
      interval_minutes = EXCLUDED.interval_minutes,
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

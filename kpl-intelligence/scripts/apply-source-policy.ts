// Explicit cadence-only application for existing installations. Never load .env implicitly.
import { parseArgs } from "node:util";
import { closeDb, sql } from "@aihot/backend/db";
import { applyCollectionDefaults } from "@aihot/backend/sources/collection-policy";

const { values } = parseArgs({ options: {
  apply: { type: "boolean", default: false },
  source: { type: "string", multiple: true },
  help: { type: "boolean", default: false },
} });
if (values.help) {
  console.log("node scripts/apply-source-policy.ts [--source ID ...] [--apply]\nDefaults to read-only preview. Set DATABASE_URL explicitly; --apply updates only cadence/policy. Save its JSON before/after output for rollback.");
} else {
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL explicitly (no implicit production/default database)");
  try {
    const result = values.apply
      ? await sql.begin((tx) => applyCollectionDefaults(tx, { apply: true, ids: values.source }))
      : await applyCollectionDefaults(sql, { ids: values.source });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await closeDb();
  }
}

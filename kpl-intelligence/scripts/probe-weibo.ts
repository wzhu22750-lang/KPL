// Read-only, one-page capability probe. Does not load .env, write a DB or call a model.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { WeiboAdapter } from "@aihot/backend/sources/adapters/weibo";
import type { SourceRow } from "@aihot/backend/sources/types";

const { values } = parseArgs({ options: {
  source: { type: "string" }, live: { type: "boolean", default: false }, help: { type: "boolean", default: false },
} });
if (values.help) {
  console.log("node scripts/probe-weibo.ts --source ID [--live]\nDefault: local configuration only. Live requires COLLECT_ENABLED=true and requests at most one listing page plus profile/long-text reads; no database writes.");
} else {
  const { sources } = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8")) as { sources: SourceRow[] };
  const entry = sources.find((s) => s.id === values.source && s.kind === "weibo");
  if (!entry) throw new Error("Specify a known Weibo source with --source");
  const source: SourceRow = { ...entry, enabled: entry.enabled !== false, cursor: null, fail_count: 0,
    first_party: entry.tier === "T1", config: { ...entry.config, maxPages: 1 } };
  const capability = source.config.query || source.config.mode === "topic" || source.config.mode === "search" ? "keyword_search" : "account_posts";
  if (!values.live) {
    console.log(JSON.stringify({ sourceId: source.id, capability, status: "configuration_only", liveVerified: false, commentsSupported: false }, null, 2));
  } else {
    if (process.env.COLLECT_ENABLED !== "true") throw new Error("Live probe requires explicit COLLECT_ENABLED=true");
    if (!source.enabled) throw new Error("Source is disabled; probe an enabled source instead");
    const adapter = new WeiboAdapter();
    try {
      const result = await adapter.collect(source);
      const sample = result.rawItems.slice(0, 3).flatMap((raw) => {
        const parsed = adapter.parse(raw, source);
        if (!parsed) return [];
        const m = adapter.normalize(parsed, raw, source);
        return [{ url: m.url, publishedAt: m.publishedAt,
          author: raw.user ? { id: String(raw.user.id), name: raw.user.screen_name, platformVerified: raw.user.verified ?? null } : null,
          metrics: m.engagementObservation?.metrics }];
      });
      console.log(JSON.stringify({ sourceId: source.id, checkedAt: new Date().toISOString(), capability,
        status: result.incompleteReason ? "partial" : "ok", count: result.rawItems.length, detail: result.detail, sample }, null, 2));
      if (result.incompleteReason) process.exitCode = 1;
    } catch (error) {
      console.log(JSON.stringify({ sourceId: source.id, checkedAt: new Date().toISOString(), capability,
        status: "unavailable", error: error instanceof Error ? error.message : "unknown error" }, null, 2));
      process.exitCode = 1;
    }
  }
}

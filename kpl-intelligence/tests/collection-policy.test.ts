import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { collectionDefaults } from "@aihot/industry/collection";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { planCollectionChange } from "@aihot/backend/sources/collection-policy";
import { normalizeObservation, observedCounter } from "@aihot/backend/content/engagement";

const now = new Date("2026-10-08T00:00:00Z");

test("all WeChat transports get daily fixed cadence; account/search Weibo remain prioritized", () => {
  const { sources } = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8"));
  const wechat = sources.filter((s: { id: string }) => s.id.startsWith("mp-"));
  assert.equal(wechat.length, 13);
  for (const s of wechat) {
    assert.equal(collectionDefaults(s)?.intervalMinutes, 1440, s.id);
    assert.equal(collectionDefaults(s)?.mode, "fixed", s.id);
    assert.deepEqual(unsupportedConfig(s.kind, { ...s.config, collectionPolicy: { mode: "fixed" } }), []);
  }
  const weibo = sources.filter((s: { kind: string }) => s.kind === "weibo");
  assert.equal(weibo.length, 16);
  for (const s of weibo) assert.equal(collectionDefaults(s)?.intervalMinutes, s.config.query ? 60 : 30);
  assert.equal(collectionDefaults({ id: "hupu-kog", kind: "json_list", config: {} }), null);
});

test("policy rejects silent invalid modes, nested garbage and non-object values", () => {
  for (const kind of ["rss", "mp_account", "weibo", "json_list"] as const) {
    for (const policy of [null, "fixed", [], {}, { mode: "fast" }, { mode: "fixed", ignored: 1 }]) {
      assert.deepEqual(unsupportedConfig(kind, { collectionPolicy: policy }), ["collectionPolicy"]);
    }
    assert.deepEqual(unsupportedConfig(kind, { collectionPolicy: { mode: "adaptive" } }), []);
    assert.deepEqual(unsupportedConfig(kind, {}), []);
  }
});

test("cadence plan is idempotent, preserves cooldowns and has a before image", () => {
  const s = { id: "mp-ag", kind: "rss", config: { feedUrl: "wechat://ag" }, interval_minutes: 120,
    last_fetch_at: now, next_fetch_at: new Date(now.getTime() + 120 * 60000) };
  const plan = planCollectionChange(s, now)!;
  assert.equal(plan.after.intervalMinutes, 1440);
  assert.equal(plan.after.nextFetchAt.getTime(), now.getTime() + 86400000);
  assert.equal(plan.before.collectionPolicy, null);
  assert.equal(planCollectionChange({ ...s, interval_minutes: 1440, config: { ...s.config, collectionPolicy: { mode: "fixed" } } }, now), null);
  const future = new Date(now.getTime() + 2 * 86400000);
  assert.equal(planCollectionChange({ ...s, next_fetch_at: future }, now)!.after.nextFetchAt.getTime(), future.getTime());
});

test("observations keep unknown separate from zero and do not invent precision", () => {
  for (const v of [undefined, null, "10", -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(observedCounter(v), null);
  assert.equal(observedCounter(0), 0);
  assert.equal(observedCounter(42), 42);
  const input = { platform: "weibo", observedAt: now, method: "source_api" as const, metrics: {} };
  assert.equal(normalizeObservation(input).coverage, "unknown");
  const zero = normalizeObservation({ ...input, metrics: { likes: 0, comments: null } });
  assert.equal(zero.coverage, "observed");
  assert.equal(zero.metrics.likes, 0);
  assert.equal(zero.metrics.comments, null);
  assert.throws(() => normalizeObservation({ ...input, observedAt: new Date(NaN) }), /time/);
  assert.throws(() => normalizeObservation({ ...input, platform: "unknown platform" }), /platform/);
});

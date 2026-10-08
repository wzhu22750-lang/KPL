import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { latestEngagement, pruneEngagement } from "@aihot/backend/content/engagement";
import { applyCollectionDefaults } from "@aihot/backend/sources/collection-policy";
import { adaptIntervals, collectSource } from "@aihot/backend/sources/collect";
import { sourceClocks } from "@aihot/backend/events/hot";

const realFetch = globalThis.fetch;
after(async () => { globalThis.fetch = realFetch; await stopBoss(); await closeDb(); });

async function addSource(id: string, kind = "weibo", config: Record<string, unknown> = {}) {
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, next_fetch_at)
    VALUES (${id}, 'P1 test source', ${kind}, ${sql.json(config as never)}, 'T2', 'editorial', 120, now())`;
}

test("same text stores new counters without resetting analysis, changing revision or adding publications", async () => {
  const source = `eng-${tag()}`;
  await addSource(source);
  const base = { sourceId: source, url: `https://weibo.com/p1/${tag()}`, title: "原始内容", bodyText: "完整正文", via: "fetch" as const };
  const observe = (at: string, metrics: { likes?: number | null; comments?: number | null }) => ({ platform: "weibo", observedAt: new Date(at), method: "source_api" as const, metrics });
  const one = observe("2026-10-08T00:00:00Z", { likes: 0, comments: 10 });
  const { articleId } = await upsertMaterial({ ...base, engagementObservation: one });
  await sql`UPDATE articles SET processing_state='analyzed', grouping_status='complete', processing_attempts=2 WHERE id=${articleId}`;
  const two = observe("2026-10-08T01:00:00Z", { likes: 20, comments: 90 });
  const result = await upsertMaterial({ ...base, engagementObservation: two });
  assert.equal(result.revised, false);
  assert.equal(result.created, false);
  await upsertMaterial({ ...base, engagementObservation: two }); // exact replay
  await upsertMaterial({ ...base, engagementObservation: one }); // late old observation
  const [row] = await sql`SELECT revision, processing_state, grouping_status, processing_attempts FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...row }, { revision: 1, processing_state: "analyzed", grouping_status: "complete", processing_attempts: 2 });
  assert.equal((await sql`SELECT 1 FROM article_revisions WHERE article_id=${articleId}`).length, 1);
  assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${articleId}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM engagement_observations WHERE article_id=${articleId}`).length, 2);
  assert.equal((await latestEngagement(sql, articleId))[0]!.metrics.comments, 90);
  await upsertMaterial({ ...base, engagementObservation: observe("2026-10-08T02:00:00Z", {}) });
  const latest = (await latestEngagement(sql, articleId))[0]!;
  assert.equal(latest.coverage, "unknown");
  assert.equal(latest.metrics.comments, null, "unknown is neither zero nor the previous value");
});

test("old observation history expires but keeps the latest snapshot of a quiet article", async () => {
  const source = `retention-${tag()}`;
  await addSource(source);
  const material = { sourceId: source, url: `https://weibo.com/retention/${tag()}`, title: "Archive", via: "fetch" as const };
  const at = new Date("2026-01-01T00:00:00Z");
  const first = await upsertMaterial({ ...material, engagementObservation: { platform: "weibo", observedAt: at, method: "source_api", metrics: { likes: 1 } } });
  await upsertMaterial({ ...material, engagementObservation: { platform: "weibo", observedAt: new Date(at.getTime() + 60000), method: "source_api", metrics: { likes: 2 } } });
  await pruneEngagement(sql, new Date("2026-03-01T00:00:00Z"));
  assert.equal((await sql`SELECT 1 FROM engagement_observations WHERE article_id=${first.articleId}`).length, 1);
  assert.equal((await latestEngagement(sql, first.articleId))[0]!.metrics.likes, 2);
});

test("dry-run and apply change only cadence; fixed WeChat RSS survives daily adaptation", async () => {
  const fixed = `mp-p1-${tag()}`;
  const adaptive = `other-p1-${tag()}`;
  await addSource(fixed, "rss", { feedUrl: "https://example.com/wechat.rss", customOperatorSetting: "keep" });
  await addSource(adaptive, "rss", { feedUrl: "https://example.com/feed.rss" });
  await sql`UPDATE sources SET enabled=false, last_fetch_at=now(), owner_type='club', owner_entity_id='ag' WHERE id=${fixed}`;
  const [before] = await sql`SELECT * FROM sources WHERE id=${fixed}`;
  const preview = await applyCollectionDefaults(sql, { ids: [fixed] });
  assert.equal(preview.applied, false);
  assert.equal(preview.changes[0]!.after.intervalMinutes, 1440);
  assert.deepEqual({ ...(await sql`SELECT * FROM sources WHERE id=${fixed}`)[0] }, { ...before });
  const applied = await sql.begin((tx) => applyCollectionDefaults(tx, { apply: true, ids: [fixed] }));
  assert.equal(applied.changes.length, 1);
  const [changed] = await sql`SELECT * FROM sources WHERE id=${fixed}`;
  assert.equal(changed!.enabled, false);
  assert.equal(changed!.owner_entity_id, "ag");
  assert.equal(changed!.config.customOperatorSetting, "keep");
  assert.equal(changed!.next_fetch_at.getTime(), before!.last_fetch_at.getTime() + 86400000);
  assert.equal((await applyCollectionDefaults(sql, { ids: [fixed] })).changes.length, 0);
  await sql`UPDATE sources SET enabled=true WHERE id=${fixed}`;
  await adaptIntervals();
  assert.equal((await sql`SELECT interval_minutes FROM sources WHERE id=${fixed}`)[0]!.interval_minutes, 1440);
  assert.equal((await sql`SELECT interval_minutes FROM sources WHERE id=${adaptive}`)[0]!.interval_minutes, 60);
});

test("keyword search failure is not healthy empty; partial material is retained without advancing last_ok_at", async () => {
  const source = `search-p1-${tag()}`;
  await addSource(source, "weibo", { mode: "search", query: "KPL", maxPages: 2 });
  const previous = new Date("2026-10-07T00:00:00Z");
  await sql`UPDATE sources SET last_ok_at=${previous} WHERE id=${source}`;
  let failFirst = true;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("genvisitor2")) return new Response('callback({"sub":"test-sub","subp":"test-subp"})');
    if (failFirst || new URL(url).searchParams.get("page") === "2") return new Response("limited", { status: 429 });
    return new Response(JSON.stringify({ ok: 1, data: { cards: [{ mblog: {
      id: "123456789123456", bid: `p1${tag()}`, created_at: new Date().toUTCString(), text: "KPL 战术观察：首发阵容公布",
      comments_count: 123, user: { id: "123", screen_name: "测试账号" },
    } }] } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const failed = await collectSource(source);
    assert.equal(failed.status, "failed");
    assert.equal(failed.created, 0);
    failFirst = false;
    const partial = await collectSource(source);
    assert.equal(partial.status, "failed");
    assert.equal(partial.created, 1, "good first page is still stored");
    const [row] = await sql`SELECT last_ok_at, health, fail_count FROM sources WHERE id=${source}`;
    assert.equal(row!.last_ok_at.getTime(), previous.getTime());
    assert.equal(row!.health, "degraded");
    assert.equal(row!.fail_count, 2);
    const [run] = await sql`SELECT status, detail FROM fetch_runs WHERE source_id=${source} ORDER BY id DESC LIMIT 1`;
    assert.equal(run!.status, "failed");
    assert.equal(run!.detail.coverage, "partial");
    assert.equal((await sql`SELECT 1 FROM engagement_observations WHERE source_id=${source}`).length, 1);
  } finally { globalThis.fetch = realFetch; }
});

test("Weibo and paid WeChat are included in heat coverage clocks", async () => {
  const weibo = `clock-weibo-${tag()}`, mp = `clock-mp-${tag()}`;
  await addSource(weibo);
  await addSource(mp, "mp_account", { ghid: "test" });
  const ids = new Set((await sourceClocks()).map((r) => r.id));
  assert.ok(ids.has(weibo));
  assert.ok(ids.has(mp));
});

// Weibo scheduling and the wechat:// bridge in the collection entrance: a due enabled weibo source
// is enqueued once (disabled/not-due are not), and a degraded bridge read fails the run instead of
// refreshing last_ok_at.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource, scheduleDueSources } from "@aihot/backend/sources/collect";
import { wechatBridge } from "@aihot/backend/sources/wechat2rss/bridge";

const T = tag();
const realFetchAccount = wechatBridge.fetchAccountArticles.bind(wechatBridge);
after(async () => {
  wechatBridge.fetchAccountArticles = realFetchAccount;
  await stopBoss();
  await closeDb();
});

test("scheduleDueSources: 到期且启用的微博源入队一次，禁用/未到期不入队，重复调度安全", async () => {
  const due = `weibo-due-${T}`;
  const disabled = `weibo-disabled-${T}`;
  const later = `weibo-later-${T}`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, enabled, next_fetch_at) VALUES
    (${due}, '到期的微博', 'weibo', ${sql.json({ uid: "1", platform: "weibo" })}, 'T1', 'editorial', true, now() - interval '1 minute'),
    (${disabled}, '禁用的微博', 'weibo', ${sql.json({ uid: "2", platform: "weibo" })}, 'T1', 'editorial', false, now() - interval '1 minute'),
    (${later}, '未到期的微博', 'weibo', ${sql.json({ uid: "3", platform: "weibo" })}, 'T1', 'editorial', true, now() + interval '1 hour')`;

  const first = await scheduleDueSources();
  assert.ok(first.enqueued >= 1, "到期微博源必须入队");
  const queued = async (id: string) => (await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = ${QUEUES.fetchSource} AND data->>'sourceId' = ${id}`)[0]!.n as number;
  assert.equal(await queued(due), 1);
  assert.equal(await queued(disabled), 0, "禁用源不得入队");
  assert.equal(await queued(later), 0, "未到期源不得入队");

  await scheduleDueSources();
  assert.equal(await queued(due), 1, "重复调度不产生不受控的重复任务（singleton 去重）");
});

test("wechat:// 降级（上游失败但有旧缓存）记为失败，不刷新 last_ok_at", async () => {
  const id = `wechat-stale-${T}`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, next_fetch_at)
    VALUES (${id}, '测试公众号', 'rss', ${sql.json({ feedUrl: "wechat://测试公众号" })}, 'T1', 'editorial', '2100-01-01')`;
  const article = {
    id: "1", title: "标题", url: "https://mp.weixin.qq.com/s/x", author: "测试公众号",
    contentHtml: "<p>正文</p>", contentText: "正文", publishedAt: new Date(),
  };

  wechatBridge.fetchAccountArticles = (async () => ({
    account: { id: "mp", name: "测试公众号" },
    articles: [article],
    status: "stale" as const,
    fetchedAt: Date.parse("2026-10-01T00:00:00Z"),
  })) as typeof wechatBridge.fetchAccountArticles;

  const degraded = await collectSource(id, { force: true });
  assert.equal(degraded.status, "failed");
  assert.match(degraded.error ?? "", /degraded/);
  const [row] = await sql<{ last_ok_at: Date | null; last_error: string | null }[]>`SELECT last_ok_at, last_error FROM sources WHERE id = ${id}`;
  assert.equal(row!.last_ok_at, null, "降级不得刷新真实成功时间");
  assert.match(String(row!.last_error), /degraded/);
  const [run] = await sql<{ status: string }[]>`SELECT status FROM fetch_runs WHERE source_id = ${id} ORDER BY id DESC LIMIT 1`;
  assert.equal(run!.status, "failed");

  wechatBridge.fetchAccountArticles = (async () => ({
    account: { id: "mp", name: "测试公众号" },
    articles: [article],
    status: "ok" as const,
    fetchedAt: Date.now(),
  })) as typeof wechatBridge.fetchAccountArticles;

  const healthy = await collectSource(id, { force: true });
  assert.equal(healthy.status, "ok");
  const [recovered] = await sql<{ last_ok_at: Date | null }[]>`SELECT last_ok_at FROM sources WHERE id = ${id}`;
  assert.ok(recovered!.last_ok_at, "上游恢复后记录真实成功时间");
});

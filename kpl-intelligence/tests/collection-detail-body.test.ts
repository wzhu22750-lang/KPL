// A listing entry that already carries title, date and summary but no body must still get its detail
// page fetched when the source wants full text: the body need alone (need.body) triggers the fetch.
// Regression: the detail gate ignored need.body, so such entries were stored body-less forever.
import "./setup.ts";
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";

const T = tag();
const detailRequests: string[] = [];
const BODY = Array.from({ length: 8 }, (_, i) => `<p>这是第${i + 1}段正文，讲述一场KPL比赛的完整过程，包含阵容、节奏与团战细节，足以构成一篇完整战报的内容长度。</p>`).join("");

const server = http.createServer((req, res) => {
  const path = req.url ?? "/";
  if (path === "/listing") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([
      { url: `${base}/article/${T}-a`, title: "标题 A", date: "2026-10-01T10:00:00+08:00", summary: "摘要 A" },
      { url: `${base}/article/${T}-b`, title: "标题 B", date: "2026-10-01T09:00:00+08:00", summary: "摘要 B" },
    ]));
    return;
  }
  if (path.startsWith("/article/")) {
    detailRequests.push(path);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body><article>${BODY}</article></body></html>`);
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });

async function source(name: string, extra: Record<string, unknown>): Promise<string> {
  const id = `detail-body-${T}-${name}`;
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES (${id},'正文补抓测试','json_list',
      ${sql.json({
        url: `${base}/listing`,
        titlePaths: ["title"],
        urlTemplate: "{raw:url}",
        publishedAtPath: "date",
        summaryPaths: ["summary"],
        ...extra,
      } as never)},'T1','editorial',NULL,'2100-01-01')`;
  return id;
}

test("an entry with title, date and summary but no body still has its detail page fetched for the body", async () => {
  const id = await source("needs-body", { detail: { maxFetches: 5 } });

  const result = await collectSource(id, { force: true });
  assert.equal(result.status, "ok");
  assert.equal(result.created, 2);
  assert.equal(detailRequests.length, 2, "both entries had their detail page fetched");

  const rows = await sql`SELECT body_status, body_text FROM articles WHERE source_id=${id} ORDER BY title`;
  assert.ok(rows.every(r => r.body_status === "ok"));
  assert.ok(rows.every(r => (r.body_text ?? "").includes("第1段正文")));
});

test("an entry whose body the listing already carries costs no detail request", async () => {
  // itemUrlPrefixRewrite gives this source its own URLs, so the shared listing's entries are not the
  // first test's articles again (the same identity would be a discovery only, and created would be 0).
  const id = await source("has-body", {
    summaryIsBody: true,
    detail: { maxFetches: 5 },
    itemUrlPrefixRewrite: { from: `${base}/article/`, to: `${base}/owned/` },
  });

  const before = detailRequests.length;
  const result = await collectSource(id, { force: true });
  assert.equal(result.status, "ok");
  assert.equal(result.created, 2);
  assert.equal(detailRequests.length - before, 0, "no detail fetch when the listing brought the body");
  const rows = await sql`SELECT body_status FROM articles WHERE source_id=${id}`;
  assert.ok(rows.every(r => r.body_status === "ok"));
});

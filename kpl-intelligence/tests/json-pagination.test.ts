// The generic JSON reader stays single-page unless pagination is explicitly configured, then follows
// the documented page parameter within a bounded page budget and stops at an empty page.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import type { SourceRow } from "@aihot/backend/sources/types";

const pages: number[] = [];
const server = http.createServer((req, res) => {
  const page = Number(new URL(req.url!, "http://x").searchParams.get("page") ?? "1");
  pages.push(page);
  const items = page <= 3
    ? [{ id: `p${page}`, title: `第 ${page} 页`, url: `https://example.org/p/${page}`, published_at: "2026-10-01T00:00:00Z" }]
    : [];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: { items } }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const source = (pagination?: Record<string, unknown>): SourceRow => ({
  id: "json-page",
  name: "分页测试",
  kind: "json_list",
  config: {
    url: `${base}/list`,
    mode: "json_api",
    itemsPath: "data.items",
    titlePaths: ["title"],
    urlTemplate: "{raw:url}",
    publishedAtPath: "published_at",
    externalIdPath: "id",
    ...(pagination ? { pagination } : {}),
  },
  tier: "T2",
  participation_mode: "editorial",
  first_party: false,
  interval_minutes: 60,
  enabled: true,
  cursor: null,
  fail_count: 0,
});

test("默认单页：未配置 pagination 只发一次请求", async () => {
  pages.length = 0;
  const out = await fetchJsonList(source());
  assert.equal(pages.length, 1, "默认保持单页，不改变普通 JSON 源的行为");
  assert.equal(out.length, 1);
});

test("显式配置后按页追平，遇空页停止，重复条目去重", async () => {
  pages.length = 0;
  const out = await fetchJsonList(source({ pageParam: "page", startPage: 1, maxPages: 5 }));
  assert.deepEqual(pages, [1, 2, 3, 4], "有上限的分页，空页即边界");
  assert.deepEqual(out.map((c) => c.url), ["https://example.org/p/1", "https://example.org/p/2", "https://example.org/p/3"]);
});

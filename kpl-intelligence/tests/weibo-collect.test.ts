// Weibo cursor semantics: the newest-check (page 1) is separate from the history-paging token, a pinned
// old post never drags the watermark back, a repeated server token ends the loop, and a later page
// failing keeps the pages already read and stores the resume token.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { WeiboAdapter, weiboIdGreater, weiboPageToken } from "@aihot/backend/sources/adapters/weibo";
import type { SourceRow } from "@aihot/backend/sources/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const source = (config: Record<string, unknown> = {}): SourceRow => ({
  id: "weibo-test",
  name: "测试微博",
  kind: "weibo",
  config: { uid: "123", containerid: "107603123", ...config },
  tier: "T1",
  participation_mode: "editorial",
  first_party: true,
  interval_minutes: 30,
  enabled: true,
  cursor: null,
  fail_count: 0,
});

const mblog = (id: string) => ({ id, bid: `b${id}`, created_at: "Wed Oct 07 15:26:20 +0800 2026", text: `post ${id}`, user: { id: "123", screen_name: "Acct" } });
const card = (id: string) => ({ mblog: mblog(id) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stub the visitor cookie negotiation plus the getIndex pages. */
function stub(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    if (url.includes("genvisitor2")) return new Response('cb(visitor_gray_callback({"sub":"S","subp":"P"}))', { status: 200 });
    return handler(url);
  }) as typeof fetch;
}

test("pure helpers: page token and numeric id order", () => {
  assert.equal(weiboPageToken({ cardlistInfo: { since_id: "123" } }), "123");
  assert.equal(weiboPageToken({ cardlistInfo: { since_id: "" } }), null);
  assert.equal(weiboPageToken({}), null);
  assert.equal(weiboIdGreater("100", null), true);
  assert.equal(weiboIdGreater("101", "100"), true);
  assert.equal(weiboIdGreater("100", "100"), false);
  assert.equal(weiboIdGreater("abc", "100"), false, "非数字 id 绝不误判为新");
});

test("collect: 多页增量追到水印后停止，不再翻旧页", async () => {
  const seen: string[] = [];
  stub((url) => {
    const since = new URL(url).searchParams.get("since_id");
    seen.push(since ?? "page1");
    if (!since) return json({ ok: 1, data: { cards: [card("106"), card("105")], cardlistInfo: { since_id: "T1" } } });
    if (since === "T1") return json({ ok: 1, data: { cards: [card("104"), card("102"), card("99")], cardlistInfo: { since_id: "T2" } } });
    return json({ ok: 1, data: { cards: [card("98")], cardlistInfo: { since_id: null } } });
  });
  const res = await new WeiboAdapter().collect(source(), { lastMid: "100" });
  assert.deepEqual(seen, ["page1", "T1"], "追到水印（本页最旧 99 <= 100）后停止");
  assert.equal(res.nextCursor?.lastMid, "106");
  assert.equal(res.nextCursor?.pageSinceId, null);
  assert.equal((res.detail as { reachedWatermark: boolean }).reachedWatermark, true);
  assert.deepEqual(res.rawItems.map((m) => m.id), ["106", "105", "104", "102", "99"]);
});

test("collect: 置顶旧帖不使水印倒退，重复 token 结束循环", async () => {
  const seen: string[] = [];
  stub((url) => {
    const since = new URL(url).searchParams.get("since_id");
    seen.push(since ?? "page1");
    if (!since) return json({ ok: 1, data: { cards: [card("102"), card("106"), card("105")], cardlistInfo: { since_id: "T1" } } });
    if (since === "T1") return json({ ok: 1, data: { cards: [card("104"), card("103"), card("102")], cardlistInfo: { since_id: "T2" } } });
    return json({ ok: 1, data: { cards: [card("101"), card("100")], cardlistInfo: { since_id: "T2" } } });
  });
  const res = await new WeiboAdapter().collect(source(), { lastMid: "100" });
  assert.equal(res.nextCursor?.lastMid, "106", "置顶的旧帖 102 不能把水印从 106 拖回旧值");
  assert.equal(seen.length, 3);
  assert.deepEqual(seen, ["page1", "T1", "T2"], "服务端重复返回同一 token 时结束，不死循环");
  assert.equal(res.nextCursor?.pageSinceId, null);
});

test("collect: 后一页失败保留已读页并保存断点游标，不整体失败", async () => {
  stub((url) => {
    const since = new URL(url).searchParams.get("since_id");
    if (!since) return json({ ok: 1, data: { cards: [card("106"), card("105")], cardlistInfo: { since_id: "T1" } } });
    return json({ ok: 0 }, 500);
  });
  const res = await new WeiboAdapter().collect(source(), { lastMid: "100" });
  assert.deepEqual(res.rawItems.map((m) => m.id), ["106", "105"]);
  assert.equal(res.nextCursor?.lastMid, "106");
  assert.equal(res.nextCursor?.pageSinceId, "T1", "预算/失败断点被保存，下轮可续");
  assert.equal((res.detail as { truncated: boolean }).truncated, true);
});

test("collect: 第一页失败（含重试）后抛出，不伪造成空结果", async () => {
  stub(() => json({ ok: 0 }, 500));
  await assert.rejects(() => new WeiboAdapter().collect(source(), { lastMid: "100" }), /failed to fetch mblogs/);
});

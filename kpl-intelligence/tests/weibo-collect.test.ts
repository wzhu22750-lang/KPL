// Weibo cursor semantics: the newest-check (page 1) is separate from the history-paging token, a pinned
// old post never drags the watermark back, a repeated server token ends the loop, and a later page
// failing keeps the pages already read and stores the resume token.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { spawnSync } from 'node:child_process';
import { WeiboAdapter, weiboIdGreater, weiboPageToken, cleanWeiboText } from "@aihot/backend/sources/adapters/weibo";
import type { SourceRow } from "@aihot/backend/sources/types";

test('body cleanup cannot block the event loop on spaced ordinary comments',()=>{
  // Isolate the regression: the old nullable nested regex hangs, so an in-process timeout cannot help.
  const moduleUrl=new URL('../packages/backend/src/sources/adapters/weibo.ts',import.meta.url).href;
  const code=`const {cleanWeiboText}=await import(${JSON.stringify(moduleUrl)});console.log(cleanWeiboText('公开评论'+' '.repeat(64)+'不同意见'));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:4000});
  assert.equal(child.error,undefined,'cleanup must finish, not hit the subprocess deadline');
  assert.equal(child.status,0);assert.equal(child.stdout.trim(),'公开评论 不同意见');
});
test('body cleanup removes truncation buttons but preserves ordinary mentions of full text',()=>{
  assert.equal(cleanWeiboText('正文……展开全文'),'正文');
  assert.equal(cleanWeiboText('正文... 查看全文'),'正文');
  assert.equal(cleanWeiboText('正文……'),'正文');
  assert.equal(cleanWeiboText('作者发布了全文'),'作者发布了全文');
  assert.equal(cleanWeiboText('<a href="/note">详见全文解读</a>'),'详见全文解读');
  assert.equal(cleanWeiboText('正文<a href="/status/1"><span>全文</span></a>'),'正文');
  assert.equal(cleanWeiboText('公开评论'+' '.repeat(10000)+'不同意见'),'公开评论 不同意见');
});

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
  assert.equal(res.detail?.coverage, "partial", "重复 token 判定为 partial 失败而非到达终点");
  assert.equal(res.detail?.reachedEnd, false, "重复 token 不是到达终点的证据");
  assert.match(String(res.incompleteReason), /repeated pagination token/, "提供管理员/诊断原因");
  assert.equal(res.nextCursor?.stableWatermark, "100", "重复 token 绝不推进稳定水位线");
  assert.equal(res.nextCursor?.pendingWatermark, "106", "保留待追平水位线");
  assert.equal(res.nextCursor?.pageSinceId, "T2", "保留断点游标，防止跳页漏抓");
});

test("reviewer example regression: resuming backlog { ok: 1, data: {} } malformed response fails first page without advancing watermark or erasing cursor", async () => {
  stub(() => json({ ok: 1, data: {} }));
  const resumeCursor = {
    lastMid: "106",
    stableWatermark: "100",
    pendingWatermark: "106",
    pageSinceId: "TOKEN_P1",
  };
  await assert.rejects(
    () => new WeiboAdapter().collect(source(), resumeCursor),
    /failed to fetch mblogs/,
    "回溯积压第 1 页遇到缺失 cards 的畸形响应必须抛出异常，触发 collectSource 捕获并保留原有数据库游标"
  );
});

test("strict API envelope: truthy ok of other types (ok: true, ok: '1') is rejected", async () => {
  for (const badOk of [true, "1", "true", 2]) {
    stub(() => json({ ok: badOk, data: { cards: [card("106")] } }));
    await assert.rejects(
      () => new WeiboAdapter().collect(source(), { lastMid: "100" }),
      /failed to fetch mblogs/,
      `ok: ${JSON.stringify(badOk)} 必须被严格拒绝`
    );
  }
});

test("collect: repeated token with no items preserves cursor, prevents skip, and sets admin reason", async () => {
  stub((url) => {
    const since = new URL(url).searchParams.get("since_id");
    if (!since) return json({ ok: 1, data: { cards: [card("106")], cardlistInfo: { since_id: "T1" } } });
    return json({ ok: 1, data: { cards: [], cardlistInfo: { since_id: "T1" } } });
  });
  const res = await new WeiboAdapter().collect(source(), { lastMid: "100" });
  assert.deepEqual(res.rawItems.map((m) => m.id), ["106"]);
  assert.equal(res.detail?.coverage, "partial");
  assert.equal(res.detail?.reachedEnd, false);
  assert.match(String(res.incompleteReason), /repeated pagination token T1 with no items/);
  assert.equal(res.nextCursor?.stableWatermark, "100");
  assert.equal(res.nextCursor?.pendingWatermark, "106");
  assert.equal(res.nextCursor?.pageSinceId, "T1", "preserve cursor to prevent skipping");
});

test("collect: later page malformed { ok: 1, data: {} } keeps good raw items and returns incompleteReason without advancing watermark", async () => {
  stub((url) => {
    const since = new URL(url).searchParams.get("since_id");
    if (!since) return json({ ok: 1, data: { cards: [card("106")], cardlistInfo: { since_id: "T1" } } });
    return json({ ok: 1, data: {} });
  });
  const res = await new WeiboAdapter().collect(source(), { lastMid: "100" });
  assert.deepEqual(res.rawItems.map((m) => m.id), ["106"]);
  assert.equal(res.detail?.coverage, "partial");
  assert.equal(res.nextCursor?.stableWatermark, "100", "后页畸形绝不推进稳定水位");
  assert.equal(res.nextCursor?.pendingWatermark, "106");
  assert.equal(res.nextCursor?.pageSinceId, "T1", "保留已读页之后的分页游标");
  assert.match(String(res.incompleteReason), /page 2 failed/);
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
  assert.match(res.incompleteReason!, /page 2 failed/);
});

test("collect: 第一页失败（含重试）后抛出，不伪造成空结果", async () => {
  stub(() => json({ ok: 0 }, 500));
  await assert.rejects(() => new WeiboAdapter().collect(source(), { lastMid: "100" }), /failed to fetch mblogs/);
});

test("keyword search distinguishes valid empty results from HTTP, login and malformed failures", async () => {
  const search = source({ mode: "topic", query: "AG" });
  for (const reply of [() => json({}, 403), () => json({ ok: 0, msg: "login" }), () => new Response("<html>login</html>"), () => json({ ok: 1 })]) {
    stub(reply);
    await assert.rejects(() => new WeiboAdapter().collect(search), /keyword search page 1 failed/);
  }
  stub(() => json({ ok: 1, data: { cards: [] } }));
  const empty = await new WeiboAdapter().collect(search);
  assert.deepEqual(empty.rawItems, []);
  assert.equal(empty.incompleteReason, undefined);
  assert.equal(empty.detail?.capability, "keyword_search", "does not claim a supertopic feed");
  assert.equal(empty.detail?.coverage, "complete");
});

test("keyword search retains a good page but signals a failed tail", async () => {
  stub((url) => new URL(url).searchParams.get("page") === "1"
    ? json({ ok: 1, data: { cards: [card("106")] } }) : json({}, 429));
  const result = await new WeiboAdapter().collect(source({ mode: "search", query: "AG" }));
  assert.deepEqual(result.rawItems.map((m) => m.id), ["106"]);
  assert.equal(result.detail?.coverage, "partial");
  assert.match(result.incompleteReason!, /HTTP 429/);
});

test("keyword search budget is bounded, not an invented full-coverage result", async () => {
  stub(() => json({ ok: 1, data: { cards: [card("106")] } }));
  const result = await new WeiboAdapter().collect(source({ mode: "search", query: "AG", maxPages: 1 }));
  assert.equal(result.detail?.coverage, "bounded");
  assert.equal(result.incompleteReason, undefined);
});

test("normalized observations carry source time and missing counters stay null", () => {
  const adapter = new WeiboAdapter();
  const s = source();
  const raw = { ...mblog("106"), attitudes_count: 0 };
  const candidate = adapter.parse(raw, s)!;
  const result = adapter.normalize(candidate, raw, s);
  assert.equal(result.canonical?.engagement?.likes, 0);
  assert.equal(result.canonical?.engagement?.comments, null);
  assert.equal(result.engagementObservation?.platform, "weibo");
  assert.equal(result.engagementObservation?.method, "source_api");
  assert.ok(Number.isFinite(result.engagementObservation?.observedAt.getTime()));
});

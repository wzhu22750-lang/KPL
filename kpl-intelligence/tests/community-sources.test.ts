import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as appConfig } from "@aihot/backend/config";
import { WeiboAdapter, resolveWatermark, maxWeiboId } from "@aihot/backend/sources/adapters/weibo";
import { fetchJsonList, validateBusinessErrors } from "@aihot/backend/sources/json-list";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { FetchError, type SourceRow } from "@aihot/backend/sources/types";
import http from "node:http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const makeWeiboSource = (config: Record<string, unknown> = {}, overrides: Partial<SourceRow> = {}): SourceRow => ({
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
  ...overrides,
});

const mblog = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  bid: `b${id}`,
  created_at: "Wed Oct 07 15:26:20 +0800 2026",
  text: `post ${id}`,
  user: { id: "123", screen_name: "Acct" },
  ...extra,
});
const card = (id: string, extra: Record<string, unknown> = {}) => ({ mblog: mblog(id, extra) });
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as { url: string }).url;
    if (url.includes("genvisitor2")) {
      return new Response('cb(visitor_gray_callback({"sub":"TEST_SUB","subp":"TEST_SUBP"}))', { status: 200 });
    }
    return handler(url, init);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// 1. Weibo 游标语义与断点续抓：中途失败/超页预算不前移稳定水印，保存待续 token
// ---------------------------------------------------------------------------
test("weibo: resolveWatermark 纯函数与显式 null 水印语义", () => {
  // 显式为 null 的 stableWatermark 绝不回退到 lastMid
  assert.equal(resolveWatermark({ stableWatermark: null, lastMid: "100" }), null);
  assert.equal(resolveWatermark({ stableWatermark: null }), null);
  assert.equal(resolveWatermark({ stableWatermark: "" }), null);
  // 仅在 stableWatermark 未定义（旧游标向前兼容）时才回退到 lastMid
  assert.equal(resolveWatermark({ lastMid: "100" }), "100");
  assert.equal(resolveWatermark({ stableWatermark: undefined, lastMid: "100" }), "100");
  assert.equal(resolveWatermark({ stableWatermark: "90", lastMid: "100" }), "90");
  assert.equal(resolveWatermark({}), null);
  assert.equal(resolveWatermark(undefined), null);

  // maxWeiboId 辅助函数
  assert.equal(maxWeiboId("100", "106", "104"), "106");
  assert.equal(maxWeiboId(null, "104", undefined), "104");
  assert.equal(maxWeiboId(null, undefined), null);
});

test("weibo: 显式为 null 的 stableWatermark 绝不回退为 lastMid，不因旧 mid 提前截断", async () => {
  let requestedTokens: (string | null)[] = [];
  stubFetch((url) => {
    const since = new URL(url).searchParams.get("since_id");
    requestedTokens.push(since);
    return jsonResponse({
      ok: 1,
      data: {
        cards: [card("105"), card("102"), card("99")],
        cardlistInfo: { since_id: "TOKEN_NEXT" },
      },
    });
  });

  const adapter = new WeiboAdapter();
  // stableWatermark 显式为 null，但传入了 lastMid: "100"
  const res = await adapter.collect(makeWeiboSource({ maxPages: 1 }), {
    stableWatermark: null,
    lastMid: "100",
  });

  assert.equal(res.detail?.reachedWatermark, false, "因为 watermark 为 null，99 <= 100 不得误触发 reachedWatermark");
  assert.equal(res.nextCursor?.stableWatermark, null, "稳定水印必须保持 null，绝不能误升级或回退为 100");
  assert.equal(res.nextCursor?.pendingWatermark, "105");
  assert.equal(res.nextCursor?.pageSinceId, "TOKEN_NEXT");
  assert.equal(res.nextCursor?.lastMid, "105");
  assert.equal(res.detail?.coverage, "bounded");
});

test("weibo: 中途失败不推进 stableWatermark，保存 pendingWatermark 与 pageSinceId", async () => {
  stubFetch((url) => {
    const since = new URL(url).searchParams.get("since_id");
    if (!since) {
      return jsonResponse({
        ok: 1,
        data: {
          cards: [card("106"), card("105")],
          cardlistInfo: { since_id: "TOKEN_P1" },
        },
      });
    }
    return jsonResponse({ ok: 0 }, 500);
  });

  const adapter = new WeiboAdapter();
  const res = await adapter.collect(makeWeiboSource(), { lastMid: "100" });

  assert.deepEqual(res.rawItems.map((m) => m.id), ["106", "105"]);
  assert.equal(res.nextCursor?.stableWatermark, "100", "稳定水印在积压排空前绝不前移");
  assert.equal(res.nextCursor?.pendingWatermark, "106", "头部最新 mid 记录在待追平水印");
  assert.equal(res.nextCursor?.pageSinceId, "TOKEN_P1", "记录续扫断点 token");
  assert.equal(res.detail?.coverage, "partial");
  assert.match(String(res.incompleteReason), /page 2 failed/);
});

test("weibo: 保守续扫消除 head-gap：先排空旧积压且不更新 head watermark，排空后推进至前序 pendingWatermark，下一轮头部巡检覆盖所有新页面", async () => {
  // 阶段 1：续扫历史积压（输入第 1 轮中断后的游标）
  const requestedSinceTokens: (string | null)[] = [];
  stubFetch((url) => {
    const since = new URL(url).searchParams.get("since_id");
    requestedSinceTokens.push(since);

    // 必须直接请求 TOKEN_P1，不得在续扫轮次中先请求头部 (null) 造成 head-gap
    if (since === "TOKEN_P1") {
      return jsonResponse({
        ok: 1,
        data: {
          cards: [card("104"), card("102"), card("99")],
          cardlistInfo: { since_id: "TOKEN_P2" },
        },
      });
    }
    return jsonResponse({ ok: 1, data: { cards: [] } });
  });

  const adapter = new WeiboAdapter();
  const resumeCursor = {
    lastMid: "106",
    stableWatermark: "100",
    pendingWatermark: "106",
    pageSinceId: "TOKEN_P1",
  };

  const res = await adapter.collect(makeWeiboSource(), resumeCursor);

  // 验证请求序列：直接消费 TOKEN_P1，不请求头部
  assert.deepEqual(requestedSinceTokens, ["TOKEN_P1"], "续扫轮次直接请求 savedToken，不发 head 请求");

  // 验证旧积压已排空（99 <= 100 触及 stableWatermark）
  assert.equal(res.detail?.reachedWatermark, true);
  // 水印推进至前序记录的 pendingWatermark 106
  assert.equal(res.nextCursor?.stableWatermark, "106", "排空后稳定水位推进至前序 pendingWatermark 106");
  assert.equal(res.nextCursor?.lastMid, "106", "lastMid 保持 106，不因本轮只看到历史旧帖而倒退");
  assert.equal(res.nextCursor?.pendingWatermark, null, "积压追平后清空 pendingWatermark");
  assert.equal(res.nextCursor?.pageSinceId, null, "积压追平后清空断点 token");

  // 阶段 2：积压排空后的下一轮巡检（此时 pageSinceId 为 null，从头扫描，覆盖新发布的 >head 多页博文）
  const headRunTokens: (string | null)[] = [];
  stubFetch((url) => {
    const since = new URL(url).searchParams.get("since_id");
    headRunTokens.push(since);

    // 第 0 页（头部）：发现全新博文 112、111
    if (!since) {
      return jsonResponse({
        ok: 1,
        data: {
          cards: [card("112"), card("111")],
          cardlistInfo: { since_id: "TOKEN_H1" },
        },
      });
    }
    // 第 1 页：博文 110、109
    if (since === "TOKEN_H1") {
      return jsonResponse({
        ok: 1,
        data: {
          cards: [card("110"), card("109")],
          cardlistInfo: { since_id: "TOKEN_H2" },
        },
      });
    }
    // 第 2 页：博文 108、107
    if (since === "TOKEN_H2") {
      return jsonResponse({
        ok: 1,
        data: {
          cards: [card("108"), card("107")],
          cardlistInfo: { since_id: "TOKEN_H3" },
        },
      });
    }
    // 第 3 页：博文 106、105（106 <= 106，追平 stableWatermark 106）
    if (since === "TOKEN_H3") {
      return jsonResponse({
        ok: 1,
        data: {
          cards: [card("106"), card("105")],
          cardlistInfo: { since_id: "TOKEN_H4" },
        },
      });
    }
    return jsonResponse({ ok: 1, data: { cards: [] } });
  });

  const headRes = await adapter.collect(makeWeiboSource(), res.nextCursor);

  // 验证从头部完整向下翻页，完全捕获了中间所有新页，无任何 gap
  assert.deepEqual(headRunTokens, [null, "TOKEN_H1", "TOKEN_H2", "TOKEN_H3"]);
  assert.equal(headRes.detail?.reachedWatermark, true);
  assert.equal(headRes.nextCursor?.stableWatermark, "112", "追平后稳定水印顺利更新至新头部 112");
  assert.equal(headRes.nextCursor?.lastMid, "112");
  assert.equal(headRes.nextCursor?.pageSinceId, null);
  assert.equal(headRes.nextCursor?.pendingWatermark, null);

  const headItemIds = headRes.rawItems.map((m) => m.id);
  assert.deepEqual(headItemIds, ["112", "111", "110", "109", "108", "107", "106", "105"]);
});

test("weibo: 冷启动（bootstrap）多轮受限续扫：stableWatermark 保持 null 不被提前提升，排空后提升并追平新发 >head 页面", async () => {
  const adapter = new WeiboAdapter();

  // 第 1 轮冷启动（maxPages = 1）：读取第 0 页头部
  stubFetch((url) => {
    const since = new URL(url).searchParams.get("since_id");
    assert.equal(since, null);
    return jsonResponse({
      ok: 1,
      data: {
        cards: [card("200"), card("199")],
        cardlistInfo: { since_id: "BOOT_P1" },
      },
    });
  });

  const res1 = await adapter.collect(makeWeiboSource({ maxPages: 1 }), { stableWatermark: null });
  assert.equal(res1.nextCursor?.stableWatermark, null, "冷启动首轮受限中断时 stableWatermark 必须保持 null");
  assert.equal(res1.nextCursor?.pendingWatermark, "200");
  assert.equal(res1.nextCursor?.pageSinceId, "BOOT_P1");
  assert.equal(res1.nextCursor?.lastMid, "200");
  assert.equal(res1.detail?.coverage, "bounded");

  // 第 2 轮冷启动（maxPages = 1）：续扫消费 BOOT_P1，依然受限中断
  stubFetch((url) => {
    const since = new URL(url).searchParams.get("since_id");
    assert.equal(since, "BOOT_P1", "必须直接请求 BOOT_P1 续扫");
    return jsonResponse({
      ok: 1,
      data: {
        cards: [card("198"), card("197")],
        cardlistInfo: { since_id: "BOOT_P2" },
      },
    });
  });

  const res2 = await adapter.collect(makeWeiboSource({ maxPages: 1 }), res1.nextCursor);
  assert.equal(res2.nextCursor?.stableWatermark, null, "第 2 轮冷启动中断时 stableWatermark 依然必须为 null，绝不误回退 lastMid 导致提前判定追平");
  assert.equal(res2.nextCursor?.pendingWatermark, "200");
  assert.equal(res2.nextCursor?.pageSinceId, "BOOT_P2");
  assert.equal(res2.nextCursor?.lastMid, "200");

  // 第 3 轮冷启动（maxPages = 1）：消费 BOOT_P2 并触达列表终点 (reachedEnd)
  stubFetch((url) => {
    const since = new URL(url).searchParams.get("since_id");
    assert.equal(since, "BOOT_P2");
    return jsonResponse({
      ok: 1,
      data: {
        cards: [card("196"), card("195")],
        cardlistInfo: { since_id: null }, // 触达历史终点
      },
    });
  });

  const res3 = await adapter.collect(makeWeiboSource({ maxPages: 1 }), res2.nextCursor);
  assert.equal(res3.detail?.reachedEnd, true);
  assert.equal(res3.nextCursor?.stableWatermark, "200", "冷启动全量排空后，稳定水位提升为首轮 pendingWatermark 200");
  assert.equal(res3.nextCursor?.pendingWatermark, null);
  assert.equal(res3.nextCursor?.pageSinceId, null);
  assert.equal(res3.nextCursor?.lastMid, "200");

  // 第 4 轮：冷启动排空后，新发布的 >head 页面被完整追平
  const r4Tokens: (string | null)[] = [];
  stubFetch((url) => {
    const since = new URL(url).searchParams.get("since_id");
    r4Tokens.push(since);
    if (!since) {
      return jsonResponse({
        ok: 1,
        data: {
          cards: [card("206"), card("205")],
          cardlistInfo: { since_id: "H_NEW_1" },
        },
      });
    }
    if (since === "H_NEW_1") {
      return jsonResponse({
        ok: 1,
        data: {
          cards: [card("204"), card("200")], // 触及 stableWatermark 200
          cardlistInfo: { since_id: "H_NEW_2" },
        },
      });
    }
    return jsonResponse({ ok: 1, data: { cards: [] } });
  });

  const res4 = await adapter.collect(makeWeiboSource(), res3.nextCursor);
  assert.deepEqual(r4Tokens, [null, "H_NEW_1"]);
  assert.equal(res4.detail?.reachedWatermark, true);
  assert.equal(res4.nextCursor?.stableWatermark, "206", "追平后推进到最新 206");
  assert.equal(res4.nextCursor?.lastMid, "206");
  assert.deepEqual(res4.rawItems.map((m) => m.id), ["206", "205", "204", "200"]);
});

test("weibo: 达到 maxPages 预算中断时保留断点且不前移 stableWatermark", async () => {
  stubFetch((url) => {
    const since = new URL(url).searchParams.get("since_id");
    if (!since) {
      return jsonResponse({
        ok: 1,
        data: {
          cards: [card("105")],
          cardlistInfo: { since_id: "TOKEN_PAGE1" },
        },
      });
    }
    return jsonResponse({
      ok: 1,
      data: {
        cards: [card("104")],
        cardlistInfo: { since_id: "TOKEN_PAGE2" },
      },
    });
  });

  const adapter = new WeiboAdapter();
  // 设置 maxPages 为 1
  const res = await adapter.collect(makeWeiboSource({ maxPages: 1 }), { lastMid: "90", stableWatermark: "90" });

  assert.equal(res.nextCursor?.stableWatermark, "90", "预算用尽但未触及水印，稳定水位线不前移");
  assert.equal(res.nextCursor?.pendingWatermark, "105");
  assert.equal(res.nextCursor?.pageSinceId, "TOKEN_PAGE1");
  assert.equal(res.detail?.coverage, "bounded");
});

test("weibo regression: 回溯积压遇到 { ok: 1, data: {} } 畸形响应首页抛出异常，绝不判定 reachedEnd 推进稳定水位", async () => {
  stubFetch(() => jsonResponse({ ok: 1, data: {} }));

  const adapter = new WeiboAdapter();
  const resumeCursor = {
    lastMid: "106",
    stableWatermark: "100",
    pendingWatermark: "106",
    pageSinceId: "TOKEN_P1",
  };

  await assert.rejects(
    () => adapter.collect(makeWeiboSource(), resumeCursor),
    /failed to fetch mblogs/,
    "回溯积压第 1 页遇到缺失 cards 的畸形响应必须抛出异常，触发 collectSource 捕获并保留原有数据库游标"
  );
});

test("weibo: 严格 API envelope 校验与重复 token 语义保护稳定水位线", async () => {
  const adapter = new WeiboAdapter();

  // 1. ok 为真值但非数字 1 被严格拒绝
  stubFetch(() => jsonResponse({ ok: "1", data: { cards: [card("106")] } }));
  await assert.rejects(
    () => adapter.collect(makeWeiboSource(), { lastMid: "100" }),
    /failed to fetch mblogs/
  );

  // 2. 正常卡片但重复 token：判定为 partial failure，保留 stableWatermark 与断点游标
  stubFetch((url) => {
    const since = new URL(url).searchParams.get("since_id");
    if (!since) {
      return jsonResponse({
        ok: 1,
        data: {
          cards: [card("106"), card("105")],
          cardlistInfo: { since_id: "TOKEN_LOOP" },
        },
      });
    }
    return jsonResponse({
      ok: 1,
      data: {
        cards: [card("104"), card("100")],
        cardlistInfo: { since_id: "TOKEN_LOOP" }, // 重复 token
      },
    });
  });

  const loopRes = await adapter.collect(makeWeiboSource(), { lastMid: "100" });
  assert.equal(loopRes.detail?.coverage, "partial");
  assert.equal(loopRes.detail?.reachedEnd, false);
  assert.equal(loopRes.nextCursor?.stableWatermark, "100", "重复 token 绝不能推进 stableWatermark");
  assert.equal(loopRes.nextCursor?.pendingWatermark, "106");
  assert.equal(loopRes.nextCursor?.pageSinceId, "TOKEN_LOOP");
  assert.match(String(loopRes.incompleteReason), /repeated pagination token/);
});

// ---------------------------------------------------------------------------
// 2. 长文展开：实际成功拉取后移除 truncation flag，拉取失败保持 partial
// ---------------------------------------------------------------------------
test("weibo: 长文接口拉取成功后，解除截断标记，completeness 为 full", async () => {
  stubFetch((url) => {
    if (url.includes("/statuses/extend")) {
      return jsonResponse({
        ok: 1,
        data: { longTextContent: "这是完整的长文本博文内容，包含所有段落。" },
      });
    }
    return jsonResponse({
      ok: 1,
      data: {
        cards: [card("201", { isLongText: true, text: "正文截断..." })],
      },
    });
  });

  const adapter = new WeiboAdapter();
  const source = makeWeiboSource();
  const res = await adapter.collect(source, { lastMid: "200" });

  assert.equal(res.rawItems.length, 1);
  const item = res.rawItems[0]!;
  assert.equal(item.text, "这是完整的长文本博文内容，包含所有段落。");
  assert.equal(item.isLongText, false, "展开成功后 isLongText 置为 false");

  const cand = adapter.parse(item, source)!;
  const mat = adapter.normalize(cand, item, source);

  assert.equal(mat.canonical?.quality?.completeness, "full");
  assert.deepEqual(mat.canonical?.quality?.warnings, []);
});

test("weibo: 长文接口异常或未成功时，如实保留 partial 与 long_text_truncated", async () => {
  stubFetch((url) => {
    if (url.includes("/statuses/extend")) {
      return jsonResponse({ ok: 0 }, 500); // 模拟长文拉取失败
    }
    return jsonResponse({
      ok: 1,
      data: {
        cards: [card("202", { isLongText: true, text: "未展开的博文..." })],
      },
    });
  });

  const adapter = new WeiboAdapter();
  const source = makeWeiboSource();
  const res = await adapter.collect(source, { lastMid: "200" });

  const item = res.rawItems[0]!;
  assert.equal(item.isLongText, true);

  const cand = adapter.parse(item, source)!;
  const mat = adapter.normalize(cand, item, source);

  assert.equal(mat.canonical?.quality?.completeness, "partial");
  assert.deepEqual(mat.canonical?.quality?.warnings, ["long_text_truncated"]);
});

// ---------------------------------------------------------------------------
// 3. 用户 URL 与 Profile 回退保真：缺少 UID 时生成有效 detail URL
// ---------------------------------------------------------------------------
test("weibo: missing user UID fallback 生成有效 detail 链接且 profileUrl 为 null", () => {
  const adapter = new WeiboAdapter();
  const sourceWithoutUid: SourceRow = {
    ...makeWeiboSource(),
    config: {},
  };

  const rawWithoutUser = {
    id: "301",
    bid: "bid301",
    created_at: "Wed Oct 07 15:26:20 +0800 2026",
    text: "无 UID 博文内容",
  };

  const cand = adapter.parse(rawWithoutUser, sourceWithoutUid)!;
  assert.equal(cand.url, "https://weibo.com/detail/bid301", "缺少 uid 时回退到合法 detail 链接，无双斜杠");

  const mat = adapter.normalize(cand, rawWithoutUser, sourceWithoutUid);
  assert.equal(mat.canonical?.author?.profileUrl, null, "缺少 uid 时 profileUrl 为 null");
});

// ---------------------------------------------------------------------------
// 4. 搜索能力标记为 keyword_search 而非 supertopic，不伪造超话接口
// ---------------------------------------------------------------------------
test("weibo: 关键词搜索 capability 标为 keyword_search，categories 标为微博搜索而非超话", async () => {
  stubFetch(() =>
    jsonResponse({
      ok: 1,
      data: { cards: [card("401")] },
    }),
  );

  const adapter = new WeiboAdapter();
  const searchSource = makeWeiboSource(
    { mode: "search", query: "成都AG超玩会" },
    { owner_type: "community" },
  );

  const res = await adapter.collect(searchSource);
  assert.equal(res.detail?.capability, "keyword_search", "搜索能力严禁冒充 supertopic");

  const cand = adapter.parse(res.rawItems[0]!, searchSource)!;
  assert.ok(cand.categories?.includes("微博搜索"), "标注为微博搜索");
  assert.ok(!cand.categories?.includes("微博超话"), "非超话接口绝不标注为微博超话");
});

// ---------------------------------------------------------------------------
// 5. 校验 industry/sources.json 中 B站 filters 移除幽默/整活/搞笑机械拦截
// ---------------------------------------------------------------------------
test("sources.json: B站社区源已移除对搞笑、整活、鬼畜等社区文化的机械屏蔽", () => {
  const sourcesJsonPath = path.resolve(__dirname, "../industry/sources.json");
  const raw = fs.readFileSync(sourcesJsonPath, "utf-8");
  const data = JSON.parse(raw) as { sources: SourceRow[] };

  const biliCommunity = data.sources.find((s) => s.id === "bili-kpl-community");
  assert.ok(biliCommunity, "需包含 bili-kpl-community 信源");

  const filter = biliCommunity.config?.ingestNoiseFilter as {
    dropMarkersTitleOnly?: string[];
    keepIfMatches?: string[];
  };

  if (filter?.dropMarkersTitleOnly) {
    const dropped = filter.dropMarkersTitleOnly;
    assert.ok(!dropped.includes("搞笑"), "不可机械屏蔽'搞笑'");
    assert.ok(!dropped.includes("整活"), "不可机械屏蔽'整活'");
    assert.ok(!dropped.includes("鬼畜"), "不可屏蔽'鬼畜'");
  }
  // 验证商业垃圾广告保留过滤
  assert.ok(filter?.dropMarkersTitleOnly?.includes("红包"));
  assert.ok(filter?.dropMarkersTitleOnly?.includes("抽奖"));
});

// ---------------------------------------------------------------------------
// 6. JSON List 业务错误校验 (validateBusinessErrors)
// ---------------------------------------------------------------------------
test("json-list: validateBusinessErrors 准确识别各类上游业务报错", () => {
  // B站风格业务错误
  assert.throws(
    () => validateBusinessErrors({ code: -412, message: "请求被拦截" }),
    (err: unknown) => err instanceof FetchError && err.message.includes("请求被拦截"),
  );
  assert.throws(
    () => validateBusinessErrors({ code: -400, message: "参数错误" }),
    (err: unknown) => err instanceof FetchError && err.message.includes("参数错误"),
  );

  // 微信/微博/通用风格 ok === 0 / ok === false
  assert.throws(
    () => validateBusinessErrors({ ok: 0, msg: "未登录或登录凭证过期" }),
    (err: unknown) => err instanceof FetchError && err.message.includes("未登录或登录凭证过期"),
  );
  assert.throws(
    () => validateBusinessErrors({ ok: false, error: "token invalid" }),
    (err: unknown) => err instanceof FetchError && err.message.includes("token invalid"),
  );

  // status 显式报错
  assert.throws(
    () => validateBusinessErrors({ status: "error", message: "rate limit exceeded" }),
    (err: unknown) => err instanceof FetchError && err.message.includes("rate limit exceeded"),
  );
  assert.throws(
    () => validateBusinessErrors({ status: 403, message: "forbidden access" }),
    (err: unknown) => err instanceof FetchError && err.message.includes("forbidden access"),
  );

  // 正常响应不报错
  assert.doesNotThrow(() => validateBusinessErrors({ code: 0, data: { result: [] } }));
  assert.doesNotThrow(() => validateBusinessErrors({ code: 200, items: [] }));
  assert.doesNotThrow(() => validateBusinessErrors({ ok: 1, data: [] }));
  assert.doesNotThrow(() => validateBusinessErrors([{ id: 1 }]));
});

test("json-list: fetchJsonList 向上抛出上游业务报错", async () => {
  appConfig.allowPrivateNetworkFetch = true;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: -412, message: "触发风控拦截" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const jsonSource: SourceRow = {
      id: "json-bili-test",
      name: "B站测试",
      kind: "json_list",
      config: {
        url: `http://127.0.0.1:${port}/test`,
        mode: "json_api",
        itemsPath: "data.result",
        titlePaths: ["title"],
        urlTemplate: "https://bilibili.com/{id}",
      },
      tier: "T2",
      participation_mode: "editorial",
      first_party: false,
      interval_minutes: 60,
      enabled: true,
      cursor: null,
      fail_count: 0,
    };

    await assert.rejects(
      () => fetchJsonList(jsonSource),
      (err: unknown) => err instanceof FetchError && err.message.includes("触发风控拦截"),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// 7. 采样页内按评论数重排 (prioritizeObservedReplies)，不伪造 genuine hot endpoint
// ---------------------------------------------------------------------------
test("json-list: 采样页内按 observed replies 降序重排，不混淆为真实全站热榜", async () => {
  appConfig.allowPrivateNetworkFetch = true;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        code: 0,
        data: {
          threads: [
            { tid: "1", title: "帖子一（较少讨论）", replies: 5, pubdate: 1700000000 },
            { tid: "2", title: "帖子二（热烈讨论）", replies: 350, pubdate: 1700000010 },
            { tid: "3", title: "帖子三（中等讨论）", replies: 88, pubdate: 1700000020 },
          ],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const sourceWithPrioritize: SourceRow = {
      id: "hupu-test",
      name: "虎扑测试",
      kind: "json_list",
      config: {
        url: `http://127.0.0.1:${port}/kog-postdate`,
        mode: "json_api",
        itemsPath: "data.threads",
        titlePaths: ["title"],
        urlTemplate: "https://bbs.hupu.com/{tid}",
        engagementPaths: { platform: "hupu", comments: "replies" },
        prioritizeObservedReplies: true, // 开启样本页内按回复量重排
      },
      tier: "T2",
      participation_mode: "hot_signal",
      first_party: false,
      interval_minutes: 60,
      enabled: true,
      cursor: null,
      fail_count: 0,
    };

    const results = await fetchJsonList(sourceWithPrioritize);
    assert.equal(results.length, 3);
    assert.equal(results[0]!.title, "帖子二（热烈讨论）", "回复数最多的排在首位");
    assert.equal(results[1]!.title, "帖子三（中等讨论）");
    assert.equal(results[2]!.title, "帖子一（较少讨论）");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// 8. 静态契约测试：校验 industry/sources.json 中 bili-kpl-community-hot 信源配置形态与受控状态
// 注意：本测试为纯静态结构断言，无 live 网络请求，亦不声称 mock 为真实在线执行 (no mocks live claim)
// ---------------------------------------------------------------------------
test("sources.json: bili-kpl-community-hot 具备合规的 JSON list 字段形态且全局默认禁用 (no mocks live claim)", () => {
  const sourcesJsonPath = path.resolve(__dirname, "../industry/sources.json");
  const raw = fs.readFileSync(sourcesJsonPath, "utf-8");
  const data = JSON.parse(raw) as { sources: SourceRow[] };

  const biliHot = data.sources.find((s) => s.id === "bili-kpl-community-hot");
  assert.ok(biliHot, "需包含 bili-kpl-community-hot 信源配置");

  // 全局成本与风控约束：未经验证或日常默认必须保持禁用 (enabled: false)
  assert.equal(biliHot.enabled, false, "bili-kpl-community-hot 默认必须保持禁用 (enabled: false)");
  assert.equal(biliHot.kind, "json_list");
  assert.equal(biliHot.tier, "T2");
  assert.equal(biliHot.owner_type, "community");
  assert.equal(biliHot.participation_mode, "hot_signal");

  // config 结构校验
  const cfg = biliHot.config as Record<string, any>;
  assert.equal(cfg.mode, "json_api");
  assert.equal(cfg.itemsPath, "data.result");
  assert.deepEqual(cfg.titlePaths, ["title"]);
  assert.equal(cfg.urlTemplate, "https://www.bilibili.com/video/{bvid}");
  assert.deepEqual(cfg.authorPaths, ["author"]);
  assert.equal(cfg.publishedAtPath, "pubdate");
  assert.equal(cfg.publishedAtUnit, "epoch_s");
  assert.equal(cfg.externalIdPath, "bvid");
  assert.equal(cfg.sortByPublishedAt, false);

  // 校验 URL 指向真实公开验证过的 B站热门排序接口 (order=totalrank)
  const url = new URL(cfg.url);
  assert.equal(url.hostname, "api.bilibili.com");
  assert.equal(url.searchParams.get("search_type"), "video");
  assert.equal(url.searchParams.get("keyword"), "KPL");
  assert.equal(url.searchParams.get("order"), "totalrank");
  assert.equal(url.searchParams.get("page"), "1");

  // 校验互动指标映射仅使用已知的 engagementPaths 字段
  assert.deepEqual(cfg.engagementPaths, {
    platform: "bilibili",
    views: "play",
    likes: "like",
    comments: "review",
    favorites: "favorites",
    danmaku: "danmaku",
  });

  // 过滤规则：移除幽默/鬼畜等机械拦截，保留商业垃圾过滤
  const filter = cfg.ingestNoiseFilter as {
    dropMarkersTitleOnly?: string[];
  };
  assert.ok(filter?.dropMarkersTitleOnly, "需包含 dropMarkersTitleOnly");
  assert.ok(!filter.dropMarkersTitleOnly.includes("搞笑"), "不可机械屏蔽'搞笑'");
  assert.ok(!filter.dropMarkersTitleOnly.includes("整活"), "不可机械屏蔽'整活'");
  assert.ok(!filter.dropMarkersTitleOnly.includes("鬼畜"), "不可屏蔽'鬼畜'");
  assert.ok(filter.dropMarkersTitleOnly.includes("红包"), "保留过滤'红包'");
  assert.ok(filter.dropMarkersTitleOnly.includes("抽奖"), "保留过滤'抽奖'");

  // 保证配置项完全被 json_list 支持，无不支持的配置项
  const bad = unsupportedConfig("json_list", cfg);
  assert.deepEqual(bad, [], `不应包含不支持的配置字段：${bad.join(", ")}`);
});

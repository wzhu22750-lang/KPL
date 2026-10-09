// Unit test suite for bounded community comments:
// - Reusable Bilibili and Weibo parsers with stable ID, parent, likes, floor, null unknown
// - Bad shape (null, {}, denied, missing list) throws -> triggers unavailable (not complete)
// - Explicit terminal pagination evidence required; repeated cursor causes partial error
// - Unknown total never substitutes allPosts.length; replyCount never substitutes nested sample length
// - Flatten nested comments into single DiscussionPost[] parent IDs, bounded iterative depth <=8 and total 100 max, dedup ids, enforce budgets before visiting descendants, mark partial when omitted nested
// - resumeCursor optional uses prior next cursor from caller
// - Endpoint serialized per-platform concurrency 1 with default 1000ms minInterval (injectable for zero delay in tests)
// - Conservative coverage: hot sample even at end is partial unless actual known totals <= fetched all IDs
// - Security validation: HTTPS platform exact host allowlists, credential bypass rejection, no arbitrary hosts, no guessed APIs
// - Hard page & comment budgets
// - Partial results survive page failure; fail state unavailable does not fail original extraction
// All tests use local injected fixtures; zero live requests.
import assert from "node:assert/strict";
import test from "node:test";
import {
  validateCommentEndpointUrl,
  resolveEndpointUrl,
  parseBilibiliReplyResponse,
  parseWeiboCommentResponse,
  fetchBilibiliComments,
  fetchWeiboComments,
  fetchCommunityComments,
  executeSerializedPlatformFetch,
  resetPlatformQueues,
  defaultGuardedFetchJson,
  isCommunityCollectionEnabled,
  HARD_MAX_PAGES,
  HARD_MAX_COMMENTS,
  MAX_NESTED_DEPTH,
  DEFAULT_MIN_INTERVAL_MS,
} from "@aihot/backend/content/community-comments";
import { config } from "@aihot/backend/config";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { bilibiliExtractor } from "@aihot/backend/content/extractors/bilibili";
import { profileFor } from "@aihot/backend/content/extractors/index";
import type { ExtractionInput } from "@aihot/backend/content/extractors/base";

// Explicitly enable globals in test setup so shared network functions are permitted by default
process.env.COMMUNITY_COLLECTION_ENABLED = "true";
process.env.COLLECT_ENABLED = "true";
config.collectEnabled = true;

// ---------------------------------------------------------------------------
// Helper for creating ExtractionInput
// ---------------------------------------------------------------------------
function makeInput(over: Partial<ExtractionInput> & { url: string; html?: string | null }): ExtractionInput {
  return {
    url: over.url,
    html: over.html ?? null,
    profile: over.profile ?? profileFor({ url: over.url }),
    sourceId: over.sourceId ?? "test-bilibili",
    sourceKind: over.sourceKind ?? "json_list",
    title: over.title ?? null,
    excerpt: over.excerpt ?? null,
    author: over.author ?? null,
    publishedAt: over.publishedAt ?? null,
    xPost: null,
    raw: null,
    sourceConfig: over.sourceConfig ?? null,
    fetchJson: over.fetchJson ?? null,
  };
}

// ---------------------------------------------------------------------------
// 1. Security & Host Allowlist Validation
// ---------------------------------------------------------------------------

test("安全校验：允许 Bilibili 官方 API 域名，拒绝 HTTP 与非白名单域名", () => {
  const valid = validateCommentEndpointUrl("https://api.bilibili.com/x/v2/reply?type=1&oid=123", "bilibili");
  assert.equal(valid.ok, true);

  const httpRes = validateCommentEndpointUrl("http://api.bilibili.com/x/v2/reply?type=1&oid=123", "bilibili");
  assert.equal(httpRes.ok, false);
  assert.match((httpRes as any).reason, /https:/);

  const evilRes = validateCommentEndpointUrl("https://evil.com/x/v2/reply", "bilibili");
  assert.equal(evilRes.ok, false);
  assert.match((evilRes as any).reason, /allowlist/);

  const spoofRes = validateCommentEndpointUrl("https://api.bilibili.com.attacker.org/x/v2/reply", "bilibili");
  assert.equal(spoofRes.ok, false);

  const ipRes = validateCommentEndpointUrl("https://127.0.0.1/x/v2/reply", "bilibili");
  assert.equal(ipRes.ok, false);

  const awsRes = validateCommentEndpointUrl("https://169.254.169.254/latest/meta-data", "bilibili");
  assert.equal(awsRes.ok, false);
});

test("安全校验：拒绝带凭证的 URL (Credential Bypass) 与非标准端口", () => {
  const credRes = validateCommentEndpointUrl("https://user:pass@api.bilibili.com/x/v2/reply", "bilibili");
  assert.equal(credRes.ok, false);
  assert.match((credRes as any).reason, /Credentials/);

  const portRes = validateCommentEndpointUrl("https://api.bilibili.com:8443/x/v2/reply", "bilibili");
  assert.equal(portRes.ok, false);
  assert.match((portRes as any).reason, /Non-standard port/);
});

test("安全校验：允许 Weibo 白名单域名 (m.weibo.cn, api.weibo.cn, api.weibo.com)，拒绝未知主机", () => {
  const mWeibo = validateCommentEndpointUrl("https://m.weibo.cn/comments/hotflow?id=123", "weibo");
  assert.equal(mWeibo.ok, true);

  const apiWeiboCn = validateCommentEndpointUrl("https://api.weibo.cn/2/comments/build_comments", "weibo");
  assert.equal(apiWeiboCn.ok, true);

  const apiWeiboCom = validateCommentEndpointUrl("https://api.weibo.com/2/comments/show.json", "weibo");
  assert.equal(apiWeiboCom.ok, true);

  const fakeWeibo = validateCommentEndpointUrl("https://weibo.cn.badguy.com/comments", "weibo");
  assert.equal(fakeWeibo.ok, false);
});

test("模板变量解析：必需关键变量（oid/id）缺失时安全拦截，不发请求", () => {
  const resolvedMissing = resolveEndpointUrl(
    "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}",
    { oid: undefined },
    "bilibili",
  );
  assert.equal(resolvedMissing.ok, false);
  assert.match((resolvedMissing as any).reason, /Missing required template variable/);

  const resolvedOk = resolveEndpointUrl(
    "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}&pn={pn}&ps={ps}",
    { oid: 114514, pn: 1, ps: 20 },
    "bilibili",
  );
  assert.equal(resolvedOk.ok, true);
  assert.equal((resolvedOk as any).url, "https://api.bilibili.com/x/v2/reply?type=1&oid=114514&pn=1&ps=20");
});

// ---------------------------------------------------------------------------
// 2. Bilibili Reply Parser (Flattening, IDs, Null Safety)
// ---------------------------------------------------------------------------

test("Bilibili 评论解析：平铺嵌套子评为单一 DiscussionPost[]，映射 parentCommentId，保留真实属性", () => {
  const fixture = {
    code: 0,
    message: "0",
    data: {
      cursor: {
        all_count: 88,
        is_end: false,
        next: 2,
        mode: 3,
      },
      replies: [
        {
          rpid: 10001,
          oid: 99999,
          type: 1,
          mid: 20001,
          root: 0,
          parent: 0,
          floor: 1,
          like: 342,
          rcount: 2,
          ctime: 1696800000,
          member: {
            mid: "20001",
            uname: "Fly彭云飞",
            avatar: "http://i0.hdslb.com/bfs/face/fly.jpg",
            level_info: { current_level: 6 },
          },
          content: {
            message: "今天大家辛苦了，逆风翻盘全靠团队执行力！",
          },
          replies: [
            {
              rpid: 10002,
              oid: 99999,
              type: 1,
              mid: 30001,
              root: 10001,
              parent: 10001,
              floor: 2,
              like: 45,
              rcount: 0,
              ctime: 1696800060,
              member: {
                mid: "30001",
                uname: "狼队粉丝小王",
                avatar: "http://i1.hdslb.com/bfs/face/wang.jpg",
                level_info: { current_level: 5 },
              },
              content: {
                message: "关羽那一刀太关键了，永远可以相信飞牛！",
              },
            },
          ],
        },
      ],
    },
  };

  const parsed = parseBilibiliReplyResponse(fixture, {
    bvid: "BV1TESTBV",
    oid: 99999,
    upMid: 20001,
  });

  assert.equal(parsed.totalReplies, 88);
  assert.equal(parsed.nextCursor, "2");
  assert.equal(parsed.isEnd, false);
  // Flattened into a single DiscussionPost[]: root + sub = 2
  assert.equal(parsed.posts.length, 2);

  const root = parsed.posts[0]!;
  assert.equal(root.id, "10001");
  assert.equal(root.parentCommentId, null, "root comment must have parentCommentId === null");
  assert.equal(root.platform, "bilibili");
  assert.equal(root.author.name, "Fly彭云飞");
  assert.equal(root.author.avatarUrl, "https://i0.hdslb.com/bfs/face/fly.jpg", "avatar must be normalized to https");
  assert.equal(root.likes, 342);
  assert.equal(root.floor, 1);
  assert.equal(root.isOriginalAuthor, true, "matches upMid");
  assert.equal(root.publishedAt, "2023-10-08T21:20:00.000Z");
  assert.equal(root.originalUrl, "https://www.bilibili.com/video/BV1TESTBV#reply10001");

  const sub = parsed.posts[1]!;
  assert.equal(sub.id, "10002");
  assert.equal(sub.parentCommentId, "10001", "sub-reply parentCommentId must point to parent rpid");
  assert.equal(sub.likes, 45);
  assert.equal(sub.isOriginalAuthor, false);
  assert.equal(sub.author.name, "狼队粉丝小王");
});

test("Bilibili 评论解析：异常与空值安全归一化为 null，未知指标不以子列表长度替代", () => {
  const fixture = {
    code: 0,
    data: {
      replies: [
        {
          rpid: 10003,
          member: null,
          content: null,
          like: -1,
          floor: 0,
          ctime: 0,
          rcount: null, // unknown reply count
          replies: [
            {
              rpid: 10004,
              content: { message: "子评" },
            },
          ],
        },
      ],
    },
  };

  const parsed = parseBilibiliReplyResponse(fixture);
  assert.equal(parsed.posts.length, 2);
  const p = parsed.posts[0]!;
  assert.equal(p.id, "10003");
  assert.equal(p.author.name, null, "unknown author stays unknown; only UI may show an anonymous label");
  assert.equal(p.author.avatarUrl, null);
  assert.equal(p.likes, null, "negative likes must normalize to null");
  assert.equal(p.floor, null, "zero or negative floor must normalize to null");
  assert.equal(p.publishedAt, null, "invalid ctime must normalize to null");
  assert.equal(p.replyCount, null, "unknown replyCount must remain null, never substitute replies.length");
  assert.equal(p.text, "");
});

// ---------------------------------------------------------------------------
// 3. Weibo Comment Parser (Flattening, IDs, HTML Stripping)
// ---------------------------------------------------------------------------

test("Weibo 评论解析：平铺嵌套回复为单一 DiscussionPost[]，清洗 HTML 并映射 parentCommentId", () => {
  const fixture = {
    ok: 1,
    data: {
      total_number: 450,
      max_id: 4950000000000002,
      data: [
        {
          id: "4950000000000001",
          rootid: "4950000000000001",
          floor_number: 1,
          text: '一诺这一把公孙离真的绝了！<span class="url-icon"><img src="http://h5.sinaimg.cn/m/emoticon/icon/others/d_taikaixin-82ba65c2b6.png"></span>',
          created_at: "Wed Oct 07 15:26:20 +0800 2026",
          like_count: 888,
          total_number: 1,
          user: {
            id: 111111,
            screen_name: "成都AG超玩会资讯",
            profile_image_url: "http://tvax1.sinaimg.cn/crop.xxx.jpg",
            verified: true,
          },
          comments: [
            {
              id: "4950000000000002",
              rootid: "4950000000000001",
              text: '回复<a href="/u/111111">@成都AG超玩会资讯</a>: 狂暴开的时机太完美了',
              created_at: "Wed Oct 07 15:30:00 +0800 2026",
              like_count: 36,
              user: {
                id: 222222,
                screen_name: "粉丝小李",
                profile_image_url: "https://tvax2.sinaimg.cn/crop.yyy.jpg",
              },
            },
          ],
        },
      ],
    },
  };

  const parsed = parseWeiboCommentResponse(fixture, {
    originalUrl: "https://weibo.com/123/456",
    postAuthorId: 111111,
  });

  assert.equal(parsed.totalReplies, 450);
  assert.equal(parsed.nextCursor, "4950000000000002");
  assert.equal(parsed.posts.length, 2);

  const root = parsed.posts[0]!;
  assert.equal(root.id, "4950000000000001");
  assert.equal(root.parentCommentId, null, "root comment rootid === id must result in parentCommentId: null");
  assert.equal(root.author.name, "成都AG超玩会资讯");
  assert.equal(root.author.avatarUrl, "https://tvax1.sinaimg.cn/crop.xxx.jpg");
  assert.equal(root.likes, 888);
  assert.equal(root.floor, 1);
  assert.equal(root.isOriginalAuthor, true, "matches postAuthorId");
  assert.ok(root.text.includes("一诺这一把公孙离真的绝了！"));
  assert.ok(!root.text.includes("<span"), "HTML tags must be stripped");
  assert.ok(!root.text.includes("<img"), "img tags must be stripped");
  assert.equal(root.originalUrl, "https://weibo.com/123/456#comment-4950000000000001");

  const sub = parsed.posts[1]!;
  assert.equal(sub.id, "4950000000000002");
  assert.equal(sub.parentCommentId, "4950000000000001");
  assert.equal(sub.likes, 36);
  assert.ok(sub.text.includes("@成都AG超玩会资讯"));
  assert.ok(sub.text.includes("狂暴开的时机太完美了"));
  assert.ok(!sub.text.includes("<a href"), "HTML tags in replies must be stripped");
});

// ---------------------------------------------------------------------------
// 4. Bad Shape (null, {}, denied, missing list) Throws -> unavailable (Not complete)
// ---------------------------------------------------------------------------

test("响应校验：null / {} / 拒绝访问 / 缺少列表 必须抛出 Bad shape 错误，严禁误判为成功结束", () => {
  // 1. null or non-object throws
  assert.throws(() => parseBilibiliReplyResponse(null), /Bad response shape/);
  assert.throws(() => parseBilibiliReplyResponse(undefined), /Bad response shape/);
  assert.throws(() => parseBilibiliReplyResponse("string"), /Bad response shape/);
  assert.throws(() => parseWeiboCommentResponse(null), /Bad response shape/);

  // 2. empty object {} throws
  assert.throws(() => parseBilibiliReplyResponse({}), /Bad response shape.*empty/);
  assert.throws(() => parseWeiboCommentResponse({}), /Bad response shape.*empty/);

  // 3. Denied / Error codes throw
  assert.throws(() => parseBilibiliReplyResponse({ code: -403, message: "访问权限受限" }), /访问权限受限/);
  assert.throws(() => parseWeiboCommentResponse({ ok: 0, msg: "博文已删除" }), /博文已删除/);
  assert.throws(() => parseWeiboCommentResponse({ ok: 0 }), /Weibo request denied/);

  // 4. Missing list throws
  assert.throws(() => parseBilibiliReplyResponse({ code: 0, data: {} }), /replies list is missing/);
  assert.throws(() => parseBilibiliReplyResponse({ code: 0, data: { replies: null } }), /replies list is missing/);
  assert.throws(() => parseWeiboCommentResponse({ ok: 1, data: {} }), /comments list is missing/);
});

test("状态流转：API 返回 null / {} / 拒绝 / 缺失列表 时，fetchCommunityComments 标记 unavailable 而非 complete", async () => {
  // When fetch returns empty object {}
  const resEmptyObj = await fetchBilibiliComments({
    oid: 123,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}",
        minIntervalMs: 0,
      },
    },
    fetchJson: async () => ({}),
  });
  assert.ok(resEmptyObj);
  assert.equal(resEmptyObj.fetchedReplies, 0);
  assert.equal(resEmptyObj.collection?.coverage, "unavailable", "empty object must be unavailable");

  // When fetch returns denied code
  const resDenied = await fetchBilibiliComments({
    oid: 123,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}",
        minIntervalMs: 0,
      },
    },
    fetchJson: async () => ({ code: -403, message: "Forbidden" }),
  });
  assert.ok(resDenied);
  assert.equal(resDenied.collection?.coverage, "unavailable", "denied must be unavailable");

  // When fetch returns missing replies list
  const resMissingList = await fetchBilibiliComments({
    oid: 123,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}",
        minIntervalMs: 0,
      },
    },
    fetchJson: async () => ({ code: 0, data: { replies: null } }),
  });
  assert.ok(resMissingList);
  assert.equal(resMissingList.collection?.coverage, "unavailable", "missing list must be unavailable");

  // Legitimate empty list with explicit terminal evidence is complete
  const resLegitEmpty = await fetchBilibiliComments({
    oid: 123,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}",
        minIntervalMs: 0,
      },
    },
    fetchJson: async () => ({
      code: 0,
      data: {
        cursor: { all_count: 0, is_end: true },
        replies: [],
      },
    }),
  });
  assert.ok(resLegitEmpty);
  assert.equal(resLegitEmpty.fetchedReplies, 0);
  assert.equal(resLegitEmpty.totalReplies, 0);
  assert.equal(resLegitEmpty.collection?.coverage, "complete", "genuine empty list with terminal evidence is complete");
});

// ---------------------------------------------------------------------------
// 5. Unknown Total & ReplyCount Never Substitute Fallbacks
// ---------------------------------------------------------------------------

test("未知计数安全：未知 totalReplies 严格为 null（严禁以 allPosts.length 代替），未知 replyCount 严格为 null", async () => {
  const dummyFetch = async () => ({
    code: 0,
    data: {
      // totalReplies / all_count is completely omitted
      cursor: { is_end: true },
      replies: [
        {
          rpid: 1,
          content: { message: "这是一条测试讨论内容，关于战队运营与战术分析" },
          rcount: null, // unknown replyCount
          like: 10,
          replies: [{ rpid: 2, content: { message: "子评采样回复讨论内容" }, like: 5 }],
        },
      ],
    },
  });

  const res = await fetchBilibiliComments({
    oid: 123,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}",
        minIntervalMs: 0,
      },
    },
    fetchJson: dummyFetch,
  });

  assert.ok(res);
  // Total replies must remain null, NOT substituted with 2!
  assert.equal(res.totalReplies, null, "unknown totalReplies must strictly be null");
  assert.equal(res.fetchedReplies, 2);
  // Coverage cannot be complete when total is unknown
  assert.equal(res.collection?.coverage, "partial");

  const rootPost = res.highlightedReplies[0]!;
  assert.equal(rootPost.replyCount, null, "unknown replyCount must strictly be null, not substituted with sample length 1");
});

// ---------------------------------------------------------------------------
// 6. Bounded Iterative Flattening (Depth <= 8, 100 max, Dedup, Budget Gate)
// ---------------------------------------------------------------------------

test("嵌套平铺边界：深度严格 <= 8，超深子评截断并不导致栈溢出，标记 partial", () => {
  // Construct a nested tree of depth 12
  let current: any = { rpid: 12, content: { message: "depth 12" } };
  for (let d = 11; d >= 1; d--) {
    current = {
      rpid: d,
      content: { message: `depth ${d}` },
      replies: [current],
    };
  }

  const fixture = {
    code: 0,
    data: {
      cursor: { all_count: 12, is_end: true },
      replies: [current],
    },
  };

  const parsed = parseBilibiliReplyResponse(fixture);
  // Max depth is bounded at 8
  assert.equal(parsed.posts.length, 8);
  assert.equal(parsed.posts[0]!.id, "1");
  assert.equal(parsed.posts[7]!.id, "8");
  assert.equal(parsed.hasOmittedNested, true, "deeper replies were omitted");
});

test("嵌套平铺边界：单页 100 条硬上限截断，重复 ID 自动去重，访问子节点前执行配额拦截", () => {
  // 120 comments across roots
  const roots = Array.from({ length: 60 }, (_, i) => ({
    rpid: i + 1,
    content: { message: `root ${i + 1}` },
    replies: [
      { rpid: (i + 1) * 100, content: { message: `sub ${(i + 1) * 100}` } },
      { rpid: (i + 1) * 100, content: { message: `duplicate ${(i + 1) * 100}` } }, // duplicate ID
    ],
  }));

  const fixture = {
    code: 0,
    data: {
      cursor: { all_count: 180, is_end: true },
      replies: roots,
    },
  };

  const parsed = parseBilibiliReplyResponse(fixture);
  assert.equal(parsed.posts.length, HARD_MAX_COMMENTS, `capped at ${HARD_MAX_COMMENTS}`);
  assert.equal(parsed.hasOmittedNested, true);

  // Check unique IDs
  const idSet = new Set(parsed.posts.map((p) => p.id));
  assert.equal(idSet.size, parsed.posts.length, "all IDs in result must be deduplicated");
});

test("嵌套平铺边界：配额在访问子节点前生效，截断后标记 partial", async () => {
  const fixture = {
    code: 0,
    data: {
      cursor: { all_count: 50, is_end: true },
      replies: [
        {
          rpid: 1,
          content: { message: "root 1" },
          replies: [
            { rpid: 2, content: { message: "sub 1" } },
            { rpid: 3, content: { message: "sub 2" } },
            { rpid: 4, content: { message: "sub 3" } },
          ],
        },
      ],
    },
  };

  const res = await fetchBilibiliComments({
    oid: 123,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}",
        maxComments: 2, // only allow 2 comments
        minIntervalMs: 0,
      },
    },
    fetchJson: async () => fixture,
  });

  assert.ok(res);
  assert.equal(res.fetchedReplies, 2);
  assert.equal(res.collection?.coverage, "partial", "partial when nested comments omitted due to budget");
});

// ---------------------------------------------------------------------------
// 7. Explicit Terminal Pagination Evidence & Repeated Cursor
// ---------------------------------------------------------------------------

test("终结证据：缺失显式终结证据时标记 partial，重复游标报错中断并不误判 complete", async () => {
  // Case A: Missing terminal evidence (cursor.is_end === false and nextCursor is null)
  const noTerminalRes = await fetchBilibiliComments({
    oid: 777,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}",
        minIntervalMs: 0,
      },
    },
    fetchJson: async () => ({
      code: 0,
      data: {
        cursor: { all_count: 10, is_end: false, next: null },
        replies: [{ rpid: 1, content: { message: "未终结评论" } }],
      },
    }),
  });
  assert.ok(noTerminalRes);
  assert.equal(noTerminalRes.collection?.coverage, "partial", "without explicit terminal evidence, coverage must be partial");

  // Case B: Repeated cursor loop error
  let pageCall = 0;
  const repeatedCursorFetch = async () => {
    pageCall++;
    return {
      code: 0,
      data: {
        cursor: { all_count: 50, is_end: false, next: "loop_token" },
        replies: [{ rpid: pageCall, content: { message: `page ${pageCall}` } }],
      },
    };
  };

  const repeatRes = await fetchBilibiliComments({
    oid: 888,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}&cursor={cursor}",
        maxPages: 4,
        minIntervalMs: 0,
      },
    },
    fetchJson: repeatedCursorFetch,
  });
  assert.ok(repeatRes);
  assert.equal(pageCall, 2, "must abort when repeated cursor is detected on page 2");
  assert.equal(repeatRes.collection?.coverage, "partial", "repeated cursor must result in partial");
  assert.match(repeatRes.collection?.error ?? "", /Repeated pagination cursor detected/);
});

// ---------------------------------------------------------------------------
// 8. Resume Cursor (Incremental Pagination)
// ---------------------------------------------------------------------------

test("游标续抓：resumeCursor 可传入上轮 nextCursor 并从该断点发起请求", async () => {
  const requestedUrls: string[] = [];
  const dummyFetch = async (url: string) => {
    requestedUrls.push(url);
    const urlObj = new URL(url);
    const cursorParam = urlObj.searchParams.get("cursor");
    return {
      code: 0,
      data: {
        cursor: {
          all_count: 20,
          is_end: cursorParam === "cursor_page_2",
          next: cursorParam === "cursor_page_2" ? null : "cursor_page_3",
        },
        replies: [
          { rpid: 201, content: { message: `从游标 ${cursorParam} 恢复的内容` } },
        ],
      },
    };
  };

  // Resume from cursor_page_2
  const res = await fetchBilibiliComments({
    oid: 999,
    resumeCursor: "cursor_page_2",
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}&cursor={cursor}",
        maxPages: 1,
        minIntervalMs: 0,
      },
    },
    fetchJson: dummyFetch,
  });

  assert.ok(res);
  assert.equal(requestedUrls.length, 1);
  assert.ok(requestedUrls[0]!.includes("cursor=cursor_page_2"), "page 1 must use resumeCursor");
});

// ---------------------------------------------------------------------------
// 9. Per-Platform Serialized Concurrency 1 & Min-Interval
// ---------------------------------------------------------------------------

test("平台并发控制：单平台执行串行化 (Concurrency 1)，支持最小间隔与 0 延迟注入", async () => {
  resetPlatformQueues();

  let activeRequests = 0;
  let maxConcurrent = 0;
  const executionOrder: number[] = [];

  const createWorker = (id: number) => async () => {
    activeRequests++;
    maxConcurrent = Math.max(maxConcurrent, activeRequests);
    executionOrder.push(id);
    await new Promise((r) => setTimeout(r, 10));
    activeRequests--;
    return id;
  };

  // Run 3 requests concurrently on platform "bilibili" with minInterval 0
  const promises = [
    executeSerializedPlatformFetch("bilibili", 0, createWorker(1)),
    executeSerializedPlatformFetch("bilibili", 0, createWorker(2)),
    executeSerializedPlatformFetch("bilibili", 0, createWorker(3)),
  ];

  const results = await Promise.all(promises);
  assert.deepEqual(results, [1, 2, 3]);
  assert.equal(maxConcurrent, 1, "concurrency on the same platform must strictly be 1");
  assert.deepEqual(executionOrder, [1, 2, 3], "requests must execute serially in order");
});

// ---------------------------------------------------------------------------
// 10. Conservative Coverage (Hot Samples vs Full Known Totals)
// ---------------------------------------------------------------------------

test("保守覆盖度：热评采样 (hotflow/mode=3) 即使流终结仍为 partial，唯有实际总数 <= 已采唯一 ID 时方可 complete", async () => {
  // Case A: Weibo hotflow with total 450, returns 1 item, max_id=0 -> partial!
  const hotflowRes = await fetchWeiboComments({
    id: "49999",
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://m.weibo.cn/comments/hotflow?id={id}&mid={mid}",
        minIntervalMs: 0,
      },
    },
    fetchJson: async () => ({
      ok: 1,
      data: {
        total_number: 450,
        max_id: 0, // hotflow stream ended
        data: [{ id: "c1", text: "热评第1条" }],
      },
    }),
  });
  assert.ok(hotflowRes);
  assert.equal(hotflowRes.fetchedReplies, 1);
  assert.equal(hotflowRes.totalReplies, 450);
  assert.equal(hotflowRes.collection?.coverage, "partial", "hotflow with total 450 > fetched 1 must strictly be partial");

  // Case B: Known totalReplies <= unique fetched IDs -> complete!
  const fullCoverageRes = await fetchBilibiliComments({
    oid: 111,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}",
        minIntervalMs: 0,
      },
    },
    fetchJson: async () => ({
      code: 0,
      data: {
        cursor: { all_count: 2, is_end: true },
        replies: [
          { rpid: 1, content: { message: "唯一第 1 条" } },
          { rpid: 2, content: { message: "唯一第 2 条" } },
        ],
      },
    }),
  });
  assert.ok(fullCoverageRes);
  assert.equal(fullCoverageRes.fetchedReplies, 2);
  assert.equal(fullCoverageRes.totalReplies, 2);
  assert.equal(fullCoverageRes.collection?.coverage, "complete", "when actual known total (2) <= fetched (2), coverage is complete");
});

// ---------------------------------------------------------------------------
// 11. Hard Page & Comment Budgets
// ---------------------------------------------------------------------------

test("硬性配额：超出 maxPages 或 maxComments 时强制截断终止，survives budget caps", async () => {
  const calls: string[] = [];
  const dummyFetch = async (url: string) => {
    calls.push(url);
    const urlObj = new URL(url);
    const page = Number(urlObj.searchParams.get("pn") || "1");
    return {
      code: 0,
      data: {
        page: { num: page, size: 10, count: 100 },
        replies: Array.from({ length: 10 }, (_, i) => ({
          rpid: (page - 1) * 10 + i + 1,
          content: { message: `评论第 ${page} 页 第 ${i + 1} 条，关于队伍阵容与节奏运营` },
          like: 10 - i,
          floor: (page - 1) * 10 + i + 1,
          member: { uname: `用户_${page}_${i}` },
        })),
      },
    };
  };

  const res = await fetchBilibiliComments({
    oid: 999,
    bvid: "BV1BUDGET",
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}&pn={pn}&ps={ps}",
        maxPages: 2,
        maxComments: 15,
        minIntervalMs: 0,
      },
    },
    fetchJson: dummyFetch,
  });

  assert.ok(res);
  assert.equal(calls.length, 2, "must fetch at most 2 pages");
  assert.equal(res.fetchedReplies, 15, "must be truncated to maxComments 15");
  assert.equal(res.collection?.coverage, "partial", "partial coverage due to budget");
});

test("硬性上限：用户配置超大配额时，被 HARD_MAX_PAGES 与 HARD_MAX_COMMENTS 强制限制", async () => {
  assert.equal(HARD_MAX_PAGES, 5);
  assert.equal(HARD_MAX_COMMENTS, 100);

  let pageCount = 0;
  const dummyFetch = async (url: string) => {
    pageCount++;
    return {
      code: 0,
      data: {
        page: { num: pageCount, size: 30, count: 5000 },
        replies: Array.from({ length: 30 }, (_, i) => ({
          rpid: pageCount * 100 + i,
          content: { message: `测试讨论回复 ${i}` },
          like: 1,
          member: { uname: `U_${i}` },
        })),
      },
    };
  };

  const res = await fetchBilibiliComments({
    oid: 111,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}&pn={pn}&ps={ps}",
        maxPages: 100,
        maxComments: 1000,
        minIntervalMs: 0,
      },
    },
    fetchJson: dummyFetch,
  });

  assert.ok(res);
  assert.ok(pageCount <= HARD_MAX_PAGES, `pages fetched (${pageCount}) must not exceed HARD_MAX_PAGES (${HARD_MAX_PAGES})`);
  assert.ok((res.fetchedReplies ?? 0) <= HARD_MAX_COMMENTS, `comments (${res.fetchedReplies}) must not exceed HARD_MAX_COMMENTS (${HARD_MAX_COMMENTS})`);
});

// ---------------------------------------------------------------------------
// 12. Partial Results Survive Page Failure
// ---------------------------------------------------------------------------

test("容灾鲁棒性：第 1 页成功，第 2 页异常崩溃时，第 1 页抓取结果存活且标记 partial", async () => {
  let callCount = 0;
  const failOnPageTwo = async (url: string) => {
    callCount++;
    if (callCount === 1) {
      return {
        code: 0,
        data: {
          page: { num: 1, size: 5, count: 50 },
          cursor: { next: 2, is_end: false },
          replies: [
            {
              rpid: 101,
              content: { message: "第一局打得很好，双C前期发育很稳" },
              like: 20,
              member: { uname: "粉丝A" },
            },
            {
              rpid: 102,
              content: { message: "第二局BP有点冒险，好在选手抗压顶住了" },
              like: 15,
              member: { uname: "粉丝B" },
            },
          ],
        },
      };
    }
    throw new Error("HTTP 502 Bad Gateway from upstream CDN");
  };

  const res = await fetchBilibiliComments({
    oid: 555,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}&pn={pn}&ps={ps}",
        maxPages: 3,
        minIntervalMs: 0,
      },
    },
    fetchJson: failOnPageTwo,
  });

  assert.ok(res);
  assert.equal(res.fetchedReplies, 2, "the 2 comments from page 1 must survive");
  assert.equal(res.collection?.coverage, "partial", "coverage must be partial on subsequent page failure");
  assert.match(res.collection?.error ?? "", /HTTP 502 Bad Gateway/);
  assert.ok(res.highlightedReplies.length >= 1, "highlighted replies can still be ranked from page 1");
});

test("容灾鲁棒性：第 1 页抓取直接报错时，标记 unavailable 且不抛出异常", async () => {
  const alwaysFail = async () => {
    throw new Error("ETIMEDOUT: Connection timed out");
  };

  const res = await fetchBilibiliComments({
    oid: 555,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}&pn={pn}&ps={ps}",
        minIntervalMs: 0,
      },
    },
    fetchJson: alwaysFail,
  });

  assert.ok(res);
  assert.equal(res.fetchedReplies, 0);
  assert.equal(res.collection?.coverage, "unavailable");
  assert.match(res.collection?.error ?? "", /ETIMEDOUT/);
  assert.deepEqual(res.highlightedReplies, []);
});

// ---------------------------------------------------------------------------
// 13. Bilibili Extractor Integration
// ---------------------------------------------------------------------------

test("Bilibili Extractor：解析 view API 的 aid，填入 template 抓取评论，注入真实 coins 与 danmaku", async () => {
  const viewApiData = {
    code: 0,
    data: {
      bvid: "BV1KPLFINALS",
      aid: 888777,
      title: "【2026 KPL春决】巅峰对决：决胜局全程回放与战术拆解",
      desc: "两支战队鏖战七局，第七局巅峰对决双方镜像阵容，拆解关键龙坑团战决策。",
      pic: "https://i0.hdslb.com/bfs/archive/finals.jpg",
      pubdate: 1775000000,
      duration: 1800,
      owner: { mid: 99, name: "KPL赛事官方", face: "https://i0.hdslb.com/bfs/face/kpl.jpg" },
      stat: {
        view: 1500000,
        danmaku: 45000,
        reply: 12000,
        favorite: 68000,
        coin: 92000,
        share: 25000,
        like: 180000,
      },
    },
  };

  const replyApiData = {
    code: 0,
    data: {
      cursor: { all_count: 12000, is_end: true },
      replies: [
        {
          rpid: 90001,
          oid: 888777,
          mid: 99,
          like: 5000,
          floor: 1,
          member: { uname: "KPL赛事官方", face: "https://i0.hdslb.com/bfs/face/kpl.jpg" },
          content: { message: "感谢大家一个赛季的陪伴！下一站世冠见！" },
        },
        {
          rpid: 90002,
          oid: 888777,
          mid: 666,
          like: 1200,
          floor: 2,
          member: { uname: "战术分析师老李", face: "https://i0.hdslb.com/bfs/face/li.jpg" },
          content: { message: "第七局巅峰对决的bp博弈太精彩了，双边体系的兵线运营直接拉满！" },
        },
      ],
    },
  };

  const requestedUrls: string[] = [];
  const fakeFetchJson = async (url: string) => {
    requestedUrls.push(url);
    if (url.includes("/x/web-interface/view")) {
      return viewApiData;
    }
    if (url.includes("/x/v2/reply")) {
      return replyApiData;
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const input = makeInput({
    url: "https://www.bilibili.com/video/BV1KPLFINALS",
    html: `<html><head><title>视频标题</title></head><body>BV1KPLFINALS</body></html>`,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={aid}&pn={pn}&ps={ps}",
        maxPages: 1,
        minIntervalMs: 0,
      },
    },
    fetchJson: fakeFetchJson,
  });

  const extracted = await bilibiliExtractor.extract(input);
  assert.ok(extracted, "must extract canonical content");

  assert.equal(extracted.engagement?.coins, 92000, "coins must be populated from stat.coin");
  assert.equal(extracted.engagement?.danmaku, 45000, "danmaku must be populated from stat.danmaku");
  assert.equal(extracted.engagement?.views, 1500000);
  assert.equal(extracted.engagement?.likes, 180000);
  assert.equal(extracted.video?.transcriptSummary, null, "transcriptSummary must strictly be null");

  const replyCall = requestedUrls.find((u) => u.includes("/x/v2/reply"));
  assert.ok(replyCall, "must have called reply API");
  assert.ok(replyCall.includes("oid=888777"), "must pass actual aid 888777 to reply API template");

  assert.ok(extracted.discussion, "discussion must be populated");
  assert.equal(extracted.discussion.fetchedReplies, 2);
  // Conservative coverage: 12000 total comments, only 2 fetched -> partial!
  assert.equal(extracted.discussion.collection?.coverage, "partial", "conservative coverage: only fetched 2 out of 12000 replies");
  assert.equal(extracted.discussion.collection?.sourceUrl, replyCall);

  assert.equal(extracted.discussion.authorFollowups.length, 1);
  assert.equal(extracted.discussion.authorFollowups[0]!.author.name, "KPL赛事官方");
  assert.equal(extracted.discussion.highlightedReplies.length, 1);
  assert.equal(extracted.discussion.highlightedReplies[0]!.author.name, "战术分析师老李");
});

test("Bilibili Extractor：评论抓取失败 (unavailable) 不导致原视频提取失败", async () => {
  const viewApiData = {
    code: 0,
    data: {
      bvid: "BV1CRASHTEST",
      aid: 333222,
      title: "正常视频",
      desc: "正常简介",
      pic: "https://i0.hdslb.com/bfs/archive/pic.jpg",
      pubdate: 1775000000,
      duration: 300,
      owner: { mid: 10, name: "UP主", face: null },
      stat: { view: 1000, danmaku: 50, reply: 10, favorite: 20, coin: 30, share: 5, like: 100 },
    },
  };

  const fetchWithReplyFail = async (url: string) => {
    if (url.includes("/x/web-interface/view")) {
      return viewApiData;
    }
    throw new Error("503 Service Unavailable");
  };

  const input = makeInput({
    url: "https://www.bilibili.com/video/BV1CRASHTEST",
    html: `<html><body>BV1CRASHTEST</body></html>`,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={aid}",
        minIntervalMs: 0,
      },
    },
    fetchJson: fetchWithReplyFail,
  });

  const extracted = await bilibiliExtractor.extract(input);
  assert.ok(extracted, "video extraction must succeed despite comment fetch failure");
  assert.equal(extracted.title, "正常视频");
  assert.equal(extracted.engagement?.likes, 100);
  assert.equal(extracted.engagement?.coins, 30);
  assert.equal(extracted.engagement?.danmaku, 50);
  if (extracted.discussion) {
    assert.equal(extracted.discussion.collection?.coverage, "unavailable");
  }
});

// ---------------------------------------------------------------------------
// 14. Exported Weibo Fetch Function
// ---------------------------------------------------------------------------

test("导出 Weibo 抓取函数：可被 Coordinator 在微博采集时直接独立调用，遵守保守覆盖度", async () => {
  const weiboPage = {
    ok: 1,
    data: {
      total_number: 120,
      max_id: 0,
      data: [
        {
          id: "weibo_c_1",
          floor_number: 1,
          text: "春季赛常规赛第一轮分组出来了，S组竞争太残酷了！",
          created_at: "Wed Oct 07 15:26:20 +0800 2026",
          like_count: 55,
          user: { id: 888, screen_name: "微博电竞爱好者" },
        },
      ],
    },
  };

  const fetchJson = async (url: string) => {
    assert.ok(url.startsWith("https://m.weibo.cn/"));
    return weiboPage;
  };

  const discussion = await fetchWeiboComments({
    id: "4999999999999999",
    originalUrl: "https://weibo.com/detail/4999999999999999",
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://m.weibo.cn/comments/hotflow?id={id}&mid={mid}",
        minIntervalMs: 0,
      },
    },
    fetchJson,
    minIntervalMs: 0,
  });

  assert.ok(discussion);
  assert.equal(discussion.fetchedReplies, 1);
  // Conservative coverage: hotflow with 120 total > fetched 1 is partial!
  assert.equal(discussion.collection?.coverage, "partial");
  assert.equal(discussion.highlightedReplies[0]?.author.name, "微博电竞爱好者");
  assert.equal(discussion.highlightedReplies[0]?.originalUrl, "https://weibo.com/detail/4999999999999999#comment-weibo_c_1");
});

// ---------------------------------------------------------------------------
// 15. Bilibili data.replies: null (Documented Zero Count vs Malformed Fail)
// ---------------------------------------------------------------------------

test("Bilibili replies:null 契约：仅在 code 0 且明确记录总数为 0 时合法允许，否则视为畸变失败", () => {
  // 1. 合法场景 A：cursor.all_count === 0 且 code === 0
  const validCursorZero = {
    code: 0,
    message: "0",
    data: {
      cursor: { all_count: 0, is_end: true, mode: 3 },
      replies: null,
    },
  };
  const parsedCursor = parseBilibiliReplyResponse(validCursorZero);
  assert.equal(parsedCursor.posts.length, 0);
  assert.equal(parsedCursor.totalReplies, 0);
  assert.equal(parsedCursor.isEnd, true);
  assert.equal(parsedCursor.hasTerminalEvidence, true);
  assert.equal(parsedCursor.nextCursor, null);

  // 2. 合法场景 B：page.count === 0 且 code === 0
  const validPageZero = {
    code: 0,
    message: "0",
    data: {
      page: { count: 0, num: 1, size: 20 },
      replies: null,
    },
  };
  const parsedPage = parseBilibiliReplyResponse(validPageZero);
  assert.equal(parsedPage.posts.length, 0);
  assert.equal(parsedPage.totalReplies, 0);
  assert.equal(parsedPage.isEnd, true);
  assert.equal(parsedPage.hasTerminalEvidence, true);

  // 3. 畸变场景 A：code === 0 但 cursor.all_count > 0（数据缺失，必须报错）
  const malformedCount = {
    code: 0,
    message: "0",
    data: {
      cursor: { all_count: 50, is_end: false },
      replies: null,
    },
  };
  assert.throws(() => parseBilibiliReplyResponse(malformedCount), /replies list is missing/);

  // 4. 畸变场景 B：code === 0 但完全无 cursor/page 计数证明为 0
  const malformedNoMeta = {
    code: 0,
    message: "0",
    data: {
      replies: null,
    },
  };
  assert.throws(() => parseBilibiliReplyResponse(malformedNoMeta), /replies list is missing/);

  // 5. 异常场景 C：code !== 0 且 replies: null
  const errorCode = {
    code: -404,
    message: "啥都木有",
    data: {
      replies: null,
    },
  };
  assert.throws(() => parseBilibiliReplyResponse(errorCode), /啥都木有/);
});

// ---------------------------------------------------------------------------
// 16. Numeric Pagination ({pn} Direct Cursor vs Opaque Cursor)
// ---------------------------------------------------------------------------

test("数字分页：{pn} 直接使用游标请求 1, 2, 3 页，不出现 cursor+page-1 跳页；不透明游标 {cursor} 保持原样", async () => {
  const requestedUrls: string[] = [];
  const pagedFetch = async (url: string) => {
    requestedUrls.push(url);
    const u = new URL(url);
    const pn = u.searchParams.get("pn");
    if (pn === "1") {
      return {
        code: 0,
        data: {
          page: { num: 1, count: 60, size: 20 },
          replies: [{ rpid: 101, content: { message: "第一页评论" }, member: { uname: "U1" } }],
        },
      };
    }
    if (pn === "2") {
      return {
        code: 0,
        data: {
          page: { num: 2, count: 60, size: 20 },
          replies: [{ rpid: 102, content: { message: "第二页评论" }, member: { uname: "U2" } }],
        },
      };
    }
    if (pn === "3") {
      return {
        code: 0,
        data: {
          page: { num: 3, count: 60, size: 20 },
          replies: [{ rpid: 103, content: { message: "第三页评论" }, member: { uname: "U3" } }],
        },
      };
    }
    throw new Error(`Unexpected pn: ${pn}`);
  };

  const res = await fetchCommunityComments({
    platform: "bilibili",
    targetId: 10001,
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}&pn={pn}&ps={ps}",
        maxPages: 3,
        pageSize: 20,
        minIntervalMs: 0,
      },
    },
    fetchJson: pagedFetch,
  });

  assert.ok(res);
  assert.equal(res.fetchedReplies, 3);
  // Verify numeric pages requested in exact order 1, 2, 3 without skipping to 1, 3, 5!
  assert.equal(requestedUrls.length, 3);
  assert.ok(requestedUrls[0]!.includes("pn=1"), "第 1 次请求必须是 pn=1");
  assert.ok(requestedUrls[1]!.includes("pn=2"), "第 2 次请求必须是 pn=2，绝不跳过");
  assert.ok(requestedUrls[2]!.includes("pn=3"), "第 3 次请求必须是 pn=3，绝不跳过");

  // Opaque cursor test: cursor string passed unchanged
  const opaqueUrls: string[] = [];
  const opaqueFetch = async (url: string) => {
    opaqueUrls.push(url);
    return {
      code: 0,
      data: {
        cursor: { is_end: true, all_count: 1 },
        replies: [{ rpid: 201, content: { message: "不透明游标评论" }, member: { uname: "U4" } }],
      },
    };
  };

  await fetchCommunityComments({
    platform: "bilibili",
    targetId: 10001,
    resumeCursor: "custom_opaque_cursor_xyz",
    sourceConfig: {
      communityComments: {
        enabled: true,
        endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}&cursor={cursor}",
        maxPages: 1,
        minIntervalMs: 0,
      },
    },
    fetchJson: opaqueFetch,
  });

  assert.equal(opaqueUrls.length, 1);
  assert.ok(opaqueUrls[0]!.includes("cursor=custom_opaque_cursor_xyz"), "不透明游标必须原样保留传入");
});

// ---------------------------------------------------------------------------
// 17. Global Kill Switch & Direct Extractor Gate
// ---------------------------------------------------------------------------

test("全局安全总闸：COMMUNITY_COLLECTION_ENABLED 关闭时直接拦截共享网络函数，禁止通过注入绕过；纯解析器无阻碍", async () => {
  const oldCommunity = process.env.COMMUNITY_COLLECTION_ENABLED;
  try {
    process.env.COMMUNITY_COLLECTION_ENABLED = "false";
    assert.equal(isCommunityCollectionEnabled(), false);

    let fetchCalled = false;
    const fakeFetch = async () => {
      fetchCalled = true;
      return { code: 0, data: { replies: [] } };
    };

    // Shared network function fetchCommunityComments must return null immediately!
    const res = await fetchCommunityComments({
      platform: "bilibili",
      targetId: 10001,
      sourceConfig: {
        communityComments: {
          enabled: true,
          endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={oid}",
        },
      },
      fetchJson: fakeFetch,
    });

    assert.equal(res, null, "全局关闭时 fetchCommunityComments 必须立即返回 null");
    assert.equal(fetchCalled, false, "全局关闭时严禁调用 fetchJson 发送任何网络请求");

    // Pure parsers have NO gate and work as normal
    const pureParsed = parseBilibiliReplyResponse({
      code: 0,
      data: { cursor: { all_count: 0, is_end: true }, replies: [] },
    });
    assert.equal(pureParsed.totalReplies, 0, "纯解析器无门禁，正常工作");

    // Direct bilibili extractor: zero comment requests, but main video metadata is unaffected!
    let viewApiCalled = false;
    let commentApiCalled = false;
    const multiFetch = async (url: string) => {
      if (url.includes("/x/web-interface/view")) {
        viewApiCalled = true;
        return {
          code: 0,
          data: {
            bvid: "BV1METATEST",
            aid: 777666,
            title: "全局关闭下的元数据测试视频",
            desc: "测试简介内容",
            owner: { mid: 1, name: "官方UP", face: null },
            stat: { view: 9999, like: 888 },
          },
        };
      }
      if (url.includes("/x/v2/reply")) {
        commentApiCalled = true;
        return { code: 0, data: { replies: [] } };
      }
      throw new Error(`Unexpected: ${url}`);
    };

    const input = makeInput({
      url: "https://www.bilibili.com/video/BV1METATEST",
      html: `<html><body>BV1METATEST</body></html>`,
      sourceConfig: {
        communityComments: {
          enabled: true,
          endpointTemplate: "https://api.bilibili.com/x/v2/reply?type=1&oid={aid}",
        },
      },
      fetchJson: multiFetch,
    });

    const extracted = await bilibiliExtractor.extract(input);
    assert.ok(extracted, "视频元数据提取成功");
    assert.equal(extracted.title, "全局关闭下的元数据测试视频");
    assert.equal(extracted.engagement?.views, 9999);
    assert.equal(extracted.engagement?.likes, 888);
    assert.equal(extracted.discussion, null, "评论提取被总闸安全置空");
    assert.equal(viewApiCalled, true, "主视频元数据允许通过 view API 加载");
    assert.equal(commentApiCalled, false, "总闸关闭时评论请求数必须严格为 0");
  } finally {
    process.env.COMMUNITY_COLLECTION_ENABLED = oldCommunity ?? "true";
  }
});

// ---------------------------------------------------------------------------
// 18. Production defaultGuardedFetchJson Security & Behavior
// ---------------------------------------------------------------------------

test("生产传输 defaultGuardedFetchJson：严格 HTTPS、非200报错、拒绝跨源重定向", async () => {
  // 1. Rejects non-HTTPS
  await assert.rejects(
    defaultGuardedFetchJson("http://api.bilibili.com/x/v2/reply"),
    /must be https:/i,
  );

  // 2. Mock upstream with MockAgent
  const previous = getGlobalDispatcher();
  const mock = new MockAgent();
  mock.disableNetConnect();
  const oldPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  setGlobalDispatcher(mock);

  try {
    // 200 OK -> parses JSON
    mock.get("https://api.bilibili.com").intercept({ path: "/x/v2/reply?test=1" })
      .reply(200, JSON.stringify({ code: 0, data: { ok: true } }));
    const data = (await defaultGuardedFetchJson("https://api.bilibili.com/x/v2/reply?test=1")) as any;
    assert.equal(data?.code, 0);
    assert.equal(data?.data?.ok, true);

    // 404 / 500 error throws
    mock.get("https://api.bilibili.com").intercept({ path: "/x/v2/reply?err=1" })
      .reply(404, "Not Found");
    await assert.rejects(
      defaultGuardedFetchJson("https://api.bilibili.com/x/v2/reply?err=1"),
      /HTTP 404/i,
    );

    // Cross-origin redirect is rejected
    mock.get("https://api.bilibili.com").intercept({ path: "/x/v2/reply?redir=1" })
      .reply(302, "", { headers: { location: "https://evil.com/leak" } });
    await assert.rejects(
      defaultGuardedFetchJson("https://api.bilibili.com/x/v2/reply?redir=1"),
      /redirect/i,
    );
  } finally {
    setGlobalDispatcher(previous);
    config.allowPrivateNetworkFetch = oldPrivate;
    await mock.close();
  }
});

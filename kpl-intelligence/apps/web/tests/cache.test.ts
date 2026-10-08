// Run after `npm run build -w @aihot/web`. Real production server/router, synthetic HTTP API only.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { TimelineCard } from '@aihot/contracts/site';
import { CATEGORY_KEYS, SOURCE_GROUP_KEYS, SOURCE_GROUP_LABELS } from "@aihot/contracts/taxonomy";

let web: ChildProcess;
let origin: string;
let logs = "";
let deadline: number;
let metaDelayMs = 0;
let hotUnavailable = false;
let timelineUnavailable = false;
let radarDeadlineOffset = 0;
let timelineDeadlineOffset = 0;
let timelineNoStore = false;
const hotEntries = [1, 2, 3].map(rank => ({ rank, title: `测试热点 ${rank}`, heat: 20, trend: 'unknown', storyPublicId: `test-hot-${rank}`, itemId: null, participants: [], participantCount: 0 }));
const timelineCards: TimelineCard[] = ['2026-10-08T00:00:00Z', '2026-10-07T00:00:00Z'].map((at, i) => ({
  key: `aoriginal-${i}`, anchorAt: at, group: null,
  item: { id: `original-${i}`, title: `原精选报道 ${i}`, summary: '来自旧精选读取层的新闻', reason: null, source: { name: '测试新闻来源' }, publishedAt: at, timelineAt: at, category: null, tags: [], score: 80, selected: true, channel: 'news', x: null },
}));
const apiCookies: Array<string | undefined> = [];
const apiPaths: string[] = [];
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://api.local");
  apiCookies.push(req.headers.cookie);
  apiPaths.push(url.pathname + url.search);
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/api/site/meta") {
    const respond = () => res.end(JSON.stringify({ changelogVersion: "2026-09-28T12:00" }));
    return metaDelayMs ? setTimeout(respond, metaDelayMs) : respond();
  }
  if (url.pathname === "/api/site/radar") {
    res.setHeader("X-Accel-Expires", `@${deadline + radarDeadlineOffset}`);
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    return res.end(JSON.stringify({ day: '2026-10-08', topics: [], matches: [], standalone: [], coverage: { reviewed: 0, pending: 0, note: 'test' } }));
  }
  if (url.pathname === "/api/site/timeline") {
    if (timelineUnavailable) { res.statusCode = 503; return res.end(JSON.stringify({ code: 'service_unavailable' })); }
    const filters = { channel: "all", category: url.searchParams.get("category"), tag: null, sourceGroup: url.searchParams.get('sourceGroup') };
    res.setHeader("X-Accel-Expires", `@${deadline + timelineDeadlineOffset}`);
    res.setHeader("Cache-Control", timelineNoStore ? 'private, no-store' : "public, max-age=30, s-maxage=30");
    return res.end(JSON.stringify({ filters, cards: timelineCards, nextCursor: null, dayCounts: { '2026-10-08': 1, '2026-10-07': 1 }, hot: hotUnavailable ? null : hotEntries }));
  }
  if (url.pathname === "/api/site/hot/strip") return res.end(JSON.stringify({ entries: hotEntries }));
  if (url.pathname === "/api/site/hot") return res.end(JSON.stringify({ entries: [] }));
  if (url.pathname === "/api/site/echo-client") return res.end(JSON.stringify({ forwarded: req.headers["x-forwarded-for"], real: req.headers["x-real-ip"] }));
  if (url.pathname === "/api/site/items/long-lived") return res.end(JSON.stringify({ id: "long-lived", title: "t" }));
  if (url.pathname === "/api/site/contact") return res.end(JSON.stringify({ wechatQr: "/qr.png", feishuQr: "/qr.png" }));
  if (url.pathname === "/api/site/stories/merged") {
    res.statusCode = 308;
    return res.end(JSON.stringify({ mergedInto: "surviving-story" }));
  }
  res.statusCode = url.pathname.startsWith("/api/admin/") ? 401 : 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

before(async () => {
  deadline = Math.floor(Date.now() / 1000) + 20;
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: { ...process.env, WEB_PORT: "0", TRUST_PROXY: "false", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on("exit", () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
    web.stderr!.on("data", (chunk) => { logs += String(chunk); });
    web.stdout!.on("data", (chunk) => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) {
        origin = `http://127.0.0.1:${match[1]}`;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
});

after(async () => {
  if (web && web.exitCode === null) {
    web.kill("SIGTERM");
    await once(web, "exit");
  }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

test("public route subsets produce the same complete navigation data; old filters redirect to all",  async () => {
  const answers = await Promise.all(["", "?_routes=root", "?_routes=routes%2Fhome", "?_routes=unknown"].map(async (query) => {
    const res = await fetch(`${origin}/_.data${query}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Cache-Control")!, /^public,/);
    assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
    assert.doesNotMatch(res.headers.get("Cache-Control")!, /stale/);
    const body = await res.text();
    assert.ok(body.includes("root") && body.includes("routes/home"));
    return body;
  }));
  assert.ok(answers.every((body) => body === answers[0]));
  const category = CATEGORY_KEYS.at(-1)!;
  const filtered = await fetch(`${origin}/_.data?category=${category}&_routes=root`);
  const body = await filtered.text();
  assert.equal(filtered.status, 202);
  assert.match(filtered.headers.get('Cache-Control')!, /no-store/);
  assert.ok(body.includes(`/all?category=${category}`));
  assert.notEqual(body, answers[0]);
});

test('homepage keeps hot ranking above radar and restores the original selected feed below', async () => {
  const response=await fetch(origin+'/');
  const html=await response.text();
  assert.equal(response.status,200);
  assert.ok(apiPaths.includes('/api/site/radar?current=true'));
  assert.ok(apiPaths.includes('/api/site/timeline'));
  assert.ok(html.indexOf('id="hot-topics"') >= 0 && html.indexOf('id="hot-topics"') < html.indexOf('aria-label="KPL内容雷达"'));
  assert.ok(html.includes('测试热点 1'));
  assert.ok(html.indexOf('id="featured-updates"') > html.indexOf('aria-label="KPL内容雷达"'));
  assert.ok(html.includes('原精选报道 0') && html.includes('原精选报道 1'));
  assert.ok(html.includes('data-item-id="original-0"'));
  assert.doesNotMatch(html,/内容回顾|前一天|后一天|更多动态|aria-label="2026-10-0[78]"/);
  const oldDay=await fetch(origin+'/?radarDay=2026-10-07',{redirect:'manual'});
  assert.equal(oldDay.status,302);
  assert.equal(oldDay.headers.get('Location'),'/');
  const search=await fetch(origin+'/?q=all',{redirect:'manual'});
  assert.equal(search.headers.get('Location'),'/all?q=all');
});

test('homepage publisher boxes filter in place and preserve hot topics and radar', async () => {
  for (const sourceGroup of SOURCE_GROUP_KEYS) {
    const response = await fetch(`${origin}/?sourceGroup=${sourceGroup}`, { redirect: 'manual' });
    assert.equal(response.status, 200, `must stay on homepage for ${sourceGroup}`);
    const html = await response.text();
    const nav = /<nav aria-label="按发布者筛选"[\s\S]*?<\/nav>/.exec(html)?.[0];
    assert.ok(nav);
    for (const key of SOURCE_GROUP_KEYS) assert.ok(nav.includes(SOURCE_GROUP_LABELS[key]));
    assert.doesNotMatch(nav, /一手|赛果|阵容|版本|联盟|战术|观点/);
    assert.match(nav, new RegExp(`href="/\\?sourceGroup=${sourceGroup}"[^>]*aria-current="page"`));
    assert.ok(apiPaths.includes(`/api/site/timeline?sourceGroup=${sourceGroup}`));
    assert.ok(html.includes('id="hot-topics"') && html.includes('aria-label="KPL内容雷达"'));
    assert.match(html, /发现动态/);
    assert.ok(html.includes(`/?sourceGroup=${sourceGroup}`), 'canonical URL carries the applied group');
  }
});

test('no hot entries never hides radar or the original selected feed', async () => {
  hotUnavailable = true;
  try {
    const response = await fetch(origin + '/');
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(html.includes('aria-label="KPL内容雷达"'));
    assert.ok(!html.includes('id="hot-topics"'));
    assert.ok(html.includes('原精选报道 0'));
  } finally { hotUnavailable = false; }
});

test('unavailable selected feed never hides the current focus', async () => {
  timelineUnavailable = true;
  try {
    const response = await fetch(origin + '/');
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(html.includes('aria-label="KPL内容雷达"'));
    assert.ok(html.includes('发现动态暂不可用'));
  } finally { timelineUnavailable = false; }
});

test('composed homepage uses the earliest API deadline and respects no-store from either list', async () => {
  try {
    for (const [radar, timeline] of [[-7, -2], [-2, -7]]) {
      radarDeadlineOffset = radar; timelineDeadlineOffset = timeline;
      const response = await fetch(origin + '/');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('X-Accel-Expires'), `@${deadline - 7}`);
      await response.text();
    }
    timelineNoStore = true;
    const response = await fetch(origin + '/');
    assert.equal(response.headers.get('X-Accel-Expires'), '0');
    assert.match(response.headers.get('Cache-Control')!, /no-cache|no-store/);
    await response.text();
  } finally { radarDeadlineOffset = 0; timelineDeadlineOffset = 0; timelineNoStore = false; }
});

test("HTML and navigation share freshness; cookies do not personalize public results", async () => {
  const html = await fetch(`${origin}/`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("X-Accel-Expires"), `@${deadline}`);
  assert.match(await html.text(), /精选/);
  const plain = await fetch(`${origin}/about.data`);
  const signedIn = await fetch(`${origin}/about.data?_routes=root`, { headers: { cookie: "admin_session=private; aihot_vid=reader" } });
  assert.match(plain.headers.get("Cache-Control")!, /^public,/);
  assert.match(plain.headers.get("X-Accel-Expires")!, /^@\d+$/);
  assert.equal(plain.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  assert.equal(Date.parse(plain.headers.get("Date")!) / 1000 + 300, Number(plain.headers.get("X-Accel-Expires")!.slice(1)));
  assert.equal(signedIn.headers.get("Set-Cookie"), null);
  assert.equal(await signedIn.text(), await plain.text());
  assert.ok(apiCookies.every((cookie) => !cookie));
});

test("missing routes cannot be hidden by a root-only request; errors and redirects stay uncached", async () => {
  for (const pathname of ["/items/missing.data?_routes=root", "/does-not-exist.data?_routes=root", "/items/missing"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 404, pathname);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(res.headers.get("X-Accel-Expires"), "0");
    await res.text();
  }
  for (const [pathname, target] of [["/story/merged.data?_routes=root", "/story/surviving-story"], ["/_.data?q=search&_routes=root", "/all?q=search"]]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.match(await res.text(), new RegExp(target.replace("?", "\\?")));
  }
});

test("admin data and actions never become public cache entries", async () => {
  const admin = await fetch(`${origin}/admin/sources.data?_routes=admin-layout`);
  assert.equal(admin.status, 202);
  assert.equal(admin.headers.get("Cache-Control"), "private, no-store");
  assert.equal(admin.headers.get("X-Accel-Expires"), "0");
  assert.match(await admin.text(), /admin\/login/);
  const action = await fetch(`${origin}/hot.data`, { method: "POST" });
  assert.equal(action.status, 405);
  assert.equal(action.headers.get("Cache-Control"), "private, no-store");
  assert.equal(action.headers.get("X-Accel-Expires"), "0");
  await action.text();
});

test("browser freshness shares the selected deadline, including slow sibling loaders", async () => {
  const savedDeadline = deadline;
  try {
    deadline = Math.floor(Date.now() / 1000) + 20;
    for (const pathname of ["/", "/_.data?_routes=routes%2Fhome"]) {
      const res = await fetch(origin + pathname);
      const cc = res.headers.get("Cache-Control")!;
      const browser = Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]);
      const shared = Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]);
      assert.ok(browser > 0 && browser === shared);
      assert.ok(Date.parse(res.headers.get("Date")!) / 1000 + browser <= deadline);
      assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
      assert.match(cc, /must-revalidate/);
      assert.doesNotMatch(cc, /stale/);
      await res.text();
    }
    // The selected loader initially grants a positive TTL, but root metadata finishes after it.
    deadline = Math.floor(Date.now() / 1000) + 2;
    metaDelayMs = 2300;
    await Promise.all(["/", "/_.data?_routes=routes%2Fhome"].map(async (pathname) => {
      const res = await fetch(origin + pathname);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-cache");
      assert.equal(res.headers.get("X-Accel-Expires"), "0");
      await res.text();
    }));
  } finally {
    deadline = savedDeadline;
    metaDelayMs = 0;
  }
});

test("a shared cache may keep an item page longer than browsers", async () => {
  const res = await fetch(`${origin}/items/long-lived.data`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300, s-maxage=600, must-revalidate");
  await res.text();
});

test("browser caching preserves noindex and private sign-in responses", async () => {
  const feedback = await fetch(origin + "/feedback");
  assert.equal(feedback.status, 200);
  assert.match(await feedback.text(), /name="robots" content="noindex/);
  assert.equal(feedback.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  const login = await fetch(origin + "/admin/login");
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("Cache-Control"), "private, no-store");
  assert.equal(login.headers.get("X-Robots-Tag"), "noindex, nofollow");
  await login.text();
});

test("a visitor cannot name its own address to the api without a trusted proxy in front", async () => {
  const res = await fetch(`${origin}/api/site/echo-client`, { headers: { "X-Forwarded-For": "6.6.6.6", "X-Real-IP": "6.6.6.6" } });
  assert.deepEqual(await res.json(), { forwarded: "127.0.0.1", real: "127.0.0.1" });
});

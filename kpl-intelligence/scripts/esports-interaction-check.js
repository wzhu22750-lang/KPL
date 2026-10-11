// Playwright CLI callback. Open the running /heroes page before run-code.
async (page) => {
  const origin = new URL(page.url()).origin;
  const startedAt = new Date().toISOString();
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push({ name, status: "passed" }); }
    catch (error) { results.push({ name, status: "failed", error: String(error) }); }
  };
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const settle = async () => { await page.waitForTimeout(100); await page.locator('.esports-nav[aria-busy="false"]').waitFor({ timeout: 30000 }); await page.waitForTimeout(200); };
  const heroes = (await (await page.request.get("http://127.0.0.1:3001/api/site/kb/heroes")).json()).heroes;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/heroes");
  await check("all six hero lanes match real API data and preserve URL selection", async () => {
    for (const pos of ["全部", "对抗路", "打野", "中路", "发育路", "游走"]) {
      await page.getByRole("button", { name: pos, exact: true }).click(); await settle();
      const count = heroes.filter(h => pos === "全部" || h.primaryPos === pos || h.positions.includes(pos)).length;
      expect(await page.locator(".hero-rank-card").count() === count, `${pos}: count mismatch`);
      expect(new URL(page.url()).searchParams.get("pos") === (pos === "全部" ? null : pos), `${pos}: URL mismatch`);
    }
  });
  await check("all four hero sort orders remain unchanged", async () => {
    await page.getByRole("button", { name: "全部", exact: true }).click(); await settle();
    for (const sort of ["bpRate", "winRate", "picks", "tier"]) {
      const expected = [...heroes].sort((a, b) => {
        if (sort === "winRate") return Number(b.picks >= 10) - Number(a.picks >= 10) || b.winRate - a.winRate || b.picks - a.picks;
        if (sort === "picks") return b.picks - a.picks || b.bpRate - a.bpRate;
        if (sort === "tier") { const w = { T0: 5, "T0.5": 4, T1: 3, T2: 2, T3: 1 }; return (w[b.versionStrength] ?? 0) - (w[a.versionStrength] ?? 0) || b.bpRate - a.bpRate; }
        return b.bpRate - a.bpRate || b.picks - a.picks;
      }).map(h => h.id);
      await page.getByLabel("排序规则").selectOption(sort); await settle();
      const actual = await page.locator(".hero-rank-card").evaluateAll(links => links.map(link => decodeURIComponent(new URL(link.href).pathname.split("/").pop())));
      expect(JSON.stringify(actual) === JSON.stringify(expected), `changed sort ${sort}`);
    }
  });
  await check("hero search, URL persistence, no-results and reset", async () => {
    await page.getByLabel("搜索英雄").fill("不知火舞"); await settle();
    expect(await page.locator(".hero-rank-card").count() === 1, "name search failed");
    await page.reload(); expect(await page.getByLabel("搜索英雄").inputValue() === "不知火舞", "search did not persist");
    await page.getByLabel("搜索英雄").fill("no-such-kpl-hero"); await settle();
    expect(await page.locator(".hero-rank-card").count() === 0, "empty state missing");
    await page.screenshot({ path: "output/playwright/esports-ui/after/heroes-empty-390.png" });
    await page.getByRole("button", { name: "恢复全部筛选" }).click(); await settle();
    expect(await page.locator(".hero-rank-card").count() === heroes.length, "reset failed");
  });
  await check("real low and zero hero samples never imply absolute strength", async () => {
    const low = heroes.find(h => h.picks > 0 && h.picks < 10 && h.winRate === 1);
    const zero = heroes.find(h => h.picks === 0);
    expect(low && zero, "required real edge samples unavailable");
    await page.getByLabel("搜索英雄").fill(low.name); await settle();
    expect(await page.locator(".hero-rank-win").first().textContent().then(text => text.includes("低样本")), "small sample not labelled");
    expect(await page.locator(".hero-rank-card").first().getAttribute("data-leading") !== "true", "small sample got leading emphasis");
    await page.screenshot({ path: "output/playwright/esports-ui/after/heroes-low-sample-390.png" });
    await page.getByLabel("搜索英雄").fill(zero.name); await settle();
    expect((await page.locator(".hero-rank-win strong").first().textContent()) === "—", "zero sample fabricated win rate");
    await page.screenshot({ path: "output/playwright/esports-ui/after/heroes-zero-sample-390.png" });
  });
  await check("hero detail return restores lane, sort, search and scroll position", async () => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(origin + "/heroes?pos=中路&sort=winRate&q=爆发");
    const card = page.locator(".hero-rank-card").nth(5); await card.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => window.scrollY);
    await card.click(); await settle();
    await page.locator(".hero-return").click(); await settle();
    expect(new URL(page.url()).searchParams.get("pos") === "中路", "lane lost");
    expect(new URL(page.url()).searchParams.get("sort") === "winRate", "sort lost");
    expect(await page.getByLabel("搜索英雄").inputValue() === "爆发", "search lost");
    const after = await page.evaluate(() => window.scrollY);
    expect(Math.abs(after - before) < 10, `scroll lost: before=${before}, after=${after}`);
  });
  await check("independent red/blue meters retain their own 0–100 scale", async () => {
    await page.goto(origin + "/heroes/lubandashi");
    const detail = await (await page.request.get("http://127.0.0.1:3001/api/site/kb/heroes/lubandashi")).json();
    const meters = page.locator(".hero-side-panel [role=meter]");
    expect(await meters.count() === 2, "side meters missing");
    const values = await meters.evaluateAll(els => els.map(el => [Number(el.getAttribute("aria-valuenow")), Number(el.getAttribute("aria-valuemax"))]));
    expect(Math.abs(values[0][0] - detail.stats.blueWinRate * 100) < .001 && values[0][1] === 100, "blue normalized incorrectly");
    expect(Math.abs(values[1][0] - detail.stats.redWinRate * 100) < .001 && values[1][1] === 100, "red normalized incorrectly");
  });
  await check("standings season and stage selectors work on mobile", async () => {
    await page.setViewportSize({ width: 320, height: 844 }); await page.goto(origin + "/standings");
    await page.getByLabel("切换赛季").selectOption("kpl-2026-spring"); await page.waitForURL(url => url.searchParams.get("season") === "kpl-2026-spring"); await settle();
    expect(new URL(page.url()).searchParams.get("season") === "kpl-2026-spring", "season URL missing");
    const stages = page.locator(".standings-stages button");
    expect(await stages.count() > 1, "expected historical season stages");
    for (const index of [0, 1]) { const stage = await stages.nth(index).textContent(); await stages.nth(index).click(); await settle(); expect(new URL(page.url()).searchParams.get("stage") === stage, "stage URL missing"); }
    expect(await page.locator(".standings-table tbody tr").count() > 0, "historical standings missing");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile standings overflow");
    await page.screenshot({ path: "output/playwright/esports-ui/after/standings-spring-320.png", fullPage: true });
  });
  await check("team roster links open real player profiles", async () => {
    await page.goto(origin + "/teams/wolves"); const roster = page.locator(".team-roster-card");
    expect(await roster.count() > 0, "roster missing"); await roster.first().click(); await page.waitForURL(url => url.pathname.startsWith("/players/")); await settle();
    expect(new URL(page.url()).pathname.startsWith("/players/"), "player link failed");
    expect(await page.locator(".ep-athlete h1").count() === 1, "profile missing");
  });
  await check("schedule season selection, scheduled VS and archive navigation", async () => {
    await page.goto(origin + "/matches");
    const upcoming = page.locator('.esports-match-row').filter({ has: page.locator('[data-status="scheduled"]') }).first();
    expect((await upcoming.locator('.esports-match-score').textContent()) === 'VS', 'upcoming match shows invented result');
    await upcoming.scrollIntoViewIfNeeded(); await settle();
    await page.screenshot({ path: "output/playwright/esports-ui/after/matches-upcoming-320.png" });
    await page.getByLabel("选择赛季").selectOption("kpl-2026-summer"); await page.waitForURL(url => url.searchParams.get("season") === "kpl-2026-summer"); await settle();
    expect(new URL(page.url()).searchParams.get("season") === "kpl-2026-summer", "schedule season missing");
    expect(await page.locator(".esports-match-row").count() > 0, "schedule empty");
    await page.locator(".esports-match-row").first().click(); await settle(); expect(await page.locator(".ep-scoreboard").count() === 1, "archive link failed");
  });
  await check("all small games retain every ordered BP step at 320px", async () => {
    const id = "kpl-20260003-2026081603";
    const data = await (await page.request.get(`http://127.0.0.1:3001/api/site/kb/matches/${id}`)).json();
    await page.goto(`${origin}/matches/${id}`);
    for (const [i, game] of data.games.entries()) {
      await page.locator(".ep-game-selector button").nth(i).click(); await settle();
      expect(await page.locator(".ep-bp-steps li").count() === game.bp.length, `lost BP game ${game.gameNo}`);
      const expected = [...game.bp].sort((a,b) => a.step-b.step).map(step => [String(step.step).padStart(2,"0"),step.side,step.type]);
      const actual = await page.locator(".ep-bp-steps li").evaluateAll(els => els.map(el => [el.querySelector(".ep-bp-order").textContent,el.dataset.side,el.dataset.action]));
      expect(JSON.stringify(actual) === JSON.stringify(expected), "BP order/side/action changed");
      expect(await page.locator(".ep-performance-table tbody tr").count() === game.players.length, "lost player row");
    }
    await page.locator(".ep-bp-details summary").click(); await page.locator(".ep-bp-details summary").click();
    expect(await page.locator(".ep-bp-details").getAttribute("open") !== null, "BP cannot reopen");
    for (const step of await page.locator('.ep-bp-steps li').all()) { await step.scrollIntoViewIfNeeded(); await page.waitForTimeout(50); }
    await page.waitForTimeout(500);
    // Data-region capture only: suppress floating shell chrome in this screenshot, not BP content.
    await page.locator(".ep-bp").screenshot({ path: "output/playwright/esports-ui/after/match-bp-320.png", style: '[data-phone-bar],nav[aria-label="底部导航"] { visibility: hidden !important; }' });
  });
  await check("H2H swap and selection preserve factual wins and other URL parameters", async () => {
    await page.goto(origin + "/h2h?teamA=wolves&teamB=ag&source=regression");
    const wins = await page.locator(".ep-win-count").allTextContents();
    await page.getByRole("button", { name: "对调两队位置" }).click(); await page.waitForURL(url => url.searchParams.get("teamA") === "ag"); await settle();
    expect(new URL(page.url()).searchParams.get("teamA") === "ag", "swap URL wrong");
    expect(new URL(page.url()).searchParams.get("source") === "regression", "unknown param lost");
    expect(JSON.stringify(await page.locator(".ep-win-count").allTextContents()) === JSON.stringify(wins.reverse()), "swap scores wrong");
    await page.getByLabel("战队 A", { exact: true }).selectOption("ksg"); await page.waitForURL(url => url.searchParams.get("teamA") === "ksg"); await settle();
    expect(new URL(page.url()).searchParams.get("teamA") === "ksg", "team selection failed");
  });
  await check("keyboard focus survives navigation from match styles to heroes", async () => {
    await page.goto(origin + "/matches"); await page.locator(".esports-nav").getByRole("link", { name: "英雄榜" }).click(); await settle();
    await page.keyboard.press("Tab"); await page.getByLabel("搜索英雄").focus();
    const focus = await page.getByLabel("搜索英雄").evaluate(el => ({ width: getComputedStyle(el).outlineWidth, style: getComputedStyle(el).outlineStyle }));
    expect(focus.width !== "0px" && focus.style !== "none", "focus ring missing");
  });
  await check("missing official images degrade without broken icons or layout shifts", async () => {
    await page.route("**/heroimg/**", route => route.abort()); await page.goto(origin + "/heroes"); await settle();
    await page.locator(".esports-portrait-fallback").first().waitFor({ timeout: 15000 });
    expect(await page.locator(".esports-portrait-fallback").count() > 0, "missing-image fallback failed");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "fallback overflow");
    await page.screenshot({ path: "output/playwright/esports-ui/after/heroes-image-fallback-320.png" }); await page.unroute("**/heroimg/**");
  });
  await check("reduced motion preference disables competition transitions", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const duration = await page.locator(".hero-rank-card").first().evaluate(el => getComputedStyle(el).transitionDuration);
    expect(duration.split(",").every(x => parseFloat(x) <= .001), "reduced motion ignored");
  });
  const evidence = { origin, apiOrigin: "http://127.0.0.1:3001", startedAt, completedAt: new Date().toISOString(), checks: results };
  await page.evaluate(evidence => localStorage.setItem("kpl:interaction-results", JSON.stringify(evidence)), evidence);
}

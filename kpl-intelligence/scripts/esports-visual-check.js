// Playwright CLI callback; run against the actual app/API, never fixtures.
// From repository root:
// playwright_cli.sh open http://127.0.0.1:3000/heroes
// playwright_cli.sh run-code "$(< kpl-intelligence/scripts/esports-visual-check.js)"
// playwright_cli.sh close
async (page) => {
  const origin = new URL(page.url()).origin;
  const out = "output/playwright/esports-ui";
  const routes = [
    ["heroes", "/heroes"], ["hero", "/heroes/lubandashi"], ["standings", "/standings"],
    ["teams", "/teams"], ["team", "/teams/wolves"], ["player", "/players/子阳"],
    ["matches", "/matches"], ["match", "/matches/kpl-20260003-2026081603"],
    ["h2h", "/h2h?teamA=wolves&teamB=ag"],
  ];
  const widths = [320, 375, 390, 768, 1024, 1440];
  const result = { origin, capturedAt: new Date().toISOString(), matrix: [], pageErrors: [] };
  page.on("pageerror", error => result.pageErrors.push(String(error)));
  for (const [name, path] of routes) {
    const response = await page.goto(origin + path);
    await page.waitForTimeout(800);
    const folder = response.ok() && await page.locator('.esports-page').count() ? "after" : "failed";
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      for (const width of widths) {
        await page.setViewportSize({ width, height: 960 });
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        await page.waitForTimeout(120);
        const layout = await page.evaluate(() => ({
          title: document.querySelector(".esports-page h1")?.textContent,
          viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          brokenImages: [...document.querySelectorAll(".esports-page img")].filter(img => img.complete && !img.naturalWidth).map(img => img.src),
          smallControls: [...document.querySelectorAll(".esports-page button,.esports-page select,.esports-page input")].filter(el => el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().height < 44).map(el => el.textContent || el.getAttribute("aria-label")),
        }));
        result.matrix.push({ route: path, name, theme, width, status: response.status(), ...layout });
        await page.screenshot({ path: `${out}/${folder}/${name}-${width}-${theme}.png` });
        if (width === 390 || width === 1440) await page.screenshot({ path: `${out}/${folder}/${name}-${width}-${theme}-full.png`, fullPage: true });
      }
    }
  }
  await page.evaluate(result => localStorage.setItem("kpl:visual-results", JSON.stringify(result)), result);
}

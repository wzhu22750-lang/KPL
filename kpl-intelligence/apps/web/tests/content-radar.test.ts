import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { load } from 'cheerio';
import { rolldown } from 'rolldown';
import type { RadarMaterial, RadarMatch, RadarResponse } from '@aihot/contracts/radar';

// Use the installed Vite bundler to compile the real TSX tree in memory.
// External React imports keep the renderer, router and component on one instance.
const bundle = await rolldown({
  input: fileURLToPath(new URL('../app/features/feed/ContentRadar.tsx', import.meta.url)),
  platform: 'node',
  plugins: [{
    name: 'ssr-test-externals',
    resolveId(source) {
      if (!source.startsWith('.') && !source.startsWith('/')) {
        return { id: import.meta.resolve(source), external: true };
      }
    },
  }],
});
let ContentRadar: typeof import('../app/features/feed/ContentRadar.tsx').ContentRadar;
try {
  const { output } = await bundle.generate({ format: 'esm' });
  ({ ContentRadar } = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString('base64')}`));
} finally {
  await bundle.close();
}

const report: RadarMaterial = {
  id: 'report', title: 'AG战胜狼队', summary: '独立赛果报道', source: '官方赛事',
  url: 'https://example.test/report', publishedAt: null, kind: 'match', claimStatus: 'fact',
  stance: null, evidence: [], matchId: null, gameNo: null,
  score: { version: '1', base: 50, official: 20, heat: null, noise: 0, total: 70,
    heatCoverage: 'unknown', observedAt: null, reason: '', heatPlatform: null, metrics: {} },
};
const match: RadarMatch = {
  id: 'match', title: 'AG vs 狼队', bo: 7, status: 'finished', scheduledAt: null,
  home: { slug: 'ag', name: 'AG', shortName: null, logo: null },
  away: { slug: 'wolves', name: '狼队', shortName: null, logo: null },
  homeScore: 4, awayScore: 2, materials: [], games: [],
};
const radar: RadarResponse = {
  day: '2026-10-07', matches: [], topics: [], standalone: [report],
  coverage: { reviewed: 14, pending: 0, note: '仅展示已通过评估的内容' },
};
function render(value: RadarResponse | null, matches: RadarMatch[] = [match]) {
  return load(renderToStaticMarkup(createElement(MemoryRouter, null,
    createElement(ContentRadar, { radar: value, matches, matchesUnavailable: false }))));
}
function focus($: ReturnType<typeof render>) {
  assert.equal($('h2#radar-focus').text(), '圈内焦点');
  assert.equal($('h2#radar-focus').length, 1);
  return $('section[aria-labelledby="radar-focus"]');
}

test('matches and reviewed standalone results do not hide or become an empty focus', () => {
  const $ = render(radar);
  const section = focus($);
  assert.equal(section.find('p').text(), '暂无新焦点。');
  assert.equal(section.find('article').length, 0);
  assert.ok(!section.text().includes(report.title));
  assert.equal($('#radar-matches').text(), '比赛速览');
  assert.equal($('#radar-factual').text(), '重要事实与赛事实报');
  assert.ok($('section[aria-labelledby="radar-factual"]').text().includes(report.title));
});

test('pending materials are honestly distinguished from approved topics', () => {
  const $ = render({ ...radar, coverage: { ...radar.coverage, pending: 7 } });
  assert.equal(focus($).find('p').text(), '尚无通过评估的话题，7 份素材待评估。');
});

test('unavailable radar keeps focus visible even when matches are available', () => {
  const $ = render(null);
  assert.equal(focus($).find('p').text(), '圈内焦点暂不可用，请稍后重试。');
  assert.ok(!focus($).text().includes('暂无新焦点'));
  assert.equal($('#radar-matches').text(), '比赛速览');
});

test('fully empty radar has only one focus empty state, not the legacy duplicate', () => {
  const $ = render({ ...radar, standalone: [] }, []);
  assert.equal(focus($).find('p').text(), '暂无新焦点。');
  assert.equal($('h2').filter((_, el) => $(el).text().includes('焦点')).length, 1);
  assert.ok(!$('body').text().includes('近期暂无通过评估的话题或动态'));
});

test('published radar items use same-origin routes even if canonical SITE_URL is misconfigured', () => {
  const $ = render({ ...radar, standalone: [{ ...report, itemUrl: 'http://localhost:3000/items/report' }] });
  assert.equal($('section[aria-labelledby="radar-factual"] a').attr('href'), '/items/report');
});

test('approved lead and additional topics retain their titles, sources and details', () => {
  const topic = { id: 1, title: '阵容调整讨论', updatedAt: '2026-10-07T12:00:00Z', score: 80,
    materials: [{ ...report, id: 'discussion', title: '阵容调整讨论', kind: 'analysis' as const, claimStatus: 'opinion' as const, summary: '已评估讨论摘要' }] };
  const $ = render({ ...radar, topics: [topic, { ...topic, id: 2, title: '战术变化讨论' }] });
  const section = focus($);
  assert.deepEqual(section.find('h3').map((_, el) => $(el).text()).get(), ['阵容调整讨论', '战术变化讨论']);
  assert.equal(section.find('article.focus-story').length, 2);
  assert.equal(section.find('details.focus-details > summary').length, 2);
  assert.ok(section.text().includes('1 条来源'));
  assert.ok(section.text().includes('已评估讨论摘要'));
  assert.ok(!section.text().includes('暂无新焦点'));
  assert.ok(!section.text().includes('暂不可用'));
});

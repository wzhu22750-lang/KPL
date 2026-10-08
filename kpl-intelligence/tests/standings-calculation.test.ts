import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateStandings, validStandingResult, type StandingsMatch } from '@aihot/backend/kb/standings';
import { standingsRules } from '@aihot/industry/standings';

const team = (slug: string) => ({slug, name: slug, shortName: null, logo: null});
const match = (overrides: Partial<StandingsMatch> = {}): StandingsMatch => ({
  id: 'match', home: team('a'), away: team('b'), scoreA: 3, scoreB: 1,
  winner: 'a', status: 'finished', bo: 5, ...overrides,
});

test('scores and winners must describe a valid finished series', () => {
  assert.ok(validStandingResult(match()));
  for (const overrides of [
    {status:'scheduled'}, {status:'live'}, {winner:null}, {winner:'b'},
    {scoreA:0,scoreB:0}, {scoreA:2}, {scoreB:-1}, {scoreA:4}, {scoreB:1.5},
  ]) assert.equal(validStandingResult(match(overrides)),false, JSON.stringify(overrides));
});

test('each valid series contributes one win, one loss and opposite game differential', () => {
  const rows = calculateStandings([match()], [team('a'),team('b'),team('c')], '总榜','常规赛');
  assert.equal(rows.reduce((n,r) => n+r.wins,0),1);
  assert.equal(rows.reduce((n,r) => n+r.losses,0),1);
  assert.equal(rows.reduce((n,r) => n+r.gameDiff,0),0);
  const unplayed = rows.find(r=>r.team.slug==='c')!;
  assert.equal(unplayed.matchesPlayed,0);
  assert.equal(unplayed.streak,'-');
});

test('cross-group wins count even if the opponent is outside the group roster', () => {
  const rows = calculateStandings([match()], [team('b')], '精英组','擂台赛');
  assert.deepEqual([rows[0]!.matchesPlayed,rows[0]!.wins,rows[0]!.losses,rows[0]!.gameDiff],[1,0,1,-2]);
});

test('equal points and game differential stay tied, not decided by total games won', () => {
  const rows = calculateStandings([
    match({home:team('a'),away:team('x'),scoreA:3,scoreB:0,winner:'a'}),
    match({home:team('a'),away:team('y'),scoreA:1,scoreB:3,winner:'y'}),
    match({home:team('b'),away:team('x'),scoreA:3,scoreB:1,winner:'b'}),
    match({home:team('b'),away:team('y'),scoreA:2,scoreB:3,winner:'y'}),
  ],[team('a'),team('b')],'大师组','擂台赛');
  assert.deepEqual(rows.map(r => [r.points,r.gameDiff,r.rank]),[[1,1,1],[1,1,1]]);
});

test('streaks and win rates use chronological valid results only', () => {
  const rows = calculateStandings([
    match({scoreA:1,scoreB:3,winner:'b'}),match(),match(),match({status:'live'}),
  ],[team('a')],'总榜','常规赛');
  assert.equal(rows[0]!.streak,'2连胜');
  assert.equal(rows[0]!.winRate,2/3);
});

test('verified annual groups are scoped to the exact season and arena stage', () => {
  const rules = standingsRules('20260004','擂台赛')!;
  assert.equal(rules.groups['大师组']!.length,6);
  assert.equal(rules.groups['精英组']!.length,6);
  assert.equal(new Set(Object.values(rules.groups).flat()).size,12);
  assert.equal(standingsRules('20250003','擂台赛'),null);
  assert.equal(standingsRules('20260004','突围赛'),null);
  assert.equal(standingsRules('20260001','常规赛第二轮'),null);
});

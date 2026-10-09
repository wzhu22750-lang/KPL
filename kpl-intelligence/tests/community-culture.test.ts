import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSocialPost } from '@aihot/backend/editorial/social-analyzer';
import type { SourceRow } from '@aihot/backend/sources/types';
import { radarScore, type RadarJudgmentData } from '@aihot/backend/editorial/radar-score';
const source = { id:'offline-community',name:'Offline community',kind:'weibo',tier:'T2',owner_type:'community',config:{} } as SourceRow;

test('community expressions alone are not commercial noise or abuse', () => {
  const text = 'KPL 赛后讨论：饭圈、破防、吵架、逆天、菜、整活这些表达不自动构成灌水，讨论 BP 和比赛发挥仍有语境与信息。';
  const result = evaluateSocialPost({sourceId:source.id,url:'https://weibo.com/detail/offline',title:text,bodyText:text,via:'fetch'},source);
  assert.equal(result.breakdown.noise_penalty,0);
});

test('Hupu growth compares only shared observed metrics without requiring nonexistent shares', () => {
  const j = {kind:'controversy',claimStatus:'opinion',information:50,interpretation:50,distinctiveness:50,timeliness:50,interest:50,noise:0,reason:'offline fixture'} as RadarJudgmentData;
  const previous = {platform:'hupu',observedAt:new Date('2026-10-08T10:00:00Z'),metrics:{comments:50,likes:20,shares:null}};
  const latest = {platform:'hupu',observedAt:new Date('2026-10-08T11:00:00Z'),metrics:{comments:800,likes:100,shares:null}};
  assert.ok(radarScore(j,false,latest,previous).heat! > radarScore(j,false,latest).heat!);
  const decreased = {...latest,metrics:{comments:20,likes:100,shares:null}};
  assert.equal(radarScore(j,false,decreased,previous).heat,radarScore(j,false,decreased).heat,'counter decreases are not positive growth');
});

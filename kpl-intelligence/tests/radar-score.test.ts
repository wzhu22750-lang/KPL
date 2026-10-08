import assert from 'node:assert/strict';
import test from 'node:test';
import { RadarJudgment,radarScore,radarAdmission,chooseRadarMix,type RadarJudgmentData } from '@aihot/backend/editorial/radar-score';
import { associateMatch } from '@aihot/backend/events/radar-match';
const judgment: RadarJudgmentData={ relevant:true,safe:true,kind:'controversy',title:'首发讨论',summary:'不同观点',claimStatus:'opinion',stance:null,
  evidence:['原始观点'],topicKey:'AG 2026首发调整',information:80,interpretation:80,distinctiveness:80,timeliness:80,interest:80,noise:10,newDevelopment:true,reason:'清楚的分歧' };

test('type-weighted base, official bonus and real heat are independently explainable',()=>{
  const low=radarScore({...judgment,kind:'official',claimStatus:'fact'},true);
  assert.equal(low.base,56);assert.equal(low.official,10);assert.equal(low.heat,null);assert.equal(low.total,63);
  const high=radarScore(judgment,false,{platform:'hupu',observedAt:new Date('2026-10-08T02:00:00Z'),metrics:{likes:300,comments:1000,shares:0}},
    {platform:'hupu',observedAt:new Date('2026-10-08T01:00:00Z'),metrics:{likes:1,comments:1,shares:0}});
  assert.ok(high.heat!>=15);assert.ok(high.total>low.total);assert.equal(high.official,0);
  const unknown=radarScore(judgment,false,{platform:'weibo',observedAt:new Date(),metrics:{comments:null}});
  assert.equal(unknown.heatCoverage,'unknown');assert.equal(unknown.heat,null);
});
test('a platform name does not grant heat, zero is observed and unsupported platforms stay unknown',()=>{
  assert.equal(radarScore(judgment,false).heat,null);
  assert.equal(radarScore(judgment,false,{platform:'hupu',observedAt:new Date(),metrics:{comments:0}}).heat,0);
  assert.equal(radarScore(judgment,false,{platform:'new_platform',observedAt:new Date(),metrics:{comments:10000}}).heat,null);
  const fun={...judgment,kind:'fun' as const,information:20,interpretation:10,interest:100,distinctiveness:100};
  assert.equal(radarAdmission(fun,radarScore(fun,false)),'accepted','good short jokes need not pass a knowledge-depth gate');
  assert.equal(radarAdmission({...judgment,safe:false},radarScore(judgment,true)),'review');
  assert.equal(radarAdmission({...judgment,relevant:false},radarScore(judgment,true)),'rejected');
});
test('strict model contract does not coerce dimensions or execute injected instructions',()=>{
  assert.throws(()=>RadarJudgment.parse({...judgment,information:'100'}));
  assert.throws(()=>RadarJudgment.parse({...judgment,noise:-1}));
  assert.throws(()=>RadarJudgment.parse({...judgment,safe:'true'}));
});
test('match parent groups different games without merging their fact identity; ambiguous identity remains null',()=>{
  const day=new Date('2026-10-07T12:00:00+08:00');
  const matches=[{id:'ag-lgd',homeName:'成都AG超玩会',awayName:'杭州LGD.NBW',at:day,bo:5,stage:'2026年度总决赛'}];
  assert.deepEqual(associateMatch('成都AG超玩会第一局战胜杭州LGD.NBW',day,matches)?.gameNo,1);
  assert.equal(associateMatch('杭州LGD.NBW第三局战胜成都AG超玩会',day,matches)?.matchId,'ag-lgd');
  assert.equal(associateMatch('杭州LGD.NBW九尾沈梦溪越塔三杀',day,matches)?.gameNo,null);
  assert.equal(associateMatch('成都AG超玩会第九局战胜LGD',day,matches)?.gameNo,null);
  assert.equal(associateMatch('AG第一局战胜LGD',day,[...matches,{...matches[0]!,id:'rematch'}]),null);
  assert.equal(associateMatch('AG第一局战胜LGD',null,matches),null);
  assert.equal(associateMatch('2026年10月7日 AG对LGD复盘',new Date('2026-10-08T12:00:00+08:00'),matches)?.matchId,'ag-lgd');
  assert.equal(associateMatch('挑战者杯 AG第一局战胜LGD',day,matches),null);
});
test('soft mix fills available content without manufacturing controversy',()=>{
  const rows=[{kind:'analysis' as const,score:80},{kind:'fun' as const,score:70}];
  assert.equal(chooseRadarMix(rows,20).length,2);
});

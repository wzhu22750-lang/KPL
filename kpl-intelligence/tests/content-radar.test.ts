import { stub,tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after,before,test } from 'node:test';
import { closeDb,sql } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { assessRadar } from '@aihot/backend/editorial/radar';
import { loadRadar } from '@aihot/backend/publication/radar';
import { loadTimeline } from '@aihot/backend/publication/timeline';
import { buildApp } from '../apps/api/src/app.ts';
import { upsertMatch } from '@aihot/backend/kb/upsert';
import { RADAR } from '@aihot/industry/radar';
import { queueRadar } from '@aihot/backend/jobs/radar';
RADAR.enabled=true;

const t=tag(),official=`official-${t}`,community=`community-${t}`;
const day='2026-10-07',at=new Date(`${day}T12:00:00+08:00`);
const provider=await stub((_hit,req)=>{
  const body=JSON.parse(req.body); const input=JSON.parse(body.messages.at(-1).content);
  const original=String(input.original);
  const controversy=original.includes('争议');
  const joke=original.includes('趣评');
  const answer={ relevant:true,safe:!original.includes('隐私'),kind:controversy?'controversy':joke?'fun':'match',title:input.title,
    summary:`已确认的公开内容与不同观点：${input.title}`,claimStatus:controversy?'opinion':joke?'joke':'fact',stance:controversy?original.includes('反对')?'反对':'支持':null,
    evidence:[original.includes('无依据') ? '完全不在原文的引文' : input.title],topicKey:controversy?`2026年总 首发争议 ${t}`:null,information:85,interpretation:80,distinctiveness:85,timeliness:90,interest:90,
    noise:5,newDevelopment:original.includes('回应'),reason:'有原始出处的赛事内容'};
  return {choices:[{message:{content:JSON.stringify(answer)}}],usage:{prompt_tokens:10,completion_tokens:10}};
});
process.env.ZHIPU_BASE_URL=`${provider.url}/v1`;process.env.ZHIPU_API_KEY='test-key';
const app=await buildApp();
before(async()=>{
  await sql`INSERT INTO sources(id,name,kind,tier,owner_type,participation_mode,site_fulltext,enabled) VALUES
    (${official},'核验官方','weibo','T1_5','club','editorial',true,true),(${community},'测试社区','weibo','T2','community','hot_signal',false,true)`;
  await sql`INSERT INTO entity_accounts(entity_type,entity_id,entity_name,platform,handle,source_id,official_verified,verified_evidence)
    VALUES ('team','ag','成都AG超玩会','weibo',${`handle-${t}`},${official},true,'合成测试核验证据')`;
  await sql`INSERT INTO seasons(id,name,year,split) VALUES (${`season-${t}`},'2026年度总决赛',2026,'annual')`;
  for (const [id,name] of [['ag','成都AG超玩会'],['lgd','杭州LGD.NBW'],['ksg','苏州KSG'],['tes','长沙TES.A'],['wb','北京WB'],['edgm','上海EDG.M']]) {
    await sql`INSERT INTO teams(id,slug,name) VALUES (${id+t},${id+t},${name})`;
  }
  for (const [home,away,bo] of [['ag','lgd',5],['ksg','tes',7],['wb','edgm',9]] as const) {
    await sql`INSERT INTO matches(id,season_id,team_a_id,team_b_id,scheduled_at,bo,status,score_a,score_b)
      VALUES (${`${home}-${away}-${t}`},${`season-${t}`},${home+t},${away+t},${at},${bo},'live',1,0)`;
  }
});
after(async()=>{await app.close();await provider.close();await stopBoss();await closeDb();});
const add=async(title:string,source=official)=> (await upsertMaterial({sourceId:source,url:`https://weibo.com/${t}/${tag()}`,title,
  bodyText:`${title}。这是合成原始素材，不是已核验赛果。`,bodyStatus:'ok',publishedAt:at,discoveredAt:at,via:'fetch',
  engagementObservation:{platform:'weibo',observedAt:at,method:'source_api',metrics:{likes:0,comments:0,shares:0}}})).articleId;

test('end to end: three series form three match cards; games and unknown operations remain distinct',async()=>{
  const first=await add('成都AG超玩会第一局战胜杭州LGD.NBW');
  const third=await add('杭州LGD.NBW第三局战胜成都AG超玩会，断雨杨戬获MVP');
  const operation=await add('杭州LGD.NBW九尾沈梦溪越塔三杀');
  for(const id of [first,third,operation]) assert.equal((await assessRadar(id)).state,'accepted');
  const data=await loadRadar(day);
  assert.equal(data.matches.length,3);
  const match=data.matches.find(m=>m.id===`ag-lgd-${t}`)!;
  assert.equal(match.materials.length,3);
  assert.equal(match.materials.find(m=>m.id===first)!.gameNo,1);
  assert.equal(match.materials.find(m=>m.id===third)!.gameNo,3);
  assert.equal(match.materials.find(m=>m.id===operation)!.gameNo,null);
  const calls=provider.hits();await assessRadar(first);assert.equal(provider.hits(),calls,'same revision reuses judgment without another paid call');
  assert.equal((await sql`SELECT 1 FROM radar_materials WHERE article_id=${first}`).length,1);
  const response=await app.inject({method:'GET',url:`/api/site/radar?day=${day}`});
  assert.equal(response.statusCode,200);assert.equal(response.json().matches.length,3);
});

test('community-first controversy creates a public topic with different stances and preserves unknown/zero',async()=>{
  const support=await add('首发争议：支持这次调整',community),oppose=await add('首发争议：反对这次调整',community);
  const response=await add('首发争议：当事人回应说明',official);
  for(const id of [support,oppose,response])await assessRadar(id);
  const result=await loadRadar(day);
  assert.equal(result.topics.length,1);assert.equal(result.topics[0]!.materials.length,3);
  assert.ok(result.topics[0]!.materials.some(m=>m.stance==='反对'));
  assert.equal(result.topics[0]!.materials.find(m=>m.id===support)!.evidence.length,0,'no raw quotes for unlicensed source');
  assert.equal(result.topics[0]!.materials.find(m=>m.id===support)!.score.heat,0,'real zero is not unknown');
  assert.equal(result.topics[0]!.materials.find(m=>m.id===support)!.score.official,0);
  const stamp=result.topics[0]!.updatedAt,calls=provider.hits();
  const [raw]=await sql`SELECT url,title,body_text FROM articles WHERE id=${support}`;
  await upsertMaterial({sourceId:community,url:raw!.url,title:raw!.title,bodyText:raw!.body_text,bodyStatus:'ok',publishedAt:at,via:'fetch',
    engagementObservation:{platform:'weibo',observedAt:new Date(at.getTime()+3600000),method:'source_api',metrics:{likes:5000,comments:1000,shares:100}}});
  await assessRadar(support);
  assert.equal(provider.hits(),calls,'metric refresh never buys another judgment');
  const refreshed=await loadRadar(day);assert.equal(refreshed.topics[0]!.updatedAt,stamp,'likes alone never count as substantive development');
  assert.ok(refreshed.topics[0]!.materials.find(m=>m.id===support)!.score.heat!>0);
});

test('match observations reject stale scores but allow newer corrections and postponed status',async()=>{
  const base={leagueId:'20260001',matchId:t,seasonId:`season-${t}`,teamAId:`ag${t}`,teamBId:`lgd${t}`,scoreA:2,scoreB:1,
    winnerId:null,status:'live' as const,scheduledAt:at,playedAt:null,bo:9,observedAt:new Date(at.getTime()+3600000)};
  const first=await upsertMatch(sql,base);assert.equal(first.created,true);
  const stale=await upsertMatch(sql,{...base,scoreA:0,observedAt:at});assert.equal(stale.revised,false);
  assert.equal((await sql`SELECT score_a FROM matches WHERE id=${first.id}`)[0]!.score_a,2);
  const correction=await upsertMatch(sql,{...base,scoreA:1,observedAt:new Date(at.getTime()+7200000)});assert.equal(correction.revised,true);
  assert.equal((await sql`SELECT score_a FROM matches WHERE id=${first.id}`)[0]!.score_a,1);
  await upsertMatch(sql,{...base,status:'postponed',observedAt:new Date(at.getTime()+10800000)});
  assert.equal((await sql`SELECT status FROM matches WHERE id=${first.id}`)[0]!.status,'postponed');
});

test('unsafe material waits for review and stale/retracted material never leaks from new endpoint',async()=>{
  const missing=await add('首发争议：无依据的模型陈述',community);assert.equal((await assessRadar(missing)).state,'review');
  const id=await add('首发争议：隐私信息',community);assert.equal((await assessRadar(id)).state,'review');
  assert.ok(!(await loadRadar(day)).topics.flatMap(t=>t.materials).some(m=>m.id===id));
  const item=await add('趣评：有趣的公开比赛梗',community);await assessRadar(item);
  await upsertMaterial({sourceId:community,url:(await sql`SELECT url FROM articles WHERE id=${item}`)[0]!.url,title:'改过的新稿',bodyText:'新稿',via:'fetch'});
  assert.ok(!(await loadRadar(day)).standalone.some(m=>m.id===item),'a stale judged revision is withheld');
  const invalid=await app.inject({method:'GET',url:'/api/site/radar?day=2026-02-30'});assert.equal(invalid.statusCode,400);
});

test('restored selected feed is independent of radar placement and still enforces publication scope',async()=>{
  const [item]=await sql`SELECT a.id,a.source_id,a.url,r.title,r.summary FROM articles a JOIN radar_materials r ON r.article_id=a.id
    WHERE a.source_id=${official} AND r.state='accepted' AND r.match_id IS NOT NULL LIMIT 1`;
  assert.ok(item);
  await sql`INSERT INTO publications(article_id,source_id,title,summary,channel,url,discovered_at,timeline_at,published_at,sort_at,
    eligible,selected,seat,visible_after,visibility,body_mode,syndicate)
    VALUES (${item.id},${item.source_id},${item.title},${item.summary},'news',${item.url},${at},${at},${at},${at},
      true,true,true,${new Date(at.getTime()-60000)},'public','full',false)`;
  const calls=provider.hits();
  const all=await loadTimeline({channel:'all',category:null,tag:null,now:at});
  assert.ok(all.cards.some(c=>c.item.id===item.id),'originally selected material stays visible even when associated with a radar match');
  const news=await loadTimeline({channel:'news',category:null,tag:null,now:at});
  assert.ok(news.cards.some(c=>c.item.id===item.id),'a filtered legacy list does not silently hide its material');
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${item.id}`;
  assert.ok(!(await loadTimeline({channel:'all',category:null,tag:null,now:at})).cards.some(c=>c.item.id===item.id),'restoring the original feed never restores withdrawn material');
  assert.equal(provider.hits(),calls,'selected-feed reads do not purchase another judgment');
});

test('current homepage combines recent focus with independent live, upcoming and latest results, including team crests',async()=>{
  const now=new Date('2026-10-08T12:00:00+08:00');
  await sql`UPDATE teams SET logo_url='https://example.test/ag.png',short_name='AG' WHERE id=${'ag'+t}`;
  for(const [id,status,date] of [['next','scheduled','2026-10-09T12:00:00+08:00'],['recent','finished','2026-10-06T12:00:00+08:00']] as const) {
    await sql`INSERT INTO matches(id,season_id,team_a_id,team_b_id,scheduled_at,status)
      VALUES (${id+t},${'season-'+t},${'ag'+t},${'lgd'+t},${new Date(date)},${status})`;
  }
  const calls=provider.hits();
  const result=await loadRadar('2026-10-08',undefined,{current:true,now});
  assert.ok(result.topics.length>0,'yesterday’s still-relevant discussions remain visible');
  assert.ok(result.matches.some(m=>m.id==='next'+t));
  assert.ok(result.matches.some(m=>m.id==='recent'+t));
  assert.ok(result.matches.some(m=>m.status==='live'));
  assert.equal(result.matches.find(m=>m.id==='ag-lgd-'+t)!.home.logo,'https://example.test/ag.png');
  assert.equal(result.matches.find(m=>m.id==='ag-lgd-'+t)!.home.shortName,'AG');
  assert.equal(provider.hits(),calls,'reading current focus never buys a judgment');
  const oldTopicIds=result.topics.map(topic=>topic.id);
  const later=await loadRadar('2026-10-20',undefined,{current:true,now:new Date('2026-10-20T12:00:00+08:00')});
  assert.ok(!later.topics.some(topic=>oldTopicIds.includes(topic.id)),'old discussions are not made current by an unrelated scorecard');
  assert.equal((await app.inject({method:'GET',url:'/api/site/radar?current=true&day=2026-10-07'})).statusCode,400);
  assert.equal((await app.inject({method:'GET',url:'/api/site/radar?current=invalid'})).statusCode,400);
  assert.equal((await app.inject({method:'GET',url:'/api/site/radar?current=true'})).statusCode,200);
});

test('match news includes every visible association beyond the homepage limit, without stale or withdrawn material',async()=>{
  const matchId='ag-lgd-'+t;
  const before=(await loadRadar(day,matchId)).matches[0]!.materials.length;
  const prefix='bulk_'+t+'_';
  try {
    await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at)
      SELECT ${prefix}||n,${official},${prefix}||n,'https://example.test/'||${prefix}||n,'关联报道 '||n,${at},${at},${at} FROM generate_series(1,305) n`;
    await sql`INSERT INTO radar_materials(article_id,input_revision,state,kind,title,summary,claim_status,judgment,base_score,official_bonus,noise,score_version,reason,match_id,game_no)
      SELECT a.id,1,'accepted','match',a.title,'合成测试摘要','fact',sample.judgment,60,0,0,${RADAR.version},'test',${matchId},1
      FROM articles a CROSS JOIN (SELECT judgment FROM radar_materials WHERE match_id=${matchId} LIMIT 1) sample
      WHERE left(a.id,length(${prefix}))=${prefix}`;
    await sql`UPDATE radar_materials SET input_revision=0 WHERE article_id=${prefix+'1'}`;
    await sql`INSERT INTO editorial_overrides(article_id,visibility) VALUES (${prefix+'2'},'withdrawn')`;
    const result=(await loadRadar(day,matchId)).matches[0]!;
    assert.equal(result.materials.length,before+303);
    assert.ok(result.materials.some(m=>m.id===prefix+'305'));
    assert.ok(!result.materials.some(m=>m.id===prefix+'1'||m.id===prefix+'2'));
    assert.ok(result.materials.every(m=>m.matchId===matchId));
  } finally {await sql`DELETE FROM articles WHERE left(id,length(${prefix}))=${prefix}`;}
});

test('closed rollout gate stops radar exposure and does not enqueue judgment work',async()=>{
  RADAR.enabled=false;
  try {
    const calls=provider.hits();
    const response=await app.inject({method:'GET',url:`/api/site/radar?day=${day}`});
    assert.equal(response.statusCode,503);
    const hot = await app.inject({method:'GET',url:'/api/site/hot/strip'});
    assert.equal(hot.statusCode,200,'the original hot ranking is independent of the radar rollout gate');
    assert.ok(Array.isArray(hot.json().entries));
    assert.match(hot.headers['cache-control'] as string,/max-age=30/);
    await queueRadar('not-a-real-material');assert.equal(provider.hits(),calls);
  } finally { RADAR.enabled=true; }
});

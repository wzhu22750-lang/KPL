import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { StandingRow, StandingsResponse } from '@aihot/contracts/kpl';

const row = (slug: string, group: string, played: number): StandingRow => ({
  rank: 1, team: {slug,name:slug,shortName:null,logo:null},group,stageName:'擂台赛',
  matchesPlayed:played,wins:played ? 2 : 0,losses:played ? 1 : 0,winRate:played ? 2/3 : 0,
  gamesWon:played ? 7 : 0,gamesLost:played ? 5 : 0,gameDiff:played ? 2 : 0,points:played ? 2 : 0,streak:played ? '2连胜' : '-',
});
const data: StandingsResponse = {
  season:{id:'annual',name:'2026年KPL年度总决赛',year:2026},
  availableSeasons:[{id:'annual',name:'2026年KPL年度总决赛',year:2026,externalId:'20260004',isCurrent:true}],
  currentStage:'擂台赛',stages:['擂台赛','突围赛'],
  standingsByGroup:{大师组:[row('大师战队','大师组',3)],精英组:[row('精英战队','精英组',0)]},
  notes:['同分同净胜局暂列并列，最终顺位以官方裁定为准。'],
  rulesDescription:'BO5 组外单循环，两个组别独立排名。当前排名不代表已锁定晋级。',
  rulesSourceUrl:'https://news.qq.com/rain/a/20261001A0ASAJ00',
};
const requests: URL[] = [];
const api = createServer((req,res) => {
  const url = new URL(req.url!,'http://api.local');
  res.setHeader('Content-Type','application/json');
  if(url.pathname === '/api/site/meta') return res.end(JSON.stringify({changelogVersion:'2026-10-01'}));
  if(url.pathname === '/api/site/kb/standings') {
    requests.push(url);
    if(url.searchParams.get('season') === 'unverified') return res.end(JSON.stringify({
      ...data,standingsByGroup:{'战绩汇总（分组待核实）':[row('待核实战队','总榜',3)]},
      rulesDescription:null,rulesSourceUrl:null,notes:['本赛段尚无已核实的官方分组资料，不代表官方积分排名。'],
    }));
    return res.end(JSON.stringify(data));
  }
  res.statusCode=404;
  res.end(JSON.stringify({code:'not_found'}));
});
let web: ChildProcess;
let origin = '';
let logs = '';
before(async () => {
  api.listen(0,'127.0.0.1');
  await once(api,'listening');
  web=spawn(process.execPath,[fileURLToPath(new URL('../server.ts',import.meta.url))],{
    env:{...process.env,NODE_ENV:'production',PORT:'0',WEB_HOST:'127.0.0.1',API_BASE_URL:`http://127.0.0.1:${(api.address() as AddressInfo).port}`},
    stdio:['ignore','pipe','pipe'],
  });
  await new Promise<void>((resolve,reject) => {
    const timeout=setTimeout(()=>reject(new Error(`web did not start: ${logs}`)),15_000);
    web.on('exit',()=>{clearTimeout(timeout);reject(new Error(`web exited: ${logs}`));});
    web.stderr!.on('data',chunk=>{logs+=String(chunk);});
    web.stdout!.on('data',chunk=>{
      logs+=String(chunk);
      const match=logs.match(/"msg":"web started","port":(\d+)/);
      if(match) {origin=`http://127.0.0.1:${match[1]}`;clearTimeout(timeout);resolve();}
    });
  });
});
after(async () => {
  if(web && web.exitCode === null) {web.kill('SIGTERM');await once(web,'exit');}
  api.closeAllConnections();
  await new Promise<void>(resolve=>api.close(()=>resolve()));
});
const visible = (html: string) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<[^>]+>/g,'');

test('annual standings SSR shows master and elite groups without regular-season promotion badges',async () => {
  const response=await fetch(`${origin}/standings`);
  assert.equal(response.status,200,logs);
  const html=await response.text();
  const text=visible(html);
  assert.match(text,/大师组积分榜/);
  assert.match(text,/精英组积分榜/);
  assert.match(text,/组外单循环/);
  assert.match(text,/已赛/);
  assert.match(text,/66\.7%/);
  assert.doesNotMatch(text,/S\/A\/B|升S卡位|淘汰预警|胜者组/);
  const tables=html.match(/<table\b[\s\S]*?<\/table>/g)!;
  assert.equal(tables.length,2);
  assert.match(visible(tables[0]!),/大师战队/);
  assert.doesNotMatch(visible(tables[0]!),/精英战队/);
  assert.match(visible(tables[1]!),/精英战队/);
  assert.match(visible(tables[1]!),/—/);
  assert.doesNotMatch(visible(tables[1]!),/0\.0%/);
  assert.match(html,/href="https:\/\/news\.qq\.com\/rain\/a\/20261001A0ASAJ00"/);
});

test('season and stage selections are forwarded unchanged to the standings API',async () => {
  const response=await fetch(`${origin}/standings?season=annual&stage=${encodeURIComponent('擂台赛')}`);
  assert.equal(response.status,200);
  assert.ok(requests.some(url=>url.searchParams.get('season')==='annual' && url.searchParams.get('stage')==='擂台赛'));
});

test('unverified group data is explicitly labelled instead of inventing official groups',async () => {
  const response=await fetch(`${origin}/standings?season=unverified`);
  assert.equal(response.status,200);
  const text=visible(await response.text());
  assert.match(text,/战绩汇总（分组待核实）/);
  assert.match(text,/不代表官方积分排名/);
  assert.doesNotMatch(text,/大师组积分榜|精英组积分榜|S 组积分榜|官方赛制与分组公告/);
});

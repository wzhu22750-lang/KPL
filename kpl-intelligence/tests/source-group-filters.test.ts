import './setup.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { closeDb, sql } from '@aihot/backend/db';
import { loadPool } from '@aihot/backend/publication/pool';
import { loadTimeline } from '@aihot/backend/publication/timeline';
import { loadGroupReports } from '@aihot/backend/publication/groups';
import { InvalidCursorError } from '@aihot/backend/lib/cursor';
import { SOURCE_GROUP_KEYS } from '@aihot/contracts/taxonomy';
import { parseFilters } from '../apps/api/src/routes/site.ts';

after(closeDb);
const now = new Date('2020-10-10T00:00:00Z');
const filters = {channel:'all' as const,category:null,tag:null,now};
const sources = [
  {id:'official',owner:'league',tags:['联盟'],group:'official'},
  {id:'club',owner:'club',tags:['战队'],group:'club'},
  {id:'player',owner:'player',tags:[],group:'participant'},
  {id:'coach',owner:'coach',tags:[],group:'participant'},
  {id:'staff',owner:'staff',tags:[],group:'participant'},
  {id:'caster',owner:'media',tags:['解说'],group:'caster'},
  {id:'media',owner:'media',tags:['战术'],group:'media'},
  {id:'community',owner:'community',tags:['社区'],group:'community'},
  {id:'unknown',owner:null,tags:['官方'],group:null},
] as const;
const factPublicId = 'source-group-shared-fact';
before(async () => {
  const [fact] = await sql<{id:number}[]>`INSERT INTO facts(public_id,title) VALUES (${factPublicId},'同一赛果多方报道') RETURNING id`;
  for (const [index,source] of sources.entries()) {
    await sql`INSERT INTO sources(id,name,kind,tier,owner_type,tags) VALUES (${source.id},${source.id},'rss','T1',${source.owner},${[...source.tags]})`;
    for (let n=0;n<2;n++) {
      const id=`${source.id}-${n}`;
      const at=new Date(now.getTime()-3600_000-index*1000-n*100_000);
      await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at) VALUES (${id},${source.id},${id},${`https://example.test/${id}`},${id},${at},${at})`;
      // Every article deliberately has the same misleading identity words. Only source metadata counts.
      await sql`INSERT INTO publications(article_id,source_id,title,channel,url,discovered_at,timeline_at,sort_at,visible_after,visibility,eligible,selected,category,tags,fact_id)
        VALUES (${id},${source.id},${`赛果 ${id}`},'news',${`https://example.test/${id}`},${at},${at},${at},${at},'public',true,true,'match-result',${['官方','战队官方','二路','赛果战报']},${n===0?fact!.id:null})`;
      if(n===0) await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES (${fact!.id},${id},'report')`;
    }
  }
});

for (const sourceGroup of SOURCE_GROUP_KEYS) test(`${sourceGroup}: pool, timeline and reading group use the same publisher identity`, async () => {
  const expected = sources.filter(s=>s.group===sourceGroup).map(s=>s.id);
  const pool = await loadPool({...filters,sourceGroup});
  assert.equal(pool.total,expected.length*2);
  assert.equal(pool.filters.sourceGroup,sourceGroup);
  assert.ok(pool.items.every(item=>item.source.group===sourceGroup));
  assert.deepEqual(new Set(pool.items.map(item=>item.id.split('-')[0])),new Set(expected));
  const timeline = await loadTimeline({...filters,sourceGroup});
  assert.equal(timeline.cards.length,expected.length+1,'one shared fact plus each standalone report');
  assert.ok(timeline.cards.every(card=>card.item.source.group===sourceGroup));
  const shared=timeline.cards.find(card=>card.key.startsWith('f'))!;
  assert.ok(shared);
  assert.equal(shared.group?.reportCount ?? 1,expected.length);
  const group = await loadGroupReports({...filters,sourceGroup,factPublicId},now);
  assert.deepEqual(new Set(group!.reports.map(item=>item.id.split('-')[0])),new Set(expected));
});

test('unknown T1 sources are not official; theme filters still intersect identity filters',async () => {
  const all=await loadPool(filters);
  assert.equal(all.items.find(item=>item.id==='unknown-0')!.source.group ?? null,null);
  const club=await loadPool({...filters,sourceGroup:'club',category:'match-result',tag:'赛果战报'});
  assert.equal(club.total,2);
  assert.equal((await loadPool({...filters,sourceGroup:'club',category:'roster'})).total,0);
});

test('cache scopes and pagination cursors do not cross publisher groups',async () => {
  const query={channel:'all' as const,category:null,tag:null};
  const official=await loadPool({...query,sourceGroup:'official'});
  const club=await loadPool({...query,sourceGroup:'club'});
  assert.ok(official.items.every(item=>item.source.group==='official'));
  assert.ok(club.items.every(item=>item.source.group==='club'));
  const head=await loadTimeline({...filters,sourceGroup:'official',limit:1});
  assert.ok(head.nextCursor);
  await assert.rejects(loadTimeline({...filters,sourceGroup:'club',cursor:head.nextCursor}),InvalidCursorError);
  const tail=await loadTimeline({...filters,sourceGroup:'official',cursor:head.nextCursor});
  assert.equal(tail.cards.length,1);
  assert.ok(tail.cards.every(card=>card.item.source.group==='official'));
});

test('API accepts only the six public groups and keeps legacy topic/category inputs separate',()=>{
  for(const sourceGroup of SOURCE_GROUP_KEYS) assert.equal(parseFilters({sourceGroup}).sourceGroup,sourceGroup);
  assert.equal(parseFilters({}).sourceGroup,null);
  assert.throws(()=>parseFilters({sourceGroup:'赛果'}),/invalid source group/);
  const parsed=parseFilters({sourceGroup:'club',category:'match-result',tag:'年度总决赛'});
  assert.equal(parsed.category,'match-result');
  assert.equal(parsed.tag,'年度总决赛');
});

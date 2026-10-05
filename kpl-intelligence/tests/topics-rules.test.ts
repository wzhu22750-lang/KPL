// Milestone failures to guard before implementing the new deterministic rules:
// - a useful tutorial, opinion or trend list is presented as a historical milestone;
// - a stronger later report moves an event's date, or an explicit occurrence loses to collection time;
// - cached titles survive a score/tag/subject correction, while the selected list should stay readable.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { beijingDate } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadTopicPage } from "@aihot/backend/publication/topics";
import { overrideFields } from "@aihot/backend/admin/content";

const T = tag();
const SOURCE = `test-topic-rules-${T}`;
const now = new Date();
const at = new Date(now.getTime() - 6 * 3600_000);
let serial = 0;
let cached: string;
let cachedFact: number;
before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,owner_entity_id,next_fetch_at)
    VALUES (${SOURCE},'Official','rss','T1','editorial','ksg','2100-01-01')`;
  cachedFact = await fact(null, "苏州KSG");
  cached = await report({ company: "ksg", title: "苏州KSG 3 比 1 战胜对手", factId: cachedFact, score: 90 });
  await loadTopicPage("ksg", 1); // Warm once; all corrections below happen before expiry.
});
after(async () => { await stopBoss(); await closeDb(); });

async function fact(storyId: number | null, subject: string, occurred: Date | null = null, action = "战胜"): Promise<number> {
  const [f] = await sql<{id: number}[]>`INSERT INTO facts (public_id,story_id,title,subject,action,object,occurred_at)
    VALUES (${`f-${randomUUID()}`},${storyId},'比赛赛果',${subject},${action},'对手',${occurred}) RETURNING id`;
  return f!.id;
}
async function story() {
  const id = randomUUID();
  const [s] = await sql<{id: number}[]>`INSERT INTO stories (public_id,title,first_report_at,latest_at) VALUES (${id},'焦点对局',${at},${at}) RETURNING id`;
  return { id: s!.id, publicId: id };
}
async function report(o: {company?: string; title: string; category?: string; tags?: string[]; score?: number; factId?: number; published?: Date; timeline?: Date}) {
  const published = o.published ?? at;
  const timeline = o.timeline ?? published;
  const {articleId} = await upsertMaterial({sourceId: SOURCE,url:`https://example.com/topic-rules-${T}-${++serial}`,title:o.title,
    publishedAt:published,bodyText:'Supported report',bodyHtml:'<p>Supported report</p>',bodyStatus:'ok',via:'fetch'});
  await sql`UPDATE articles SET discovered_at=${timeline},timeline_at=${timeline},grouped_at=now() WHERE id=${articleId}`;
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected,subjects,tags)
    VALUES (${articleId},1,'rule','pass',${o.category ?? 'match-result'},${o.title},'新的消息',${o.score ?? 90},true,
    ${o.company ? [o.company] : []},${o.tags ?? ['赛果战报']})`;
  if (o.factId) await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${o.factId},${articleId},'report')`;
  await publishArticle(articleId,{releasedAt:new Date(timeline.getTime()+60000)});
  return articleId;
}
const page = async (slug: string) => {const p=await loadTopicPage(slug,1,new Date()); assert.ok(p); return p;};

test("tutorial, opinion and trend topics keep selected reading without manufacturing milestones or SEO highlights", async () => {
  for (const [slug, category, tag] of [['tactics','tactics','战术复盘'],['views','opinion','观点评论']] as const) {
    const id=await report({title:`高分内容 ${slug}`,category,tags:[tag!],score:99});
    const p=await page(slug!);
    assert.deepEqual(p.chronicle,[],slug);
    assert.deepEqual(p.highlights,[],`${slug}: search snippets use the same milestone rules`);
    assert.ok(p.items.some(r=>r.id===id));
  }
});

// A release can include a migration guide or benchmark result; those suffixes do not change its main action.
test("launches keep their milestones when the headline also mentions supporting guides or benchmarks", async () => {
  const launch = await report({company:'ag',title:'成都AG超玩会 3 比 1 战胜重庆狼队，附对局复盘与BP解析',score:87});
  const model = await report({company:'wolves',title:'重庆狼队 3 比 0 击败西安WE，常规赛领跑',score:79});
  const product = await report({company:'wolves',title:'重庆狼队公布季后赛大名单（附选手履历）',category:'roster',tags:['阵容转会'],score:76});
  const tutorial = await report({company:'ag',title:'王者荣耀新赛季野区战术教学指南',category:'tactics',tags:['战术复盘'],score:99});
  const view = await fact(null,'成都AG超玩会',null,'opinion');
  const opinion = await report({company:'ag',title:'成都AG超玩会主教练谈下一轮BP博弈思路',factId:view,category:'opinion',tags:['观点评论'],score:99});
  const ag=await page('ag');
  assert.deepEqual(ag.milestones.map(m=>m.href),[`/items/${launch}`]);
  assert.ok(ag.items.some(r=>r.id===tutorial)&&ag.items.some(r=>r.id===opinion));
  const wolves=await page('wolves');
  assert.deepEqual(new Set(wolves.milestones.map(m=>m.href)),new Set([model,product].map(id=>`/items/${id}`)));
});

test("event dates use an explicit occurrence, otherwise the earliest publication, and do not move with the stronger report", async () => {
  const month=beijingDate(now).slice(0,7);
  const boundary=new Date(`${month}-01T00:00:00+08:00`);
  const earlier=new Date(boundary.getTime()-40*86400000);
  const later=new Date(boundary.getTime()-2*86400000);
  const occurred=new Date(earlier.getTime()-86400000);
  for(const [company,useOccurrence,sameFact] of [['ag',true,false],['wolves',false,false],['estar',false,true]] as const) {
    const event=await story();
    const original=await fact(event.id,company,useOccurrence?occurred:null);
    const follow=sameFact ? original : await fact(event.id,company);
    const old=await report({company,title:`${company} 赛果简讯`,published:earlier,timeline:new Date(earlier.getTime()+3600000),factId:original,score:69});
    const stronger=await report({company,title:`${company} 官方全场比赛战报`,published:later,factId:follow,score:95});
    const p=await page(company);
    const entries=p.milestones.filter(m=>m.href===`/story/${event.publicId}`);
    assert.equal(entries.length,1);
    assert.equal(entries[0]!.date,beijingDate(useOccurrence?occurred:earlier));
    assert.ok(p.items.some(r=>r.id===stronger));
    if (sameFact) assert.ok(!p.items.some(r=>r.id===old),'the old fact representative no longer holds a selected seat');
    else assert.ok(p.items.some(r=>r.id===old));
  }
});

test("cached milestone eligibility follows current score, launch tag and fact subject corrections", async () => {
  assert.ok((await loadTopicPage('ksg',1))?.milestones.length);
  await sql`UPDATE analyses SET score=1 WHERE article_id=${cached}`;
  await publishArticle(cached,{releasedAt:at});
  assert.deepEqual((await loadTopicPage('ksg',1))?.milestones,[],'score changes apply without waiting for cached counts');
  await sql`UPDATE analyses SET score=90 WHERE article_id=${cached}`;
  await overrideFields(cached,{fields:{category:'opinion',tags:['观点评论','entity:ksg']},version:0,reason:'实际是观点'},'topic-rules');
  assert.deepEqual((await loadTopicPage('ksg',1))?.milestones,[],'the current launch tag is checked');
  await overrideFields(cached,{fields:{category:'match-result',tags:['赛果战报','entity:ksg']},version:1,reason:'恢复已核实赛果'},'topic-rules');
  await sql`UPDATE facts SET subject='重庆狼队' WHERE id=${cachedFact}`;
  assert.deepEqual((await loadTopicPage('ksg',1))?.milestones,[],'a known different action subject cannot remain a KSG milestone');
  assert.ok((await loadTopicPage('ksg',1))?.items.some(r=>r.id===cached),'chronicle rules do not remove the selected report');
});

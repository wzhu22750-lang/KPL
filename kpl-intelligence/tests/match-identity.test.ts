import { stub, tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql, closeDb } from '@aihot/backend/db';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { groupArticle } from '@aihot/backend/events/group';
import { conflictingMatchFacts, factMatchReports } from '@aihot/backend/events/match-identity';
import { inspectMatchGroups, repairMatchGroup } from '@aihot/backend/events/repair-match-groups';
import { publishArticle } from '@aihot/backend/publication/publish';
import { loadTimeline } from '@aihot/backend/publication/timeline';
import { stopBoss } from '@aihot/backend/jobs/queue';

const T = tag();
const source = `match-identity-${T}`;
// Deliberately wrong model: every candidate is the same occurrence. The hard guard must still win.
const provider = await stub((_n, req) => {
  const text = JSON.parse(req.body).messages[1].content;
  const ids = [...text.matchAll(/【候选 (C\d+)】/g)].map(m => m[1]);
  const answer = text.includes('【报道 A】')
    ? { a: '比赛', b: '比赛', relation: 'SAME_OCCURRENCE', confidence: 1, difference: '' }
    : { query: '比赛', decisions: ids.map(id => ({ id, relation: 'SAME_OCCURRENCE', confidence: 1, note: '' })), selection: { addsValue: true, reason: '测试新增信息' } };
  return { choices: [{ message: { content: JSON.stringify(answer) } }] };
});
for (const name of ['DEEPSEEK', 'XIAOMI_MIMO']) {
  process.env[`${name}_BASE_URL`] = `${provider.url}/v1`;
  process.env[`${name}_API_KEY`] = 'test-key';
}
process.env.DASHSCOPE_API_KEY = '';
before(async () => { await sql`INSERT INTO sources (id,name,kind,tier,participation_mode) VALUES (${source},'比赛测试','rss','T1','editorial')`; });
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

async function article(title: string, at: Date, score = 80) {
  const { articleId } = await upsertMaterial({ sourceId: source, title, url: `https://example.org/${T}/${randomUUID()}`, publishedAt: at, discoveredAt: at, bodyText: title, bodyStatus: 'ok', via: 'fetch' });
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected,output)
    VALUES (${articleId},1,'rule','pass','match-result',${title},${title},${score},true,${sql.json({ scope: 'single', fact: { title, subject: 'KPL', action: '对决' } })})`;
  await sql`UPDATE articles SET grouping_status='complete',grouped_at=now(),processing_state='analyzed',backfill=false,selection_adds_value=true WHERE id=${articleId}`;
  await publishArticle(articleId);
  return articleId;
}
async function fact(ids: string[]) {
  const [story] = await sql`INSERT INTO stories (public_id,title) VALUES (${randomUUID()},'比赛') RETURNING id`;
  const [f] = await sql`INSERT INTO facts (public_id,story_id,title) VALUES (${`f${tag()}`},${story!.id},'比赛') RETURNING id`;
  for (const [i,id] of ids.entries()) await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${f!.id},${id},${i === ids.length-1 ? 'primary' : 'report'})`;
  for (const id of ids) await publishArticle(id);
  return Number(f!.id);
}

test('all group members are checked even when the new representative matches the query', async () => {
  const at = new Date();
  const old = await article('2026年10月3日 北京JDG对阵上海EDG.M', at);
  const recent = await article('2026年10月7日 北京WB对阵上海EDG.M', at);
  const f = await fact([old,recent]);
  const conflicts = await conflictingMatchFacts({ title: '2026年10月7日 上海EDG.M 3:1战胜北京WB', at }, [f]);
  assert.equal(conflicts.has(f), true);
  const incoming = await article('2026年10月7日 上海EDG.M 3:1战胜北京WB', at);
  const grouped = await groupArticle(incoming);
  assert.notEqual(grouped.factId, f, 'wrong model/high similarity cannot override contradictory members');
  assert.equal((await sql`SELECT 1 FROM fact_articles WHERE article_id=${incoming} AND fact_id=${f}`).length, 0);
});

test('repair splits the October 3/7 group, rebuilds timeline and is idempotent', async () => {
  const oldAt = new Date('2026-10-03T10:16:43Z');
  const newAt = new Date('2026-10-07T11:25:04Z');
  const old = await article('2026KPL年度总决赛：10月3日北京JDG对阵上海EDG.M',oldAt,70);
  const recent = await article('2026KPL年度总决赛10月7日上海EDG.M 3:1战胜北京WB',newAt,90);
  const f = await fact([old,recent]);
  const now = new Date('2027-01-01');
  const before = await loadTimeline({now,limit:40,channel:"all",category:null,tag:null});
  assert.equal(before.cards.find(c => c.item.id===recent)?.anchorAt,oldAt.toISOString(), 'reproduce the actual wrong day');
  const plan = (await inspectMatchGroups()).find(p => p.id===f)!;
  assert.ok(plan);
  const result = await repairMatchGroup(f,plan.reports,'test');
  assert.equal(result.groups.length,2);
  const after = await loadTimeline({now,limit:40,channel:"all",category:null,tag:null});
  assert.equal(after.cards.find(c => c.item.id===recent)?.anchorAt,newAt.toISOString());
  assert.equal(after.cards.find(c => c.item.id===old)?.anchorAt,oldAt.toISOString());
  assert.equal((await inspectMatchGroups()).some(p=>result.groups.includes(p.id)||p.id===f),false);
  assert.equal((await repairMatchGroup(f,[],'test')).changed,false);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action='content.split-match-group' AND actor='test'`).length,1);
  assert.equal((await sql`SELECT 1 FROM articles WHERE id IN (${old},${recent})`).length,2,'no article deletion');
});

test('repair refuses stale plans and manual overrides without changing memberships', async () => {
  const at = new Date();
  const a = await article('2026年10月3日 KSG对阵RW侠',at);
  const b = await article('2026年10月7日 KSG对阵RW侠',at);
  const f = await fact([a,b]);
  const expected = await factMatchReports([f]);
  await sql`UPDATE fact_articles SET manual=true WHERE fact_id=${f} AND article_id=${a}`;
  await assert.rejects(repairMatchGroup(f,expected,'test'),/changed/);
  await assert.rejects(repairMatchGroup(f,await factMatchReports([f]),'test'),/Manual/);
  assert.equal((await factMatchReports([f])).length,2);
});

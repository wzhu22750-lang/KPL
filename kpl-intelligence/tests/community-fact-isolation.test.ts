import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { sql, closeDb } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { config } from '@aihot/backend/config';
import { loadAnalyzeInput, buildMaterial } from '@aihot/backend/editorial/input';
import { buildScoreInput, normalizeStructure, StructureSchema } from '@aihot/backend/editorial/analyze';
import { renderContext } from '@aihot/backend/editorial/writing';
import { rebuildArticleChunks } from '@aihot/backend/kb/chunks';
import { tag } from './setup.ts';
const source = `fact-isolation-${tag()}`;
const original = 'KPL 赛后主帖：本场双方争夺决胜局，原作者讨论 BP。';
const rumor = 'COMMENT_ONLY_SENTINEL：选手被禁赛，这是未经确认的评论传言。';
const canonical = { kind:'forum_thread',title:'赛后讨论',main:[],media:[],
  quality:{score:90,completeness:'full',flags:[]},extraction:{extractor:'hupu',provenance:'page_html'},
  discussion:{originalPost:{text:original,author:{name:'原作者'},media:[]},
    authorFollowups:[{text:rumor,author:{name:'原作者'},media:[]}],
    highlightedReplies:[{text:rumor,author:{name:'网友'},media:[]}],totalReplies:2},
};
let enabled:boolean;
before(async()=>{
  enabled=config.modelCallsEnabled;
  config.modelCallsEnabled=false;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${source},'Offline isolation fixture','web_list','T2','editorial','2100-01-01')`;
});
after(async()=>{config.modelCallsEnabled=enabled;await stopBoss();await closeDb();});
async function article(suffix:string, c:unknown=canonical) {
  const id=`${source}-${suffix}`;
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,content_hash,body_text,body_status,content_kind,content_quality_score,canonical_content,discovered_at,timeline_at)
    VALUES (${id},${source},${id},${`https://example.com/${id}`},'KPL 赛后讨论',${id},${original+'\n\n'+rumor},'ok','forum_thread',90,${c?sql.json(c as never):null},now(),now())`;
  return id;
}
test('editorial fact/score/writing inputs exclude even same-author replies and cached translations; stored evidence remains intact',async()=>{
  const id=await article('editorial');
  await sql`INSERT INTO translations (article_id,lang,revision,body_text) VALUES (${id},'zh',1,${rumor})`;
  const input=(await loadAnalyzeInput(id))!;
  assert.equal(input.bodyText,original);
  assert.equal(input.translationZh,null);
  for(const text of [buildMaterial(input),buildScoreInput(input),renderContext(input)]) {
    assert.ok(text.includes(original)); assert.ok(!text.includes('COMMENT_ONLY_SENTINEL'));
  }
  const structure=normalizeStructure(StructureSchema.parse({scope:'single',category:null,tags:[],subjects:[],fact:{title:'传言',evidence:rumor,conditions:[]}}),input);
  assert.equal(structure.fact?.evidence,null,'a model cannot ground a fact in excluded comments');
  const [stored]=await sql<{body_text:string}[]>`SELECT body_text FROM articles WHERE id=${id}`;
  assert.ok(stored!.body_text.includes(rumor),'do not destructively erase discussion history');
});
test('article RAG rebuild removes comment-contaminated chunks, keeps original, and is idempotent',async()=>{
  const id=await article('rag');
  await sql`INSERT INTO chunks (source_type,ref_id,ord,title,content,text_hash,token_count) VALUES ('article',${id},0,'old',${rumor},'old-fixture',20)`;
  assert.equal(await rebuildArticleChunks(id),1);
  assert.equal(await rebuildArticleChunks(id),1);
  const rows=await sql<{content:string}[]>`SELECT content FROM chunks WHERE source_type='article' AND ref_id=${id}`;
  assert.deepEqual(rows.map(r=>r.content),[original]);
});
test('legacy articles without canonical discussion are unchanged, even when their main text quotes a discussion marker',async()=>{
  const id=await article('legacy',null);
  assert.equal((await loadAnalyzeInput(id))!.bodyText,original+'\n\n'+rumor);
  await rebuildArticleChunks(id);
  const rows=await sql<{content:string}[]>`SELECT content FROM chunks WHERE source_type='article' AND ref_id=${id}`;
  assert.ok(rows.map(r=>r.content).join('\n').includes(rumor));
});

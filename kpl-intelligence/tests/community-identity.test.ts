import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { sql, closeDb } from '@aihot/backend/db';
import { upsertMaterial, contentHash } from '@aihot/backend/content/materials';
import { canonicalToBody, canonicalIdentityText } from '@aihot/backend/content/canonical';
import { extractCanonical, profileFor } from '@aihot/backend/content/extractors/index';
after(closeDb);

test('persisted listing replay and legacy hash upgrade never turn collected comments into main edits', async () => {
  const sourceId = `community-identity-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${sourceId},'Offline shape fixture','json_list','T2','hot_signal')`;
  const url = 'https://bbs.hupu.com/642828440.html';
  const got = await extractCanonical({ url, html: readFileSync(new URL('./fixtures/content/hupu-thread-live-verified.html',import.meta.url),'utf8'),
    profile: profileFor({url}), sourceId, sourceKind:'json_list',title:'',excerpt:null,author:null,publishedAt:null,xPost:null,raw:null,sourceConfig:null,fetchJson:null });
  assert.ok(got);
  const input = { sourceId,url,title:got.content.title!,canonical:got.content,via:'fetch' as const };
  const first = await upsertMaterial(input);
  await sql`UPDATE articles SET processing_state='skipped' WHERE id=${first.articleId}`;
  const replay = await upsertMaterial({sourceId,url,title:input.title,via:'fetch',engagementObservation:{platform:'hupu',observedAt:new Date(),method:'page_dom',metrics:{comments:800}}});
  assert.equal(replay.revised,false);
  const legacyHash = contentHash({title:input.title,bodyText:canonicalToBody(got.content).text});
  await sql`UPDATE articles SET content_hash=${legacyHash} WHERE id=${first.articleId}`;
  assert.equal((await upsertMaterial({sourceId,url,title:input.title,via:'fetch'})).revised,false);
  const [row] = await sql`SELECT revision,content_hash,processing_state FROM articles WHERE id=${first.articleId}`;
  assert.equal(row!.revision,1);
  assert.equal(row!.processing_state,'skipped');
  assert.equal(row!.content_hash,contentHash({title:input.title,bodyText:canonicalIdentityText(got.content)}));
  assert.equal((await sql`SELECT 1 FROM article_revisions WHERE article_id=${first.articleId}`).length,1);
});

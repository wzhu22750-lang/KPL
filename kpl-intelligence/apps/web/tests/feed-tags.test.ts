import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedTopicTags } from '../app/features/feed/tags.ts';
import { readFilters, filterParams, listPath } from '../app/lib/seo.ts';

test('publisher claims never become topic chips and category chips are not repeated',()=>{
  const tags=[' 官方 ','战队官方','二路','赛果战报','赛果','年度总决赛','年度总决赛','成都AG超玩会','entity:ag','MVP'];
  assert.deepEqual(feedTopicTags(tags,'match-result'),['年度总决赛','成都AG超玩会','MVP']);
  assert.equal(tags[0],' 官方 ','source data is not mutated');
});

test('article topics do not choose publisher identity',()=>{
  assert.equal(readFilters(new URLSearchParams('tag=官方&category=match-result')).sourceGroup,null);
  assert.equal(readFilters(new URLSearchParams('sourceGroup=bad')).sourceGroup,null);
  const filters=readFilters(new URLSearchParams('sourceGroup=caster&tag=年度总决赛&category=opinion'));
  assert.equal(filters.sourceGroup,'caster');
  assert.equal(filters.category,'opinion');
  const url=new URL(listPath('/all',filterParams(filters)),'http://site.local');
  assert.equal(url.searchParams.get('sourceGroup'),'caster');
  assert.equal(url.searchParams.get('tag'),'年度总决赛');
});

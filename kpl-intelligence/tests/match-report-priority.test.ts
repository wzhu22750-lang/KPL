import './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeDb, sql } from '@aihot/backend/db';
import { pickRepresentative, representativePriority, REPRESENTATIVE_COLUMNS } from '@aihot/backend/publication/representative';

after(closeDb);
const replay = { id: 'bili-replay', source_tier: 'T1', body_mode: 'full' as const, score: 99, timeline_at: new Date('2026-10-01'), preferred_match_report: false };

test('league Weibo report leads a grouped result even when replay is longer and higher scoring', () => {
  const report = { ...replay, id: 'weibo-report', body_mode: 'summary' as const, score: 60, timeline_at: new Date('2026-10-02'), preferred_match_report: true };
  assert.equal(pickRepresentative([replay, report]), report);
  assert.equal(pickRepresentative([report, replay]), report);
  assert.equal(representativePriority(report), -1);
});

test('missing preference preserves existing ranking and does not manufacture a report', () => {
  assert.equal(pickRepresentative([replay]), replay);
  assert.equal(representativePriority({ source_tier: 'T1' }), 0);
  assert.equal(representativePriority({ source_tier: 'T2', preferred_match_report: false }), 3);
});

test('SQL preference requires league UID, ownership, Weibo and a result fact', async () => {
  for (const change of [
    {}, { uid: '5698023579' }, { kind: 'json_list' }, { owner: 'club' },
    { entity: 'other' }, { claim: 'analysis' }, { claim: null },
  ]) {
    const input = { uid: '6074356560', kind: 'weibo', owner: 'league', entity: 'kpl', claim: 'match_result', ...change };
    const [row] = await sql`WITH s AS (
      SELECT 'T1'::text AS tier, ${sql.json({ uid: input.uid })}::jsonb AS config,
        ${input.kind}::text AS kind, ${input.owner}::text AS owner_type, ${input.entity}::text AS owner_entity_id
    ), f AS (SELECT ${input.claim}::text AS claim_type, 'AG vs 狼队'::text AS subject)
    SELECT ${REPRESENTATIVE_COLUMNS} FROM s CROSS JOIN f`;
    assert.equal(row!.preferred_match_report === true, Object.keys(change).length === 0, JSON.stringify(change));
  }
});

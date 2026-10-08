// Explicit bounded backfill/review. Default is read-only; --apply only enqueues jobs, never calls models here.
import { parseArgs } from 'node:util';
import { RADAR } from '@aihot/industry/radar';
import { closeDb, sql } from '@aihot/backend/db';
import { queueRadar } from '@aihot/backend/jobs/radar';
import { stopBoss } from '@aihot/backend/jobs/queue';

const { values } = parseArgs({ options: { apply:{type:'boolean',default:false}, article:{type:'string',multiple:true}, limit:{type:'string',default:'20'}, help:{type:'boolean',default:false} } });
if (values.help) console.log('node scripts/review-radar.ts [--article ID ...] [--limit 20] [--apply]\nDefault: preview up to 100 recent unreviewed/failed materials. --apply enqueues receipt/budget-protected model work. Set DATABASE_URL explicitly.');
else {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL explicitly');
  if (values.apply && !RADAR.enabled) throw new Error('Radar rollout is disabled; calibrate and enable industry/radar.ts before enqueueing paid review work');
  const limit=Number(values.limit);
  if (!Number.isInteger(limit)||limit<1||limit>100) throw new Error('limit must be 1–100');
  try {
    const rows=await sql<{id:string;title:string;revision:number}[]>`SELECT a.id,a.title,a.revision,r.state AS old_state,r.score_version AS old_version,r.base_score AS old_base,
      r.official_bonus AS old_official,r.noise AS old_noise FROM articles a JOIN sources s ON s.id=a.source_id
      LEFT JOIN radar_materials r ON r.article_id=a.id LEFT JOIN radar_failures f ON f.article_id=a.id
      WHERE s.enabled AND s.participation_mode<>'isolated'
        AND ${values.article?.length ? sql`a.id IN ${sql(values.article)}` : sql`a.discovered_at > now()-interval '7 days' AND (r.article_id IS NULL OR r.input_revision<>a.revision OR r.score_version<>${RADAR.version} OR f.article_id IS NOT NULL)`}
      ORDER BY a.discovered_at DESC LIMIT ${limit}`;
    if (values.apply) for (const row of rows) await queueRadar(row.id);
    console.log(JSON.stringify({ applied:values.apply, count:rows.length, rows },null,2));
  } finally { await stopBoss(); await closeDb(); }
}

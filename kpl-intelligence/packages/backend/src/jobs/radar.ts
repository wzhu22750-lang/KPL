import type { PgBoss } from 'pg-boss';
import { RADAR } from '@aihot/industry/radar';
import { enqueue, QUEUES, work } from './queue.ts';
import { assessRadar } from '../editorial/radar.ts';
import type { Db } from '../db.ts';

export async function queueRadar(articleId: string, db?: Db) {
  if (RADAR.enabled) await enqueue(QUEUES.radar,{ articleId },{ singletonKey: articleId }, db);
}
export async function registerRadarJobs(boss: PgBoss) {
  if (!RADAR.enabled) return;
  await work(boss,QUEUES.radar,{ localConcurrency: 2, pollingIntervalSeconds: 3 },({ articleId }) => assessRadar(articleId));
}

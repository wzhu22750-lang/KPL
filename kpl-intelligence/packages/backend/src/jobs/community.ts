// Job definitions and registration for community comments refresh.
// Enforces global opt-in, source-level opt-in, and pg-boss queue serialization.
import type { PgBoss } from "pg-boss";
import {
  isCommunityCollectionEnabled,
  refreshArticleCommunity,
  sweepCommunityRefresh as runSweep,
  type RefreshArticleOptions,
  type SweepCommunityOptions,
  type SweepCommunityResult,
} from "../content/community-refresh.ts";
import { sql, type Db } from "../db.ts";
import { enqueue, QUEUES, work } from "./queue.ts";

/**
 * Enqueues a community refresh job for the given article ID into pg-boss.
 * Deduplicated by singletonKey per article.
 */
export async function queueCommunityRefresh(
  articleId: string,
  sourceId?: string,
  options: { force?: boolean; tx?: Db } = {},
): Promise<string | null> {
  // Global safety valve: force must NEVER bypass global disabled state
  if (!isCommunityCollectionEnabled()) {
    return null;
  }

  if (sourceId) {
    const db = options.tx ?? sql;
    const [source] = await db<{ enabled: boolean; participation_mode: string; config: any }[]>`
      SELECT enabled, participation_mode, config FROM sources WHERE id = ${sourceId}
    `;
    if (source) {
      const communityCfg = source.config?.communityComments;
      if (!source.enabled || source.participation_mode === "isolated" || communityCfg?.enabled !== true) {
        return null;
      }
    }
  }

  return enqueue(
    QUEUES.community,
    { articleId, sourceId, force: options.force },
    { singletonKey: `community:${articleId}` },
    options.tx,
  );
}

/**
 * Sweeps candidate articles for community refresh and enqueues them.
 * Scheduled via cron in worker/schedules.ts.
 */
export async function sweepCommunityRefresh(
  options: SweepCommunityOptions = {},
): Promise<SweepCommunityResult> {
  return runSweep({
    ...options,
    enqueueFn: options.enqueueFn ?? ((articleId, sourceId) => queueCommunityRefresh(articleId, sourceId)),
  });
}

/**
 * Registers pg-boss worker handlers for the content.community queue.
 * Each job independently refreshes an article with cursor failure isolation.
 */
export async function registerCommunityJobs(boss: PgBoss): Promise<void> {
  await work(boss, QUEUES.community, { localConcurrency: 1, pollingIntervalSeconds: 2 }, async (data) => {
    await refreshArticleCommunity(data.articleId, {
      sourceId: data.sourceId,
      force: data.force,
    });
  });
}

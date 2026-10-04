// 管理后台：采集监控与流转漏斗数据加载
import { sql } from "../db.ts";
import type { AdminFunnelDashboard } from "@aihot/contracts/admin";

export async function loadAdminFunnel(): Promise<AdminFunnelDashboard> {
  const [funnel] = await sql<{
    total_articles: string;
    blocked_garbage: string;
    low_quality_discarded: string;
    curated_published: string;
  }[]>`
    SELECT
      (SELECT count(*) FROM articles) AS total_articles,
      (SELECT count(DISTINCT article_id) FROM analyses WHERE relevance = 'block') AS blocked_garbage,
      (SELECT count(DISTINCT article_id) FROM analyses WHERE relevance <> 'block' AND selected = false) AS low_quality_discarded,
      (SELECT count(*) FROM publications WHERE selected = true) AS curated_published
  `;

  const sources = await sql<{
    id: string;
    name: string;
    tier: string;
    kind: string;
    enabled: boolean;
    interval_minutes: number;
    last_fetch_at: Date | null;
    fail_count: number;
    last_error: string | null;
    total_articles: string;
    recent_articles: string;
  }[]>`
    SELECT 
      s.id, s.name, s.tier, s.kind, s.enabled, s.interval_minutes, 
      s.last_fetch_at, s.fail_count, s.last_error,
      count(a.id) AS total_articles,
      count(a.id) FILTER (WHERE a.created_at >= now() - interval '24 hours') AS recent_articles
    FROM sources s
    LEFT JOIN articles a ON a.source_id = s.id
    GROUP BY s.id, s.name, s.tier, s.kind, s.enabled, s.interval_minutes, s.last_fetch_at, s.fail_count, s.last_error
    ORDER BY s.enabled DESC, count(a.id) DESC
  `;

  return {
    funnel: {
      totalArticles: Number(funnel?.total_articles ?? 0),
      blockedGarbage: Number(funnel?.blocked_garbage ?? 0),
      lowQualityDiscarded: Number(funnel?.low_quality_discarded ?? 0),
      curatedPublished: Number(funnel?.curated_published ?? 0),
    },
    sourcesHealth: sources.map((s) => ({
      id: s.id,
      name: s.name,
      tier: s.tier,
      kind: s.kind,
      enabled: s.enabled,
      intervalMinutes: Number(s.interval_minutes),
      lastFetchAt: s.last_fetch_at ? s.last_fetch_at.toISOString() : null,
      failCount: Number(s.fail_count),
      lastError: s.last_error,
      totalArticles: Number(s.total_articles),
      recentArticles: Number(s.recent_articles),
    })),
  };
}

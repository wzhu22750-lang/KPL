// One public read layer for the new projection. No model calls on reads; stale revisions,
// isolated/disabled sources and explicit editorial withdrawals never enter the radar surface.
import { sql } from '../db.ts';
import { RADAR } from '@aihot/industry/radar';
import type { RadarMaterial, RadarMatch, RadarResponse, RadarTopic } from '@aihot/contracts/radar';
import { beijingDate, beijingMidnight } from '@aihot/contracts/time';
import { radarScore, chooseRadarMix, type RadarJudgmentData } from '../editorial/radar-score.ts';
import { loadMatchCards } from './match-overview.ts';

export async function loadRadar(day = beijingDate(new Date()), matchId?: string, options: { current?: boolean; now?: Date } = {}): Promise<RadarResponse> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(+new Date(day)) || beijingDate(beijingMidnight(day)) !== day) throw new Error('invalid radar day');
  const current = options.current === true && !matchId;
  const now = options.now ?? new Date();
  // Current focus is a rolling window, independent of the dates of the scorecards below it.
  const start = current ? new Date(now.getTime() - 7 * 86400000) : beijingMidnight(day);
  const end = current ? now : new Date(start.getTime() + 86400000);
  const matches = await loadMatchCards({ day, matchId, current, now });
  const rows = await sql<{ article_id: string; title: string; summary: string; kind: RadarMaterial['kind']; claim_status: RadarMaterial['claimStatus'];
    stance: string | null; evidence: string[]; judgment: RadarJudgmentData; official_bonus: number; reason: string; match_id: string | null;
    game_no: number | null; topic_id: number | null; published_at: Date | null; source_name: string; source_id: string; url: string;
    site_fulltext: boolean; official: boolean; topic_title: string | null; topic_updated_at: Date | null; topic_key: string | null }[]>`
    SELECT r.*,a.published_at,a.url,s.name AS source_name,s.id AS source_id,s.site_fulltext,
      (s.owner_type IN ('league','club') AND EXISTS (SELECT 1 FROM entity_accounts ea WHERE ea.source_id=s.id AND ea.official_verified AND ea.active)) AS official,
      t.title AS topic_title,t.last_development_at AS topic_updated_at,t.topic_key
    FROM radar_materials r JOIN articles a ON a.id=r.article_id JOIN sources s ON s.id=a.source_id
    LEFT JOIN radar_topics t ON t.id=r.topic_id LEFT JOIN editorial_overrides eo ON eo.article_id=a.id
    WHERE r.state='accepted' AND r.input_revision=a.revision AND r.score_version=${RADAR.version} AND s.enabled AND s.participation_mode <> 'isolated'
      AND coalesce(eo.visibility,'public') NOT IN ('withdrawn','summary-only')
      AND ${matchId ? sql`r.match_id=${matchId}` : sql`((coalesce(a.published_at,a.discovered_at) >= ${start} AND coalesce(a.published_at,a.discovered_at) < ${end})
        OR r.match_id IN ${matches.length ? sql(matches.map(m=>m.id)) : sql`(SELECT id FROM matches WHERE false)`}
        OR (t.last_development_at >= ${start} AND t.last_development_at < ${end}))`}
    ORDER BY coalesce(a.published_at,a.discovered_at) ASC,a.id ${matchId || current ? sql`` : sql`LIMIT 300`}`;
  const ids = rows.map(r=>r.article_id);
  const observations = ids.length ? await sql<{ article_id: string; source_id: string; platform: string; observed_at: Date; metrics: any; n: number }[]>`
    SELECT * FROM (SELECT article_id,source_id,platform,observed_at,metrics,
      row_number() OVER(PARTITION BY article_id,source_id,platform ORDER BY observed_at DESC,id DESC) AS n
      FROM engagement_observations WHERE article_id IN ${sql(ids)}) ranked WHERE n <= 2` : [];
  const materials: RadarMaterial[] = rows.map(r=> {
    const snapshots = observations.filter(o=>o.article_id===r.article_id && o.source_id===r.source_id);
    const last = snapshots.find(o=>Number(o.n)===1), prev = snapshots.find(o=>Number(o.n)===2 && o.platform===last?.platform);
    const score = radarScore(r.judgment,r.official,
      last ? {platform:last.platform,observedAt:last.observed_at,metrics:last.metrics} : undefined,
      prev ? {platform:prev.platform,observedAt:prev.observed_at,metrics:prev.metrics} : undefined);
    return { id:r.article_id,title:r.title,summary:r.summary,source:r.source_name,url:r.url,publishedAt:r.published_at?.toISOString() ?? null,
      kind:r.kind,score,claimStatus:r.claim_status,stance:r.stance,evidence:r.site_fulltext ? r.evidence : [],matchId:r.match_id,gameNo:r.game_no };
  });
  // Exact same text/origin URL cannot create extra cards. Different angles remain within one parent.
  const unique = materials.filter((m,i)=>materials.findIndex(x=>x.url===m.url)===i);
  const byMatch: RadarMatch[] = matches.map(m=> ({...m, materials:unique.filter(x=>x.matchId===m.id).sort((a,b)=>(a.gameNo??99)-(b.gameNo??99))}));
  const topics: RadarTopic[] = [...new Set(rows.flatMap(r=>r.topic_id ? [Number(r.topic_id)] : []))].map(id=> {
    const topicRows = rows.filter(r=>Number(r.topic_id)===id);
    const first=topicRows[0]!;
    const items=unique.filter(m=>topicRows.some(r=>r.article_id===m.id));
    return {id,title:first.topic_title ?? first.title,updatedAt:first.topic_updated_at!.toISOString(),
      score:Math.max(...items.map(m=>m.score.total)),materials:items};
  }).filter(t=>t.materials.length>0 && (!current || (Date.parse(t.updatedAt)>=start.getTime() && Date.parse(t.updatedAt)<end.getTime())))
    .sort((a,b)=>b.score-a.score || Date.parse(b.updatedAt)-Date.parse(a.updatedAt) || a.id-b.id);
  const standalone = chooseRadarMix(unique.filter(m=>!m.matchId && !rows.find(r=>r.article_id===m.id)?.topic_id).map(m=>({...m, scoreNumber:m.score.total})).map(m=>({ kind:m.kind,score:m.scoreNumber,material:m })),20).map(r=>r.material);
  const [counts] = await sql`SELECT count(*) FILTER(WHERE r.article_id IS NOT NULL) AS reviewed,
    count(*) FILTER(WHERE r.article_id IS NULL OR r.input_revision<>a.revision) AS pending FROM articles a
    JOIN sources s ON s.id=a.source_id LEFT JOIN radar_materials r ON r.article_id=a.id
    WHERE s.enabled AND s.participation_mode<>'isolated' AND a.discovered_at>=${start} AND a.discovered_at<${end}`;
  return {day,matches:byMatch,topics:topics.slice(0,20),standalone,
    coverage:{reviewed:Number(counts?.reviewed??0),pending:Number(counts?.pending??0),note:'热度是观测信号，不代表事实成立；未知指标不作零互动。局次待确认的材料单列。'}};
}

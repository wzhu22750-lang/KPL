// Canonical schedule and scores are public independently of experimental editorial projections.
import { sql } from '../db.ts';
import { beijingDate, beijingMidnight } from '@aihot/contracts/time';
import type { MatchOverviewResponse, RadarMatch } from '@aihot/contracts/radar';

export async function loadMatchCards(options: { day?: string; matchId?: string; current?: boolean; now?: Date } = {}): Promise<RadarMatch[]> {
  const now = options.now ?? new Date();
  const start = beijingMidnight(options.day ?? beijingDate(now));
  const end = new Date(start.getTime() + 86400000);
  const { matchId, current } = options;
  const matches = await sql<{ id: string; title: string; bo: number | null; status: string; scheduled_at: Date | null; score_a: number; score_b: number;
    a_slug: string; a_name: string; a_short: string | null; a_logo: string | null;
    b_slug: string; b_name: string; b_short: string | null; b_logo: string | null }[]>`
    SELECT m.id,concat(ta.name,' vs ',tb.name) AS title,m.bo,m.status,m.scheduled_at,m.score_a,m.score_b,
      ta.slug AS a_slug,ta.name AS a_name,ta.short_name AS a_short,ta.logo_url AS a_logo,
      tb.slug AS b_slug,tb.name AS b_name,tb.short_name AS b_short,tb.logo_url AS b_logo
    FROM matches m JOIN teams ta ON ta.id=m.team_a_id JOIN teams tb ON tb.id=m.team_b_id
    WHERE ${matchId ? sql`m.id=${matchId}` : current ? sql`m.id IN (
      (SELECT id FROM matches WHERE status='live' ORDER BY scheduled_at DESC NULLS LAST,id LIMIT 3)
      UNION (SELECT id FROM matches WHERE status IN ('scheduled','postponed') AND scheduled_at>=${now} ORDER BY scheduled_at,id LIMIT 2)
      UNION (SELECT id FROM matches WHERE status='finished' AND coalesce(played_at,scheduled_at)<=${now} ORDER BY coalesce(played_at,scheduled_at) DESC,id LIMIT 3)
    )` : sql`coalesce(m.scheduled_at,m.played_at) >= ${start} AND coalesce(m.scheduled_at,m.played_at) < ${end}`}
    ORDER BY ${current ? sql`CASE WHEN m.status='live' THEN 0 WHEN m.status IN ('scheduled','postponed') THEN 1 ELSE 2 END,
      CASE WHEN m.status='finished' THEN coalesce(m.played_at,m.scheduled_at) END DESC,` : sql``} m.scheduled_at NULLS LAST,m.id`;
  const games = matches.length ? await sql<{ match_id: string; game_no: number; winner: string | null; mvp: string | null }[]>`
    SELECT g.match_id,g.game_no,t.name AS winner,p.nickname AS mvp FROM games g
    LEFT JOIN teams t ON t.id=g.winner_id LEFT JOIN players p ON p.id=g.mvp_player_id
    WHERE g.match_id IN ${sql(matches.map(m=>m.id))} ORDER BY g.game_no` : [];
  return matches.map(m=> ({ id:m.id,title:m.title,bo:m.bo,status:m.status,scheduledAt:m.scheduled_at?.toISOString() ?? null,
    home:{slug:m.a_slug,name:m.a_name,shortName:m.a_short,logo:m.a_logo},away:{slug:m.b_slug,name:m.b_name,shortName:m.b_short,logo:m.b_logo},
    homeScore:m.score_a,awayScore:m.score_b,materials:[],
    games:games.filter(g=>g.match_id===m.id).map(g=>({gameNo:g.game_no,winner:g.winner,mvp:g.mvp})) }));
}

export async function loadCurrentMatchOverview(now = new Date()): Promise<MatchOverviewResponse> {
  return { matches: await loadMatchCards({ current: true, now }) };
}

// KPL 知识库的公开读取函数：网站 API（apps/api site 路由）读这里。
// 全部参数绑定；只读 kb 表，不碰 articles/publications（新闻侧走 publication/ 的读取层）。
import { sql } from "../db.ts";
import type {
  AvailableSeason,
  BpStep,
  GameDetail,
  GamePlayerRow,
  H2HResponse,
  HeroDetailResponse,
  HeroListItem,
  HeroListResponse,
  MatchBattleVideoItem,
  MatchDetailResponse,
  MatchSummary,
  PlayerHeroStat,
  PlayerSeasonStat,
  ScheduleMatch,
  ScheduleResponse,
  SeasonSummary,
  StandingRow,
  StandingsResponse,
  TeamSummary,
} from "@aihot/contracts/kpl";
import { cached, cachedByKey } from "../lib/cache.ts";
import { standingsRules } from "@aihot/industry/standings";
import { calculateStandings, validStandingResult, type StandingsMatch } from "./standings.ts";

interface MatchRowRaw {
  id: string; season_id: string; season_name: string; stage: string | null; bo: number | null; status: string;
  scheduled_at: Date | null; played_at: Date | null; games_expected: number | null; games_count: number;
  score_a: number; score_b: number; winner_id: string | null; cc_key: string | null;
  team_a_id: string; team_b_id: string;
  a_slug: string; a_name: string; a_short: string | null; a_logo: string | null;
  b_slug: string; b_name: string; b_short: string | null; b_logo: string | null;
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

function toScheduleMatch(r: MatchRowRaw): ScheduleMatch {
  return {
    id: r.id, seasonId: r.season_id, seasonName: r.season_name, stage: r.stage, bo: r.bo,
    status: r.status as ScheduleMatch["status"], scheduledAt: iso(r.scheduled_at), playedAt: iso(r.played_at),
    gamesExpected: r.games_expected, gamesCount: Number(r.games_count),
    home: { slug: r.a_slug, name: r.a_name, shortName: r.a_short, logo: r.a_logo, score: r.score_a },
    away: { slug: r.b_slug, name: r.b_name, shortName: r.b_short, logo: r.b_logo, score: r.score_b },
    winner: r.winner_id, ccKey: r.cc_key,
  };
}

function toMatchSummary(r: MatchRowRaw): MatchSummary {
  return {
    id: r.id,
    seasonId: r.season_id,
    seasonName: r.season_name,
    stage: r.stage,
    bo: r.bo,
    status: r.status,
    scheduledAt: iso(r.scheduled_at),
    playedAt: iso(r.played_at),
    home: {
      slug: r.a_slug,
      name: r.a_name,
      shortName: r.a_short,
      logo: r.a_logo,
      score: r.score_a,
    },
    away: {
      slug: r.b_slug,
      name: r.b_name,
      shortName: r.b_short,
      logo: r.b_logo,
      score: r.score_b,
    },
    winner: r.winner_id,
  };
}

const MATCH_SELECT = sql`
  SELECT m.id, m.season_id, s.name AS season_name, m.stage, m.bo, m.status, m.scheduled_at, m.played_at,
         m.games_expected, (SELECT count(*) FROM games g WHERE g.match_id = m.id) AS games_count,
         m.score_a, m.score_b, m.winner_id, m.cc_key,
         m.team_a_id, m.team_b_id,
         ta.slug AS a_slug, ta.name AS a_name, ta.short_name AS a_short, ta.logo_url AS a_logo,
         tb.slug AS b_slug, tb.name AS b_name, tb.short_name AS b_short, tb.logo_url AS b_logo
  FROM matches m
  JOIN teams ta ON ta.id = m.team_a_id
  JOIN teams tb ON tb.id = m.team_b_id
  JOIN seasons s ON s.id = m.season_id`;

/** 最新一个有比赛的赛季（按最近比赛日期，而非 id 字母序）：页面默认展示它。 */
export async function latestSeason(): Promise<{ id: string; name: string } | null> {
  const [row] = await sql<{ id: string; name: string }[]>`
    SELECT s.id, s.name FROM seasons s
    WHERE EXISTS (SELECT 1 FROM matches m WHERE m.season_id = s.id)
    ORDER BY (SELECT max(coalesce(m.played_at, m.scheduled_at)) FROM matches m WHERE m.season_id = s.id) DESC
    LIMIT 1`;
  return row ?? null;
}

/** 所有有比赛的赛季列表（按最近比赛日期倒序排序） */
const cachedAvailableSeasons = cached(async () => {
  const rows = await sql<{ id: string; name: string; year: number; external_id: string }[]>`
    SELECT s.id, s.name, s.year, s.external_id
    FROM seasons s
    WHERE EXISTS (SELECT 1 FROM matches m WHERE m.season_id = s.id)
    ORDER BY (SELECT max(coalesce(m.played_at, m.scheduled_at)) FROM matches m WHERE m.season_id = s.id) DESC, s.year DESC`;
  const latestId = rows[0]?.id;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    year: Number(r.year),
    externalId: r.external_id,
    isCurrent: r.id === latestId,
  }));
}, { freshMs: 30 * 60_000, maxStaleMs: 120 * 60_000 });

export async function listAvailableSeasons(): Promise<AvailableSeason[]> {
  return cachedAvailableSeasons.get();
}

async function fetchScheduleRaw(opts: { season?: string | null; team?: string | null; upcoming?: boolean; limit?: number }): Promise<ScheduleResponse> {
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 300);
  const availableSeasons = await listAvailableSeasons();
  const currentSeason = availableSeasons[0] ?? null;

  let season: { id: string; name: string } | null = null;
  if (opts.season) {
    const matched = availableSeasons.find((s) => s.id === opts.season || s.externalId === opts.season);
    if (matched) {
      season = { id: matched.id, name: matched.name };
    } else {
      const [dbSeason] = await sql<{ id: string; name: string }[]>`SELECT id, name FROM seasons WHERE id = ${opts.season} OR external_id = ${opts.season} LIMIT 1`;
      season = dbSeason ?? (currentSeason ? { id: currentSeason.id, name: currentSeason.name } : null);
    }
  } else {
    season = currentSeason ? { id: currentSeason.id, name: currentSeason.name } : null;
  }

  if (!season) return { season: null, availableSeasons, matches: [] };

  const rows = await sql<MatchRowRaw[]>`
    ${MATCH_SELECT}
    WHERE m.season_id = ${season.id}
      ${opts.team ? sql`AND (ta.slug = ${opts.team} OR tb.slug = ${opts.team})` : sql``}
      ${opts.upcoming ? sql`AND m.status = 'scheduled'` : sql``}
    ORDER BY m.played_at DESC NULLS LAST, m.scheduled_at DESC NULLS LAST
    LIMIT ${limit}`;

  return { season, availableSeasons, matches: rows.map(toScheduleMatch) };
}

const cachedSchedule = cachedByKey<string, ScheduleResponse>(
  (key) => key,
  (key) => {
    const [season, team, upcoming, limit] = key.split("::");
    return fetchScheduleRaw({
      season: season || undefined,
      team: team || undefined,
      upcoming: upcoming === "1",
      limit: limit ? Number(limit) : undefined,
    });
  },
  { freshMs: 2 * 60_000, maxStaleMs: 15 * 60_000, maxKeys: 40 }
);

export async function loadSchedule(opts: { season?: string | null; team?: string | null; upcoming?: boolean; limit?: number }): Promise<ScheduleResponse> {
  return cachedSchedule(`${opts.season ?? ""}::${opts.team ?? ""}::${opts.upcoming ? "1" : "0"}::${opts.limit ?? 60}`);
}

/** 首页的“今日赛事”：有临近赛程时显示未来的比赛；休赛期回退到最近已赛的比赛。 */
export async function loadUpcomingAndRecent(limit = 8): Promise<ScheduleMatch[]> {
  const upcoming = await sql<MatchRowRaw[]>`
    ${MATCH_SELECT}
    WHERE m.status IN ('scheduled', 'live') AND m.scheduled_at > now() - interval '12 hours'
    ORDER BY m.scheduled_at ASC LIMIT ${limit}`;
  if (upcoming.length > 0) return upcoming.map(toScheduleMatch);
  const recent = await sql<MatchRowRaw[]>`
    ${MATCH_SELECT}
    WHERE m.status = 'finished'
    ORDER BY m.played_at DESC NULLS LAST LIMIT ${limit}`;
  return recent.map(toScheduleMatch);
}

/** 首页聚合：近期比赛 + 头部战队。 */
export async function loadKbHome(limit = 6) {
  const [matches, teams] = await Promise.all([loadUpcomingAndRecent(limit), listTeams()]);
  return { matches, teams: teams.filter((t) => t.isActive).slice(0, 10) };
}

const cachedTeams = cached(async () => {
  const rows = await sql<{ slug: string; name: string; short_name: string | null; logo_url: string | null; city: string | null; is_active: boolean; champions: number }[]>`
    SELECT t.slug, t.name, t.short_name, t.logo_url, t.city, t.is_active,
      (SELECT count(*) FROM team_honors h WHERE h.team_id = t.id AND h.kind = 'champion') AS champions
    FROM teams t ORDER BY t.sort_weight DESC, t.is_active DESC, t.name`;
  return rows.map((r) => ({ slug: r.slug, name: r.name, shortName: r.short_name, logo: r.logo_url, city: r.city, isActive: r.is_active, champions: Number(r.champions) }));
}, { freshMs: 30 * 60_000, maxStaleMs: 120 * 60_000 });

export async function listTeams(): Promise<Array<{ slug: string; name: string; shortName: string | null; logo: string | null; city: string | null; isActive: boolean; champions: number }>> {
  return cachedTeams.get();
}

/** 实体详情页的“相关动态”：entity_mentions 桥联出来的最近新闻（有分析结果的）。 */
export async function loadEntityNews(entityType: "team" | "player" | "hero", entityId: string, limit = 10) {
  const rows = await sql<{ id: string; title: string; summary: string | null; published_at: Date | null; selected: boolean | null; content_kind: string | null }[]>`
    SELECT a.id,
      coalesce(nullif(an.title_zh, ''), a.title) AS title,
      coalesce(nullif(an.summary_zh, ''), a.excerpt) AS summary,
      a.published_at, an.selected, a.content_kind
    FROM entity_mentions em
    JOIN articles a ON a.id = em.article_id
    LEFT JOIN analyses an ON an.article_id = a.id AND an.id = (SELECT max(id) FROM analyses WHERE article_id = a.id)
    WHERE em.entity_type = ${entityType} AND em.entity_id = ${entityId}
      AND (an.relevance IS NULL OR an.relevance <> 'block')
    ORDER BY coalesce(a.published_at, a.discovered_at) DESC NULLS LAST
    LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    summary: r.summary,
    publishedAt: r.published_at?.toISOString() ?? null,
    selected: r.selected ?? false,
    kind: r.content_kind ?? null,
  }));
}

async function fetchTeamDetailRaw(slug: string) {
  const [team] = await sql<{ id: string; slug: string; name: string; short_name: string | null; logo_url: string | null; city: string | null; founded_at: string | null; history_names: string[] | null; style_notes: string | null; is_active: boolean }[]>`
    SELECT id, slug, name, short_name, logo_url, city, founded_at::text, history_names, style_notes, is_active FROM teams WHERE slug = ${slug}`;
  if (!team) return null;
  const [[record], roster, honors, recent, news] = await Promise.all([
    sql<{ wins: number; losses: number }[]>`
      SELECT count(*) FILTER (WHERE m.winner_id = ${team.id}) AS wins,
             count(*) FILTER (WHERE m.status = 'finished' AND m.winner_id IS NOT NULL AND m.winner_id <> ${team.id} AND (m.team_a_id = ${team.id} OR m.team_b_id = ${team.id})) AS losses
      FROM matches m WHERE (m.team_a_id = ${team.id} OR m.team_b_id = ${team.id}) AND m.status = 'finished'`,
    sql<{ slug: string; nickname: string; position: string | null; portrait: string | null }[]>`
      SELECT p.slug, p.nickname, p.position, p.portrait_url AS portrait
      FROM players p WHERE p.current_team_id = ${team.id} AND p.is_active
      ORDER BY CASE p.position WHEN '对抗路' THEN 1 WHEN '打野' THEN 2 WHEN '中路' THEN 3 WHEN '发育路' THEN 4 WHEN '游走' THEN 5 ELSE 6 END, p.nickname`,
    sql<{ season: string | null; kind: string; note: string | null; year: number | null; title: string | null }[]>`
      SELECT s.name AS season, h.kind, h.note, h.year, h.title FROM team_honors h LEFT JOIN seasons s ON s.id = h.season_id
      WHERE h.team_id = ${team.id} ORDER BY h.year DESC NULLS LAST, s.year DESC NULLS LAST`,
    sql<MatchRowRaw[]>`
      ${MATCH_SELECT}
      WHERE m.team_a_id = ${team.id} OR m.team_b_id = ${team.id}
      ORDER BY coalesce(m.played_at, m.scheduled_at) DESC NULLS LAST LIMIT 10`,
    loadEntityNews("team", team.id),
  ]);
  return {
    team: { slug: team.slug, name: team.name, shortName: team.short_name, logo: team.logo_url, city: team.city, isActive: team.is_active, foundedAt: team.founded_at, historyNames: team.history_names ?? [], styleNotes: team.style_notes },
    record: { wins: Number(record?.wins ?? 0), losses: Number(record?.losses ?? 0) },
    roster, honors, recentMatches: recent.map(toScheduleMatch), news,
  };
}

const cachedTeamDetail = cachedByKey<string, any>(
  (slug) => slug,
  (slug) => fetchTeamDetailRaw(slug),
  { freshMs: 15 * 60_000, maxStaleMs: 60 * 60_000, maxKeys: 40 }
);

export async function loadTeamDetail(slug: string) {
  return cachedTeamDetail(slug);
}

export async function loadMatchDetail(id: string): Promise<MatchDetailResponse | null> {
  const [match] = await sql<Array<MatchRowRaw & { raw: { match_battle_video_list?: Array<{ battle_seq?: number; video_list?: Array<{ video_url?: string; video_channel?: string }> }> } | null }>>`
    SELECT m.id, m.season_id, s.name AS season_name, m.stage, m.bo, m.status, m.scheduled_at, m.played_at,
           m.games_expected, (SELECT count(*) FROM games g WHERE g.match_id = m.id) AS games_count,
           m.score_a, m.score_b, m.winner_id, m.cc_key, m.raw,
           ta.slug AS a_slug, ta.name AS a_name, ta.short_name AS a_short, ta.logo_url AS a_logo,
           tb.slug AS b_slug, tb.name AS b_name, tb.short_name AS b_short, tb.logo_url AS b_logo
    FROM matches m
    JOIN teams ta ON ta.id = m.team_a_id
    JOIN teams tb ON tb.id = m.team_b_id
    JOIN seasons s ON s.id = m.season_id
    WHERE m.id = ${id}`;
  if (!match) return null;
  const games = await sql<{ id: string; game_no: number; mode: string; winner_team: string | null; duration_secs: number | null; mvp: string | null; kills_a: number | null; kills_b: number | null; gold_a: number | null; gold_b: number | null }[]>`
    SELECT g.id, g.game_no, g.mode, tw.name AS winner_team, g.duration_secs, p.nickname AS mvp,
           g.kills_a, g.kills_b, g.gold_a, g.gold_b
    FROM games g
    LEFT JOIN teams tw ON tw.id = g.winner_id
    LEFT JOIN players p ON p.id = g.mvp_player_id
    WHERE g.match_id = ${id} ORDER BY g.game_no`;
  const gameIds = games.map((g) => g.id);
  const bp = gameIds.length
    ? await sql<{ game_id: string; step_index: number; action_type: string; side: string; hero_id: string; hero_name: string; hero_icon: string | null; player: string | null; position: string | null }[]>`
        SELECT b.game_id, b.step_index, b.action_type, b.side, b.hero_id, h.name AS hero_name, h.portrait_url AS hero_icon, p.nickname AS player, b.position
        FROM bp_actions b JOIN heroes h ON h.id = b.hero_id LEFT JOIN players p ON p.id = b.player_id
        WHERE b.game_id IN ${sql(gameIds)} ORDER BY b.game_id, b.step_index`
    : [];
  const stats = gameIds.length
    ? await sql<{ game_id: string; nickname: string; team: string | null; side: string | null; hero: string | null; hero_icon: string | null; position: string | null; kills: number | null; deaths: number | null; assists: number | null; gold: string | null; damage: string | null; mvp: boolean; mvp_score: string | null }[]>`
        SELECT pg.game_id, p.nickname, t.name AS team, pg.side, h.name AS hero, h.portrait_url AS hero_icon, pg.position,
               pg.kills, pg.deaths, pg.assists, pg.gold::text, pg.damage_to_hero::text AS damage, pg.mvp, pg.mvp_score::text
        FROM player_games pg
        JOIN players p ON p.id = pg.player_id
        LEFT JOIN teams t ON t.id = pg.team_id
        LEFT JOIN heroes h ON h.id = pg.hero_id
        WHERE pg.game_id IN ${sql(gameIds)}
        ORDER BY pg.game_id, pg.side, pg.position NULLS LAST, pg.kills DESC NULLS LAST`
    : [];
  const byGame = new Map<string, GameDetail>();
  for (const g of games) {
    byGame.set(g.id, {
      id: g.id, gameNo: g.game_no, mode: g.mode as GameDetail["mode"], winner: g.winner_team,
      durationSecs: g.duration_secs, mvp: g.mvp,
      killsBlue: g.kills_a, killsRed: g.kills_b, goldBlue: g.gold_a, goldRed: g.gold_b,
      bp: [], players: [],
    });
  }
  for (const b of bp) {
    const game = byGame.get(b.game_id);
    if (!game) continue;
    game.bp.push({ step: b.step_index, type: b.action_type as BpStep["type"], side: b.side as BpStep["side"], hero: { id: b.hero_id, name: b.hero_name, icon: b.hero_icon }, player: b.player, position: b.position });
  }
  for (const s of stats) {
    const game = byGame.get(s.game_id);
    if (!game) continue;
    const row: GamePlayerRow = {
      nickname: s.nickname, team: s.team, side: s.side as GamePlayerRow["side"], hero: s.hero, heroIcon: s.hero_icon,
      position: s.position, kills: s.kills, deaths: s.deaths, assists: s.assists,
      gold: s.gold != null ? Number(s.gold) : null, damage: s.damage != null ? Number(s.damage) : null,
      mvp: s.mvp, mvpScore: s.mvp_score != null ? Number(s.mvp_score) : null,
    };
    game.players.push(row);
  }
  const videos: MatchBattleVideoItem[] = [];
  const rawBattleList = match.raw?.match_battle_video_list;
  if (Array.isArray(rawBattleList)) {
    for (const item of rawBattleList) {
      const seq = Number(item.battle_seq) || 1;
      const vList = item.video_list;
      if (Array.isArray(vList) && vList.length > 0) {
        for (const v of vList) {
          if (v.video_url) {
            videos.push({
              battleSeq: seq,
              url: v.video_url,
              channel: v.video_channel || "tencent_video",
              title: `第 ${seq} 局官方高清回放`,
            });
          }
        }
      }
    }
  }

  return {
    match: { ...toScheduleMatch(match), sourceUrl: "https://pvp.qq.com/matchdata/schedule.html" },
    blue: { id: match.a_slug, slug: match.a_slug, name: match.a_name, shortName: match.a_short, logo: match.a_logo, score: match.score_a },
    red: { id: match.b_slug, slug: match.b_slug, name: match.b_name, shortName: match.b_short, logo: match.b_logo, score: match.score_b },
    games: [...byGame.values()],
    videos,
  };
}

async function fetchPlayerDetailRaw(slug: string) {
  // slug 按大小写不敏感解析：历史同步可能给同一选手留下大小写两个档（'Fly'/'fly'），
  // 优先取有对局数据的现役行，空壳行不参与展示。
  const [player] = await sql<{ id: string; slug: string; nickname: string; real_name: string | null; bio: string | null; position: string | null; portrait_url: string | null; debut_at: string | null; team: string | null; team_slug: string | null }[]>`
    SELECT p.id, p.slug, p.nickname, p.real_name, p.bio, p.position, p.portrait_url, p.debut_at::text,
           t.name AS team, t.slug AS team_slug
    FROM players p LEFT JOIN teams t ON t.id = p.current_team_id
    WHERE lower(p.slug) = lower(${slug})
    ORDER BY p.is_active DESC, (SELECT count(*) FROM player_games pg WHERE pg.player_id = p.id) DESC
    LIMIT 1`;
  if (!player) return null;
  const [stints, seasons, heroes, honors, news] = await Promise.all([
    sql<{ team: string | null; team_slug: string | null; joined_at: string | null; left_at: string | null }[]>`
      SELECT t.name AS team, t.slug AS team_slug, ps.joined_at::text, ps.left_at::text
      FROM player_stints ps LEFT JOIN teams t ON t.id = ps.team_id
      WHERE ps.player_id = ${player.id} ORDER BY ps.joined_at DESC NULLS FIRST`,
    sql<{ season_id: string; season_name: string; games: number; wins: number; mvps: number; avg_kills: number | null; avg_deaths: number | null; avg_assists: number | null }[]>`
      SELECT m.season_id, s.name AS season_name, count(DISTINCT pg.game_id) AS games,
        count(DISTINCT pg.game_id) FILTER (WHERE tw.id = pg.team_id) AS wins,
        sum(pg.mvp::int) AS mvps,
        round(avg(pg.kills), 1) AS avg_kills, round(avg(pg.deaths), 1) AS avg_deaths, round(avg(pg.assists), 1) AS avg_assists
      FROM player_games pg
      JOIN games g ON g.id = pg.game_id
      JOIN matches m ON m.id = g.match_id
      JOIN seasons s ON s.id = m.season_id
      LEFT JOIN teams tw ON tw.id = g.winner_id
      WHERE pg.player_id = ${player.id}
      GROUP BY m.season_id, s.name ORDER BY s.name DESC`,
    sql<{ hero: string; hero_icon: string | null; games: number; wins: number }[]>`
      SELECT h.name AS hero, h.portrait_url AS hero_icon, count(*) AS games,
        count(*) FILTER (WHERE tw.id = pg.team_id) AS wins
      FROM player_games pg
      JOIN games g ON g.id = pg.game_id
      LEFT JOIN heroes h ON h.id = pg.hero_id
      LEFT JOIN teams tw ON tw.id = g.winner_id
      WHERE pg.player_id = ${player.id}
      GROUP BY h.name, h.portrait_url ORDER BY games DESC LIMIT 8`,
    sql<{ season: string | null; kind: string; title: string | null; year: number | null; note: string | null }[]>`
      SELECT s.name AS season, h.kind, h.title, h.year, h.note
      FROM player_honors h LEFT JOIN seasons s ON s.id = h.season_id
      WHERE h.player_id = ${player.id}
      ORDER BY h.year DESC NULLS LAST,
        CASE h.kind WHEN 'fmvp' THEN 0 WHEN 'regular_mvp' THEN 1 WHEN 'annual_mvp' THEN 2 WHEN 'best_lineup' THEN 3 WHEN 'champion' THEN 4 ELSE 5 END`,
    loadEntityNews("player", player.id),
  ]);
  return {
    player: { slug: player.slug, nickname: player.nickname, realName: player.real_name, bio: player.bio, position: player.position, portrait: player.portrait_url, debutAt: player.debut_at, team: player.team, teamSlug: player.team_slug },
    stints: stints.map((s) => ({ team: s.team, teamSlug: s.team_slug, joinedAt: s.joined_at, leftAt: s.left_at })),
    seasons: seasons.map((s): PlayerSeasonStat => ({ seasonId: s.season_id, seasonName: s.season_name, games: Number(s.games), wins: Number(s.wins), mvps: Number(s.mvps), avgKills: s.avg_kills == null ? null : Number(s.avg_kills), avgDeaths: s.avg_deaths == null ? null : Number(s.avg_deaths), avgAssists: s.avg_assists == null ? null : Number(s.avg_assists) })),
    heroes: heroes.map((h): PlayerHeroStat => ({ hero: h.hero ?? "未知", heroIcon: h.hero_icon, games: Number(h.games), wins: Number(h.wins) })),
    honors: honors.map((h) => ({ kind: h.kind, season: h.season, title: h.title, year: h.year == null ? null : Number(h.year), note: h.note })),
    news,
  };
}

const cachedPlayerDetail = cachedByKey<string, any>(
  (slug) => slug.toLowerCase(),
  (slug) => fetchPlayerDetailRaw(slug),
  { freshMs: 15 * 60_000, maxStaleMs: 60 * 60_000, maxKeys: 100 }
);

export async function loadPlayerDetail(slug: string) {
  return cachedPlayerDetail(slug);
}

function calculateVersionStrength(bpRate: number, dbStrength?: string | number | null): string {
  // 富化后的库值就是 T0–T3 梯度文本（scripts/enrich-heroes.ts），直接采用。
  if (typeof dbStrength === "string" && dbStrength.trim()) return dbStrength.trim();
  if (dbStrength === 0) return "T0";
  if (dbStrength === 1) return "T1";
  if (dbStrength === 2) return "T2";
  if (dbStrength === 3) return "T3";
  if (bpRate >= 0.45) return "T0";
  if (bpRate >= 0.28) return "T0.5";
  if (bpRate >= 0.16) return "T1";
  if (bpRate >= 0.08) return "T2";
  return "T3";
}

const DEFAULT_POS_TAGS: Record<string, string[]> = {
  发育路: ["爆发射手", "后期大核"],
  对抗路: ["抗压前排", "带线牵制"],
  中路: ["法术爆发", "阵地消耗"],
  打野: ["野区掌控", "节奏突击"],
  游走: ["开团先手", "视野控制"],
};

interface FmvpSkinRecord {
  aliases: string[];
  heroName: string;
  skin: string;
}

const FMVP_HERO_SKINS: FmvpSkinRecord[] = [
  { aliases: ["fly", "彭云飞"], heroName: "花木兰", skin: "冠军飞将" },
  { aliases: ["fly", "彭云飞"], heroName: "曜", skin: "云鹰飞将" },
  { aliases: ["fly", "彭云飞"], heroName: "马超", skin: "无双飞将" },
  { aliases: ["久诚", "jiucheng"], heroName: "干将莫邪", skin: "久胜战神" },
  { aliases: ["cat", "陈正正", "猫神"], heroName: "貂蝉", skin: "猫影幻舞" },
  { aliases: ["清融", "qingrong"], heroName: "西施", skin: "游龙清影" },
  { aliases: ["暖阳", "nuanyang"], heroName: "镜", skin: "炽阳神光" },
  { aliases: ["坦然", "tanran"], heroName: "吕布", skin: "怒海麟威" },
  { aliases: ["花海", "huahai"], heroName: "澜", skin: "逐花归海" },
  { aliases: ["子阳", "ziyang"], heroName: "东皇太一", skin: "灼幽烈阳" },
  { aliases: ["一诺", "yinuo"], heroName: "公孙离", skin: "世冠FMVP" },
  { aliases: ["小胖", "xiaopang"], heroName: "裴擒虎", skin: "苍雷飞将" },
];

function checkFmvpSkin(playerSlug: string, playerNickname: string, heroName: string): string | null {
  const p1 = (playerSlug || "").toLowerCase();
  const p2 = (playerNickname || "").toLowerCase();
  for (const item of FMVP_HERO_SKINS) {
    if (item.heroName === heroName) {
      if (item.aliases.some((a) => p1.includes(a.toLowerCase()) || p2.includes(a.toLowerCase()))) {
        return item.skin;
      }
    }
  }
  return null;
}

async function fetchBaseHeroesList(season?: string): Promise<{ heroes: HeroListItem[]; totalGames: number; season?: string }> {
  const [totalGamesRow, picksAndWins, bansData, topPlayersData, heroesRows] = await Promise.all([
    season
      ? sql<{ count: string }[]>`
          SELECT count(DISTINCT g.id) AS count
          FROM games g JOIN matches m ON m.id = g.match_id
          WHERE m.season_id = ${season}`
      : sql<{ count: string }[]>`SELECT count(*) AS count FROM games`,
    season
      ? sql<{ hero_id: string; picks: string; wins: string }[]>`
          SELECT pg.hero_id, count(*) AS picks,
                 count(*) FILTER (WHERE tw.id = pg.team_id) AS wins
          FROM player_games pg
          JOIN games g ON g.id = pg.game_id
          JOIN matches m ON m.id = g.match_id
          LEFT JOIN teams tw ON tw.id = g.winner_id
          WHERE m.season_id = ${season}
          GROUP BY pg.hero_id`
      : sql<{ hero_id: string; picks: string; wins: string }[]>`
          SELECT pg.hero_id, count(*) AS picks,
                 count(*) FILTER (WHERE tw.id = pg.team_id) AS wins
          FROM player_games pg
          JOIN games g ON g.id = pg.game_id
          LEFT JOIN teams tw ON tw.id = g.winner_id
          GROUP BY pg.hero_id`,
    season
      ? sql<{ hero_id: string; bans: string }[]>`
          SELECT b.hero_id, count(*) AS bans
          FROM bp_actions b
          JOIN games g ON g.id = b.game_id
          JOIN matches m ON m.id = g.match_id
          WHERE b.action_type = 'ban' AND m.season_id = ${season}
          GROUP BY b.hero_id`
      : sql<{ hero_id: string; bans: string }[]>`
          SELECT b.hero_id, count(*) AS bans
          FROM bp_actions b
          WHERE b.action_type = 'ban'
          GROUP BY b.hero_id`,
    sql<{
      hero_id: string; hero_name: string; slug: string; nickname: string;
      games: string; wins: string; playoff_wins: string; win_rate: string;
      kda: string | null; mvps: string;
    }[]>`
      SELECT pg.hero_id, h.name AS hero_name, p.slug, p.nickname,
             count(pg.game_id) AS games,
             count(pg.game_id) FILTER (WHERE tw.id = pg.team_id) AS wins,
             count(pg.game_id) FILTER (WHERE tw.id = pg.team_id AND (m.bo >= 7 OR m.stage LIKE '%季后赛%' OR m.stage LIKE '%决赛%')) AS playoff_wins,
             round(count(pg.game_id) FILTER (WHERE tw.id = pg.team_id)::numeric / count(pg.game_id), 4) AS win_rate,
             round(avg(CASE WHEN pg.deaths = 0 THEN (pg.kills + pg.assists) ELSE (pg.kills + pg.assists)::numeric / pg.deaths END), 2) AS kda,
             sum(pg.mvp::int) AS mvps
      FROM player_games pg
      JOIN heroes h ON h.id = pg.hero_id
      JOIN players p ON p.id = pg.player_id
      JOIN games g ON g.id = pg.game_id
      JOIN matches m ON m.id = g.match_id
      LEFT JOIN teams tw ON tw.id = g.winner_id
      WHERE p.nickname <> '' AND p.id <> 'player'
      GROUP BY pg.hero_id, h.name, p.slug, p.nickname
      HAVING count(pg.game_id) >= 3`,
    sql<{
      id: string; slug: string; name: string; primary_pos: string | null;
      positions: string[] | null; function_tags: string[] | null;
      version_strength: string | number | null; portrait_url: string | null;
    }[]>`
      SELECT id, slug, name, primary_pos, positions, function_tags, version_strength, portrait_url
      FROM heroes
      WHERE name <> '' AND id <> '0'
      ORDER BY id`,
  ]);

  let totalGames = Number(totalGamesRow[0]?.count ?? 0);
  if (totalGames === 0) totalGames = 1;

  const picksMap = new Map<string, { picks: number; wins: number }>();
  for (const r of picksAndWins) {
    picksMap.set(r.hero_id, { picks: Number(r.picks), wins: Number(r.wins) });
  }

  const bansMap = new Map<string, number>();
  for (const r of bansData) {
    bansMap.set(r.hero_id, Number(r.bans));
  }

  const topPlayerMap = new Map<
    string,
    {
      slug: string;
      nickname: string;
      games: number;
      winRate: number;
      score: number;
      mvpCount: number;
      isFmvpHero?: boolean;
      fmvpSkinTitle?: string;
    }
  >();

  for (const r of topPlayersData) {
    const wins = Number(r.wins);
    const playoffWins = Number(r.playoff_wins || 0);
    const winRate = Number(r.win_rate);
    const mvps = Number(r.mvps || 0);
    const kda = Number(r.kda || 0);
    const games = Number(r.games);
    const fmvpSkin = checkFmvpSkin(r.slug, r.nickname, r.hero_name);

    const weightedWins = wins + playoffWins * 0.5;
    const baseScore = weightedWins * (1 + winRate);
    const mvpScore = mvps * 2.2;
    const mvpRate = wins > 0 ? mvps / wins : 0;
    const carryBonus = mvpRate >= 0.3 ? mvpRate * 15 : 0;
    const fmvpBonus = fmvpSkin ? 35 : 0;
    const kdaBonus = Math.min(kda, 10) * 0.8;
    const totalScore = Math.round(baseScore + mvpScore + carryBonus + fmvpBonus + kdaBonus);

    const existing = topPlayerMap.get(r.hero_id);
    if (!existing || totalScore > existing.score || (totalScore === existing.score && games > existing.games)) {
      topPlayerMap.set(r.hero_id, {
        slug: r.slug,
        nickname: r.nickname,
        games,
        winRate,
        score: totalScore,
        mvpCount: mvps,
        isFmvpHero: !!fmvpSkin,
        fmvpSkinTitle: fmvpSkin || undefined,
      });
    }
  }

  const heroes: HeroListItem[] = heroesRows.map((h) => {
    const pw = picksMap.get(h.id) ?? { picks: 0, wins: 0 };
    const bans = bansMap.get(h.id) ?? 0;
    const picks = pw.picks;
    const wins = pw.wins;
    const bpRate = Math.min(1, Math.round(((picks + bans) / totalGames) * 1000) / 1000);
    const winRate = picks > 0 ? Math.round((wins / picks) * 1000) / 1000 : 0;
    const primaryPos = h.primary_pos || (h.positions?.[0] ?? "对抗路");
    const positions = h.positions && h.positions.length > 0 ? h.positions : [primaryPos];
    const functionTags = h.function_tags && h.function_tags.length > 0 ? h.function_tags : (DEFAULT_POS_TAGS[primaryPos] ?? ["战术核心"]);
    const versionStrength = calculateVersionStrength(bpRate, h.version_strength);

    return {
      id: h.slug || h.id,
      heroId: Number(h.id),
      name: h.name,
      avatar: h.portrait_url || `https://game.gtimg.cn/images/yxzj/img201606/heroimg/${h.id}/${h.id}.jpg`,
      primaryPos,
      positions,
      functionTags,
      versionStrength,
      picks,
      bans,
      bpRate,
      winRate,
      topPlayer: topPlayerMap.get(h.id),
    };
  });

  return { heroes, totalGames, season };
}

const cachedBaseHeroesList = cachedByKey<string, { heroes: HeroListItem[]; totalGames: number; season?: string }>(
  (seasonKey) => seasonKey,
  (seasonKey) => fetchBaseHeroesList(seasonKey === "__all__" ? undefined : seasonKey),
  { freshMs: 15 * 60_000, maxStaleMs: 60 * 60_000, maxKeys: 10 }
);

export async function loadHeroesList(opts?: { season?: string; pos?: string; sort?: string }): Promise<HeroListResponse> {
  const season = opts?.season;
  const pos = opts?.pos;
  const sort = opts?.sort ?? "bpRate";

  const base = await cachedBaseHeroesList(season ?? "__all__");
  let filtered = [...base.heroes];

  if (pos && pos !== "全部") {
    filtered = filtered.filter((h) => h.primaryPos === pos || h.positions.includes(pos));
  }

  if (sort === "winRate") {
    filtered.sort((a, b) => {
      const aQual = a.picks >= 10 ? 1 : 0;
      const bQual = b.picks >= 10 ? 1 : 0;
      if (aQual !== bQual) return bQual - aQual;
      return b.winRate - a.winRate || b.picks - a.picks;
    });
  } else if (sort === "picks") {
    filtered.sort((a, b) => b.picks - a.picks || b.bpRate - a.bpRate);
  } else if (sort === "tier") {
    const tierWeight: Record<string, number> = { T0: 5, "T0.5": 4, T1: 3, T2: 2, T3: 1 };
    filtered.sort((a, b) => (tierWeight[b.versionStrength] ?? 0) - (tierWeight[a.versionStrength] ?? 0) || b.bpRate - a.bpRate);
  } else {
    filtered.sort((a, b) => b.bpRate - a.bpRate || b.picks - a.picks);
  }

  return {
    heroes: filtered,
    totalGames: base.totalGames,
    season: base.season,
  };
}

async function fetchHeroDetailRaw(slug: string, _opts?: { season?: string }): Promise<HeroDetailResponse | null> {
  const [heroRow] = await sql<{
    id: string; slug: string; name: string; title: string | null;
    primary_pos: string | null; positions: string[] | null;
    function_tags: string[] | null; version_strength: string | number | null;
    power_period: string | null; portrait_url: string | null;
  }[]>`
    SELECT id, slug, name, title, primary_pos, positions, function_tags,
           version_strength, power_period, portrait_url
    FROM heroes
    WHERE slug = ${slug}
       OR replace(slug, '-', '') = replace(${slug}, '-', '')
       OR id = ${slug}
       OR name = ${slug}
    LIMIT 1`;

  if (!heroRow) return null;
  const heroId = heroRow.id;

  const [[totalRow], [picksRow], [bansRow], topPlayersRows, partnersRows, countersRows, recentRows] = await Promise.all([
    sql<{ count: string }[]>`SELECT count(*) AS count FROM games`,
    sql<{
      picks: string;
      wins: string;
      blue_games: string;
      blue_wins: string;
      red_games: string;
      red_wins: string;
      avg_kda: string | null;
      avg_dmg_share: string | null;
    }[]>`
      SELECT count(*) AS picks,
             count(*) FILTER (WHERE tw.id = pg.team_id) AS wins,
             count(*) FILTER (WHERE pg.side = 'blue') AS blue_games,
             count(*) FILTER (WHERE pg.side = 'blue' AND tw.id = pg.team_id) AS blue_wins,
             count(*) FILTER (WHERE pg.side = 'red') AS red_games,
             count(*) FILTER (WHERE pg.side = 'red' AND tw.id = pg.team_id) AS red_wins,
             avg(CASE WHEN pg.deaths = 0 THEN (pg.kills + pg.assists) ELSE (pg.kills + pg.assists)::numeric / pg.deaths END) AS avg_kda,
             avg((pg.raw->>'hurt_to_hero_total_rate')::numeric) AS avg_dmg_share
      FROM player_games pg
      JOIN games g ON g.id = pg.game_id
      LEFT JOIN teams tw ON tw.id = g.winner_id
      WHERE pg.hero_id = ${heroId}`,
    sql<{ bans: string }[]>`
      SELECT count(*) AS bans FROM bp_actions WHERE hero_id = ${heroId} AND action_type = 'ban'`,
    sql<{
      slug: string; nickname: string; portrait: string | null; team_name: string | null;
      games: string; wins: string; playoff_wins: string; win_rate: string; kda: string | null; mvps: string;
    }[]>`
      SELECT p.slug, p.nickname, p.portrait_url AS portrait, t.name AS team_name,
             count(pg.game_id) AS games,
             count(pg.game_id) FILTER (WHERE tw.id = pg.team_id) AS wins,
             count(pg.game_id) FILTER (WHERE tw.id = pg.team_id AND (m.bo >= 7 OR m.stage LIKE '%季后赛%' OR m.stage LIKE '%决赛%')) AS playoff_wins,
             round(count(pg.game_id) FILTER (WHERE tw.id = pg.team_id)::numeric / count(pg.game_id), 4) AS win_rate,
             round(avg(CASE WHEN pg.deaths = 0 THEN (pg.kills + pg.assists) ELSE (pg.kills + pg.assists)::numeric / pg.deaths END), 2) AS kda,
             sum(pg.mvp::int) AS mvps
      FROM player_games pg
      JOIN players p ON p.id = pg.player_id
      LEFT JOIN teams t ON t.id = p.current_team_id
      JOIN games g ON g.id = pg.game_id
      JOIN matches m ON m.id = g.match_id
      LEFT JOIN teams tw ON tw.id = g.winner_id
      WHERE pg.hero_id = ${heroId} AND p.nickname <> '' AND p.id <> 'player'
      GROUP BY p.id, p.slug, p.nickname, p.portrait_url, t.name
      HAVING count(pg.game_id) >= 3`,
    sql<{
      hero_id: string; name: string; avatar: string | null; games: string; win_rate: string;
    }[]>`
      SELECT h.id AS hero_id, h.name, h.portrait_url AS avatar,
             count(*) AS games,
             round(count(*) FILTER (WHERE tw.id = pg2.team_id)::numeric / count(*), 4) AS win_rate
      FROM player_games pg1
      JOIN player_games pg2 ON pg1.game_id = pg2.game_id 
                           AND (pg1.team_id = pg2.team_id OR pg1.side = pg2.side)
                           AND pg1.hero_id <> pg2.hero_id
      JOIN heroes h ON h.id = pg2.hero_id
      JOIN games g ON g.id = pg1.game_id
      LEFT JOIN teams tw ON tw.id = g.winner_id
      WHERE pg1.hero_id = ${heroId} AND h.name <> '' AND h.id <> '0'
      GROUP BY h.id, h.name, h.portrait_url
      HAVING count(*) >= 5
      ORDER BY win_rate DESC, games DESC
      LIMIT 5`,
    sql<{
      hero_id: string; name: string; avatar: string | null; games: string; win_rate: string;
    }[]>`
      SELECT h.id AS hero_id, h.name, h.portrait_url AS avatar,
             count(*) AS games,
             round(count(*) FILTER (WHERE tw.id = pg1.team_id)::numeric / count(*), 4) AS win_rate
      FROM player_games pg1
      JOIN player_games pg2 ON pg1.game_id = pg2.game_id 
                           AND pg1.side <> pg2.side
      JOIN heroes h ON h.id = pg2.hero_id
      JOIN games g ON g.id = pg1.game_id
      LEFT JOIN teams tw ON tw.id = g.winner_id
      WHERE pg1.hero_id = ${heroId} AND h.name <> '' AND h.id <> '0'
      GROUP BY h.id, h.name, h.portrait_url
      HAVING count(*) >= 5
      ORDER BY win_rate DESC, games DESC
      LIMIT 5`,
    sql<MatchRowRaw[]>`
      ${MATCH_SELECT}
      WHERE m.id IN (
        SELECT g.match_id
        FROM player_games pg
        JOIN games g ON g.id = pg.game_id
        WHERE pg.hero_id = ${heroId}
        ORDER BY g.id DESC
        LIMIT 10
      )
      ORDER BY coalesce(m.played_at, m.scheduled_at) DESC NULLS LAST
      LIMIT 10`,
  ]);

  const totalGames = Math.max(Number(totalRow?.count ?? 1), 1);
  const picks = Number(picksRow?.picks ?? 0);
  const bans = Number(bansRow?.bans ?? 0);
  const wins = Number(picksRow?.wins ?? 0);
  const losses = Math.max(0, picks - wins);
  const bpRate = Math.min(1, Math.round(((picks + bans) / totalGames) * 1000) / 1000);
  const winRate = picks > 0 ? Math.round((wins / picks) * 1000) / 1000 : 0;

  const blueGames = Number(picksRow?.blue_games ?? 0);
  const blueWins = Number(picksRow?.blue_wins ?? 0);
  const blueWinRate = blueGames > 0 ? Math.round((blueWins / blueGames) * 1000) / 1000 : 0;

  const redGames = Number(picksRow?.red_games ?? 0);
  const redWins = Number(picksRow?.red_wins ?? 0);
  const redWinRate = redGames > 0 ? Math.round((redWins / redGames) * 1000) / 1000 : 0;

  const avgKda = picksRow?.avg_kda != null ? Math.round(Number(picksRow.avg_kda) * 10) / 10 : 3.0;
  const avgDamageShare = picksRow?.avg_dmg_share != null ? Math.round(Number(picksRow.avg_dmg_share) * 1000) / 1000 : 0.2;
  const avgGoldShare = 0.2;

  const scoredPlayers = topPlayersRows.map((r) => {
    const pWins = Number(r.wins);
    const playoffWins = Number(r.playoff_wins || 0);
    const pWinRate = Number(r.win_rate);
    const mvps = Number(r.mvps || 0);
    const kda = r.kda != null ? Number(r.kda) : 0;
    const games = Number(r.games);
    const fmvpSkin = checkFmvpSkin(r.slug, r.nickname, heroRow.name);

    const weightedWins = pWins + playoffWins * 0.5;
    const baseScore = weightedWins * (1 + pWinRate);
    const mvpScore = mvps * 2.2;
    const mvpRate = pWins > 0 ? mvps / pWins : 0;
    const carryBonus = mvpRate >= 0.3 ? mvpRate * 15 : 0;
    const fmvpBonus = fmvpSkin ? 35 : 0;
    const kdaBonus = Math.min(kda, 10) * 0.8;
    const totalScore = Math.round(baseScore + mvpScore + carryBonus + fmvpBonus + kdaBonus);

    return {
      playerSlug: r.slug,
      nickname: r.nickname,
      portrait: r.portrait || undefined,
      teamName: r.team_name || undefined,
      games,
      wins: pWins,
      winRate: pWinRate,
      kda,
      mvpCount: mvps,
      mvpRate: Math.round(mvpRate * 1000) / 1000,
      playoffWins,
      score: totalScore,
      isFmvpHero: !!fmvpSkin,
      fmvpSkinTitle: fmvpSkin || undefined,
    };
  });

  scoredPlayers.sort((a, b) => b.score - a.score || b.games - a.games);
  const topPlayers = scoredPlayers.slice(0, 5);

  const bestPartners = partnersRows.map((r) => ({
    heroId: Number(r.hero_id),
    name: r.name,
    avatar: r.avatar || `https://game.gtimg.cn/images/yxzj/img201606/heroimg/${r.hero_id}/${r.hero_id}.jpg`,
    games: Number(r.games),
    winRate: Number(r.win_rate),
  }));

  const counters = countersRows.map((r) => ({
    heroId: Number(r.hero_id),
    name: r.name,
    avatar: r.avatar || `https://game.gtimg.cn/images/yxzj/img201606/heroimg/${r.hero_id}/${r.hero_id}.jpg`,
    games: Number(r.games),
    winRate: Number(r.win_rate),
  }));

  const primaryPos = heroRow.primary_pos || (heroRow.positions?.[0] ?? "对抗路");
  const positions = heroRow.positions && heroRow.positions.length > 0 ? heroRow.positions : [primaryPos];
  const functionTags = heroRow.function_tags && heroRow.function_tags.length > 0 ? heroRow.function_tags : (DEFAULT_POS_TAGS[primaryPos] ?? ["战术核心"]);

  return {
    hero: {
      id: heroRow.slug || heroRow.id,
      heroId: Number(heroRow.id),
      name: heroRow.name,
      title: heroRow.title || undefined,
      avatar: heroRow.portrait_url || `https://game.gtimg.cn/images/yxzj/img201606/heroimg/${heroRow.id}/${heroRow.id}.jpg`,
      primaryPos,
      positions,
      functionTags,
      versionStrength: calculateVersionStrength(bpRate, heroRow.version_strength),
      powerPeriod: heroRow.power_period || undefined,
    },
    stats: {
      picks,
      bans,
      bpRate,
      wins,
      losses,
      winRate,
      blueWinRate,
      redWinRate,
      avgKda,
      avgDamageShare,
      avgGoldShare,
    },
    topPlayers,
    bestPartners,
    counters,
    recentMatches: recentRows.map(toMatchSummary),
  };
}

const cachedHeroDetail = cachedByKey<string, HeroDetailResponse | null>(
  (key) => key,
  (key) => {
    const [slug, season] = key.split("::");
    return fetchHeroDetailRaw(slug, season ? { season } : undefined);
  },
  { freshMs: 15 * 60_000, maxStaleMs: 60 * 60_000, maxKeys: 150 }
);

export async function loadHeroDetail(slug: string, opts?: { season?: string }): Promise<HeroDetailResponse | null> {
  return cachedHeroDetail(`${slug}::${opts?.season ?? ""}`);
}

async function fetchH2HRaw(teamASlug: string, teamBSlug: string, season?: string): Promise<H2HResponse | null> {
  const [[teamA], [teamB]] = await Promise.all([
    sql<{ id: string; slug: string; name: string; short_name: string | null; logo_url: string | null; city: string | null }[]>`
      SELECT id, slug, name, short_name, logo_url, city FROM teams
      WHERE slug = ${teamASlug} OR id = ${teamASlug} LIMIT 1`,
    sql<{ id: string; slug: string; name: string; short_name: string | null; logo_url: string | null; city: string | null }[]>`
      SELECT id, slug, name, short_name, logo_url, city FROM teams
      WHERE slug = ${teamBSlug} OR id = ${teamBSlug} LIMIT 1`,
  ]);

  if (!teamA || !teamB) return null;

  const matches = await sql<MatchRowRaw[]>`
    ${MATCH_SELECT}
    WHERE ((m.team_a_id = ${teamA.id} AND m.team_b_id = ${teamB.id}) OR (m.team_a_id = ${teamB.id} AND m.team_b_id = ${teamA.id}))
      AND m.status = 'finished'
      ${season ? sql`AND m.season_id = ${season}` : sql``}
    ORDER BY coalesce(m.played_at, m.scheduled_at) DESC NULLS LAST`;

  let teamAWins = 0;
  let teamBWins = 0;
  let teamAGames = 0;
  let teamBGames = 0;
  let teamABo7Wins = 0;
  let teamBBo7Wins = 0;
  const last5WinnerSlugs: string[] = [];

  for (const m of matches) {
    const aIsHome = m.a_slug === teamA.slug;
    const aScore = aIsHome ? m.score_a : m.score_b;
    const bScore = aIsHome ? m.score_b : m.score_a;
    teamAGames += aScore;
    teamBGames += bScore;

    const winnerSlug = m.winner_id === teamA.id ? teamA.slug : m.winner_id === teamB.id ? teamB.slug : null;
    if (winnerSlug === teamA.slug) {
      teamAWins++;
      if ((m.bo ?? 5) >= 7) teamABo7Wins++;
    } else if (winnerSlug === teamB.slug) {
      teamBWins++;
      if ((m.bo ?? 5) >= 7) teamBBo7Wins++;
    }

    if (winnerSlug && last5WinnerSlugs.length < 5) {
      last5WinnerSlugs.push(winnerSlug);
    }
  }

  return {
    teamA: {
      slug: teamA.slug,
      name: teamA.name,
      shortName: teamA.short_name,
      logo: teamA.logo_url,
      city: teamA.city,
    },
    teamB: {
      slug: teamB.slug,
      name: teamB.name,
      shortName: teamB.short_name,
      logo: teamB.logo_url,
      city: teamB.city,
    },
    stats: {
      totalMatches: matches.length,
      teamAWins,
      teamBWins,
      teamAGames,
      teamBGames,
      teamABo7Wins,
      teamBBo7Wins,
      last5WinnerSlugs,
    },
    matches: matches.map(toMatchSummary),
  };
}

const cachedH2H = cachedByKey<string, H2HResponse | null>(
  (key) => key,
  (key) => {
    const [teamASlug, teamBSlug, season] = key.split("::");
    return fetchH2HRaw(teamASlug, teamBSlug, season || undefined);
  },
  { freshMs: 15 * 60_000, maxStaleMs: 60 * 60_000, maxKeys: 150 }
);

export async function loadH2H(teamASlug: string, teamBSlug: string, season?: string): Promise<H2HResponse | null> {
  return cachedH2H(`${teamASlug}::${teamBSlug}::${season ?? ""}`);
}

async function fetchStandingsRaw(opts?: { season?: string; stage?: string }): Promise<StandingsResponse | null> {
  const availableSeasons = await listAvailableSeasons();
  if (availableSeasons.length === 0) return null;

  let selectedSeason = availableSeasons[0];
  if (opts?.season) {
    const matched = availableSeasons.find((s) => s.id === opts.season || s.externalId === opts.season);
    if (matched) selectedSeason = matched;
  }

  const stagesRows = await sql<{ stage: string; count: string }[]>`
    SELECT stage, count(*) AS count
    FROM matches
    WHERE season_id = ${selectedSeason.id} AND stage IS NOT NULL AND status != 'cancelled'
    GROUP BY stage
    ORDER BY min(coalesce(played_at, scheduled_at)) ASC NULLS LAST, stage ASC`;

  const stages = stagesRows.map((r) => r.stage);
  if (stages.length === 0) {
    return {
      season: { id: selectedSeason.id, name: selectedSeason.name, year: selectedSeason.year },
      availableSeasons,
      currentStage: "暂无赛段",
      stages: [],
      standingsByGroup: {},
    };
  }

  let currentStage = opts?.stage;
  if (!currentStage || !stages.includes(currentStage)) {
    const [latest] = await sql<{ stage: string }[]>`
      SELECT stage FROM matches
      WHERE season_id = ${selectedSeason.id} AND stage IS NOT NULL
        AND status IN ('finished', 'live')
      ORDER BY coalesce(played_at, scheduled_at) DESC NULLS LAST, id DESC LIMIT 1`;
    currentStage = latest?.stage ?? stages[0];
  }

  const stageMatches = await sql<MatchRowRaw[]>`
    ${MATCH_SELECT}
    WHERE m.season_id = ${selectedSeason.id}
      AND m.stage = ${currentStage}
      AND m.status != 'cancelled'
    ORDER BY coalesce(m.played_at, m.scheduled_at) ASC NULLS LAST, m.id ASC`;

  const matches: StandingsMatch[] = stageMatches.map(m => ({
    id: m.id,
    home: { slug: m.a_slug, name: m.a_name, shortName: m.a_short, logo: m.a_logo },
    away: { slug: m.b_slug, name: m.b_name, shortName: m.b_short, logo: m.b_logo },
    scoreA: m.score_a, scoreB: m.score_b, status: m.status, bo: m.bo,
    winner: m.winner_id === m.team_a_id ? m.a_slug : m.winner_id === m.team_b_id ? m.b_slug : null,
  }));
  const rules = standingsRules(selectedSeason.externalId, currentStage);
  const teams = new Map(matches.flatMap(m => [[m.home.slug, m.home], [m.away.slug, m.away]] as const));
  const standingsByGroup: Record<string, StandingRow[]> = {};
  const notes = ['仅统计本赛段已完赛且比分、胜方一致的比赛；胜一场积 1 分，按积分、净胜局排序。同分同净胜局暂列并列，最终顺位以官方裁定为准。'];
  if (rules) {
    const slugs = Object.values(rules.groups).flat();
    const roster = await sql<{ slug: string; name: string; short_name: string | null; logo_url: string | null }[]>`
      SELECT slug, name, short_name, logo_url FROM teams WHERE slug IN ${sql(slugs)}`;
    for (const t of roster) teams.set(t.slug, { slug: t.slug, name: t.name, shortName: t.short_name, logo: t.logo_url });
    for (const [group, members] of Object.entries(rules.groups)) {
      standingsByGroup[group] = calculateStandings(matches, members.flatMap(slug => teams.has(slug) ? [teams.get(slug)!] : []), group, currentStage);
    }
    if (slugs.some(slug => !teams.has(slug))) notes.push('部分参赛战队档案尚未入库，名单展示不完整。');
    if (matches.some(m => !slugs.includes(m.home.slug) || !slugs.includes(m.away.slug))) notes.push('赛程存在不在已核实分组名单中的战队，请复核分组资料。');
  } else {
    // 对局关系不能证明官方组别，尤其年总是组外循环。缺名单时只展示战绩汇总。
    standingsByGroup['战绩汇总（分组待核实）'] = calculateStandings(matches, [...teams.values()], '总榜', currentStage);
    notes.push('本赛段尚无已核实的官方分组资料，暂展示战绩汇总，不代表官方积分排名或晋级顺位。');
  }
  const invalidCount = matches.filter(m => m.status === 'finished' && !validStandingResult(m)).length;
  if (invalidCount) notes.push(`${invalidCount} 场完赛记录的比分或胜方不完整，暂未计入统计。`);

  return {
    season: { id: selectedSeason.id, name: selectedSeason.name, year: selectedSeason.year },
    availableSeasons,
    currentStage,
    stages,
    standingsByGroup,
    notes,
    rulesDescription: rules?.description ?? null,
    rulesSourceUrl: rules?.sourceUrl ?? null,
  };
}

const cachedStandings = cachedByKey<string, StandingsResponse | null>(
  (key) => key,
  (key) => {
    const [season, stage] = key.split("::");
    return fetchStandingsRaw({ season: season || undefined, stage: stage || undefined });
  },
  { freshMs: 60_000, maxStaleMs: 5 * 60_000, maxKeys: 40 }
);

export async function loadStandings(opts?: { season?: string; stage?: string }): Promise<StandingsResponse | null> {
  return cachedStandings(`${opts?.season ?? ""}::${opts?.stage ?? ""}`);
}

// 启动时在后台静默预热热门接口缓存，避免用户首次访问冷启动等待
setTimeout(() => {
  void listAvailableSeasons().catch(() => {});
  void listTeams().catch(() => {});
  void cachedBaseHeroesList("__all__").catch(() => {});
  void loadH2H("wolves", "ag").catch(() => {});
  void loadStandings().catch(() => {});
}, 200);


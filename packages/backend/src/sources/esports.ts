// esports_api 读取器：KPL 官方赛事数据（league → match → battle 三级）。
// 每次运行：整季赛程/赛果入库（幂等），再按预算补抓缺失的对局详情（BO 小局、BP、选手单局数据）。
// 结构化数据不进 articles 流水线；战队的官方 team_id 已在 kb 种子里的按种子接续，新队自动建行。
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { beijingTime, SMOBA_BASE, ensureSeason, ensureTeam, upsertGame, upsertMatch, type BpEntry, type BattlePlayer } from "../kb/upsert.ts";
import type { SourceRow } from "./types.ts";

export interface EsportsSyncResult {
  found: number;
  created: number;
  revised: number;
  battles: number;
  detail: Record<string, unknown>;
  cursor: Record<string, unknown>;
}

interface LeagueMatch {
  match_id: string;
  bo: number;
  status: number;
  win_camp: number | null;
  start_time: string | null;
  end_time: string | null;
  match_stage_name?: string | null;
  match_stage_desc?: string | null;
  cc_match_id?: string | null;
  camp1: CampRow;
  camp2: CampRow;
  [key: string]: unknown;
}

interface CampRow {
  team_id: string;
  team_name: string;
  team_abbreviation?: string | null;
  team_icon?: string | null;
  score?: number | null;
  is_win?: number | boolean | null;
}

interface BattleListRow { battle_id: string; status: number; win_camp: number | null; game_duration: number | null; battle_seq: number }

interface BattleData {
  battle_id: string; status: number; win_camp: number | null; game_duration: number | null; battle_seq: number;
  camp1: CampAgg; camp2: CampAgg;
  battle_player_list: BattlePlayer[];
  bp_list: BpEntry[];
  [key: string]: unknown;
}

interface CampAgg { team_id: string; kill_num?: number; gold?: number; [key: string]: unknown }

async function getJson(url: string): Promise<unknown> {
  const res = await guardedFetch(url, { headers: { origin: "https://pvp.qq.com", referer: "https://pvp.qq.com/" }, timeoutMs: 20_000 });
  if (res.status === 404) return null;
  if (res.status >= 400) throw new Error(`esports api HTTP ${res.status}`);
  return JSON.parse(res.text()) as unknown;
}

/** 赛季行：external_id（league_id）为准，id 由年份与分季生成。 */
/** 已完赛但对局不齐的比赛：数量与官方对局列表（games_expected）对不上的，或者还没拉过列表的。 */
async function incompleteMatches(seasonId: string, limit: number) {
  return sql<{ id: string; source_key: string; bo: number | null; played_at: string | null }[]>`
    SELECT m.id, m.source_key, m.bo, m.played_at FROM matches m
    WHERE m.season_id = ${seasonId} AND m.status = 'finished' AND m.source = 'smoba'
      AND ((m.games_expected IS NULL AND (SELECT count(*) FROM games g WHERE g.match_id = m.id) = 0)
        OR (SELECT count(*) FROM games g WHERE g.match_id = m.id) < coalesce(m.games_expected, 0))
    ORDER BY m.played_at ASC NULLS LAST LIMIT ${limit}`;
}

/**
 * 一次采集运行：赛程赛果全部对齐（每轮都便宜），再用剩余预算抓对局详情。
 * 对局详情只补“完赛但数量不齐”的比赛，最老的优先；断点续抓天然成立（部分入库的对局仍在阈值内）。
 */
export async function syncEsportsSource(source: SourceRow): Promise<EsportsSyncResult> {
  const baseUrl = String(source.config.baseUrl || SMOBA_BASE).replace(/\/+$/, "");
  const leagueId = String(source.config.leagueId ?? "");
  if (!/^\d{8}$/.test(leagueId)) throw new Error("esports_api 需要 config.leagueId（8 位数字，如 20260001）");
  const battlesPerRun = Number(source.config.battlesPerRun ?? 12);

  const payload = (await getJson(`${baseUrl}/leaguesite/matches/open?league_id=${leagueId}`)) as { results?: LeagueMatch[] } | null;
  const rows = payload?.results ?? [];
  const seasonId = await ensureSeason(sql, leagueId, rows[0]?.cc_match_id ?? null);
  let created = 0;
  let revised = 0;
  const teamOf = new Map<string, string>();
  for (const row of rows) {
    for (const camp of [row.camp1, row.camp2]) {
      if (!camp?.team_id) continue;
      if (!teamOf.has(camp.team_id)) {
        teamOf.set(camp.team_id, await ensureTeam(sql, { externalId: camp.team_id, name: camp.team_name, shortName: camp.team_abbreviation ?? null, logoUrl: camp.team_icon ?? null }));
      }
    }
    const campTeams: { 1?: string | null; 2?: string | null } = { 1: teamOf.get(row.camp1?.team_id ?? "") ?? null, 2: teamOf.get(row.camp2?.team_id ?? "") ?? null };
    if (!campTeams[1] || !campTeams[2]) continue;
    const finished = row.status === 2 || (row.win_camp === 1 || row.win_camp === 2);
    const winnerId = finished && row.win_camp ? campTeams[row.win_camp as 1 | 2] ?? null : null;
    const res = await upsertMatch(sql, {
      leagueId, matchId: row.match_id, seasonId,
      ccKey: row.cc_match_id ?? null,
      stage: row.match_stage_desc || row.match_stage_name || null,
      bo: row.bo ?? null,
      teamAId: campTeams[1]!, teamBId: campTeams[2]!,
      scoreA: Number(row.camp1?.score ?? 0), scoreB: Number(row.camp2?.score ?? 0),
      winnerId,
      status: finished ? "finished" : row.status === 1 ? "live" : "scheduled",
      scheduledAt: beijingTime(row.start_time), playedAt: beijingTime(row.end_time),
      sourceUrl: "https://pvp.qq.com/matchdata/schedule.html?league_id=" + leagueId,
      raw: row,
    });
    if (res.created) created += 1;
    else if (res.revised) revised += 1;
  }

  // 对局详情回灌：预算内从最老的缺局比赛开始。
  let battles = 0;
  const candidates = await incompleteMatches(seasonId, 6);
  for (const match of candidates) {
    if (battles >= battlesPerRun) break;
    const [matchRow] = await sql<{ team_a_id: string; team_b_id: string; played_at: string | null }[]>`
      SELECT team_a_id, team_b_id, played_at FROM matches WHERE id = ${match.id}`;
    if (!matchRow) continue;
    const playedAt = beijingTime(matchRow.played_at);
    const list = (await getJson(`${baseUrl}/leaguesite/match/battles/open?match_id=${match.source_key}`)) as { results?: BattleListRow[] } | null;
    const battleRows = list?.results ?? [];
    // 先记下官方局数：断点续抓按“库存 < 官方局数”精确补缺。
    if (battleRows.length) await sql`UPDATE matches SET games_expected = ${battleRows.length} WHERE id = ${match.id}`;
    for (const battle of battleRows) {
      if (battles >= battlesPerRun) break;
      const stored = await sql<{ id: string }[]>`SELECT id FROM games WHERE source = 'smoba' AND source_key = ${battle.battle_id}`;
      if (stored.length) continue;
      const detail = (await getJson(`${baseUrl}/leaguesite/battle/open?battle_id=${battle.battle_id}`)) as { data?: BattleData } | null;
      const data = detail?.data;
      if (!data) continue;
      await upsertGame({
        matchId: match.id,
        bo: match.bo,
        battleId: data.battle_id,
        battleSeq: data.battle_seq ?? battle.battle_seq,
        status: data.status ?? battle.status,
        winCamp: data.win_camp ?? battle.win_camp,
        durationMs: data.game_duration ?? battle.game_duration,
        teamAId: matchRow.team_a_id,
        teamBId: matchRow.team_b_id,
        campTeams: { 1: matchRow.team_a_id, 2: matchRow.team_b_id },
        kills: { 1: data.camp1?.kill_num ?? null, 2: data.camp2?.kill_num ?? null },
        golds: { 1: data.camp1?.gold ?? null, 2: data.camp2?.gold ?? null },
        bpList: data.bp_list ?? [],
        players: data.battle_player_list ?? [],
        playedAt,
        raw: data,
      });
      battles += 1;
    }
  }

  return {
    found: rows.length, created, revised, battles,
    detail: { league: leagueId, matches: rows.length, matchesCreated: created, matchesRevised: revised, battles },
    cursor: { ...(source.cursor ?? {}), lastLeagueFetch: new Date().toISOString() },
  };
}

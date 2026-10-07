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

/** Per-match backfill bookkeeping, kept in the source cursor (no new columns): attempts and last recheck. */
interface EsportsBackfillState { attempts: number; lastAt: string; reason?: string; recheckedAt?: string }

interface BackfillCandidate {
  id: string; source_key: string; bo: number | null; played_at: string | null;
  game_count: number; games_expected: number; missing_fields: boolean; recent: boolean;
}

/** 超过这个次数的持续失败比赛不再抢占候选位置，而是记为“覆盖受限”。 */
const MAX_MATCH_ATTEMPTS = 5;
/** 近期完赛比赛在这么多天内的复查窗口（接收官方迟到数据与修正）。 */
const RECENT_RECHECK_WINDOW_MS = 3 * 86400_000;
/** 同一场比赛两次复查的最小间隔。 */
const RECHECK_INTERVAL_MS = 6 * 3600_000;

async function getJson(url: string): Promise<unknown> {
  const res = await guardedFetch(url, { headers: { origin: "https://pvp.qq.com", referer: "https://pvp.qq.com/" }, timeoutMs: 20_000 });
  if (res.status === 404) return null;
  if (res.status >= 400) throw new Error(`esports api HTTP ${res.status}`);
  return JSON.parse(res.text()) as unknown;
}

/** 赛季行：external_id（league_id）为准，id 由年份与分季生成。 */
/**
 * 需要补全或复查的完赛比赛：按字段判断完整度，而不是只看对局数量。
 * 缺局、缺 BP、缺选手数据、缺 MVP 都算不完整；近期完赛的比赛即使完整也进入复查窗口。
 */
async function backfillCandidates(seasonId: string): Promise<BackfillCandidate[]> {
  return sql<BackfillCandidate[]>`
    WITH c AS (
      SELECT m.id, m.source_key, m.bo, m.played_at,
        (SELECT count(*) FROM games g WHERE g.match_id = m.id)::int AS game_count,
        coalesce(m.games_expected, 0) AS games_expected,
        EXISTS (
          SELECT 1 FROM games g WHERE g.match_id = m.id AND (
            (g.mode = 'standard' AND (SELECT count(*) FROM bp_actions b WHERE b.game_id = g.id) < 20)
            OR (g.mode = 'pinnacle' AND (SELECT count(*) FROM pinnacle_picks p WHERE p.game_id = g.id) = 0)
            OR (SELECT count(*) FROM player_games pg WHERE pg.game_id = g.id) < 10
            OR g.mvp_player_id IS NULL
          )
        ) AS missing_fields,
        (m.played_at IS NOT NULL AND m.played_at <= now() AND m.played_at > now() - interval '3 days') AS recent
      FROM matches m
      WHERE m.season_id = ${seasonId} AND m.status = 'finished' AND m.source = 'smoba'
    )
    SELECT * FROM c
    WHERE (games_expected = 0 AND game_count = 0) OR game_count < games_expected OR missing_fields OR recent
    ORDER BY played_at DESC NULLS LAST LIMIT 40`;
}

/** 一场比赛里字段不齐的小局 source_key，用于决定哪些对局需要重新拉取详情。 */
async function incompleteBattles(matchId: string): Promise<Set<string>> {
  const rows = await sql<{ battle_id: string }[]>`
    SELECT g.source_key AS battle_id FROM games g
    WHERE g.match_id = ${matchId} AND (
      (g.mode = 'standard' AND (SELECT count(*) FROM bp_actions b WHERE b.game_id = g.id) < 20)
      OR (g.mode = 'pinnacle' AND (SELECT count(*) FROM pinnacle_picks p WHERE p.game_id = g.id) = 0)
      OR (SELECT count(*) FROM player_games pg WHERE pg.game_id = g.id) < 10
      OR g.mvp_player_id IS NULL
    )`;
  return new Set(rows.map((r) => r.battle_id));
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

  // 对局详情回灌：按字段完整度选候选，预算限制实际请求尝试，持续失败不再抢占候选名额。
  let battles = 0;
  let failed = 0;
  let requests = 0;
  const backfill: Record<string, EsportsBackfillState> = { ...((source.cursor?.backfill as Record<string, EsportsBackfillState> | undefined) ?? {}) };
  const candidates = await backfillCandidates(seasonId);
  const isIncomplete = (c: BackfillCandidate) => (c.games_expected === 0 && c.game_count === 0) || c.game_count < c.games_expected || c.missing_fields;
  const incomplete = candidates.filter(isIncomplete);
  const rechecks = candidates.filter((c) => !isIncomplete(c) && c.recent &&
    (!backfill[c.id]?.recheckedAt || Date.now() - Date.parse(backfill[c.id]!.recheckedAt!) > RECHECK_INTERVAL_MS));

  /** 拉取一场比赛的各局详情；force 里的比赛即使小局已存在也重拉（接收官方修正）。 */
  const fetchMatchBattles = async (match: BackfillCandidate, force: boolean): Promise<{ error?: string }> => {
    const [matchRow] = await sql<{ team_a_id: string; team_b_id: string; played_at: string | null }[]>`
      SELECT team_a_id, team_b_id, played_at FROM matches WHERE id = ${match.id}`;
    if (!matchRow) return {};
    const playedAt = beijingTime(matchRow.played_at);
    const list = (await getJson(`${baseUrl}/leaguesite/match/battles/open?match_id=${match.source_key}`)) as { results?: BattleListRow[] } | null;
    const battleRows = list?.results ?? [];
    // 先记下官方局数：断点续抓按“库存 < 官方局数”精确补缺。
    if (battleRows.length) await sql`UPDATE matches SET games_expected = ${battleRows.length} WHERE id = ${match.id}`;
    const missing = await incompleteBattles(match.id);
    let error: string | undefined;
    for (const battle of battleRows) {
      if (requests >= battlesPerRun) break;
      const stored = await sql<{ id: string }[]>`SELECT id FROM games WHERE source = 'smoba' AND source_key = ${battle.battle_id}`;
      if (stored.length && !force && !missing.has(battle.battle_id)) continue;
      requests += 1;
      try {
        const detail = (await getJson(`${baseUrl}/leaguesite/battle/open?battle_id=${battle.battle_id}`)) as { data?: BattleData } | null;
        const data = detail?.data;
        // 空/临时缺字段响应：跳过，绝不清空已经取得的有效数据。
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
      } catch (e) {
        // 单局失败不终止整轮；计入失败与预算，下一轮继续。
        failed += 1;
        error = String(e instanceof Error ? e.message : e).slice(0, 200);
      }
    }
    return { error };
  };

  // 近期复查用独立额度（最多 1/3 预算），先于历史补全，避免官方迟到数据被历史回填排到最后。
  const recheckBudget = rechecks.length ? Math.max(1, Math.floor(battlesPerRun / 3)) : 0;
  let recheckUsed = 0;
  for (const match of rechecks) {
    if (recheckUsed >= recheckBudget) break;
    const before = requests;
    const { error } = await fetchMatchBattles(match, true);
    recheckUsed += requests - before;
    backfill[match.id] = { attempts: backfill[match.id]?.attempts ?? 0, lastAt: new Date().toISOString(), recheckedAt: new Date().toISOString(), ...(error ? { reason: error } : {}) };
  }

  // 历史补全：持续失败的比赛 attempts 递增、排到后面；达到上限的记为“覆盖受限”。
  const coverageLimited: string[] = [];
  const ordered = [...incomplete].sort((a, b) =>
    (backfill[a.id]?.attempts ?? 0) - (backfill[b.id]?.attempts ?? 0) ||
    (Date.parse(b.played_at ?? "") || 0) - (Date.parse(a.played_at ?? "") || 0));
  for (const match of ordered) {
    if (requests >= battlesPerRun) break;
    const attempts = backfill[match.id]?.attempts ?? 0;
    if (attempts >= MAX_MATCH_ATTEMPTS) {
      coverageLimited.push(match.source_key);
      continue;
    }
    const { error } = await fetchMatchBattles(match, false);
    backfill[match.id] = { attempts: attempts + 1, lastAt: new Date().toISOString(), ...(error ? { reason: error } : {}) };
  }
  // 只保留仍与当前候选相关的记录，游标不会随着赛季无限增长。
  const keep = new Set(candidates.map((c) => c.id));
  for (const id of Object.keys(backfill)) if (!keep.has(id)) delete backfill[id];

  return {
    found: rows.length, created, revised, battles,
    detail: { league: leagueId, matches: rows.length, matchesCreated: created, matchesRevised: revised, battles, requests, failed, rechecks: rechecks.length, coverageLimited: coverageLimited.length },
    cursor: { ...(source.cursor ?? {}), lastLeagueFetch: new Date().toISOString(), backfill, ...(coverageLimited.length ? { coverageLimited } : {}) },
  };
}

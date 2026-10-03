// KPL 历史数据一次性回灌：从官方赛事接口拉取赛季、赛程、赛果与全部对局（BO 小局、BP、选手单局数据）。
// 幂等：已入库的对局自动跳过，中断后重跑继续。运行：node --env-file-if-exists=.env scripts/import-kpl-history.ts
// 可选参数：--from=2019 --to=2026 --leagues=20260001,20260002（默认按 from/to 枚举春夏两季）
import { sql, closeDb } from "@aihot/backend/db";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { beijingTime, ensureSeason, ensureTeam, upsertGame, upsertMatch, SMOBA_BASE, type BpEntry, type BattlePlayer } from "@aihot/backend/kb/upsert";

const args = process.argv.slice(2);
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const from = Number(opt("from") ?? 2019);
const to = Number(opt("to") ?? 2026);
const LEAGUE_IDS = opt("leagues")
  ? opt("leagues")!.split(",").filter(Boolean)
  // 每年枚举 0001-0004：2026 年起 0002 是 KCC 杯赛、0003 是夏季赛、0004 是年度总决赛；不存在的序号自动跳过。
  : Array.from({ length: to - from + 1 }, (_, i) => String(from + i)).flatMap((y) => ["0001", "0002", "0003", "0004"].map((n) => y + n));

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function getJson<T>(url: string): Promise<T | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await guardedFetch(url, { headers: { "user-agent": UA, origin: "https://pvp.qq.com", referer: "https://pvp.qq.com/" }, timeoutMs: 25_000 });
      if (res.status === 404) return null;
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      return JSON.parse(res.text()) as T;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error("unreachable");
}

interface CampRow { team_id: string; team_name: string; team_abbreviation?: string | null; team_icon?: string | null; score?: number | null }
interface MatchRow { match_id: string; bo: number; status: number; win_camp: number | null; start_time: string | null; end_time: string | null; match_stage_name?: string | null; match_stage_desc?: string | null; cc_match_id?: string | null; camp1: CampRow; camp2: CampRow }
interface BattleRow { battle_id: string; status: number; win_camp: number | null; game_duration: number | null; battle_seq: number }
interface BattleData { battle_id: string; status: number; win_camp: number | null; game_duration: number | null; battle_seq: number; camp1: { team_id: string; kill_num?: number; gold?: number }; camp2: { team_id: string; kill_num?: number; gold?: number }; battle_player_list: BattlePlayer[]; bp_list: BpEntry[] }

let battles = 0;
let skipped = 0;

async function importLeague(leagueId: string): Promise<void> {
  const payload = (await getJson<{ results?: MatchRow[] }>(`${SMOBA_BASE}/leaguesite/matches/open?league_id=${leagueId}`));
  const rows = payload?.results ?? [];
  if (!rows.length) {
    console.log(`league ${leagueId}: 无数据，跳过`);
    return;
  }
  const seasonId = await ensureSeason(sql, leagueId, rows[0]?.cc_match_id ?? null);
  const teams = new Map<string, string>();
  let created = 0;
  let revised = 0;
  for (const row of rows) {
    for (const camp of [row.camp1, row.camp2]) {
      if (camp?.team_id && !teams.has(camp.team_id)) {
        teams.set(camp.team_id, await ensureTeam(sql, { externalId: camp.team_id, name: camp.team_name, shortName: camp.team_abbreviation ?? null, logoUrl: camp.team_icon ?? null }));
      }
    }
    const campTeams: { 1?: string | null; 2?: string | null } = { 1: teams.get(row.camp1?.team_id ?? "") ?? null, 2: teams.get(row.camp2?.team_id ?? "") ?? null };
    if (!campTeams[1] || !campTeams[2]) continue;
    const finished = row.status === 2 || row.win_camp === 1 || row.win_camp === 2;
    const res = await upsertMatch(sql, {
      leagueId, matchId: row.match_id, seasonId,
      ccKey: row.cc_match_id ?? null,
      stage: row.match_stage_desc || row.match_stage_name || null,
      bo: row.bo ?? null,
      teamAId: campTeams[1]!, teamBId: campTeams[2]!,
      scoreA: Number(row.camp1?.score ?? 0), scoreB: Number(row.camp2?.score ?? 0),
      winnerId: finished && row.win_camp ? campTeams[row.win_camp as 1 | 2] ?? null : null,
      status: finished ? "finished" : row.status === 1 ? "live" : "scheduled",
      scheduledAt: beijingTime(row.start_time), playedAt: beijingTime(row.end_time),
      sourceUrl: "https://pvp.qq.com/matchdata/schedule.html?league_id=" + leagueId,
      raw: row,
    });
    if (res.created) created += 1;
    else if (res.revised) revised += 1;
  }
  console.log(`league ${leagueId}: ${rows.length} 场比赛（新 ${created}，更新 ${revised}），开始回灌对局…`);

  const stored = new Set((await sql<{ source_key: string }[]>`SELECT g.source_key FROM games g JOIN matches m ON m.id = g.match_id WHERE m.season_id = ${seasonId}`).map((r) => r.source_key));
  for (const row of rows) {
    if (row.status !== 2 && row.win_camp !== 1 && row.win_camp !== 2) continue;
    const list = (await getJson<{ results?: BattleRow[] }>(`${SMOBA_BASE}/leaguesite/match/battles/open?match_id=${row.match_id}`));
    const battleRows = list?.results ?? [];
    if (battleRows.length) {
      await sql`UPDATE matches SET games_expected = ${battleRows.length} WHERE id = ${["kpl", leagueId, row.match_id].join("-")}`;
    }
    const matchId = ["kpl", leagueId, row.match_id].join("-");
    const [matchRow] = await sql<{ team_a_id: string; team_b_id: string; played_at: Date | null }[]>`SELECT team_a_id, team_b_id, played_at FROM matches WHERE id = ${matchId}`;
    if (!matchRow) continue;
    for (const battle of battleRows) {
      if (stored.has(battle.battle_id)) {
        skipped += 1;
        continue;
      }
      const detail = (await getJson<{ data?: BattleData }>(`${SMOBA_BASE}/leaguesite/battle/open?battle_id=${battle.battle_id}`))?.data;
      if (!detail) continue;
      await upsertGame(sql, {
        matchId, bo: row.bo ?? null, battleId: detail.battle_id, battleSeq: detail.battle_seq ?? battle.battle_seq,
        status: detail.status ?? battle.status, winCamp: detail.win_camp ?? battle.win_camp,
        durationMs: detail.game_duration ?? battle.game_duration, teamAId: matchRow.team_a_id, teamBId: matchRow.team_b_id,
        campTeams: { 1: matchRow.team_a_id, 2: matchRow.team_b_id },
        kills: { 1: detail.camp1?.kill_num ?? null, 2: detail.camp2?.kill_num ?? null },
        golds: { 1: detail.camp1?.gold ?? null, 2: detail.camp2?.gold ?? null },
        bpList: detail.bp_list ?? [], players: detail.battle_player_list ?? [],
        playedAt: beijingTime(matchRow.played_at), raw: detail,
      });
      battles += 1;
      if (battles % 100 === 0) console.log(`  … 已入库 ${battles} 局（跳过 ${skipped} 局已存）`);
    }
  }
}

for (const leagueId of LEAGUE_IDS) {
  await importLeague(leagueId);
}
console.log(`完成：本次新入库 ${battles} 局，跳过已存 ${skipped} 局`);
await closeDb();

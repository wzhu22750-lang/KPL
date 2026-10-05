// 把历届赛事荣誉（industry/kpl-entities/honors.json）导入 team_honors / player_honors。
// 幂等：ON CONFLICT (team_id, season_id, kind) / (player_id, season_id, kind) 覆盖种子字段；
// 历史战队（AS仙阁）与缺失的赛季行在此建档；选手冠军成员（决赛出场的冠军方）从已入库的决赛对局推导。
// 运行：node --env-file-if-exists=.env scripts/seed-kpl-honors.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

const DIR = path.join(REPO_ROOT, "industry/kpl-entities");

interface SeasonSeed { id: string; name: string; year: number; split: string }
interface TeamSeed { id: string; name: string; short_name: string; is_active: boolean; sort_weight: number; note: string }
interface PlayerSeed { nickname: string; position: string; is_active: boolean; bio: string }
interface EventSeed {
  season: string; year: number; title: string;
  champion: string; runnerUp: string;
  fmvp?: string; championNote?: string; runnerUpNote?: string;
}

const pack = JSON.parse(readFileSync(path.join(DIR, "honors.json"), "utf8")) as {
  seasons: SeasonSeed[]; teams: TeamSeed[]; teamHistory: Record<string, string[]>; players: PlayerSeed[]; events: EventSeed[];
};

for (const s of pack.seasons) {
  await sql`
    INSERT INTO seasons (id, name, year, split)
    VALUES (${s.id}, ${s.name}, ${s.year}, ${s.split})
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, year = EXCLUDED.year, split = EXCLUDED.split`;
}

for (const t of pack.teams) {
  await sql`
    INSERT INTO teams (id, slug, name, short_name, is_active, sort_weight, style_notes, league)
    VALUES (${t.id}, ${t.id}, ${t.name}, ${t.short_name}, ${t.is_active}, ${t.sort_weight}, ${t.note}, 'KPL')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name, updated_at = now()`;
}

// 历史更名映射：并入 history_names（只增不删）。
for (const [teamId, names] of Object.entries(pack.teamHistory)) {
  await sql`
    UPDATE teams SET history_names = (
      SELECT array_agg(DISTINCT n) FROM unnest(coalesce(teams.history_names, '{}') || ${names}::text[]) AS n
    ), updated_at = now()
    WHERE id = ${teamId}`;
}

for (const p of pack.players) {
  await sql`
    INSERT INTO players (id, slug, nickname, position, is_active, bio)
    VALUES (${p.nickname}, ${p.nickname}, ${p.nickname}, ${p.position}, ${p.is_active}, ${p.bio})
    ON CONFLICT (id) DO NOTHING`;
}

async function playerIdOf(nickname: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`SELECT id FROM players WHERE nickname = ${nickname} LIMIT 1`;
  if (row) return row.id;
  // FMVP 得主理应在库；缺档时先建一个占位档案（后台可再补全）。
  await sql`
    INSERT INTO players (id, slug, nickname, is_active, bio)
    VALUES (${nickname}, ${nickname}, ${nickname}, false, '荣誉种子建档（暂无详细档案）。')
    ON CONFLICT (id) DO NOTHING`;
  return nickname;
}

let teamHonorRows = 0;
let playerHonorRows = 0;
let championRosterRows = 0;

for (const e of pack.events) {
  // 冠军 / 亚军 / 该届 FMVP（FMVP 属于冠军队伍的团队荣誉注脚）。
  for (const [kind, teamId, note] of [
    ["champion", e.champion, e.championNote ?? null],
    ["runner_up", e.runnerUp, e.runnerUpNote ?? null],
  ] as const) {
    const rows = await sql`
      INSERT INTO team_honors (team_id, season_id, kind, year, title, note)
      VALUES (${teamId}, ${e.season}, ${kind}, ${e.year}, ${e.title}, ${note})
      ON CONFLICT (team_id, season_id, kind) DO UPDATE SET year = EXCLUDED.year, title = EXCLUDED.title, note = EXCLUDED.note`;
    teamHonorRows += rows.length;
  }
  if (e.fmvp) {
    const pid = await playerIdOf(e.fmvp);
    await sql`
      INSERT INTO team_honors (team_id, season_id, kind, year, title, note)
      VALUES (${e.champion}, ${e.season}, 'fmvp', ${e.year}, ${e.title}, ${`FMVP：${e.fmvp}`})
      ON CONFLICT (team_id, season_id, kind) DO UPDATE SET year = EXCLUDED.year, title = EXCLUDED.title, note = EXCLUDED.note`;
    teamHonorRows += 1;
    const rows = await sql`
      INSERT INTO player_honors (player_id, team_id, season_id, kind, year, title)
      VALUES (${pid}, ${e.champion}, ${e.season}, 'fmvp', ${e.year}, ${e.title})
      ON CONFLICT (player_id, season_id, kind) DO UPDATE SET team_id = EXCLUDED.team_id, year = EXCLUDED.year, title = EXCLUDED.title`;
    playerHonorRows += rows.length;
  }

  // 冠军成员：从已入库的决赛对局推导——该赛季两支决赛队伍的最后一交手（冠军按比分胜出），
  // 冠军方在这场比赛出过场的选手都记一条 champion 荣誉。2016–2018 等没有对局数据的赛事自然跳过。
  const [finals] = await sql<{ id: string }[]>`
    SELECT m.id FROM matches m
    WHERE m.season_id = ${e.season} AND m.status = 'finished'
      AND m.team_a_id IN (${e.champion}, ${e.runnerUp}) AND m.team_b_id IN (${e.champion}, ${e.runnerUp})
      AND m.team_a_id <> m.team_b_id
      AND (m.winner_id = ${e.champion} OR (m.winner_id IS NULL AND (
        (m.team_a_id = ${e.champion} AND m.score_a > m.score_b) OR (m.team_b_id = ${e.champion} AND m.score_b > m.score_a))))
    ORDER BY coalesce(m.played_at, m.scheduled_at) DESC NULLS LAST
    LIMIT 1`;
  if (!finals) continue;
  // 早期赛季的部分对局没有可解析的选手身份（player_id 是 'player' 占位），只认真实选手。
  const roster = await sql<{ player_id: string }[]>`
    SELECT DISTINCT pg.player_id FROM games g JOIN player_games pg ON pg.game_id = g.id
    JOIN players p ON p.id = pg.player_id
    WHERE g.match_id = ${finals.id} AND pg.team_id = ${e.champion} AND pg.player_id <> 'player'`;
  for (const r of roster) {
    const rows = await sql`
      INSERT INTO player_honors (player_id, team_id, season_id, kind, year, title, note)
      VALUES (${r.player_id}, ${e.champion}, ${e.season}, 'champion', ${e.year}, ${e.title}, ${e.championNote ?? null})
      ON CONFLICT (player_id, season_id, kind) DO UPDATE SET team_id = EXCLUDED.team_id, year = EXCLUDED.year, title = EXCLUDED.title, note = EXCLUDED.note`;
    playerHonorRows += rows.length;
    championRosterRows += 1;
  }
}

const [honors] = await sql<{ teams: number; players: number }[]>`SELECT count(*)::int AS teams FROM team_honors`;
const [ph] = await sql<{ players: number }[]>`SELECT count(*)::int AS players FROM player_honors`;
console.log(`kpl honors: ${teamHonorRows} team_honor rows, ${playerHonorRows} player_honor rows (${championRosterRows} from champion rosters) — totals: ${honors.teams} / ${ph.players}`);
await closeDb();

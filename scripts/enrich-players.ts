// 选手档案富化：
// 1) real_name / bio 回填（industry/kpl-entities/players-bio.json，真名只收已核实来源）；
// 2) 场上位置：从官方对局数据（player_games.position 的众数，≥3 局）推导，补齐 players.position；
// 3) 转会履历时序修复：多条履历的 left_at 链式补齐为下一段加入日的前一天（不覆盖已有人工值）；
// 4) 附带核实过的个人荣誉与需要建档的元老选手（如梦泪）。
// 运行：node --env-file-if-exists=.env scripts/enrich-players.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

const DIR = path.join(REPO_ROOT, "industry/kpl-entities");

interface BioSeed { nickname: string; realName?: string; bio?: string }
interface ExtraHonor { player: string; kind: string; seasonId: string; year: number; title: string }
interface CreateStint { player: string; teamId: string; joinedAt: string; leftAt?: string }

const pack = JSON.parse(readFileSync(path.join(DIR, "players-bio.json"), "utf8")) as {
  players: BioSeed[]; extraHonors: ExtraHonor[]; createStints: CreateStint[];
};

let bioCount = 0;
for (const p of pack.players) {
  // 档案缺失的元老选手先建档（inactive，无现役队伍）。
  await sql`
    INSERT INTO players (id, slug, nickname, position, is_active)
    VALUES (${p.nickname}, ${p.nickname}, ${p.nickname}, NULL, false)
    ON CONFLICT (id) DO NOTHING`;
  const rows = await sql`
    UPDATE players SET
      real_name = ${p.realName ?? null},
      bio = ${p.bio ?? null},
      updated_at = now()
    WHERE nickname = ${p.nickname}
      AND (real_name IS DISTINCT FROM ${p.realName ?? null} OR bio IS DISTINCT FROM ${p.bio ?? null})`;
  bioCount += rows.length;
}

// 场上位置：官方对局数据的众数（≥3 局才可信），只填空值。
const posRows = await sql<{ player_id: string; position: string; games: number }[]>`
  WITH mode_pos AS (
    SELECT pg.player_id, pg.position, count(*) AS games,
           row_number() OVER (PARTITION BY pg.player_id ORDER BY count(*) DESC, pg.position) AS rn
    FROM player_games pg
    WHERE pg.position IS NOT NULL AND pg.position <> '' AND pg.player_id <> 'player'
    GROUP BY pg.player_id, pg.position
  )
  SELECT player_id, position, games::int FROM mode_pos WHERE rn = 1 AND games >= 3`;
let posCount = 0;
for (const r of posRows) {
  const rows = await sql`
    UPDATE players SET position = ${r.position}, updated_at = now()
    WHERE id = ${r.player_id} AND position IS NULL AND position IS DISTINCT FROM ${r.position}`;
  posCount += rows.length;
}

// 转会履历时序修复：按 joined_at 升序，第 i 段的 left_at = 第 i+1 段 joined_at 的前一天；
// 最后一段是现效力战队，保持 left_at 为空。只补空值，不覆盖人工精确值。
const stintRows = await sql`
  WITH ordered AS (
    SELECT ps.id, ps.left_at,
           lead(ps.joined_at) OVER (PARTITION BY ps.player_id ORDER BY ps.joined_at ASC NULLS LAST, ps.id ASC) AS next_joined,
           row_number() OVER (PARTITION BY ps.player_id ORDER BY ps.joined_at ASC NULLS LAST, ps.id ASC) AS rn,
           count(*) OVER (PARTITION BY ps.player_id) AS total
    FROM player_stints ps
  )
  UPDATE player_stints ps SET left_at = o.next_joined - 1
  FROM ordered o
  WHERE ps.id = o.id AND ps.left_at IS NULL AND o.rn < o.total AND o.next_joined IS NOT NULL`;

for (const h of pack.extraHonors) {
  await sql`
    INSERT INTO player_honors (player_id, team_id, season_id, kind, year, title)
    SELECT p.id, p.current_team_id, ${h.seasonId}, ${h.kind}, ${h.year}, ${h.title}
    FROM players p WHERE p.nickname = ${h.player}
    ON CONFLICT (player_id, season_id, kind) DO UPDATE SET year = EXCLUDED.year, title = EXCLUDED.title`;
}

for (const s of pack.createStints) {
  await sql`
    INSERT INTO player_stints (player_id, team_id, joined_at, left_at)
    SELECT p.id, ${s.teamId}, ${s.joinedAt}::date, ${s.leftAt ?? null}::date FROM players p WHERE p.nickname = ${s.player}
    ON CONFLICT (player_id, team_id, joined_at) DO NOTHING`;
}

const [stats] = await sql<{ players_bio: number; stints_fixed: number; players_with_pos: number }[]>`
  SELECT
    (SELECT count(*)::int FROM players WHERE real_name IS NOT NULL AND bio IS NOT NULL) AS players_bio,
    (SELECT count(*)::int FROM player_stints WHERE left_at IS NOT NULL) AS stints_fixed,
    (SELECT count(*)::int FROM players WHERE position IS NOT NULL) AS players_with_pos`;
console.log(`players enriched: ${bioCount} bio rows written, ${posCount} positions derived (total ${stats.players_with_pos} with position), ${stintRows.count} stints got left_at (total ${stats.stints_fixed}); ${stats.players_bio} players now have real_name+bio`);
await closeDb();

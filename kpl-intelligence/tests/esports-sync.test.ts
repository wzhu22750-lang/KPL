// The esports_api reader against a fake official API: league sync, budgeted battle backfill with
// resumption, idempotent re-runs, and the knowledge-base rows the data lands in (teams, players,
// games, the 20-step BP sequence and per-player stats).
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";

const LEAGUE = "20990001";
let battleDetailHits = 0;
let failingMatch: string | null = null;
let swapCamps = false;
let invalidCamp: string | null = null;

function matchRow(matchId: string, a: { id: string; name: string; score: number }, b: { id: string; name: string; score: number }, winCamp: number, endTime = "2099-01-10 16:44:21") {
  return {
    match_id: matchId, league_id: LEAGUE, bo: 5, status: 2, win_camp: winCamp,
    start_time: "2099-01-10 14:00:00", end_time: endTime,
    match_stage_name: "cgs1", match_stage_desc: "常规赛第一轮", cc_match_id: "KPL2099S1M1W1D1", match_desc: "", match_address: "测试馆",
    camp1: { team_id: a.id, team_name: a.name, team_abbreviation: "A", team_icon: `http://img/${a.id}.png`, is_win: winCamp === 1, score: a.score, rank: 0 },
    camp2: { team_id: b.id, team_name: b.name, team_abbreviation: "B", team_icon: `http://img/${b.id}.png`, is_win: winCamp === 2, score: b.score, rank: 0 },
    match_battle_video_list: [],
  };
}

const TEAMS = { A: { id: "90001", name: "测试A队" }, B: { id: "90002", name: "测试B队" }, C: { id: "90003", name: "测试C队" } };

/** 10 名选手（camp1 英雄 101-105，camp2 英雄 201-205），camp 由 team_id 推出。 */
function players(camp1Team: string, camp2Team: string, mvpCamp: 1 | 2) {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 5; i++) {
    rows.push(playerRow(camp1Team, 1, 100 + i, `Fly${camp1Team}${i}`, i === 3 && mvpCamp === 1));
    rows.push(playerRow(camp2Team, 2, 200 + i, `花海${camp2Team}${i}`, i === 3 && mvpCamp === 2));
  }
  return rows;
}
function playerRow(teamId: string, camp: number, heroId: number, name: string, mvp: boolean) {
  const teamName = Object.values(TEAMS).find((t) => t.id === teamId)!.name;
  return {
    team_id: teamId, team_name: teamName, team_icon: "", camp, hero_id: heroId, hero_name: `英雄${heroId}`, hero_icon: `http://img/hero/${heroId}.jpg`,
    player_name: name, actual_player_name: `${teamName}.${name}`, player_icon: "", position: 7, position_desc: "7/发育路",
    is_mvp: mvp ? 1 : 0, is_lose_mvp: 0, mvp_score: mvp ? 8.5 : 5.2, kill_num: 2, death_num: 1, assist_num: 6,
    gold: 12000, participation_rate: 66, hurt_to_hero_total: 30000, be_hurt_total: 20000, kda: 2.7, hurt_total_rate: 0.3,
    SummonerAbilityInfo: {}, BriefHeroSkillList: [], BriefEquipList: [], symbol_ids: [],
  };
}

function battle(matchId: string, seq: number, winCamp: 1 | 2, camp1Team: string, camp2Team: string) {
  const bans: Array<Record<string, unknown>> = [];
  const picks: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 4; i++) bans.push({ camp: i % 2 + 1, is_ban_or_pick: 0, hero_id: 300 + i, hero_name: `禁用${i}`, hero_icon: "", position: 0 });
  for (let i = 0; i < 6; i++) {
    const camp = i % 2 + 1;
    picks.push({ camp, is_ban_or_pick: 1, hero_id: camp === 1 ? 101 + (i % 5) : 201 + (i % 5), hero_name: "", hero_icon: "", position: 4 });
  }
  for (let i = 0; i < 6; i++) bans.push({ camp: i % 2 + 1, is_ban_or_pick: 0, hero_id: 310 + i, hero_name: `禁用B${i}`, hero_icon: "", position: 0 });
  for (let i = 0; i < 4; i++) {
    const camp = i % 2 + 1;
    picks.push({ camp, is_ban_or_pick: 1, hero_id: camp === 1 ? 101 + i : 201 + i, hero_name: "", hero_icon: "", position: 4 });
  }
  const bpList = [...bans.slice(0, 4), ...picks.slice(0, 6), ...bans.slice(4), ...picks.slice(6)];
  const data = {
    battle_id: `${matchId}_${seq}_1768371100`, status: 2, win_camp: winCamp, game_duration: 944000, battle_seq: seq,
    camp1: { team_id: camp1Team, kill_num: 12, gold: 52000 }, camp2: { team_id: camp2Team, kill_num: 8, gold: 46000 },
    battle_player_list: players(camp1Team, camp2Team, winCamp),
    bp_list: bpList, video_list: [],
  };
  return data;
}

const MATCH1 = { id: "2099010101", a: TEAMS.A, b: TEAMS.B, wins: [1, 1, 2, 1] }; // 3-1，4 局
const MATCH2 = { id: "2099010102", a: TEAMS.C, b: TEAMS.A, wins: [1, 2, 1, 2, 1] }; // 3-2，5 局

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, `http://127.0.0.1`);
  res.writeHead(200, { "content-type": "text/plain" });
  if (url.pathname === "/leaguesite/matches/open") {
    res.end(JSON.stringify({
      results: [
        matchRow(MATCH1.id, { id: MATCH1.a.id, name: MATCH1.a.name, score: 3 }, { id: MATCH1.b.id, name: MATCH1.b.name, score: 1 }, 1),
        matchRow(MATCH2.id, { id: MATCH2.a.id, name: MATCH2.a.name, score: 3 }, { id: MATCH2.b.id, name: MATCH2.b.name, score: 2 }, 1, "2099-01-11 16:44:21"),
      ],
    }));
  } else if (url.pathname === "/leaguesite/match/battles/open") {
    const matchId = url.searchParams.get("match_id");
    const match = matchId === MATCH1.id ? MATCH1 : MATCH2;
    res.end(JSON.stringify({ results: match.wins.map((w, i) => ({ battle_id: `${match.id}_${i + 1}_1768371100`, status: 2, win_camp: w, game_duration: 944000, battle_seq: i + 1 })) }));
  } else if (url.pathname === "/leaguesite/battle/open") {
    battleDetailHits += 1;
    const battleId = url.searchParams.get("battle_id") ?? "";
    if (failingMatch && battleId.includes(failingMatch)) { res.statusCode = 500; res.end("upstream error"); return; }
    const [matchId, seqStr] = battleId.split("_");
    const match = matchId === MATCH1.id ? MATCH1 : MATCH2;
    const seq = Number(seqStr);
    const swapped = swapCamps && seq === 2;
    const camp1Team = swapped ? match.b.id : match.a.id, camp2Team = swapped ? match.a.id : match.b.id;
    const logicalWinner = match.wins[seq - 1] as 1 | 2;
    const winCamp = (swapped ? 3 - logicalWinner : logicalWinner) as 1 | 2;
    const data=battle(matchId, seq, winCamp, camp1Team, camp2Team);
    if(invalidCamp!==null && seq===2) data.camp1.team_id=invalidCamp;
    res.end(JSON.stringify({ data }));
  } else {
    res.end(JSON.stringify({}));
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(async () => { server.close(); await stopBoss(); await closeDb(); });

async function source(battlesPerRun: number) {
  const id = `esports-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, config) VALUES (${id}, 'Esports test', 'esports_api', ${sql.json({ leagueId: LEAGUE, baseUrl: base, battlesPerRun } as never)})`;
  return id;
}

test("esports sync: league rows land, battle backfill respects the budget and resumes, re-runs are idempotent", async () => {
  const id = await source(3);
  const first = await collectSource(id);
  assert.equal(first.status, "ok");
  assert.equal(first.created, 2, "two matches created");
  const [run1] = await sql<{ detail: { battles: number } }[]>`SELECT detail FROM fetch_runs WHERE source_id = ${id} ORDER BY id DESC LIMIT 1`;
  assert.equal(run1!.detail.battles, 3, "the run stores at most battlesPerRun battles");

  await collectSource(id);
  await collectSource(id);
  await collectSource(id);
  const [run4] = await sql<{ detail: { battles: number } }[]>`SELECT detail FROM fetch_runs WHERE source_id = ${id} ORDER BY id DESC LIMIT 1`;
  assert.equal(run4!.detail.battles, 0, "everything is stored after the backfill");
  assert.equal(battleDetailHits, 9, "9 battles total; stored battles never re-fetch their detail");

  const counts = await sql<{ games: number; bp: number; pg: number; matches: number; teams: number; players: number; heroes: number }[]>`
    SELECT (SELECT count(*) FROM games) games, (SELECT count(*) FROM bp_actions) bp, (SELECT count(*) FROM player_games) pg,
           (SELECT count(*) FROM matches) matches, (SELECT count(*) FROM teams) teams, (SELECT count(*) FROM players) players,
           (SELECT count(*) FROM heroes WHERE slug LIKE 'h%') heroes`;
  assert.equal(counts[0]!.matches, 2);
  assert.equal(counts[0]!.games, 9, "4 + 5 battles");
  assert.equal(counts[0]!.bp, 9 * 20, "every game has the full 20-step BP sequence");
  assert.equal(counts[0]!.pg, 9 * 10, "ten player rows per game");
  assert.equal(counts[0]!.teams, 3);
  assert.ok(counts[0]!.players >= 20, "20 distinct players (one per roster slot)");
  assert.ok(counts[0]!.heroes >= 18, "played and banned heroes auto-provisioned");

  const [match] = await sql<{ winner_id: string; score_a: number; score_b: number; status: string; season: string }[]>`
    SELECT m.winner_id, m.score_a, m.score_b, m.status, m.season_id season FROM matches m WHERE m.source_key = ${MATCH1.id}`;
  assert.equal(match!.score_a, 3);
  assert.equal(match!.score_b, 1);
  assert.equal(match!.status, "finished");
  const [winner] = await sql<{ name: string }[]>`SELECT name FROM teams WHERE id = ${match!.winner_id}`;
  assert.equal(winner!.name, TEAMS.A.name);
  const [season] = await sql<{ id: string }[]>`SELECT id FROM seasons WHERE external_id = ${LEAGUE}`;
  assert.equal(season!.id, "kpl-2099-spring");

  const [bp] = await sql<{ picks: number; bans: number }[]>`
    SELECT count(*) FILTER (WHERE action_type = 'pick') picks, count(*) FILTER (WHERE action_type = 'ban') bans
    FROM bp_actions WHERE game_id = ${"kpl-" + LEAGUE + "-" + MATCH1.id + "-g1"}`;
  assert.equal(bp!.picks, 10);
  assert.equal(bp!.bans, 10);
  const [last] = await sql<{ action_type: string }[]>`SELECT action_type FROM bp_actions WHERE game_id = ${"kpl-" + LEAGUE + "-" + MATCH1.id + "-g1"} AND step_index = 20`;
  assert.equal(last!.action_type, "pick", "BP steps keep their 1-20 order");

  const [game] = await sql<{ winner: string; mvp: string; duration: number }[]>`
    SELECT t.name winner, p.nickname mvp, g.duration_secs duration
    FROM games g LEFT JOIN teams t ON t.id = g.winner_id LEFT JOIN players p ON p.id = g.mvp_player_id
    WHERE g.id = ${"kpl-" + LEAGUE + "-" + MATCH2.id + "-g5"}`;
  assert.equal(game!.winner, TEAMS.C.name);
  assert.ok(game!.mvp?.length > 0, "MVP resolved to a player row");
  assert.equal(game!.duration, 944);

  const [roster] = await sql<{ players: number }[]>`
    SELECT count(DISTINCT player_id) players FROM player_games pg JOIN games g ON g.id = pg.game_id
    WHERE g.match_id = ${"kpl-" + LEAGUE + "-" + MATCH1.id}`;
  assert.equal(roster!.players, 10, "the same roster across games resolves to the same player rows");
  const [stint] = await sql<{ stints: number }[]>`
    SELECT count(*) stints FROM player_stints ps JOIN players p ON p.id = ps.player_id WHERE p.nickname LIKE 'Fly%' AND ps.team_id IS NOT NULL`;
  assert.ok(stint!.stints >= 10, "first sight of a player starts a stint on their team");
});

test('esports sync: swapped battle camps preserve winner and align kills/gold to series teams',async()=>{
  const gameId='kpl-'+LEAGUE+'-'+MATCH1.id+'-g2';
  await sql`DELETE FROM bp_actions WHERE game_id=${gameId} AND step_index=1`;
  swapCamps=true;
  try {
    await collectSource(await source(12));
    const [g]=await sql`SELECT t.name AS winner,g.kills_a,g.kills_b,g.gold_a,g.gold_b FROM games g
      LEFT JOIN teams t ON t.id=g.winner_id WHERE g.id=${gameId}`;
    assert.equal(g.winner,TEAMS.A.name,'camp2 in this battle is team A, not team B');
    assert.deepEqual([g.kills_a,g.kills_b,g.gold_a,g.gold_b],[8,12,46000,52000]);
  } finally {swapCamps=false;}
});

test('esports sync: missing, foreign or duplicate camp identities do not erase a valid game',async()=>{
  const gameId='kpl-'+LEAGUE+'-'+MATCH1.id+'-g2';
  const [before]=await sql`SELECT winner_id,kills_a,kills_b,raw FROM games WHERE id=${gameId}`;
  try {
    for(const badId of ['',TEAMS.C.id,TEAMS.B.id]) {
      await sql`DELETE FROM bp_actions WHERE game_id=${gameId} AND step_index=1`;
      invalidCamp=badId;
      const id=await source(12);
      await collectSource(id);
      const [after]=await sql`SELECT winner_id,kills_a,kills_b,raw FROM games WHERE id=${gameId}`;
      assert.deepEqual(after,before);
      const [run]=await sql`SELECT detail FROM fetch_runs WHERE source_id=${id} ORDER BY id DESC LIMIT 1`;
      assert.equal(run.detail.failed,1);
    }
  } finally {invalidCamp=null;}
});

test("esports sync: 小局存在但 BP/选手数据缺失时按字段补全", async () => {
  const id = await source(12);
  await collectSource(id);
  const gameId = "kpl-" + LEAGUE + "-" + MATCH1.id + "-g1";
  await sql`DELETE FROM bp_actions WHERE game_id = ${gameId}`;
  await sql`DELETE FROM player_games WHERE game_id = ${gameId}`;
  const res = await collectSource(id);
  assert.equal(res.status, "ok");
  const [bp] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM bp_actions WHERE game_id = ${gameId}`;
  const [pg] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM player_games WHERE game_id = ${gameId}`;
  assert.equal(bp!.n, 20, "缺失的 BP 被补回");
  assert.equal(pg!.n, 10, "缺失的选手数据被补回");
});

test("esports sync: 单场持续失败不阻挡近期比赛，且每轮请求数受预算约束", async () => {
  await sql`DELETE FROM games WHERE match_id IN (${'kpl-' + LEAGUE + '-' + MATCH1.id}, ${'kpl-' + LEAGUE + '-' + MATCH2.id})`;
  const id = await source(1);
  failingMatch = MATCH1.id;
  battleDetailHits = 0;
  try {
    for (let i = 0; i < 10; i++) {
      const run = await collectSource(id);
      assert.equal(run.status, "ok", "单场失败不使整轮失败");
    }
  } finally {
    failingMatch = null;
  }
  const [stored] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM games WHERE match_id = ${'kpl-' + LEAGUE + '-' + MATCH2.id}`;
  assert.equal(stored!.n, 5, "近期比赛在旧比赛持续失败时仍全部补全");
});

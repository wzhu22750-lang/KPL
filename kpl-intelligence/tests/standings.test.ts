import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { loadStandings } from "@aihot/backend/kb/read";

after(closeDb);

test("annual arena: cross-group opponents must be ranked separately, including unplayed teams", async () => {
  const season = "standings-2026-annual";
  await sql`INSERT INTO seasons(id,name,year,split,external_id) VALUES (${season},'2026年KPL年度总决赛',2026,'annual','20260004')`;
  const slugs = ['wolves','ag','jdg','ttg','ksg','wb','tes-a','edgm','lgd-nbw','dyg','rw','hero'];
  for (const slug of slugs) await sql`INSERT INTO teams(id,slug,name) VALUES (${slug},${slug},${slug})`;
  for (const [id, a, b, status, sa, sb, winner, date] of [
    ['one','wolves','tes-a','finished',3,1,'wolves','2026-10-02'],
    ['two','ag','tes-a','finished',0,3,'tes-a','2026-10-03'],
    ['three','wolves','edgm','scheduled',0,0,null,'2026-10-10'],
    ['invalid','jdg','hero','finished',0,0,null,'2026-10-04'],
  ] as const) await sql`INSERT INTO matches(id,season_id,stage,bo,team_a_id,team_b_id,status,score_a,score_b,winner_id,scheduled_at,played_at)
    VALUES (${id},${season},'擂台赛',5,${a},${b},${status},${sa},${sb},${winner},${date},${status === 'finished' ? date : null})`;
  await sql`INSERT INTO seasons(id,name,year,split) VALUES ('standings-old','2025春季赛',2025,'spring'),('standings-new','2027春季赛',2027,'spring')`;
  for (const [id,seasonId,stage,date] of [
    ['old','standings-old','常规赛第二轮','2025-03-01'],
    ['r2','standings-new','常规赛第二轮','2027-03-01'],
    ['r3','standings-new','常规赛第三轮','2027-04-01'],
  ] as const) await sql`INSERT INTO matches(id,season_id,stage,bo,team_a_id,team_b_id,status,scheduled_at)
    VALUES (${id},${seasonId},${stage},5,'wolves','ag','scheduled',${date})`;
  await sql`UPDATE matches SET status='finished',score_a=3,score_b=1,winner_id='wolves',played_at=scheduled_at WHERE id='r3'`;
  const result = await loadStandings({season});
  assert.ok(result);
  assert.deepEqual(Object.keys(result.standingsByGroup), ['大师组','精英组']);
  assert.equal(result.standingsByGroup['大师组']!.length,6);
  assert.equal(result.standingsByGroup['精英组']!.length,6);
  const wolf = result.standingsByGroup['大师组']!.find(r => r.team.slug === 'wolves')!;
  assert.deepEqual([wolf.matchesPlayed,wolf.wins,wolf.losses,wolf.points,wolf.gameDiff],[1,1,0,1,2]);
  const tes = result.standingsByGroup['精英组']!.find(r => r.team.slug === 'tes-a')!;
  assert.deepEqual([tes.matchesPlayed,tes.wins,tes.losses,tes.gamesWon,tes.gamesLost,tes.gameDiff],[2,1,1,4,3,1]);
  assert.equal(result.standingsByGroup['大师组']!.find(r => r.team.slug === 'jdg')!.matchesPlayed,0);
  assert.equal(result.standingsByGroup['精英组']!.find(r => r.team.slug === 'edgm')!.matchesPlayed,0);
  const latest = await loadStandings();
  assert.equal(latest?.season.id,'standings-new');
  assert.equal(latest?.currentStage,'常规赛第三轮');
  assert.ok(latest?.stages.includes('常规赛第三轮'));
  const third = await loadStandings({season:'standings-new',stage:'常规赛第三轮'});
  assert.equal(third?.currentStage,'常规赛第三轮');
});

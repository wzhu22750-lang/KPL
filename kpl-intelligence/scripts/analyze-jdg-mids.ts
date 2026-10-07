/**
 * scripts/analyze-jdg-mids.ts
 * 
 * 自动化从生产级数据库中提取并聚合 JDG 中单双子星（昊昊 vs 清融）全维度量化指标
 * 支撑终极对比研报的技术实现脚本
 */

import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const sql = postgres(databaseUrl, { ssl: "require" });

export interface FullDossierData {
  profiles: any[];
  honors: any[];
  stints: any[];
  careerSeasons: any[];
  jdgOverall: any[];
  summer2026ControlGroup: any[];
  summer2026TeamShares: any[];
  summer2026TeammateImpact: any[];
  summer2026Sides: any[];
  haohaoHeroPool: any[];
  qingrongSummerHeroPool: any[];
  qingrongJDGHeroPool: any[];
  qingrongCareerHeroPool: any[];
  opponentBans: any[];
  annualFinalsGames: any[];
  recentArticles: any[];
}

export async function extractDossier(): Promise<FullDossierData> {
  // 1. 基础档案
  const profiles = await sql`
    SELECT p.*, t.name as team_name, t.short_name as team_short_name
    FROM players p
    LEFT JOIN teams t ON p.current_team_id = t.id
    WHERE p.id IN ('昊昊', '清融')
    ORDER BY p.id;
  `;

  // 2. 荣誉成就
  const honors = await sql`
    SELECT ph.*, s.name as season_name
    FROM player_honors ph
    LEFT JOIN seasons s ON ph.season_id = s.id
    WHERE ph.player_id IN ('昊昊', '清融')
    ORDER BY ph.year ASC, ph.id ASC;
  `;

  // 3. 俱乐部履历
  const stints = await sql`
    SELECT ps.*, t.name as team_name, t.short_name as team_short_name
    FROM player_stints ps
    JOIN teams t ON ps.team_id = t.id
    WHERE ps.player_id IN ('昊昊', '清融')
    ORDER BY ps.player_id, ps.joined_at ASC;
  `;

  // 4. 生涯分赛季概览
  const careerSeasons = await sql`
    SELECT 
      pg.player_id,
      m.season_id,
      s.name as season_name,
      pg.team_id,
      t.short_name as team_name,
      count(*) as games,
      count(*) FILTER (WHERE g.winner_id = pg.team_id) as wins,
      round(count(*) FILTER (WHERE g.winner_id = pg.team_id)::numeric / count(*) * 100, 2) as win_rate,
      count(*) FILTER (WHERE pg.mvp = true) as mvps,
      count(*) FILTER (WHERE pg.lose_mvp = true) as lose_mvps
    FROM player_games pg
    JOIN games g ON pg.game_id = g.id
    JOIN matches m ON g.match_id = m.id
    LEFT JOIN seasons s ON m.season_id = s.id
    LEFT JOIN teams t ON pg.team_id = t.id
    WHERE pg.player_id IN ('昊昊', '清融')
    GROUP BY pg.player_id, m.season_id, s.name, pg.team_id, t.short_name
    ORDER BY pg.player_id, m.season_id DESC;
  `;

  // 5. JDG 效力全周期基础战斗数据
  const jdgOverall = await sql`
    SELECT 
      pg.player_id,
      count(*) as games,
      count(*) FILTER (WHERE g.winner_id = 'jdg') as wins,
      round(count(*) FILTER (WHERE g.winner_id = 'jdg')::numeric / count(*) * 100, 2) as win_rate,
      round(avg(pg.kills), 2) as avg_kills,
      round(avg(pg.deaths), 2) as avg_deaths,
      round(avg(pg.assists), 2) as avg_assists,
      round((sum(pg.kills) + sum(pg.assists))::numeric / nullif(sum(pg.deaths), 0), 2) as kda,
      round(avg(pg.damage_to_hero), 0) as avg_damage,
      round(avg(pg.damage_taken), 0) as avg_damage_taken,
      round(avg(pg.gold), 0) as avg_gold,
      round(avg(pg.damage_to_hero::numeric / nullif(g.duration_secs, 0) * 60), 0) as dpm,
      round(avg(pg.damage_taken::numeric / nullif(g.duration_secs, 0) * 60), 0) as dtpm,
      round(avg(pg.gold::numeric / nullif(g.duration_secs, 0) * 60), 0) as gpm,
      round(avg(pg.damage_to_hero::numeric / nullif(pg.gold, 0) * 100), 2) as dmg_gold_ratio,
      round(avg(pg.participation_rate), 2) as avg_part_rate,
      count(*) FILTER (WHERE pg.mvp = true) as mvps,
      count(*) FILTER (WHERE pg.lose_mvp = true) as lose_mvps,
      round(avg(g.duration_secs)::numeric / 60, 2) as avg_duration_mins
    FROM player_games pg
    JOIN games g ON pg.game_id = g.id
    WHERE pg.player_id IN ('昊昊', '清融') AND pg.team_id = 'jdg'
    GROUP BY pg.player_id;
  `;

  // 6. 2026 夏季赛同队严格控制变量
  const summer2026ControlGroup = await sql`
    SELECT 
      pg.player_id,
      count(*) as games,
      count(*) FILTER (WHERE g.winner_id = 'jdg') as wins,
      round(count(*) FILTER (WHERE g.winner_id = 'jdg')::numeric / count(*) * 100, 2) as win_rate,
      round(avg(pg.kills), 2) as avg_kills,
      round(avg(pg.deaths), 2) as avg_deaths,
      round(avg(pg.assists), 2) as avg_assists,
      round((sum(pg.kills) + sum(pg.assists))::numeric / nullif(sum(pg.deaths), 0), 2) as kda,
      round(avg(pg.damage_to_hero), 0) as avg_damage,
      round(avg(pg.damage_taken), 0) as avg_damage_taken,
      round(avg(pg.gold), 0) as avg_gold,
      round(avg(pg.damage_to_hero::numeric / nullif(g.duration_secs, 0) * 60), 0) as dpm,
      round(avg(pg.damage_taken::numeric / nullif(g.duration_secs, 0) * 60), 0) as dtpm,
      round(avg(pg.gold::numeric / nullif(g.duration_secs, 0) * 60), 0) as gpm,
      round(avg(pg.damage_to_hero::numeric / nullif(pg.gold, 0) * 100), 2) as dmg_gold_ratio,
      round(avg(pg.participation_rate), 2) as avg_part_rate,
      count(*) FILTER (WHERE pg.mvp = true) as mvps,
      count(*) FILTER (WHERE pg.lose_mvp = true) as lose_mvps,
      round(avg(g.duration_secs)::numeric / 60, 2) as avg_duration_mins
    FROM player_games pg
    JOIN games g ON pg.game_id = g.id
    JOIN matches m ON g.match_id = m.id
    WHERE pg.player_id IN ('昊昊', '清融') AND pg.team_id = 'jdg' AND m.season_id = 'kpl-2026-summer'
    GROUP BY pg.player_id;
  `;

  // 7. 2026 夏季赛团队占比 (伤害占比、经济占比、承伤占比、经济效率)
  const summer2026TeamShares = await sql`
    WITH team_totals AS (
      SELECT 
        game_id,
        team_id,
        sum(gold) as team_gold,
        sum(damage_to_hero) as team_damage,
        sum(damage_taken) as team_damage_taken
      FROM player_games
      WHERE team_id = 'jdg'
      GROUP BY game_id, team_id
    )
    SELECT 
      pg.player_id,
      count(*) as games,
      round(avg(pg.damage_to_hero::numeric / nullif(tt.team_damage, 0) * 100), 2) as avg_damage_share,
      round(avg(pg.damage_taken::numeric / nullif(tt.team_damage_taken, 0) * 100), 2) as avg_damage_taken_share,
      round(avg(pg.gold::numeric / nullif(tt.team_gold, 0) * 100), 2) as avg_gold_share,
      round(avg((pg.damage_to_hero::numeric / nullif(tt.team_damage, 0)) / nullif(pg.gold::numeric / nullif(tt.team_gold, 0), 0)), 2) as economic_efficiency
    FROM player_games pg
    JOIN games g ON pg.game_id = g.id
    JOIN matches m ON g.match_id = m.id
    JOIN team_totals tt ON pg.game_id = tt.game_id AND pg.team_id = tt.team_id
    WHERE pg.player_id IN ('昊昊', '清融') AND m.season_id = 'kpl-2026-summer'
    GROUP BY pg.player_id;
  `;

  // 8. 2026 夏季赛控制变量下队友受影响度
  const summer2026TeammateImpact = await sql`
    SELECT 
      pg_mid.player_id as mid_laner,
      pg_t.position,
      pg_t.player_id,
      count(*) as games,
      round(avg(pg_t.kills), 2) as avg_kills,
      round(avg(pg_t.deaths), 2) as avg_deaths,
      round(avg(pg_t.assists), 2) as avg_assists,
      round(avg(pg_t.damage_to_hero::numeric / nullif(g.duration_secs, 0) * 60), 0) as dpm,
      round(avg(pg_t.gold::numeric / nullif(g.duration_secs, 0) * 60), 0) as gpm,
      round(avg(pg_t.participation_rate), 2) as avg_part_rate
    FROM player_games pg_mid
    JOIN games g ON pg_mid.game_id = g.id
    JOIN matches m ON g.match_id = m.id
    JOIN player_games pg_t ON pg_t.game_id = g.id AND pg_t.team_id = 'jdg' AND pg_t.position != '中路'
    WHERE pg_mid.player_id IN ('昊昊', '清融')
      AND pg_mid.team_id = 'jdg'
      AND m.season_id = 'kpl-2026-summer'
    GROUP BY pg_mid.player_id, pg_t.position, pg_t.player_id
    ORDER BY pg_t.position, mid_laner;
  `;

  // 9. 蓝红方阵营数据
  const summer2026Sides = await sql`
    SELECT 
      pg.player_id,
      pg.side,
      count(*) as games,
      count(*) FILTER (WHERE g.winner_id = 'jdg') as wins,
      round(count(*) FILTER (WHERE g.winner_id = 'jdg')::numeric / count(*) * 100, 2) as win_rate,
      round((sum(pg.kills) + sum(pg.assists))::numeric / nullif(sum(pg.deaths), 0), 2) as kda,
      round(avg(pg.damage_to_hero::numeric / nullif(g.duration_secs, 0) * 60), 0) as dpm
    FROM player_games pg
    JOIN games g ON pg.game_id = g.id
    JOIN matches m ON g.match_id = m.id
    WHERE pg.player_id IN ('昊昊', '清融')
      AND pg.team_id = 'jdg'
      AND m.season_id = 'kpl-2026-summer'
    GROUP BY pg.player_id, pg.side
    ORDER BY pg.player_id, pg.side;
  `;

  // 10. 英雄池明细
  const haohaoHeroPool = await sql`
    SELECT 
      pg.hero_id, h.name as hero_name, count(*) as picks,
      count(*) FILTER (WHERE g.winner_id = pg.team_id) as wins,
      round(count(*) FILTER (WHERE g.winner_id = pg.team_id)::numeric / count(*) * 100, 1) as win_rate,
      round(avg(pg.kills), 1) as avg_k,
      round(avg(pg.deaths), 1) as avg_d,
      round(avg(pg.assists), 1) as avg_a,
      round((sum(pg.kills) + sum(pg.assists))::numeric / nullif(sum(pg.deaths), 0), 2) as kda,
      round(avg(pg.damage_to_hero::numeric / nullif(g.duration_secs, 0) * 60), 0) as dpm,
      count(*) FILTER (WHERE pg.mvp = true) as mvps
    FROM player_games pg
    JOIN heroes h ON pg.hero_id = h.id
    JOIN games g ON pg.game_id = g.id
    WHERE pg.player_id = '昊昊'
    GROUP BY pg.hero_id, h.name
    ORDER BY picks DESC, wins DESC;
  `;

  const qingrongSummerHeroPool = await sql`
    SELECT 
      pg.hero_id, h.name as hero_name, count(*) as picks,
      count(*) FILTER (WHERE g.winner_id = pg.team_id) as wins,
      round(count(*) FILTER (WHERE g.winner_id = pg.team_id)::numeric / count(*) * 100, 1) as win_rate,
      round(avg(pg.kills), 1) as avg_k,
      round(avg(pg.deaths), 1) as avg_d,
      round(avg(pg.assists), 1) as avg_a,
      round((sum(pg.kills) + sum(pg.assists))::numeric / nullif(sum(pg.deaths), 0), 2) as kda,
      round(avg(pg.damage_to_hero::numeric / nullif(g.duration_secs, 0) * 60), 0) as dpm,
      count(*) FILTER (WHERE pg.mvp = true) as mvps
    FROM player_games pg
    JOIN heroes h ON pg.hero_id = h.id
    JOIN games g ON pg.game_id = g.id
    JOIN matches m ON g.match_id = m.id
    WHERE pg.player_id = '清融' AND m.season_id = 'kpl-2026-summer'
    GROUP BY pg.hero_id, h.name
    ORDER BY picks DESC, wins DESC;
  `;

  const qingrongJDGHeroPool = await sql`
    SELECT 
      pg.hero_id, h.name as hero_name, count(*) as picks,
      count(*) FILTER (WHERE g.winner_id = pg.team_id) as wins,
      round(count(*) FILTER (WHERE g.winner_id = pg.team_id)::numeric / count(*) * 100, 1) as win_rate,
      round((sum(pg.kills) + sum(pg.assists))::numeric / nullif(sum(pg.deaths), 0), 2) as kda,
      round(avg(pg.damage_to_hero::numeric / nullif(g.duration_secs, 0) * 60), 0) as dpm,
      count(*) FILTER (WHERE pg.mvp = true) as mvps
    FROM player_games pg
    JOIN heroes h ON pg.hero_id = h.id
    JOIN games g ON pg.game_id = g.id
    WHERE pg.player_id = '清融' AND pg.team_id = 'jdg'
    GROUP BY pg.hero_id, h.name
    ORDER BY picks DESC, wins DESC
    LIMIT 20;
  `;

  const qingrongCareerHeroPool = await sql`
    SELECT 
      pg.hero_id, h.name as hero_name, count(*) as picks,
      count(*) FILTER (WHERE g.winner_id = pg.team_id) as wins,
      round(count(*) FILTER (WHERE g.winner_id = pg.team_id)::numeric / count(*) * 100, 1) as win_rate,
      round((sum(pg.kills) + sum(pg.assists))::numeric / nullif(sum(pg.deaths), 0), 2) as kda,
      round(avg(pg.damage_to_hero::numeric / nullif(g.duration_secs, 0) * 60), 0) as dpm,
      count(*) FILTER (WHERE pg.mvp = true) as mvps
    FROM player_games pg
    JOIN heroes h ON pg.hero_id = h.id
    JOIN games g ON pg.game_id = g.id
    WHERE pg.player_id = '清融'
    GROUP BY pg.hero_id, h.name
    ORDER BY picks DESC
    LIMIT 20;
  `;

  // 11. 对手针对性 Ban 位
  const opponentBans = await sql`
    SELECT 
      pg.player_id as mid_player,
      h.name as hero_name,
      count(*) as ban_count
    FROM bp_actions ba
    JOIN games g ON ba.game_id = g.id
    JOIN matches m ON g.match_id = m.id
    JOIN player_games pg ON pg.game_id = g.id AND pg.team_id = 'jdg' AND pg.position = '中路'
    JOIN heroes h ON ba.hero_id = h.id
    WHERE ba.action_type = 'ban'
      AND m.season_id = 'kpl-2026-summer'
      AND (
        (pg.side = 'blue' AND ba.side = 'red') OR
        (pg.side = 'red' AND ba.side = 'blue')
      )
      AND ('中路' = ANY(h.positions) OR '法师' = ANY(h.roles))
    GROUP BY pg.player_id, h.name
    ORDER BY mid_player, ban_count DESC;
  `;

  // 12. 2026 年度总决赛擂台赛实况 (JDG vs EDG.M)
  const annualFinalsGames = await sql`
    SELECT 
      g.id, g.game_no, g.winner_id, tw.short_name as winner_name,
      pg.player_id, pg.hero_id, h.name as hero_name, pg.kills, pg.deaths, pg.assists,
      pg.damage_to_hero, pg.damage_taken, pg.gold, pg.participation_rate, pg.mvp,
      g.duration_secs
    FROM games g
    LEFT JOIN teams tw ON g.winner_id = tw.id
    JOIN player_games pg ON pg.game_id = g.id
    JOIN heroes h ON pg.hero_id = h.id
    WHERE g.match_id = 'kpl-20260004-2026100302' AND pg.team_id = 'jdg' AND pg.position = '中路'
    ORDER BY g.game_no ASC;
  `;

  // 13. 社区资讯与流言板提及
  const recentArticles = await sql`
    SELECT 
      em.entity_id,
      a.id,
      a.title,
      a.published_at,
      s.name as source_name,
      substring(a.body_text from 1 for 300) as excerpt
    FROM entity_mentions em
    JOIN articles a ON em.article_id = a.id
    LEFT JOIN sources s ON a.source_id = s.id
    WHERE em.entity_id IN ('昊昊', '清融')
    ORDER BY a.published_at DESC
    LIMIT 20;
  `;

  return {
    profiles,
    honors,
    stints,
    careerSeasons,
    jdgOverall,
    summer2026ControlGroup,
    summer2026TeamShares,
    summer2026TeammateImpact,
    summer2026Sides,
    haohaoHeroPool,
    qingrongSummerHeroPool,
    qingrongJDGHeroPool,
    qingrongCareerHeroPool,
    opponentBans,
    annualFinalsGames,
    recentArticles,
  };
}

async function main() {
  try {
    console.log("Extracting dossier data from PostgreSQL...");
    const data = await extractDossier();
    console.log("Dossier extracted successfully!");
    console.log(`- Profiles: ${data.profiles.length}`);
    console.log(`- Honors: ${data.honors.length}`);
    console.log(`- Stints: ${data.stints.length}`);
    console.log(`- Career seasons: ${data.careerSeasons.length}`);
    console.log(`- JDG Overall rows: ${data.jdgOverall.length}`);
    console.log(`- Summer 2026 control rows: ${data.summer2026ControlGroup.length}`);
    console.log(`- Teammate impact rows: ${data.summer2026TeammateImpact.length}`);
    console.log(`- Haohao heroes: ${data.haohaoHeroPool.length}`);
    console.log(`- Qingrong summer heroes: ${data.qingrongSummerHeroPool.length}`);
    console.log(`- Annual Finals games: ${data.annualFinalsGames.length}`);
    console.log(`- Recent articles: ${data.recentArticles.length}`);
  } catch (err) {
    console.error("Extraction error:", err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

if (process.argv[1]?.endsWith("analyze-jdg-mids.ts")) {
  main();
}

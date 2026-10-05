-- 选手单局数据：供“选手数据变化”“英雄使用统计”类查询，字段来自官方 battle 接口的 battle_player_list。
-- 完整原始对局（装备/铭文/召唤师技能）保存在 games.raw，不在此展开。

CREATE TABLE player_games (
  game_id            text NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  player_id          text NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  team_id            text REFERENCES teams (id) ON DELETE SET NULL,
  hero_id            text REFERENCES heroes (id),
  side               text CHECK (side IN ('blue', 'red')),
  position           text,                  -- 官方 position_desc（'发育路'）
  kills              int, deaths int, assists int,
  gold               bigint,
  damage_to_hero     bigint,
  damage_taken       bigint,
  participation_rate int,                   -- 参团率（百分数）
  mvp                boolean NOT NULL DEFAULT false,
  lose_mvp           boolean NOT NULL DEFAULT false,
  mvp_score          numeric(6, 2),
  raw                jsonb,
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX player_games_player_idx ON player_games (player_id, game_id);
CREATE INDEX player_games_hero_idx ON player_games (hero_id);
CREATE INDEX player_games_team_idx ON player_games (team_id);

-- KPL 比赛域：系列赛（BO）、小局、BP 时序与巅峰对决。
-- 设计说明见 docs/KPL-Intelligence-技术方案.md §5.2；BP 20 步时序模型沿用 BP-For-HoK 在 KPL 赛制下验证的设计。
-- (source, source_key) 是官方数据的幂等键：league_id/match_id/battle_id，重复抓取不会产生重复行。

CREATE TABLE matches (
  id            text PRIMARY KEY,           -- slug：'kpl-2026s-{match_id}' 由适配器生成
  season_id     text NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  stage         text,                       -- 常规赛/季后赛/总决赛/挑战者杯……（官方 match_stage_name）
  stage_seq     text,                       -- 官方 match_stage_seq（阶段内排序）
  bo            int CHECK (bo IN (1, 3, 5, 7)),
  team_a_id     text NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  team_b_id     text NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  score_a       int NOT NULL DEFAULT 0,
  score_b       int NOT NULL DEFAULT 0,
  winner_id     text REFERENCES teams (id) ON DELETE SET NULL,
  mvp_player_id text REFERENCES players (id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'finished', 'cancelled')),
  scheduled_at  timestamptz,
  played_at     timestamptz,
  summary       text,                       -- 胜负原因一句话（AI 复盘/人工）
  source        text NOT NULL DEFAULT 'smoba',
  source_key    text,                       -- 官方 match_id（'20260312NN'）
  cc_key        text,                       -- 官方 cc_match_id（'KPL2026S1M1W1D1'），人工可读
  source_url    text,
  raw           jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX matches_source_key_idx ON matches (source, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX matches_schedule_idx ON matches (scheduled_at) WHERE status = 'scheduled';
CREATE INDEX matches_season_stage_idx ON matches (season_id, played_at DESC);
CREATE INDEX matches_team_a_idx ON matches (team_a_id, played_at DESC);
CREATE INDEX matches_team_b_idx ON matches (team_b_id, played_at DESC);

-- 小局（BO 中的每一局）。经济曲线官方接口暂缺，允许为空；key_fights 由 kb.recap 生成。
CREATE TABLE games (
  id            text PRIMARY KEY,           -- slug：'kpl-2026s-{match_id}-g{n}'
  match_id      text NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  game_no       int NOT NULL,
  mode          text NOT NULL DEFAULT 'standard' CHECK (mode IN ('standard', 'pinnacle')),
  winner_id     text REFERENCES teams (id) ON DELETE SET NULL,
  duration_secs int,
  mvp_player_id text REFERENCES players (id) ON DELETE SET NULL,
  kills_a       int, kills_b int,
  gold_a        bigint, gold_b bigint,
  economy_curve jsonb,                      -- [{t, gold_a, gold_b}]
  key_fights    jsonb,                      -- [{t, desc, outcome}]
  source        text NOT NULL DEFAULT 'smoba',
  source_key    text,                       -- 官方 battle_id
  raw           jsonb,
  UNIQUE (match_id, game_no)
);
CREATE UNIQUE INDEX games_source_key_idx ON games (source, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX games_match_idx ON games (match_id, game_no);

-- BP 时序：ban+pick 合一，保 20 步顺序（1-4 首轮 ban / 5-10 首轮 pick / 11-16 次轮 ban 红先 / 17-20 末轮 pick）。
-- 第 21 步“英雄交换”不单独存记录：pick 行的 player_id 落交换后的最终归属。
CREATE TABLE bp_actions (
  game_id     text NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  step_index  int NOT NULL CHECK (step_index BETWEEN 1 AND 20),
  action_type text NOT NULL CHECK (action_type IN ('ban', 'pick')),
  side        text CHECK (side IN ('blue', 'red')),
  hero_id     text NOT NULL REFERENCES heroes (id),
  player_id   text REFERENCES players (id) ON DELETE SET NULL,
  position    text,
  raw_order   int,                          -- 官方 bp_list 里的原始顺序（排查用）
  PRIMARY KEY (game_id, step_index)
);
CREATE INDEX bp_actions_hero_idx ON bp_actions (hero_id);

-- 巅峰对决（决胜局盲选）：无 ban、双方英雄可重复，故故意不加 (game_id, hero_id) 唯一约束。
CREATE TABLE pinnacle_picks (
  game_id   text NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  team_id   text NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  hero_id   text NOT NULL REFERENCES heroes (id),
  player_id text REFERENCES players (id) ON DELETE SET NULL,
  position  text,
  PRIMARY KEY (game_id, team_id, hero_id)
);

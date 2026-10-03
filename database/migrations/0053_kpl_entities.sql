-- KPL 知识库：赛季、战队、选手、英雄与荣誉。
-- 设计说明见 docs/KPL-Intelligence-技术方案.md §5.1；战队 slug 与 industry/taxonomy.ts 的 ENTITIES id 一致。
-- teams.external_id / players.external_id 对齐官方赛事数据的 team_id / player_id，用于幂等同步。

CREATE TABLE seasons (
  id           text PRIMARY KEY,            -- 'kpl-2026-spring'
  name         text NOT NULL,               -- '2026年KPL春季赛'
  year         int NOT NULL,
  split        text CHECK (split IN ('spring', 'summer', 'challenger', 'worlds', 'annual')),
  start_date   date,
  end_date     date,
  format_note  text,
  external_id  text UNIQUE,                 -- 官方 league_id（'20260001'）
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id            text PRIMARY KEY,           -- slug：'ag'、'wolves'……与 taxonomy ENTITIES 一致
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,              -- 官方全名：'成都AG超玩会'
  short_name    text,                       -- 官方缩写：'AG'
  city          text,
  founded_at    date,
  history_names text[],
  league        text NOT NULL DEFAULT 'KPL',
  logo_url      text,
  style_notes   text,                       -- 打法风格摘要（AI 生成，人工可改）
  external_id   text UNIQUE,                -- 官方 team_id（'10027'）
  is_active     boolean NOT NULL DEFAULT true,
  sort_weight   int NOT NULL DEFAULT 0,     -- 页面排序用（常驻席位 > 挑战者）
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 别名：不同数据源与口语叫法归一（'QGhappy'→重庆狼队）。照 lb_aliases 的 (实体, 别名) 唯一先例。
CREATE TABLE team_aliases (
  team_id    text NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  alias      text NOT NULL,
  normalized text NOT NULL,                 -- lower + 去空白，供查询
  source     text NOT NULL DEFAULT 'manual',
  PRIMARY KEY (team_id, alias)
);
CREATE INDEX team_aliases_norm_idx ON team_aliases (normalized);

CREATE TABLE players (
  id              text PRIMARY KEY,         -- slug：'catgod'、'fly'
  slug            text NOT NULL UNIQUE,
  nickname        text NOT NULL,            -- 选手昵称（圈内名）
  real_name       text,                     -- 公开才填
  position        text CHECK (position IN ('对抗路', '打野', '中路', '发育路', '游走', '教练', '辅助')),
  current_team_id text REFERENCES teams (id) ON DELETE SET NULL,
  jersey          text,
  debut_at        date,
  is_active       boolean NOT NULL DEFAULT true,
  bio             text,
  portrait_url    text,
  external_id     text UNIQUE,              -- 官方/B 站 player_id
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX players_team_idx ON players (current_team_id) WHERE is_active;

CREATE TABLE player_aliases (
  player_id  text NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  alias      text NOT NULL,
  normalized text NOT NULL,
  source     text NOT NULL DEFAULT 'manual',
  PRIMARY KEY (player_id, alias)
);
CREATE INDEX player_aliases_norm_idx ON player_aliases (normalized);

-- 转会履历：选手 ↔ 战队的多对多带时间（“猫神的 eStar 时期”按区间查）。
CREATE TABLE player_stints (
  id        bigserial PRIMARY KEY,
  player_id text NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  team_id   text NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  joined_at date,
  left_at   date,
  role      text,
  UNIQUE (player_id, team_id, joined_at)
);
CREATE INDEX player_stints_player_idx ON player_stints (player_id, joined_at);
CREATE INDEX player_stints_team_idx ON player_stints (team_id, joined_at);

CREATE TABLE heroes (
  id           text PRIMARY KEY,            -- 官方英雄数字 id（herolist.json 的 ename），对齐赛事数据 hero_id
  slug         text NOT NULL UNIQUE,        -- 'lianpo'（id_name），URL 用
  name         text NOT NULL,               -- '廉颇'
  title        text,                        -- 官方称号：'正义爆轰'
  roles        text[],                      -- 官方定位：战士/法师/射手/刺客/坦克/辅助
  positions    text[],                      -- 赛场位置：对抗路/打野/中路/发育路/游走
  primary_pos  text,
  power_period text,                        -- early/mid/late/all（BP-For-HoK 档案）
  function_tags text[],                     -- 功能标签（22 类枚举的中文）
  version_strength int,                    -- 版本强度 1-10（人工/AI 评估，随版本更新）
  notes        text,                        -- 一句话特征
  release_date date,
  portrait_url text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_honors (
  id        bigserial PRIMARY KEY,
  team_id   text NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  season_id text REFERENCES seasons (id) ON DELETE SET NULL,
  kind      text NOT NULL CHECK (kind IN ('champion', 'runner_up', 'third', 'fmvp', 'regular_champion', 'regular_mvp')),
  note      text,
  source_url text,
  UNIQUE (team_id, season_id, kind)
);

CREATE TABLE player_honors (
  id        bigserial PRIMARY KEY,
  player_id text NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  team_id   text REFERENCES teams (id) ON DELETE SET NULL,
  season_id text REFERENCES seasons (id) ON DELETE SET NULL,
  kind      text NOT NULL CHECK (kind IN ('champion', 'fmvp', 'finals_mvp', 'regular_mvp', 'all_star', 'rookie')),
  note      text,
  UNIQUE (player_id, season_id, kind)
);

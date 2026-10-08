-- P2 比赛聚合（大场 → 小局 → 节点）：matches 状态补齐 postponed；新闻 ↔ 比赛硬链接表。
-- 契约见 docs/content-redesign-contracts.md §1.1（P2）。stories/facts/matches/games 现有列不动。

-- 状态补齐：scheduled/live/finished/postponed/cancelled
ALTER TABLE matches DROP CONSTRAINT matches_status_check;
ALTER TABLE matches ADD CONSTRAINT matches_status_check
  CHECK (status IN ('scheduled','live','finished','postponed','cancelled'));

-- 新闻 ↔ 比赛硬链接（新闻域与比赛域唯一的桥）
CREATE TABLE match_story_links (
  id         bigserial PRIMARY KEY,
  match_id   text   NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  story_id   bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  game_no    integer,                       -- NULL=整场级；数字=归属小局
  link_type  text NOT NULL DEFAULT 'series' CHECK (link_type IN ('series','game','node')),
  confidence numeric(4,3),
  origin     text NOT NULL DEFAULT 'model' CHECK (origin IN ('model','manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, story_id, game_no)
);
CREATE INDEX match_story_links_match_idx ON match_story_links (match_id);
CREATE INDEX match_story_links_story_idx ON match_story_links (story_id);

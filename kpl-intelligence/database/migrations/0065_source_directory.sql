-- P1 信源目录与调度策略：信源角色、调度权重、降频保护、验证证据，以及事件加频表。
-- role 取值：league_official（联盟官方）、club_official（俱乐部官方）、principal（当事人：选手/教练/工作人员本人账号）、
-- caster（解说/主播）、media（媒体）、community（社区）。默认 'media'：新建源角色不明时取最保守的身份。
-- priority_weight：调度排序的显式权重，weibo 官方源默认 10。auto_tune=false 的源（公众号等敏感通道）不被
-- 每天 04:20 的 adaptIntervals 自动调速（见 packages/backend/src/sources/collect.ts）。
-- source_boosts：比赛等事件期间给相关信源临时加频；只决定下一次到期的间隔，不改 sources.interval_minutes 本身。

ALTER TABLE sources ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'media'
  CHECK (role IN ('league_official', 'club_official', 'principal', 'caster', 'media', 'community'));
ALTER TABLE sources ADD COLUMN IF NOT EXISTS priority_weight integer NOT NULL DEFAULT 0
  CHECK (priority_weight >= 0);
ALTER TABLE sources ADD COLUMN IF NOT EXISTS auto_tune boolean NOT NULL DEFAULT true;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS verified_evidence text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS source_boosts (
  id                        serial PRIMARY KEY,
  source_id                 text NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  reason                    text NOT NULL DEFAULT '',
  interval_override_minutes integer NOT NULL CHECK (interval_override_minutes BETWEEN 1 AND 1440),
  starts_at                 timestamptz NOT NULL DEFAULT now(),
  ends_at                   timestamptz NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_boosts_ends_after_starts CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS source_boosts_source_idx ON source_boosts (source_id);

-- 荣誉与英雄档案的深度富化（种子库回填前的结构对齐）：
-- 1) 荣誉表补 year/title/source_url——历史赛事（2016–2018）没有 seasons 记录，
--    荣誉行用自带的 title/year 表达“2016年KPL秋季赛”，season_id 只在赛季存在时关联；
-- 2) player_honors 的 kind 放开年度最佳选手与最佳阵容一阵；
-- 3) heroes.version_strength 从 1–10 整数改为 T0–T3 赛场梯度（现值全空，无损转换），
--    power_period 统一为中文发力期枚举。

ALTER TABLE team_honors ADD COLUMN IF NOT EXISTS year int;
ALTER TABLE team_honors ADD COLUMN IF NOT EXISTS title text;

ALTER TABLE player_honors ADD COLUMN IF NOT EXISTS year int;
ALTER TABLE player_honors ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE player_honors ADD COLUMN IF NOT EXISTS source_url text;

ALTER TABLE player_honors DROP CONSTRAINT IF EXISTS player_honors_kind_check;
ALTER TABLE player_honors ADD CONSTRAINT player_honors_kind_check
  CHECK (kind IN ('champion', 'fmvp', 'finals_mvp', 'regular_mvp', 'annual_mvp', 'best_lineup', 'all_star', 'rookie'));

ALTER TABLE heroes ALTER COLUMN version_strength TYPE text USING version_strength::text;
ALTER TABLE heroes DROP CONSTRAINT IF EXISTS heroes_version_strength_check;
ALTER TABLE heroes ADD CONSTRAINT heroes_version_strength_check
  CHECK (version_strength IN ('T0', 'T0.5', 'T1', 'T2', 'T3'));

ALTER TABLE heroes DROP CONSTRAINT IF EXISTS heroes_power_period_check;
ALTER TABLE heroes ADD CONSTRAINT heroes_power_period_check
  CHECK (power_period IN ('前期', '中前期', '中后期', '大后期', '全期平稳'));

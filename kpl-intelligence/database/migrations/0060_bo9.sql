-- KPL 赛制存在 BO9（如 2026 KCC 决赛加赛），bo 的 CHECK 放宽到 9。
ALTER TABLE matches DROP CONSTRAINT matches_bo_check;
ALTER TABLE matches ADD CONSTRAINT matches_bo_check CHECK (bo IN (1, 3, 5, 7, 9));

-- matches.games_expected：官方对局列表给出的局数。回灌断点续抓用它判断“还缺几局”，
-- 比“小于 BO 胜场下限”的启发式精确（3-1 的 BO5 有 4 局，存了 3 局后仍需补第 4 局）。
ALTER TABLE matches ADD COLUMN games_expected int;

-- player_games.participation_rate 改 numeric：官方参团率带小数（如 33.33），int 列会拒绝。
ALTER TABLE player_games ALTER COLUMN participation_rate TYPE numeric(5, 2);

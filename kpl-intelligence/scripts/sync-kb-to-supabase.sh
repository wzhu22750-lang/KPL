#!/usr/bin/env bash
# 把本地库（kpl-pg 容器里的 kpl_dev）的知识库数据整体复制到 Supabase。
#
# 为什么这样：跨洋逐条写入太慢（每局 ~50 次往返 × 250ms ≈ 15s/局），而本地回灌
# 约 0.7s/局；全量历史在本地跑完，一次 dump/restore 过去（几分钟）是最快的路径。
#
# 用法（本地全量回灌完成后执行一次；幂等，可重跑）：
#   cd kpl-intelligence && bash scripts/sync-kb-to-supabase.sh
#
# 前置：本地库已回灌完成（node scripts/import-kpl-history.ts --from=2019 --to=2026）；
#       .env 的 DATABASE_URL 指向 Supabase（脚本会读它）。
set -euo pipefail

cd "$(dirname "$0")/.."
REMOTE_URL="$(grep '^DATABASE_URL' .env | cut -d= -f2-)"
if [[ "$REMOTE_URL" != *"supabase"* ]]; then
  echo "DATABASE_URL 不是 Supabase 地址，拒绝执行（先确认 .env）"; exit 1
fi
if ! docker ps --format '{{.Names}}' | grep -q '^kpl-pg$'; then
  echo "本地容器 kpl-pg 未运行：docker start kpl-pg 或 docker run … pgvector/pgvector:pg17"; exit 1
fi

# 知识库表（不含新闻侧：articles/publications/sources 等不在此列）
TABLES=(seasons teams team_aliases players player_aliases player_stints heroes \
        matches games bp_actions pinnacle_picks player_games team_honors player_honors)
DUMP=/tmp/kpl-kb-sync.dump

echo "[1/4] 导出本地数据（data-only）…"
docker exec kpl-pg pg_dump -U postgres -d kpl_dev --data-only --no-owner \
  "${TABLES[@]/#/-t}" > "$DUMP"
echo "     $(wc -l < "$DUMP") 行 -> $DUMP"

echo "[2/4] 暂停 Supabase 的采集源避免写入竞争…"
docker exec -i kpl-pg psql "$REMOTE_URL" -q -c "UPDATE sources SET enabled = false WHERE kind = 'esports_api';"

echo "[3/4] 清空远端知识库表并恢复…"
docker exec -i kpl-pg psql "$REMOTE_URL" -q -c "TRUNCATE $(IFS=,; echo "${TABLES[*]}") CASCADE;"
docker exec -i kpl-pg psql "$REMOTE_URL" -q -v ON_ERROR_STOP=1 < "$DUMP"

echo "[4/4] 恢复采集源并核对…"
docker exec -i kpl-pg psql "$REMOTE_URL" -q -c "UPDATE sources SET enabled = true, next_fetch_at = now() WHERE kind = 'esports_api';"
docker exec -i kpl-pg psql "$REMOTE_URL" -c "
  SELECT (SELECT count(*) FROM seasons) seasons, (SELECT count(*) FROM teams) teams,
         (SELECT count(*) FROM players) players, (SELECT count(*) FROM matches) matches,
         (SELECT count(*) FROM games) games, (SELECT count(*) FROM bp_actions) bp,
         (SELECT count(*) FROM player_games) player_games;"
echo "完成。worker 下一轮会自动把最新赛事补齐（已重新启用 esports 源）。"
echo "⚠️ 上线前必做：Supabase Dashboard → Settings → API → 关闭 Data API（PostgREST），或给所有表加 deny-all RLS（anon key 暴露即全库泄露）。"
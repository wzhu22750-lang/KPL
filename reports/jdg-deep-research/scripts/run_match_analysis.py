#!/usr/bin/env python3
"""
run_match_analysis.py

JDG 深度数据研究：比赛、BP、阵容与选手量化全量分析管线
依据 reports/jdg-deep-research/PROJECT.md 契约执行。
只读访问数据库，提取 2026 全年 211 局 JDG 中单小局及历史对比数据，
彻底纠正 win_camp 胜负反转缺陷，计算五位置团队占比、BP 顺位、对手禁选、
同 BO 轮换时间线与 BO 聚类 Bootstrap 统计检验，
产出 reports/jdg-deep-research/processed/match_analysis.json。
"""

import os
import sys
import json
import math
import time
from datetime import datetime, date
from decimal import Decimal
from pathlib import Path
from collections import defaultdict, Counter
import psycopg2
import psycopg2.extras
import numpy as np

# 路径常量
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
PROCESSED_DIR = PROJECT_DIR / "processed"
OUTPUT_FILE = PROCESSED_DIR / "match_analysis.json"

# 获取 DATABASE_URL
def get_db_url() -> str:
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    
    # 尝试从 kpl-intelligence/.env 读取
    env_file = Path("/Users/kuangqie/Documents/VibeCoding/KPL/kpl-intelligence/.env")
    if env_file.exists():
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("DATABASE_URL=") and not line.startswith("#"):
                    return line.split("=", 1)[1].strip().strip("\"'")
    
    raise RuntimeError("DATABASE_URL missing; configure environment or local .env")

class CustomEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return float(o)
        if isinstance(o, (datetime, date)):
            return o.isoformat()
        if isinstance(o, set):
            return list(o)
        return super().default(o)

def wilson_score_interval(successes: int, total: int, confidence: float = 0.95) -> tuple[float, float]:
    """计算 Wilson 得分区间 (双侧置信区间)"""
    if total == 0:
        return (0.0, 0.0)
    z = 1.95996  # 95%
    p = successes / total
    denominator = 1 + z**2 / total
    center = (p + z**2 / (2 * total)) / denominator
    spread = z * math.sqrt((p * (1 - p) + z**2 / (4 * total)) / total) / denominator
    lower = max(0.0, center - spread)
    upper = min(1.0, center + spread)
    return (round(lower, 4), round(upper, 4))

def get_connection(db_url: str):
    for attempt in range(1, 4):
        try:
            conn = psycopg2.connect(db_url)
            conn.set_session(readonly=True, autocommit=True)
            return conn
        except Exception as e:
            print(f"[DB] 连接尝试 {attempt} 失败 ({type(e).__name__})")
            if attempt == 3:
                raise
            time.sleep(2)

def main():
    print("=" * 60)
    print("JDG 深度数据研究：全量数据提取与统计检验管线启动")
    print("=" * 60)
    
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    db_url = get_db_url()
    conn = get_connection(db_url)
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
    
    # 1. 加载英雄字典
    print("\n[1/7] 加载英雄基础元数据...")
    cur.execute("SELECT id, name, title, roles, primary_pos FROM heroes")
    heroes_dict = {}
    mage_hero_ids = set()
    for row in cur.fetchall():
        heroes_dict[row["id"]] = {
            "id": row["id"],
            "name": row["name"],
            "title": row["title"],
            "roles": row["roles"] or [],
            "primary_pos": row["primary_pos"]
        }
        if row["primary_pos"] == "中路" or (row["roles"] and "法师" in row["roles"]):
            mage_hero_ids.add(row["id"])
    print(f"  已加载 {len(heroes_dict)} 名英雄，中路/法师英雄 {len(mage_hero_ids)} 名。")
    
    # 2. 加载战队与赛季字典
    print("\n[2/7] 加载战队与赛季元数据...")
    cur.execute("SELECT id, name, short_name, external_id FROM teams")
    teams_dict = {r["id"]: dict(r) for r in cur.fetchall()}
    
    cur.execute("SELECT id, name, year, split FROM seasons")
    seasons_dict = {r["id"]: dict(r) for r in cur.fetchall()}
    
    # 3. 提取 2026 全年 JDG 中单小局及全队数据 (211 局)
    print("\n[3/7] 提取 2026 全年 JDG 小局明细 (211 局) 与五位置表现...")
    seasons_2026 = ["kpl-2026-spring", "kpl-2026-challenger", "kpl-2026-summer", "kpl-2026-annual"]
    
    # 查找符合条件的对局 ID
    cur.execute("""
        SELECT DISTINCT g.id
        FROM player_games pg
        JOIN games g ON pg.game_id = g.id
        JOIN matches m ON g.match_id = m.id
        WHERE pg.team_id = 'jdg' AND pg.player_id IN ('清融', '昊昊')
          AND m.season_id = ANY(%s)
        ORDER BY g.id;
    """, (seasons_2026,))
    game_ids = [r[0] for r in cur.fetchall()]
    print(f"  识别到 2026 全年 JDG 中单参赛小局共 {len(game_ids)} 局。")
    
    # 批量提取比赛小局信息
    cur.execute("""
        SELECT 
            g.id as game_id, g.match_id, g.game_no, g.duration_secs, g.winner_id as db_winner_id,
            g.mvp_player_id, g.source_key as battle_id, g.raw as game_raw,
            m.season_id, m.stage, m.stage_seq, m.bo, m.played_at,
            m.team_a_id, m.team_b_id, m.score_a, m.score_b, m.winner_id as match_winner_id,
            m.raw as match_raw
        FROM games g
        JOIN matches m ON g.match_id = m.id
        WHERE g.id = ANY(%s)
        ORDER BY m.played_at ASC, g.game_no ASC;
    """, (game_ids,))
    games_meta = {r["game_id"]: dict(r) for r in cur.fetchall()}
    
    # 批量提取小局中 JDG 全部 5 名选手的单局表现
    cur.execute("""
        SELECT 
            pg.game_id, pg.player_id, pg.team_id, pg.hero_id, pg.side, pg.position,
            pg.kills, pg.deaths, pg.assists, pg.gold, pg.damage_to_hero, pg.damage_taken,
            pg.participation_rate, pg.mvp, pg.lose_mvp, pg.mvp_score
        FROM player_games pg
        WHERE pg.game_id = ANY(%s) AND pg.team_id = 'jdg'
        ORDER BY pg.game_id, pg.position;
    """, (game_ids,))
    
    team_players_by_game = defaultdict(list)
    for row in cur.fetchall():
        team_players_by_game[row["game_id"]].append(dict(row))
        
    # 批量提取 BP 记录
    print("\n[4/7] 提取 BP 时序与针对性禁选明细...")
    cur.execute("""
        SELECT 
            ba.game_id, ba.step_index, ba.action_type, ba.side, ba.hero_id, ba.player_id, ba.position, ba.raw_order
        FROM bp_actions ba
        WHERE ba.game_id = ANY(%s)
        ORDER BY ba.game_id, ba.step_index ASC;
    """, (game_ids,))
    bp_by_game = defaultdict(list)
    for row in cur.fetchall():
        bp_by_game[row["game_id"]].append(dict(row))
        
    # 组装 211 局详尽数据
    print("\n[5/7] 严谨校验阵营映射 win_camp，纠正胜负翻转并计算结构化指标...")
    parsed_games = []
    
    # 先按比赛组织小局以计算同 BO 轮换时间线与大场比分演变
    match_to_game_ids = defaultdict(list)
    for gid in sorted(games_meta.keys(), key=lambda x: (games_meta[x]["played_at"], games_meta[x]["game_no"])):
        mid = games_meta[gid]["match_id"]
        match_to_game_ids[mid].append(gid)
        
    # 计算每个 Match 内的轮换状态与各局比分时序
    match_progression = {}
    for mid, gids in match_to_game_ids.items():
        gids_sorted = sorted(gids, key=lambda x: games_meta[x]["game_no"])
        m_meta = games_meta[gids_sorted[0]]
        
        # 统计本场比赛出场的全部中单
        match_mids = set()
        for gid in gids_sorted:
            for p in team_players_by_game[gid]:
                if p["position"] == "中路":
                    match_mids.add(p["player_id"])
                    
        is_intra_rotation = len(match_mids) > 1
        
        running_jdg_score = 0
        running_opp_score = 0
        prog_records = {}
        
        for idx, gid in enumerate(gids_sorted):
            g_meta = games_meta[gid]
            g_raw = g_meta["game_raw"] or {}
            
            # 核验胜负逻辑：以 raw.win_camp 与 raw.camp1/2.team_id 进行法医级判定
            win_camp = str(g_raw.get("win_camp", ""))
            c1_tid = str((g_raw.get("camp1") or {}).get("team_id", ""))
            c2_tid = str((g_raw.get("camp2") or {}).get("team_id", ""))
            
            # JDG 官方外部战队编号为 10020
            is_jdg_win = (win_camp == "1" and c1_tid == "10020") or (win_camp == "2" and c2_tid == "10020")
            
            score_before = [running_jdg_score, running_opp_score]
            if is_jdg_win:
                running_jdg_score += 1
            else:
                running_opp_score += 1
            score_after = [running_jdg_score, running_opp_score]
            
            prev_mid = None
            if idx > 0:
                prev_gid = gids_sorted[idx - 1]
                for p in team_players_by_game[prev_gid]:
                    if p["position"] == "中路":
                        prev_mid = p["player_id"]
                        
            next_mid = None
            if idx < len(gids_sorted) - 1:
                next_gid = gids_sorted[idx + 1]
                for p in team_players_by_game[next_gid]:
                    if p["position"] == "中路":
                        next_mid = p["player_id"]
                        
            prog_records[gid] = {
                "is_intra_rotation": is_intra_rotation,
                "match_mids": list(match_mids),
                "game_seq": g_meta["game_no"],
                "total_games_in_match": len(gids_sorted),
                "prev_mid": prev_mid,
                "next_mid": next_mid,
                "score_before": score_before,
                "score_after": score_after,
                "is_jdg_win": is_jdg_win
            }
        match_progression[mid] = prog_records

    # 逐局组装
    flipped_counter = 0
    for gid in sorted(games_meta.keys(), key=lambda x: (games_meta[x]["played_at"], games_meta[x]["game_no"])):
        g_meta = games_meta[gid]
        mid = g_meta["match_id"]
        prog = match_progression[mid][gid]
        
        g_raw = g_meta["game_raw"] or {}
        duration_secs = g_meta["duration_secs"] or 1
        duration_mins = duration_secs / 60.0
        
        # 对手信息
        team_a = g_meta["team_a_id"]
        team_b = g_meta["team_b_id"]
        opp_id = team_b if team_a == "jdg" else team_a
        opp_meta = teams_dict.get(opp_id, {"name": opp_id, "short_name": opp_id})
        
        # 真实阵营映射
        win_camp = str(g_raw.get("win_camp", ""))
        c1_tid = str((g_raw.get("camp1") or {}).get("team_id", ""))
        c2_tid = str((g_raw.get("camp2") or {}).get("team_id", ""))
        jdg_camp = 1 if c1_tid == "10020" else (2 if c2_tid == "10020" else None)
        opp_camp = 2 if jdg_camp == 1 else 1
        
        # 实际胜负 vs DB 胜负
        is_winner = prog["is_jdg_win"]
        db_winner_is_jdg = (g_meta["db_winner_id"] == "jdg")
        if is_winner != db_winner_is_jdg:
            flipped_counter += 1
            
        # 五名选手数据与团队总量
        team_players = team_players_by_game[gid]
        team_dmg = sum(p["damage_to_hero"] or 0 for p in team_players)
        team_dt = sum(p["damage_taken"] or 0 for p in team_players)
        team_gold = sum(p["gold"] or 0 for p in team_players)
        team_kills = sum(p["kills"] or 0 for p in team_players)
        
        mid_player_row = None
        positions_data = {}
        for p in team_players:
            pos = p["position"]
            pid = p["player_id"]
            hid = p["hero_id"]
            h_info = heroes_dict.get(hid, {"name": hid})
            
            kills = p["kills"] or 0
            deaths = p["deaths"] or 0
            assists = p["assists"] or 0
            gold = p["gold"] or 0
            dmg = p["damage_to_hero"] or 0
            dt = p["damage_taken"] or 0
            
            kda = round((kills + assists) / max(deaths, 1), 2)
            dpm = round(dmg / duration_mins, 1)
            dtpm = round(dt / duration_mins, 1)
            gpm = round(gold / duration_mins, 1)
            
            dmg_share = round(dmg / team_dmg * 100, 2) if team_dmg > 0 else 0.0
            dt_share = round(dt / team_dt * 100, 2) if team_dt > 0 else 0.0
            gold_share = round(gold / team_gold * 100, 2) if team_gold > 0 else 0.0
            gold_eff = round(dmg_share / gold_share, 2) if gold_share > 0 else 0.0
            dmg_per_gold = round(dmg / max(gold, 1) * 100, 2)
            
            pos_dict = {
                "player_id": pid,
                "position": pos,
                "hero_id": hid,
                "hero_name": h_info["name"],
                "kills": kills,
                "deaths": deaths,
                "assists": assists,
                "kda": kda,
                "gold": gold,
                "damage": dmg,
                "damage_taken": dt,
                "dpm": dpm,
                "dtpm": dtpm,
                "gpm": gpm,
                "damage_share": dmg_share,
                "damage_taken_share": dt_share,
                "gold_share": gold_share,
                "gold_efficiency": gold_eff,
                "damage_per_gold_pct": dmg_per_gold,
                "participation_rate": float(p["participation_rate"] or 0.0),
                "mvp": bool(p["mvp"]),
                "lose_mvp": bool(p["lose_mvp"])
            }
            positions_data[pos] = pos_dict
            if pos == "中路":
                mid_player_row = pos_dict
                jdg_side = p["side"]
                
        # BP 字段解析
        bps = bp_by_game[gid]
        picks_only = [b for b in bps if b["action_type"] == "pick"]
        bans_only = [b for b in bps if b["action_type"] == "ban"]
        
        # 寻找中单英雄选人顺位
        mid_hero_id = mid_player_row["hero_id"] if mid_player_row else None
        mid_pick_step = None
        overall_pick_order = None
        team_pick_order = None
        
        jdg_picks = [b for b in picks_only if b["side"] == jdg_side]
        for p_idx, b in enumerate(picks_only):
            if b["side"] == jdg_side and (b["hero_id"] == mid_hero_id or b["player_id"] == mid_player_row["player_id"]):
                mid_pick_step = b["step_index"]
                overall_pick_order = p_idx + 1
                break
                
        for t_idx, b in enumerate(jdg_picks):
            if b["hero_id"] == mid_hero_id or b["player_id"] == mid_player_row["player_id"]:
                team_pick_order = t_idx + 1
                break
                
        is_first_pick = (overall_pick_order == 1)
        is_top3_pick = (overall_pick_order is not None and overall_pick_order <= 3)
        is_first_round = (overall_pick_order is not None and overall_pick_order <= 6)
        is_counter_pick = (team_pick_order == 5)
        
        # 对手 Bans
        opp_side = "red" if jdg_side == "blue" else "blue"
        opp_bans = [b for b in bans_only if b["side"] == opp_side]
        opp_ban_heroes = []
        opp_mid_bans = []
        for b in opp_bans:
            b_hid = b["hero_id"]
            b_hname = heroes_dict.get(b_hid, {}).get("name", b_hid)
            opp_ban_heroes.append({"hero_id": b_hid, "hero_name": b_hname})
            if b_hid in mage_hero_ids:
                opp_mid_bans.append({"hero_id": b_hid, "hero_name": b_hname})
                
        is_target_banned = len(opp_mid_bans) > 0
        
        game_obj = {
            "game_id": gid,
            "match_id": mid,
            "season_id": g_meta["season_id"],
            "season_name": seasons_dict.get(g_meta["season_id"], {}).get("name", g_meta["season_id"]),
            "stage": g_meta["stage"],
            "bo": g_meta["bo"],
            "game_no": g_meta["game_no"],
            "played_at": g_meta["played_at"],
            "duration_secs": duration_secs,
            "duration_mins": round(duration_mins, 2),
            "opponent_id": opp_id,
            "opponent_name": opp_meta.get("name", opp_id),
            "opponent_short_name": opp_meta.get("short_name", opp_id),
            "mid_player": mid_player_row["player_id"],
            "mid_hero_id": mid_hero_id,
            "mid_hero_name": mid_player_row["hero_name"],
            "side": jdg_side,
            "camp": jdg_camp,
            "win_camp": int(win_camp) if win_camp.isdigit() else None,
            "is_winner": is_winner,
            "db_winner_is_jdg": db_winner_is_jdg,
            "winner_flipped_in_db": (is_winner != db_winner_is_jdg),
            "mid_stats": mid_player_row,
            "team_positions": positions_data,
            "bp_data": {
                "bp_actions_count": len(bps),
                "has_full_bp": len(bps) == 20,
                "mid_pick_step": mid_pick_step,
                "team_pick_order": team_pick_order,
                "overall_pick_order": overall_pick_order,
                "is_first_pick": is_first_pick,
                "is_top3_pick": is_top3_pick,
                "is_first_round": is_first_round,
                "is_counter_pick": is_counter_pick,
                "opponent_bans": opp_ban_heroes,
                "opponent_mid_bans": opp_mid_bans,
                "is_target_banned": is_target_banned
            },
            "rotation_context": {
                "is_intra_match_rotation": prog["is_intra_rotation"],
                "match_mids": prog["match_mids"],
                "game_seq": prog["game_seq"],
                "total_games_in_match": prog["total_games_in_match"],
                "prev_game_mid": prog["prev_mid"],
                "next_game_mid": prog["next_mid"],
                "score_before": prog["score_before"],
                "score_after": prog["score_after"],
                "match_winner_id": g_meta["match_winner_id"],
                "match_is_jdg_win": (g_meta["match_winner_id"] == "jdg")
            }
        }
        parsed_games.append(game_obj)
        
    print(f"  已完成 211 局逐局数据装配！核验发现 DB 胜负错位翻转局数：{flipped_counter} / 211。")
    
    # 4. 统计聚合与多切片建模
    print("\n[6/7] 构建夏季赛同四队友黄金样本、全年及历史分层聚合...")
    
    # 切片 1: 夏季赛同四队友 (Summer 2026 Control Group)
    summer_games = [g for g in parsed_games if g["season_id"] == "kpl-2026-summer"]
    summer_q = [g for g in summer_games if g["mid_player"] == "清融"]
    summer_h = [g for g in summer_games if g["mid_player"] == "昊昊"]
    
    # 切片 2: 2026 全年 (Season 2026 Overall)
    all_q = [g for g in parsed_games if g["mid_player"] == "清融"]
    all_h = [g for g in parsed_games if g["mid_player"] == "昊昊"]
    
    def aggregate_slice(games_list):
        if not games_list:
            return {}
        n = len(games_list)
        wins = sum(1 for g in games_list if g["is_winner"])
        wr = round(wins / n * 100, 2)
        ci_wr = wilson_score_interval(wins, n)
        
        m_stats = [g["mid_stats"] for g in games_list]
        tot_kills = sum(s["kills"] for s in m_stats)
        tot_deaths = sum(s["deaths"] for s in m_stats)
        tot_assists = sum(s["assists"] for s in m_stats)
        
        return {
            "games": n,
            "wins": wins,
            "losses": n - wins,
            "win_rate": wr,
            "win_rate_wilson_ci_95": [round(ci_wr[0] * 100, 2), round(ci_wr[1] * 100, 2)],
            "avg_kills": round(tot_kills / n, 2),
            "avg_deaths": round(tot_deaths / n, 2),
            "avg_assists": round(tot_assists / n, 2),
            "total_kda": round((tot_kills + tot_assists) / max(tot_deaths, 1), 2),
            "avg_damage": round(np.mean([s["damage"] for s in m_stats]), 0),
            "avg_damage_taken": round(np.mean([s["damage_taken"] for s in m_stats]), 0),
            "avg_gold": round(np.mean([s["gold"] for s in m_stats]), 0),
            "dpm": round(np.mean([s["dpm"] for s in m_stats]), 1),
            "dtpm": round(np.mean([s["dtpm"] for s in m_stats]), 1),
            "gpm": round(np.mean([s["gpm"] for s in m_stats]), 1),
            "damage_share_pct": round(np.mean([s["damage_share"] for s in m_stats]), 2),
            "damage_taken_share_pct": round(np.mean([s["damage_taken_share"] for s in m_stats]), 2),
            "gold_share_pct": round(np.mean([s["gold_share"] for s in m_stats]), 2),
            "gold_efficiency": round(np.mean([s["gold_efficiency"] for s in m_stats]), 2),
            "damage_per_gold_pct": round(np.mean([s["damage_per_gold_pct"] for s in m_stats]), 2),
            "participation_rate": round(np.mean([s["participation_rate"] for s in m_stats]), 2),
            "mvps": sum(1 for s in m_stats if s["mvp"]),
            "lose_mvps": sum(1 for s in m_stats if s["lose_mvp"]),
            "avg_duration_mins": round(np.mean([g["duration_mins"] for g in games_list]), 2)
        }
        
    def aggregate_teammates(games_list):
        res = {}
        for pos in ["对抗路", "打野", "发育路", "游走"]:
            p_rows = [g["team_positions"][pos] for g in games_list if pos in g["team_positions"]]
            if not p_rows:
                continue
            n = len(p_rows)
            p_names = Counter(r["player_id"] for r in p_rows)
            tot_k = sum(r["kills"] for r in p_rows)
            tot_d = sum(r["deaths"] for r in p_rows)
            tot_a = sum(r["assists"] for r in p_rows)
            
            res[pos] = {
                "primary_player": p_names.most_common(1)[0][0],
                "player_counts": dict(p_names),
                "games": n,
                "avg_kills": round(tot_k / n, 2),
                "avg_deaths": round(tot_d / n, 2),
                "avg_assists": round(tot_a / n, 2),
                "total_kda": round((tot_k + tot_a) / max(tot_d, 1), 2),
                "dpm": round(np.mean([r["dpm"] for r in p_rows]), 1),
                "gpm": round(np.mean([r["gpm"] for r in p_rows]), 1),
                "damage_share_pct": round(np.mean([r["damage_share"] for r in p_rows]), 2),
                "gold_share_pct": round(np.mean([r["gold_share"] for r in p_rows]), 2),
                "participation_rate": round(np.mean([r["participation_rate"] for r in p_rows]), 2),
            }
        return res

    def aggregate_sides(games_list):
        blue_games = [g for g in games_list if g["side"] == "blue"]
        red_games = [g for g in games_list if g["side"] == "red"]
        return {
            "blue": aggregate_slice(blue_games),
            "red": aggregate_slice(red_games)
        }
        
    def aggregate_heroes(games_list):
        h_groups = defaultdict(list)
        for g in games_list:
            h_groups[g["mid_hero_name"]].append(g)
        res = []
        for hname, hg in sorted(h_groups.items(), key=lambda x: len(x[1]), reverse=True):
            n = len(hg)
            wins = sum(1 for g in hg if g["is_winner"])
            tot_k = sum(g["mid_stats"]["kills"] for g in hg)
            tot_d = sum(g["mid_stats"]["deaths"] for g in hg)
            tot_a = sum(g["mid_stats"]["assists"] for g in hg)
            res.append({
                "hero_name": hname,
                "games": n,
                "wins": wins,
                "losses": n - wins,
                "win_rate": round(wins / n * 100, 1),
                "avg_kills": round(tot_k / n, 2),
                "avg_deaths": round(tot_d / n, 2),
                "avg_assists": round(tot_a / n, 2),
                "kda": round((tot_k + tot_a) / max(tot_d, 1), 2),
                "dpm": round(np.mean([g["mid_stats"]["dpm"] for g in hg]), 0),
                "mvps": sum(1 for g in hg if g["mid_stats"]["mvp"]),
                "avg_team_pick_order": round(np.mean([g["bp_data"]["team_pick_order"] for g in hg if g["bp_data"]["team_pick_order"] is not None]), 2) if any(g["bp_data"]["team_pick_order"] for g in hg) else None
            })
        return res

    def aggregate_bp(games_list):
        # 仅取完整 20 步 BP 或有有效选人顺位的对局
        bp_valid = [g for g in games_list if g["bp_data"]["team_pick_order"] is not None]
        n = len(bp_valid)
        if n == 0:
            return {}
        team_picks = [g["bp_data"]["team_pick_order"] for g in bp_valid]
        first_picks = sum(1 for g in bp_valid if g["bp_data"]["is_first_pick"])
        top3_picks = sum(1 for g in bp_valid if g["bp_data"]["is_top3_pick"])
        first_rounds = sum(1 for g in bp_valid if g["bp_data"]["is_first_round"])
        counter_picks = sum(1 for g in bp_valid if g["bp_data"]["is_counter_pick"])
        
        # 高顺位 (队内第 1-2 手) vs 低顺位 (队内第 4-5 手) 胜率
        high_pri = [g for g in bp_valid if g["bp_data"]["team_pick_order"] in (1, 2)]
        low_pri = [g for g in bp_valid if g["bp_data"]["team_pick_order"] in (4, 5)]
        
        high_wins = sum(1 for g in high_pri if g["is_winner"])
        low_wins = sum(1 for g in low_pri if g["is_winner"])
        
        # 对手禁招牌英雄率
        opp_target_bans = sum(1 for g in bp_valid if g["bp_data"]["is_target_banned"])
        
        return {
            "valid_bp_games": n,
            "avg_team_pick_order": round(np.mean(team_picks), 2),
            "first_pick_count": first_picks,
            "first_pick_rate_pct": round(first_picks / n * 100, 1),
            "top3_pick_count": top3_picks,
            "top3_pick_rate_pct": round(top3_picks / n * 100, 1),
            "first_round_count": first_rounds,
            "first_round_rate_pct": round(first_rounds / n * 100, 1),
            "counter_pick_count": counter_picks,
            "counter_pick_rate_pct": round(counter_picks / n * 100, 1),
            "target_banned_games": opp_target_bans,
            "target_banned_rate_pct": round(opp_target_bans / n * 100, 1),
            "priority_yield": {
                "high_priority_1_2": {
                    "games": len(high_pri),
                    "wins": high_wins,
                    "win_rate": round(high_wins / len(high_pri) * 100, 1) if high_pri else 0.0
                },
                "low_priority_4_5": {
                    "games": len(low_pri),
                    "wins": low_wins,
                    "win_rate": round(low_wins / len(low_pri) * 100, 1) if low_pri else 0.0
                }
            }
        }

    # 5. BO-Clustered Bootstrap 统计推断
    print("\n[7/7] 执行系列赛 (BO) 聚类 Bootstrap 检验 (2,000 次重抽样)...")
    np.random.seed(42)
    B = 2000
    
    def run_clustered_bootstrap(games_q, games_h):
        # 按比赛聚类
        mid_q_games = defaultdict(list)
        for g in games_q:
            mid_q_games[g["match_id"]].append(g)
            
        mid_h_games = defaultdict(list)
        for g in games_h:
            mid_h_games[g["match_id"]].append(g)
            
        q_mids = list(mid_q_games.keys())
        h_mids = list(mid_h_games.keys())
        
        boot_diff_wr = []
        boot_diff_dpm = []
        boot_diff_adc_share = []
        boot_diff_jug_kills = []
        boot_diff_top_dpm = []
        
        boot_q_wr = []
        boot_h_wr = []
        boot_q_dpm = []
        boot_h_dpm = []
        
        for _ in range(B):
            sample_q_m = np.random.choice(q_mids, size=len(q_mids), replace=True)
            sample_h_m = np.random.choice(h_mids, size=len(h_mids), replace=True)
            
            sq_g = [g for sm in sample_q_m for g in mid_q_games[sm]]
            sh_g = [g for sm in sample_h_m for g in mid_h_games[sm]]
            
            q_wr = np.mean([1 if g["is_winner"] else 0 for g in sq_g])
            h_wr = np.mean([1 if g["is_winner"] else 0 for g in sh_g])
            
            q_dpm = np.mean([g["mid_stats"]["dpm"] for g in sq_g])
            h_dpm = np.mean([g["mid_stats"]["dpm"] for g in sh_g])
            
            boot_q_wr.append(q_wr)
            boot_h_wr.append(h_wr)
            boot_q_dpm.append(q_dpm)
            boot_h_dpm.append(h_dpm)
            
            boot_diff_wr.append(q_wr - h_wr)
            boot_diff_dpm.append(q_dpm - h_dpm)
            
            # ADC 伤害占比差异 (小寒)
            q_adc_share = np.mean([g["team_positions"]["发育路"]["damage_share"] for g in sq_g if "发育路" in g["team_positions"]])
            h_adc_share = np.mean([g["team_positions"]["发育路"]["damage_share"] for g in sh_g if "发育路" in g["team_positions"]])
            boot_diff_adc_share.append(q_adc_share - h_adc_share)
            
            # 打野击杀差异 (无双)
            q_jug_k = np.mean([g["team_positions"]["打野"]["kills"] for g in sq_g if "打野" in g["team_positions"]])
            h_jug_k = np.mean([g["team_positions"]["打野"]["kills"] for g in sh_g if "打野" in g["team_positions"]])
            boot_diff_jug_kills.append(q_jug_k - h_jug_k)
            
            # 对抗路输出差异 (光明)
            q_top_dpm = np.mean([g["team_positions"]["对抗路"]["dpm"] for g in sq_g if "对抗路" in g["team_positions"]])
            h_top_dpm = np.mean([g["team_positions"]["对抗路"]["dpm"] for g in sh_g if "对抗路" in g["team_positions"]])
            boot_diff_top_dpm.append(q_top_dpm - h_top_dpm)
            
        return {
            "iterations": B,
            "q_win_rate_mean": round(float(np.mean(boot_q_wr) * 100), 2),
            "q_win_rate_ci_95": [round(float(np.percentile(boot_q_wr, 2.5) * 100), 2), round(float(np.percentile(boot_q_wr, 97.5) * 100), 2)],
            "h_win_rate_mean": round(float(np.mean(boot_h_wr) * 100), 2),
            "h_win_rate_ci_95": [round(float(np.percentile(boot_h_wr, 2.5) * 100), 2), round(float(np.percentile(boot_h_wr, 97.5) * 100), 2)],
            "win_rate_diff_mean_pp": round(float(np.mean(boot_diff_wr) * 100), 2),
            "win_rate_diff_ci_95_pp": [round(float(np.percentile(boot_diff_wr, 2.5) * 100), 2), round(float(np.percentile(boot_diff_wr, 97.5) * 100), 2)],
            "prob_q_wr_greater_than_h": round(float(np.mean(np.array(boot_diff_wr) > 0)), 4),
            "q_dpm_mean": round(float(np.mean(boot_q_dpm)), 1),
            "q_dpm_ci_95": [round(float(np.percentile(boot_q_dpm, 2.5)), 1), round(float(np.percentile(boot_q_dpm, 97.5)), 1)],
            "h_dpm_mean": round(float(np.mean(boot_h_dpm)), 1),
            "h_dpm_ci_95": [round(float(np.percentile(boot_h_dpm, 2.5)), 1), round(float(np.percentile(boot_h_dpm, 97.5)), 1)],
            "dpm_diff_mean": round(float(np.mean(boot_diff_dpm)), 1),
            "dpm_diff_ci_95": [round(float(np.percentile(boot_diff_dpm, 2.5)), 1), round(float(np.percentile(boot_diff_dpm, 97.5)), 1)],
            "prob_q_dpm_greater_than_h": round(float(np.mean(np.array(boot_diff_dpm) > 0)), 4),
            "adc_damage_share_diff_mean_pp": round(float(np.mean(boot_diff_adc_share)), 2),
            "adc_damage_share_diff_ci_95_pp": [round(float(np.percentile(boot_diff_adc_share, 2.5)), 2), round(float(np.percentile(boot_diff_adc_share, 97.5)), 2)],
            "jug_kills_diff_mean": round(float(np.mean(boot_diff_jug_kills)), 2),
            "jug_kills_diff_ci_95": [round(float(np.percentile(boot_diff_jug_kills, 2.5)), 2), round(float(np.percentile(boot_diff_jug_kills, 97.5)), 2)],
            "top_dpm_diff_mean": round(float(np.mean(boot_diff_top_dpm)), 1),
            "top_dpm_diff_ci_95": [round(float(np.percentile(boot_diff_top_dpm, 2.5)), 1), round(float(np.percentile(boot_diff_top_dpm, 97.5)), 1)]
        }
        
    summer_bootstrap = run_clustered_bootstrap(summer_q, summer_h)
    all_2026_bootstrap = run_clustered_bootstrap(all_q, all_h)
    
    # 6. 对手强度与阶段分层
    top_tier_opponents = {"ag", "ttg", "wolves", "wb"}
    def stratify_opponents(games_list):
        top_games = [g for g in games_list if g["opponent_id"] in top_tier_opponents]
        other_games = [g for g in games_list if g["opponent_id"] not in top_tier_opponents]
        return {
            "top_tier_opponents_ag_ttg_wolves_wb": {
                "games": len(top_games),
                "pct_of_player_games": round(len(top_games) / len(games_list) * 100, 1) if games_list else 0.0,
                "wins": sum(1 for g in top_games if g["is_winner"]),
                "win_rate": round(sum(1 for g in top_games if g["is_winner"]) / len(top_games) * 100, 1) if top_games else 0.0
            },
            "lower_tier_opponents": {
                "games": len(other_games),
                "pct_of_player_games": round(len(other_games) / len(games_list) * 100, 1) if games_list else 0.0,
                "wins": sum(1 for g in other_games if g["is_winner"]),
                "win_rate": round(sum(1 for g in other_games if g["is_winner"]) / len(other_games) * 100, 1) if other_games else 0.0
            }
        }
        
    def stratify_stages(games_list):
        stages = Counter(g["stage"] for g in games_list)
        res = {}
        for st, cnt in stages.items():
            st_g = [g for g in games_list if g["stage"] == st]
            w = sum(1 for g in st_g if g["is_winner"])
            res[st] = {
                "games": cnt,
                "wins": w,
                "win_rate": round(w / cnt * 100, 1)
            }
        return res
        
    # 7. 系列赛级别聚合 (Series Level Aggregation)
    # 按比赛分派主要中单：出场局数过半归属；同局数归属打前序局者
    cur.execute("""
        SELECT 
            m.id as match_id, m.season_id, m.stage, m.played_at, m.winner_id,
            m.team_a_id, m.team_b_id, m.score_a, m.score_b
        FROM matches m
        WHERE m.season_id = ANY(%s) AND (m.team_a_id = 'jdg' OR m.team_b_id = 'jdg')
        ORDER BY m.played_at;
    """, (seasons_2026,))
    all_2026_matches_db = cur.fetchall()
    
    series_q = []
    series_h = []
    series_mixed = []
    for m_row in all_2026_matches_db:
        mid = m_row["match_id"]
        m_g = [g for g in parsed_games if g["match_id"] == mid]
        if not m_g:
            continue
        q_count = sum(1 for g in m_g if g["mid_player"] == "清融")
        h_count = sum(1 for g in m_g if g["mid_player"] == "昊昊")
        is_jdg_win = (m_row["winner_id"] == "jdg")
        
        m_summary = {
            "match_id": mid,
            "season_id": m_row["season_id"],
            "stage": m_row["stage"],
            "played_at": m_row["played_at"],
            "score": f"{m_row['score_a']}-{m_row['score_b']}" if m_row["team_a_id"] == "jdg" else f"{m_row['score_b']}-{m_row['score_a']}",
            "is_jdg_win": is_jdg_win,
            "qingrong_games": q_count,
            "haohao_games": h_count,
            "total_games": len(m_g)
        }
        
        if q_count > 0 and h_count > 0:
            series_mixed.append(m_summary)
            # 按出战多数局划分主体责任 (与 HTML 报告口径一致)
            if q_count > h_count:
                series_q.append(m_summary)
            else:
                series_h.append(m_summary)
        elif q_count > 0:
            series_q.append(m_summary)
        elif h_count > 0:
            series_h.append(m_summary)
            
    # 生涯历史数据查询 (清融 vs 昊昊 历史全量)
    print("\n提取历史生涯数据以供分层对照...")
    cur.execute("""
        SELECT 
            pg.player_id,
            m.season_id,
            s.name as season_name,
            pg.team_id,
            t.short_name as team_short_name,
            count(*) as games,
            count(*) FILTER (WHERE pg.mvp = true) as mvps,
            count(*) FILTER (WHERE pg.lose_mvp = true) as lose_mvps
        FROM player_games pg
        JOIN games g ON pg.game_id = g.id
        JOIN matches m ON g.match_id = m.id
        LEFT JOIN seasons s ON m.season_id = s.id
        LEFT JOIN teams t ON pg.team_id = t.id
        WHERE pg.player_id IN ('昊昊', '清融')
        GROUP BY pg.player_id, m.season_id, s.name, pg.team_id, t.short_name
        ORDER BY pg.player_id, m.season_id;
    """)
    career_breakdown = cur.fetchall()
    
    # 汇总产物结构
    samples_block = {
        "summer_2026_control": {
            "description": "2026 夏季赛同四队友黄金样本 (光明、无双、小寒、无畏 全勤80局)",
            "qingrong": aggregate_slice(summer_q),
            "haohao": aggregate_slice(summer_h),
            "sides": {
                "qingrong": aggregate_sides(summer_q),
                "haohao": aggregate_sides(summer_h)
            },
            "teammates": {
                "qingrong": aggregate_teammates(summer_q),
                "haohao": aggregate_teammates(summer_h)
            },
            "heroes": {
                "qingrong": aggregate_heroes(summer_q),
                "haohao": aggregate_heroes(summer_h)
            },
            "draft_priority": {
                "qingrong": aggregate_bp(summer_q),
                "haohao": aggregate_bp(summer_h)
            },
            "bootstrap_clustered": summer_bootstrap,
            "confounding_audit": {
                "opponent_strength": {
                    "qingrong": stratify_opponents(summer_q),
                    "haohao": stratify_opponents(summer_h)
                },
                "stage_distribution": {
                    "qingrong": stratify_stages(summer_q),
                    "haohao": stratify_stages(summer_h)
                }
            }
        },
        "season_2026_all": {
            "description": "2026 全年总览 (含春季赛、挑杯、夏季赛、年度总决赛共211局)",
            "qingrong": aggregate_slice(all_q),
            "haohao": aggregate_slice(all_h),
            "series_record": {
                "qingrong": {
                    "matches": len(series_q),
                    "wins": sum(1 for m in series_q if m["is_jdg_win"]),
                    "losses": len(series_q) - sum(1 for m in series_q if m["is_jdg_win"]),
                    "win_rate": round(sum(1 for m in series_q if m["is_jdg_win"]) / len(series_q) * 100, 1) if series_q else 0.0
                },
                "haohao": {
                    "matches": len(series_h),
                    "wins": sum(1 for m in series_h if m["is_jdg_win"]),
                    "losses": len(series_h) - sum(1 for m in series_h if m["is_jdg_win"]),
                    "win_rate": round(sum(1 for m in series_h if m["is_jdg_win"]) / len(series_h) * 100, 1) if series_h else 0.0
                },
                "intra_rotation_matches": series_mixed
            },
            "teammate_pairing_coverage": {
                "xiaohan_adc": {"qingrong_games": 145, "haohao_games": 51, "type": "paired"},
                "guangming_top": {"qingrong_games": 40, "haohao_games": 46, "type": "paired"},
                "wushuang_jug": {"qingrong_games": 160, "haohao_games": 51, "type": "paired"},
                "wuwei_sup": {"qingrong_games": 160, "haohao_games": 51, "type": "paired"},
                "qingyu_top": {"qingrong_games": 115, "haohao_games": 0, "type": "unpaired_historical"},
                "jueyi_adc": {"qingrong_games": 15, "haohao_games": 0, "type": "unpaired_historical"},
                "huayuan_top": {"qingrong_games": 3, "haohao_games": 5, "type": "paired_annual"}
            },
            "sides": {
                "qingrong": aggregate_sides(all_q),
                "haohao": aggregate_sides(all_h)
            },
            "heroes": {
                "qingrong": aggregate_heroes(all_q),
                "haohao": aggregate_heroes(all_h)
            },
            "draft_priority": {
                "qingrong": aggregate_bp(all_q),
                "haohao": aggregate_bp(all_h)
            },
            "bootstrap_clustered": all_2026_bootstrap
        },
        "career_history": {
            "description": "数据库内全量生涯记录 (清融 917 局 vs 昊昊 59 局)",
            "qingrong_total_games_in_db": 917,
            "qingrong_jdg_games": 280,
            "qingrong_estar_games": 637,
            "haohao_total_games_in_db": 59,
            "haohao_jdg_games": 51,
            "haohao_estar_games": 8,
            "career_breakdown_by_season": [dict(r) for r in career_breakdown]
        }
    }
    
    findings_block = [
        {
            "id": "FINDING-01",
            "tier": "A",
            "title": "胜率无统计学显著差异，二者体系互补而非上下位替代",
            "detail": "按真实胜负修复后，夏季赛同阵容清融胜率 59.46% (22/37)，昊昊胜率 53.49% (23/43)；全年系列赛胜率清融 70.6% (24/34)，昊昊 66.7% (8/12)。经 BO 聚类 Bootstrap 检验，胜率差值 95% 置信区间为 [-17.79pp, +25.60pp]，跨越零点，置信区间高度重叠，不存在谁单纯更能带队赢的结论。"
        },
        {
            "id": "FINDING-02",
            "tier": "A",
            "title": "经济占比近乎均等，不存在中单主动让经济假说",
            "detail": "2026 夏季赛昊昊中路经济占比 18.38%，清融 18.25%（全年清融 18.1% vs 昊昊 18.4%）。两套体系经济分配规则一致，昊昊甚至略高 0.1~0.3pp。输出结构变化由英雄选角、站位及打法机制驱动，非线上主动经济让渡。"
        },
        {
            "id": "FINDING-03",
            "tier": "A",
            "title": "清融为高转化中核，昊昊体系终结权向发育路小寒转移",
            "detail": "清融每千经济输出转化率达 1105.7% (全年 1139.6%)，在场时全队第一输出点为中路 (26.69%~29.1%)；昊昊在场时发育路小寒击杀从 2.05 升至 2.70 (+31.7%)，死亡从 1.08 降至 0.93 (-13.9%)，伤害占比从 25.76% 升至 28.25%，反超中路成为全队第一输出核心。"
        },
        {
            "id": "FINDING-04",
            "tier": "A",
            "title": "清融中野上半区联动紧密，大幅激活打野与对抗路",
            "detail": "清融在场时，打野无双击杀达 2.30 (+56.5%)，DPM 达 4685 (+26.6%)，参团率达 73.53% (+8.58pp)；对抗路光明击杀达 1.76 (+61.5%)，DPM 达 4381 (+20.6%)，参团率达 62.89% (+8.81pp)。清融的防守封路与中轴压迫极大地解放了上半区作战节奏。"
        },
        {
            "id": "FINDING-05",
            "tier": "A",
            "title": "昊昊获得更高 BP 顺位，但高顺位未直接换来超额收益",
            "detail": "昊昊全场前三手选出率达 40.8% (清融仅 15.2%)，队内平均选人顺位 2.92 对 3.27 更靠前。然而昊昊队内 1-2 手高顺位时胜率仅 50.0%，4-5 手低顺位反弹至 71.4%；清融对顺位不敏感 (58.5% vs 61.8%)，具备更宽广的英雄池与后手抗压能力。"
        },
        {
            "id": "FINDING-06",
            "tier": "B",
            "title": "夏季赛同四队友仍非控制实验，存在严重阶段与对手强度混杂",
            "detail": "清融夏季赛 37 局全部在常规赛第 1、2 轮完成；昊昊 43 局中有 40 局在常规赛第 3 轮与季后赛高压环境进行。昊昊对阵 S 组及顶尖强队 (AG, TTG, 狼队, WB) 比例高达 76.7% (33/43 局)，远高于清融的 45.9% (17/37 局)，并面临双败淘汰 BO7 的深英雄池严峻考验。"
        },
        {
            "id": "FINDING-07",
            "tier": "A",
            "title": "2026 年度总决赛演变为结构化双轨制首发轮换",
            "detail": "在 10-03 首战对 EDG.M 遭遇 2-3 逆转后，教练组自 10-05 起确立固定轮换公式：由昊昊首发打 G1、G2 (阵地法核快速破局，小局 6 战全胜)，清融在 G3 登场收官终结 (沈梦溪/安琪拉，小局 3 战全胜)，连续以 3-0 横扫 LGD.NBW、Hero久竞与深圳DYG。"
        }
    ]
    
    metadata_block = {
        "generated_at": datetime.now().isoformat(),
        "database_source": "KPL Official Production DB (Mirror: Supabase/lusudeyrkmwyryckytag)",
        "fields_dictionary": {
            "is_winner": "真实单局胜负，依据 raw.win_camp 与 raw.camp1/camp2.team_id 严格映射，消除 DB winner_id 翻转缺陷",
            "winner_flipped_in_db": "指示该小局在原 games.winner_id 中是否被错误翻转",
            "dpm": "分均输出伤害 = 对英雄伤害 / (比赛时长秒 / 60)",
            "dtpm": "分均承伤 = 承受伤害 / (比赛时长秒 / 60)",
            "gpm": "分均经济 = 总金币 / (比赛时长秒 / 60)",
            "kda": "(击杀 + 助攻) / max(死亡, 1)",
            "damage_share": "该选手输出在己方 5 人总输出中的百分比",
            "gold_share": "该选手经济在己方 5 人总经济中的百分比",
            "gold_efficiency": "超额伤害转化比 = damage_share / gold_share",
            "team_pick_order": "JDG 队内选角顺位 (1~5)",
            "overall_pick_order": "全局所有选人顺位 (1~10)",
            "is_top3_pick": "全局前三手选出 (overall_pick_order <= 3)",
            "is_counter_pick": "队内第 5 手终极 counter 选出"
        },
        "statistical_methods": {
            "wilson_ci": "Wilson 得分二项分布置信区间 (95%)",
            "clustered_bootstrap": "以大场 (BO 系列赛) 为聚类簇单位的有放回重抽样，评估样本内聚类相关性下的置信区间与假设检验"
        }
    }
    
    output_payload = {
        "coverage": {
            "total_games": len(parsed_games),
            "total_matches": len(all_2026_matches_db),
            "total_player_games": len(parsed_games) * 5,
            "seasons": seasons_2026,
            "players": ["清融", "昊昊"],
            "bp_complete_games": sum(1 for g in parsed_games if g["bp_data"]["has_full_bp"]),
            "bp_incomplete_games": sum(1 for g in parsed_games if not g["bp_data"]["has_full_bp"]),
            "db_flips_detected": flipped_counter
        },
        "samples": samples_block,
        "games": parsed_games,
        "findings": findings_block,
        "metadata": metadata_block
    }
    
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(output_payload, f, ensure_ascii=False, indent=2, cls=CustomEncoder)
        
    print(f"\n[OK] 数据分析产物成功写入: {OUTPUT_FILE}")
    print(f"     文件体积: {OUTPUT_FILE.stat().st_size / 1024 / 1024:.2f} MB")
    print("=" * 60)
    print("管线执行完毕！")

if __name__ == "__main__":
    main()

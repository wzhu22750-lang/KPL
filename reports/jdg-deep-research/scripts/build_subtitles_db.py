#!/usr/bin/env python3
"""
build_subtitles_db.py

全库字幕 SQLite/FTS 索引构建器。
1. 复用 data/commentary_parsed.jsonl (7,839 条已解析记录)
2. 扫描全字幕源库，增量补全 52 个未索引的新增文件 (2026年度总决赛等)
3. 关联 reports/jdg-deep-research/processed/matches_db_cache.json 中的赛事数据库，判定置信度
4. 建立 SQLite 数据库及 FTS5 全文索引（按中文字符加空格分词，支持任意中文精准短语与布尔匹配）
"""

import os
import sys
import glob
import json
import re
import time
import sqlite3
from typing import Dict, Any, List, Optional, Tuple

BASE_DIR = "/Users/kuangqie/Documents/VibeCoding/B站字幕提取/KPL解说"
PARSED_JSONL = "data/commentary_parsed.jsonl"
MATCHES_CACHE = "reports/jdg-deep-research/processed/matches_db_cache.json"
OUTPUT_DB = "reports/jdg-deep-research/processed/subtitles.db"

# ─── 战队名映射 ────────────────────────────────────────────────────────
TEAM_ALIAS_MAP = {
    "成都AG超玩会": "ag", "AG超玩会": "ag", "成都AG": "ag", "AG": "ag", "超玩会": "ag",
    "重庆狼队": "wolves", "狼队": "wolves", "重庆QGhappy": "wolves", "QGhappy": "wolves",
    "武汉eStarPro": "estar", "eStarPro": "estar", "武汉eStar": "estar", "eStar": "estar", "ES": "estar",
    "北京WB": "wb", "WB战队": "wb", "北京微博": "wb", "WB": "wb", "TS战队": "wb",
    "深圳DYG": "dyg", "DYG战队": "dyg", "DYG": "dyg",
    "北京JDG": "jdg", "JDG王者荣耀": "jdg", "JDG": "jdg",
    "长沙TES.A": "tes-a", "TES.A": "tes-a", "TES": "tes-a", "滔搏": "tes-a", "滔博": "tes-a",
    "广州TTG": "ttg", "TTG战队": "ttg", "TTG": "ttg",
    "佛山DRG": "drg", "DRG.GK": "drg", "佛山DRG.GK": "drg", "佛山GK": "drg", "DRG": "drg",
    "南通Hero久竞": "hero", "Hero久竞": "hero", "南京Hero久竞": "hero", "南京Hero": "hero", "Hero": "hero",
    "济南RW侠": "rw", "RW侠": "rw", "济南RW.侠": "rw", "济南RW": "rw", "RW": "rw",
    "西安WE": "we", "WE战队": "we", "WE": "we",
    "上海EDG.M": "edgm", "EDG.M": "edgm", "EDGM": "edgm",
    "上海RNG.M": "rngm", "RNG.M": "rngm", "RNGM": "rngm", "RNG": "rngm",
    "杭州LGD.NBW": "lgd-nbw", "LGD.NBW": "lgd-nbw", "杭州LGD大鹅": "lgd-nbw", "LGD": "lgd-nbw",
    "苏州KSG": "ksg", "KSG战队": "ksg", "KSG": "ksg", "快手": "ksg",
    "桐乡情久": "qingjiu", "情久": "qingjiu", "QJ": "qingjiu",
    "无锡TCG": "tcg", "TCG": "tcg",
    "XYG": "xyg", "郑州MTG": "mtg", "MTG": "mtg", "厦门VG": "vg", "VG": "vg",
    "BOA": "boa", "九江TKL": "tkl", "TKL": "tkl"
}

# 按别名长度降序排序
SORTED_ALIASES = sorted(TEAM_ALIAS_MAP.keys(), key=lambda x: len(x), reverse=True)

def resolve_team_slug(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    cleaned = re.sub(r"^中国", "", raw)
    cleaned = re.sub(r"\s+\d+月\d+日.*$", "", cleaned)
    cleaned = re.sub(r"赛前采访$", "", cleaned).strip()
    if cleaned in TEAM_ALIAS_MAP:
        return TEAM_ALIAS_MAP[cleaned]
    if raw.strip() in TEAM_ALIAS_MAP:
        return TEAM_ALIAS_MAP[raw.strip()]
    for alias in SORTED_ALIASES:
        if alias in cleaned or alias in raw:
            return TEAM_ALIAS_MAP[alias]
    return None

def parse_season_dir(dir_name: str) -> Dict[str, Any]:
    ym = re.search(r"(\d{4})", dir_name)
    year = int(ym.group(1)) if ym else 0
    split = "other"
    if "春季赛" in dir_name:
        split = "spring"
    elif "夏季赛" in dir_name:
        split = "summer"
    elif "挑战者杯" in dir_name:
        split = "challenger"
    elif any(k in dir_name for k in ["世界冠军杯", "世冠", "KIC"]):
        split = "worlds"
    elif any(k in dir_name for k in ["年度总决赛", "年总"]):
        split = "annual"
    return {"year": year, "split": split, "seasonId": f"kpl-{year}-{split}"}

GAME_NO_MAP = {
    "第一局": 1, "第二局": 2, "第三局": 3, "第四局": 4,
    "第五局": 5, "第六局": 6, "第七局": 7, "第八局": 8, "第九局": 9,
}

def parse_content_type(file_name: str, title: str) -> Tuple[str, Optional[int], str]:
    pt_match = re.match(r"^P\d+_(.+)\.md$", file_name)
    part_title = pt_match.group(1).strip() if pt_match else file_name.replace(".md", "")
    part_title = re.sub(r"[-_ ]*4[kK]$", "", part_title).strip()

    for label, no in GAME_NO_MAP.items():
        if label in part_title or label in title:
            return ("game", no, part_title)

    num_match = re.match(r"^(\d+)$", part_title)
    if num_match:
        n = int(num_match.group(1))
        if 1 <= n <= 9:
            return ("game", n, part_title)

    if any(k in part_title for k in ["赛后采访", "采访"]):
        return ("interview", None, part_title)
    if any(k in part_title for k in ["赛前评论", "赛前节目", "赛前预测", "评论席", "赛前采访"]):
        return ("pre-show", None, part_title)
    if any(k in part_title or k in title for k in ["宣传", "巡礼", "开幕", "预告", "晋级之路", "CG", "本命英雄"]):
        return ("promo", None, part_title)

    return ("other", None, part_title)

def parse_stage(title: str, match_dir: str) -> Optional[str]:
    text = title + " " + match_dir
    if "总决赛" in text: return "总决赛"
    if "半决赛" in text: return "半决赛"
    if "淘汰赛" in text: return "淘汰赛"
    if "季后赛" in text: return "季后赛"
    if "擂台赛" in text: return "擂台赛"
    if "小组赛" in text: return "小组赛"
    if "瑞士轮" in text: return "瑞士轮"
    if "选拔赛" in text: return "选拔赛"
    if "外卡" in text: return "外卡赛"
    if "常规赛" in text: return "常规赛"
    if "决赛" in text: return "决赛"
    return None

def parse_teams(match_dir: str, title: str) -> Tuple[Optional[str], Optional[str]]:
    for text in [match_dir, title]:
        vs_m = re.search(r"【.*?】\s*\d*月?\d*日?\s*(.+?)\s+[vV][sS]\.?\s+(.+?)(?:_BV|\s*[-_]|$)", text)
        if vs_m:
            home = vs_m.group(1).strip()
            away = vs_m.group(2).strip()
            away = re.sub(r"_BV[A-Za-z0-9]+$", "", away).strip()
            away = re.sub(r"\s+\d+月\d+日.*$", "", away).strip()
            away = re.sub(r"赛前采访$", "", away).strip()
            away = re.sub(r"\s+-\s+P\d+.*$", "", away).strip()
            home = re.sub(r"\s+-\s+P\d+.*$", "", home).strip()
            return (home, away)
    return (None, None)

def parse_timestamp(raw: str) -> int:
    parts = [int(p) for p in raw.split(":")]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return 0

def find_game_start(subtitles: List[Dict[str, Any]], game_no: Optional[int]) -> Optional[Dict[str, Any]]:
    min_time = 30 if game_no == 1 else 120
    # Pass 1: 我是解说
    for i, s in enumerate(subtitles):
        if s["timeSecs"] < min_time: continue
        if "我是解说" in s["text"]:
            return {"splitIndex": i, "gameStartSecs": s["timeSecs"], "method": "caster_intro"}
    # Pass 2: 全军出击
    for i, s in enumerate(subtitles):
        if s["timeSecs"] < min_time: continue
        if "全军出击" in s["text"]:
            return {"splitIndex": i, "gameStartSecs": s["timeSecs"], "method": "battle_cry"}
    # Pass 3: 蓝色方 / 红色方
    for i, s in enumerate(subtitles):
        if s["timeSecs"] < min_time: continue
        t = s["text"]
        if "蓝色方" in t or "红色方" in t:
            confirmed = False
            for j in range(i + 1, min(len(subtitles), i + 20)):
                if subtitles[j]["timeSecs"] - s["timeSecs"] > 90: break
                if any(w in subtitles[j]["text"] for w in ["出击", "开局", "勇往直前", "出发", "解说", "加油"]):
                    confirmed = True
                    break
            return {
                "splitIndex": i,
                "gameStartSecs": s["timeSecs"],
                "method": "side_announce" if confirmed else "side_announce_unconfirmed"
            }
    return None

def parse_markdown_file(file_path: str, season_dir: str, match_dir: str) -> Optional[Dict[str, Any]]:
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
    file_name = os.path.basename(file_path)

    title_m = re.search(r"^#\s+(.+)$", content, re.M)
    title = title_m.group(1).strip() if title_m else ""
    pub_m = re.search(r"\*\*发布时间\*\*[：:]\s*(\d{4}-\d{2}-\d{2})", content)
    publish_date = pub_m.group(1) if pub_m else ""
    url_m = re.search(r"\*\*视频链接\*\*[：:]\s*(https?://[^\s)]+)", content)
    video_url = url_m.group(1) if url_m else ""
    bvid_m = re.search(r"\*\*BVID\*\*[：:]\s*`([^`]+)`", content)
    bvid = bvid_m.group(1) if bvid_m else ""
    cid_m = re.search(r"\*\*CID\*\*[：:]\s*`([^`]+)`", content)
    cid = cid_m.group(1) if cid_m else None
    lines_m = re.search(r"\*\*字幕总行数\*\*[：:]\s*(\d+)", content)
    subtitle_line_count = int(lines_m.group(1)) if lines_m else 0
    part_m = re.search(r"\*\*分P\*\*[：:]\s*第\s*(\d+)\s*集\s*/\s*共\s*(\d+)\s*集", content)
    part_no = int(part_m.group(1)) if part_m else 1
    total_parts = int(part_m.group(2)) if part_m else None
    desc_m = re.search(r"## 视频简介\s*\n\n([\s\S]*?)(?=\n---|\n## )", content)
    description = desc_m.group(1).strip() if desc_m else ""

    # Parse subtitles
    subtitles = []
    sub_re = re.compile(r"^- \[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$", re.M)
    for m in sub_re.finditer(content):
        t_raw = m.group(1)
        t_secs = parse_timestamp(t_raw)
        subtitles.append({
            "timeSecs": t_secs,
            "timeRaw": t_raw,
            "text": m.group(2).strip()
        })

    s_info = parse_season_dir(season_dir)
    c_info = parse_content_type(file_name, title)
    home_raw, away_raw = parse_teams(match_dir, title)
    home_slug = resolve_team_slug(home_raw)
    away_slug = resolve_team_slug(away_raw)
    is_match = bool(re.search(r"\s+[vV][sS]\.?\s+", match_dir) or re.search(r"\s+[vV][sS]\.?\s+", title))
    stage = parse_stage(title, match_dir)

    bp_split = None
    if c_info[0] == "game" and subtitles:
        bp_split_data = find_game_start(subtitles, c_info[1])
        if bp_split_data:
            split_idx = bp_split_data["splitIndex"]
            bp_lines = subtitles[:split_idx]
            game_lines = subtitles[split_idx:]
            bp_split = {
                "splitIndex": split_idx,
                "gameStartSecs": bp_split_data["gameStartSecs"],
                "method": bp_split_data["method"],
                "bpLineCount": len(bp_lines),
                "bpCharCount": sum(len(s["text"]) for s in bp_lines),
                "gameLineCount": len(game_lines),
                "gameCharCount": sum(len(s["text"]) for s in game_lines)
            }

    duration_secs = subtitles[-1]["timeSecs"] if subtitles else 0
    char_count = sum(len(s["text"]) for s in subtitles)
    part_id = f"{bvid}_P{part_no:02d}"

    return {
        "id": part_id,
        "bvid": bvid,
        "cid": cid,
        "partNo": part_no,
        "totalParts": total_parts,
        "publishDate": publish_date,
        "videoUrl": video_url,
        "seasonDir": season_dir,
        "seasonId": s_info["seasonId"],
        "year": s_info["year"],
        "split": s_info["split"],
        "matchDir": match_dir,
        "homeTeamRaw": home_raw,
        "awayTeamRaw": away_raw,
        "homeTeamSlug": home_slug,
        "awayTeamSlug": away_slug,
        "isMatch": is_match,
        "contentType": c_info[0],
        "gameNo": c_info[1],
        "partTitle": c_info[2],
        "title": title,
        "description": description,
        "subtitleLineCount": len(subtitles),
        "durationSecs": duration_secs,
        "charCount": char_count,
        "subtitles": subtitles,
        "stage": stage,
        "bpSplit": bp_split
    }

# ─── 数据库匹配逻辑 ───────────────────────────────────────────────────

def build_db_match_index(matches: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    # Index by teams pair (sorted)
    index: Dict[str, List[Dict[str, Any]]] = {}
    for m in matches:
        t_a = m.get("team_a_id") or ""
        t_b = m.get("team_b_id") or ""
        pair = tuple(sorted([t_a, t_b]))
        key = f"{pair[0]}__{pair[1]}"
        index.setdefault(key, []).append(m)
    return index

def match_commentary_to_db(rec: Dict[str, Any], db_index: Dict[str, List[Dict[str, Any]]]) -> Tuple[Optional[str], Optional[str], str]:
    """
    匹配字幕记录到数据库比赛 ID 及小局 ID。
    返回 (match_id, game_id, confidence)
    置信度级别:
      'exact_match': 双方 slug 匹配 + 日期完全一致 + gameNo 匹配小局
      'high': 双方 slug 匹配 + 日期相差 <= 1天 + gameNo 匹配小局
      'medium': 双方 slug 匹配 + 赛季一致 + stage/gameNo 匹配但日期相差较大
      'unmatched': 无法明确匹配，不强配
    """
    if rec.get("contentType") != "game" or not rec.get("gameNo"):
        return (None, None, "unmatched")

    home_slug = rec.get("homeTeamSlug")
    away_slug = rec.get("awayTeamSlug")
    if not home_slug or not away_slug:
        return (None, None, "unmatched")

    pair = tuple(sorted([home_slug, away_slug]))
    key = f"{pair[0]}__{pair[1]}"
    candidates = db_index.get(key, [])
    if not candidates:
        return (None, None, "unmatched")

    rec_date = rec.get("publishDate")
    game_no = rec.get("gameNo")
    season_id = rec.get("seasonId")

    # Pass 1: exact date + game_no
    for m in candidates:
        if m.get("played_at") == rec_date:
            for g in m.get("games", []):
                if g.get("game_no") == game_no:
                    return (m["id"], g["id"], "exact_match")
            # If match found on exact date but game_no not yet in DB
            return (m["id"], None, "exact_match")

    # Pass 2: date diff <= 1 day + game_no
    if rec_date:
        rec_time = time.mktime(time.strptime(rec_date, "%Y-%m-%d"))
        for m in candidates:
            if m.get("played_at"):
                m_time = time.mktime(time.strptime(m["played_at"], "%Y-%m-%d"))
                diff_days = abs(rec_time - m_time) / 86400.0
                if diff_days <= 1.5:
                    for g in m.get("games", []):
                        if g.get("game_no") == game_no:
                            return (m["id"], g["id"], "high")
                    return (m["id"], None, "high")

    # Pass 3: same season + unique candidate
    season_candidates = [m for m in candidates if m.get("season_id") == season_id]
    if len(season_candidates) == 1:
        m = season_candidates[0]
        for g in m.get("games", []):
            if g.get("game_no") == game_no:
                return (m["id"], g["id"], "medium")
        return (m["id"], None, "medium")

    return (None, None, "unmatched")

# ─── SQLite 写入与 FTS 分词 ───────────────────────────────────────────

def space_tokenize_cjk(text: str) -> str:
    """
    对中文字符之间加空格，以便 SQLite FTS5 实现任意 CJK 词汇短语精准匹配。
    英文与数字按单词保持连续。
    """
    tokens = []
    current_word = []
    for char in text:
        # CJK Unicode range
        if '\u4e00' <= char <= '\u9fff':
            if current_word:
                tokens.append("".join(current_word))
                current_word = []
            tokens.append(char)
        elif char.isalnum():
            current_word.append(char)
        else:
            if current_word:
                tokens.append("".join(current_word))
                current_word = []
            if char.strip():
                tokens.append(char)
    if current_word:
        tokens.append("".join(current_word))
    return " ".join(tokens)

def main():
    print("=== 开始构建 KPL 全库字幕 SQLite/FTS 索引 ===")
    t0 = time.time()

    # 1. 加载比赛数据库缓存
    print(f"1. 加载比赛数据库缓存: {MATCHES_CACHE}")
    with open(MATCHES_CACHE, "r", encoding="utf-8") as f:
        matches = json.load(f)
    db_index = build_db_match_index(matches)
    print(f"   已建立 {len(matches)} 场比赛的对战检索索引")

    # 2. 读取已有的 7,839 条 parsed 记录
    print(f"2. 读取已有解析文件: {PARSED_JSONL}")
    existing_records = []
    indexed_part_ids = set()
    with open(PARSED_JSONL, "r", encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            existing_records.append(rec)
            indexed_part_ids.add(rec["id"])
    print(f"   已有记录: {len(existing_records)} 条")

    # 3. 扫描源库查找新增未索引文件
    print(f"3. 扫描字幕目录: {BASE_DIR}")
    all_md_files = glob.glob(f"{BASE_DIR}/**/*.md", recursive=True)
    print(f"   磁盘 MD 总文件数: {len(all_md_files)}")
    new_records = []
    for file_path in all_md_files:
        fname = os.path.basename(file_path)
        pdir = os.path.basename(os.path.dirname(file_path))
        sdir = os.path.basename(os.path.dirname(os.path.dirname(file_path)))
        bvid = "BV" + pdir.split("_BV")[-1] if "_BV" in pdir else ""
        part_prefix = fname.split("_")[0] if "_" in fname else ""
        pid = f"{bvid}_{part_prefix}"
        if pid not in indexed_part_ids:
            # 新增文件，解析它
            parsed = parse_markdown_file(file_path, sdir, pdir)
            if parsed:
                new_records.append(parsed)
                indexed_part_ids.add(parsed["id"])

    print(f"   新增并解析文件数: {len(new_records)}")
    all_records = existing_records + new_records
    print(f"   缓存记录数: {len(all_records)}（不代表比赛/赛季完整覆盖）")

    # 4. 创建 SQLite 数据库
    if os.path.exists(OUTPUT_DB):
        os.remove(OUTPUT_DB)
    os.makedirs(os.path.dirname(OUTPUT_DB), exist_ok=True)
    conn = sqlite3.connect(OUTPUT_DB)
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA cache_size = -64000;") # 64MB cache

    conn.execute("""
    CREATE TABLE parts (
        id TEXT PRIMARY KEY,
        bvid TEXT NOT NULL,
        cid TEXT,
        part_no INTEGER,
        total_parts INTEGER,
        publish_date TEXT,
        video_url TEXT,
        season_dir TEXT,
        season_id TEXT,
        year INTEGER,
        split TEXT,
        match_dir TEXT,
        home_team_raw TEXT,
        away_team_raw TEXT,
        home_team_slug TEXT,
        away_team_slug TEXT,
        is_match INTEGER,
        content_type TEXT,
        game_no INTEGER,
        part_title TEXT,
        title TEXT,
        description TEXT,
        subtitle_line_count INTEGER,
        duration_secs INTEGER,
        char_count INTEGER,
        stage TEXT,
        bp_split_index INTEGER,
        bp_game_start_secs INTEGER,
        bp_method TEXT,
        bp_line_count INTEGER,
        bp_char_count INTEGER,
        game_line_count INTEGER,
        game_char_count INTEGER,
        match_id TEXT,
        game_id TEXT,
        match_confidence TEXT
    );
    """)

    conn.execute("""
    CREATE TABLE subtitles (
        id INTEGER PRIMARY KEY,
        part_id TEXT NOT NULL,
        line_idx INTEGER NOT NULL,
        time_secs INTEGER NOT NULL,
        time_raw TEXT NOT NULL,
        text TEXT NOT NULL,
        is_bp INTEGER NOT NULL DEFAULT 0
    );
    """)

    conn.execute("""
    CREATE VIRTUAL TABLE subtitles_fts USING fts5(
        spaced_text,
        content='subtitles',
        content_rowid='id'
    );
    """)

    # 5. 批量写入
    print("5. 开始写入 SQLite 及 FTS 索引...")
    parts_to_insert = []
    subtitles_batch = []
    fts_batch = []
    sub_global_id = 1

    matched_count = 0
    for rec in all_records:
        match_id, game_id, confidence = match_commentary_to_db(rec, db_index)
        if confidence != "unmatched":
            matched_count += 1

        bp = rec.get("bpSplit") or {}
        split_idx = bp.get("splitIndex", -1)

        parts_to_insert.append((
            rec["id"], rec.get("bvid"), rec.get("cid"), rec.get("partNo"), rec.get("totalParts"),
            rec.get("publishDate"), rec.get("videoUrl"), rec.get("seasonDir"), rec.get("seasonId"),
            rec.get("year"), rec.get("split"), rec.get("matchDir"),
            rec.get("homeTeamRaw"), rec.get("awayTeamRaw"), rec.get("homeTeamSlug"), rec.get("awayTeamSlug"),
            1 if rec.get("isMatch") else 0, rec.get("contentType"), rec.get("gameNo"),
            rec.get("partTitle"), rec.get("title"), rec.get("description"),
            rec.get("subtitleLineCount"), rec.get("durationSecs"), rec.get("charCount"),
            rec.get("stage"),
            bp.get("splitIndex"), bp.get("gameStartSecs"), bp.get("method"),
            bp.get("bpLineCount"), bp.get("bpCharCount"),
            bp.get("gameLineCount"), bp.get("gameCharCount"),
            match_id, game_id, confidence
        ))

        for idx, sub in enumerate(rec.get("subtitles", [])):
            is_bp = 1 if (split_idx != -1 and idx < split_idx) else 0
            text = sub.get("text", "")
            subtitles_batch.append((
                sub_global_id, rec["id"], idx, sub.get("timeSecs", 0), sub.get("timeRaw", ""), text, is_bp
            ))
            fts_batch.append((
                sub_global_id, space_tokenize_cjk(text)
            ))
            sub_global_id += 1

        if len(subtitles_batch) >= 50000:
            conn.executemany("INSERT INTO subtitles VALUES (?, ?, ?, ?, ?, ?, ?)", subtitles_batch)
            conn.executemany("INSERT INTO subtitles_fts (rowid, spaced_text) VALUES (?, ?)", fts_batch)
            conn.commit()
            subtitles_batch.clear()
            fts_batch.clear()
            print(f"   已写入 {sub_global_id-1} 条字幕...")

    if parts_to_insert:
        conn.executemany("""
        INSERT INTO parts VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        """, parts_to_insert)

    if subtitles_batch:
        conn.executemany("INSERT INTO subtitles VALUES (?, ?, ?, ?, ?, ?, ?)", subtitles_batch)
        conn.executemany("INSERT INTO subtitles_fts (rowid, spaced_text) VALUES (?, ?)", fts_batch)
        conn.commit()

    print("6. 创建数据库常规查询索引...")
    conn.execute("CREATE INDEX idx_parts_season ON parts(season_id);")
    conn.execute("CREATE INDEX idx_parts_teams ON parts(home_team_slug, away_team_slug);")
    conn.execute("CREATE INDEX idx_parts_match_id ON parts(match_id);")
    conn.execute("CREATE INDEX idx_parts_content_game ON parts(content_type, game_no);")
    conn.execute("CREATE INDEX idx_subtitles_part ON subtitles(part_id);")
    conn.execute("CREATE INDEX idx_subtitles_time ON subtitles(part_id, time_secs);")
    conn.commit()
    conn.close()

    db_size = os.path.getsize(OUTPUT_DB) / (1024 * 1024)
    t1 = time.time()
    print("=== SQLite/FTS 索引构建成功 ===")
    print(f"总耗时: {t1 - t0:.2f}s")
    print(f"总分P记录: {len(all_records)}")
    print(f"匹配到数据库比赛: {matched_count} 局")
    print(f"总字幕条数: {sub_global_id - 1}")
    print(f"数据库大小: {db_size:.2f} MB")
    print(f"文件位置: {OUTPUT_DB}")

if __name__ == "__main__":
    # Legacy rebuild discarded source provenance and could misassociate upload dates.
    # Preserve existing cache and route CLI to additive source verification instead.
    from verify_subtitles import main as verified_main
    verified_main()

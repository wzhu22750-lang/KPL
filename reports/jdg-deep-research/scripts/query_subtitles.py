#!/usr/bin/env python3
"""
query_subtitles.py

KPL 字幕数据库检索与上下文提取工具。
支持：
- 中文精准短语搜索与布尔检索 (利用 FTS5)
- 上下文扩展（前后 N 句或前后 N 秒）
- 战队、赛季、小局、BP 阶段多维度过滤
- 命令行直接查询与 Python 库导入调用
"""

import os
import sys
import argparse
import json
import sqlite3
from typing import List, Dict, Any, Optional

from pathlib import Path
DEFAULT_DB = str(Path(__file__).resolve().parents[1] / 'processed/subtitles.db')

def space_tokenize_cjk(text: str) -> str:
    tokens = []
    current_word = []
    for char in text:
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

def format_fts_query(phrase: str) -> str:
    """
    将用户输入的中文词语转换为 FTS5 精准短语语法。
    如 "不知火舞" -> '"不 知 火 舞"'
    """
    tokens = space_tokenize_cjk(phrase).strip()
    if not tokens:
        return ""
    return '"' + tokens.replace('"', '""') + '"'

class SubtitleDB:
    def __init__(self, db_path: str = DEFAULT_DB):
        self.db_path = db_path
        if not os.path.exists(db_path):
            raise FileNotFoundError(f"Database not found: {db_path}")
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row

    def close(self):
        self.conn.close()

    def search(
        self,
        keywords: List[str],
        team: Optional[str] = None,
        season: Optional[str] = None,
        year: Optional[int] = None,
        content_type: Optional[str] = None,
        is_bp: Optional[int] = None,
        limit: int = 50,
        context_window: int = 3
    ) -> List[Dict[str, Any]]:
        """
        检索字幕。
        keywords: 关键词列表（默认全部包含 AND，或者单短语）
        context_window: 附带的前后字幕行数
        """
        # 构建 FTS 表达式
        fts_clauses = [format_fts_query(k) for k in keywords if k.strip()]
        if not fts_clauses:
            return []
        match_expr = " AND ".join(fts_clauses)

        sql = """
        SELECT 
            s.id as sub_id, s.part_id, s.line_idx, s.source_line, s.time_secs, s.time_raw, s.text,
            CASE WHEN c.content_type='game' AND c.game_start_seconds IS NOT NULL AND s.time_secs<c.game_start_seconds THEN 1 ELSE 0 END AS is_bp,
            p.bvid, p.part_no, c.publish_date, c.season_id, c.year, p.match_dir,
            p.home_team_raw, p.away_team_raw, c.team_a AS home_team_slug, c.team_b AS away_team_slug,
            c.content_type, c.game_no, p.part_title, p.title, c.match_id, c.game_id, c.confidence AS match_confidence,
            c.path AS source_path, c.source_date, c.reason AS match_reason,
            CASE WHEN c.content_type='pre-show' THEN 'pre_show'
                 WHEN c.game_start_seconds IS NULL THEN 'unknown'
                 WHEN s.time_secs<c.game_start_seconds THEN 'bp_estimated'
                 ELSE 'game_estimated' END AS phase
        FROM subtitles_fts f
        JOIN subtitles s ON f.rowid = s.id
        JOIN parts p ON s.part_id = p.id
        JOIN metadata_corrections c ON c.path=s.source_path
        WHERE subtitles_fts MATCH ?
        """
        fts_table = 'subtitles_fts_verified' if self.conn.execute("SELECT 1 FROM sqlite_master WHERE name='subtitles_fts_verified'").fetchone() else 'subtitles_fts'
        sql = sql.replace('subtitles_fts', fts_table)
        params = [match_expr]

        if team:
            sql += " AND (c.team_a = ? OR c.team_b = ?)"
            params.extend([team, team])
        if season:
            sql += " AND c.season_id = ?"
            params.append(season)
        if year:
            sql += " AND c.year = ?"
            params.append(year)
        if content_type:
            sql += " AND c.content_type = ?"
            params.append(content_type)
        if is_bp is not None:
            # Deprecated --bp is an estimate filter; pre-show/unknown never counted as BP/game.
            sql += " AND c.content_type='game' AND c.game_start_seconds IS NOT NULL AND " + ('s.time_secs<c.game_start_seconds' if is_bp else 's.time_secs>=c.game_start_seconds')

        sql += " ORDER BY c.source_date DESC, s.id ASC LIMIT ?"
        params.append(max(0, int(limit)))

        cursor = self.conn.execute(sql, params)
        hits = [dict(row) for row in cursor.fetchall()]

        # 扩充上下文
        results = []
        for hit in hits:
            part_id = hit["part_id"]
            line_idx = hit["line_idx"]

            # 获取前后窗口字幕
            ctx_cursor = self.conn.execute("""
                SELECT line_idx, time_raw, time_secs, text, is_bp
                FROM subtitles
                WHERE part_id = ? AND line_idx BETWEEN ? AND ?
                ORDER BY line_idx ASC
            """, (part_id, max(0, line_idx - context_window), line_idx + context_window))
            ctx_lines = [dict(r) for r in ctx_cursor.fetchall()]

            # Cached FTS is candidate retrieval only: re-read original before displaying context.
            from verify_subtitles import SOURCE, read_source
            import hashlib
            raw, _, physical, source_subs = read_source(SOURCE / hit['source_path'])
            exact=[(i,s) for i,s in enumerate(source_subs) if i==hit['line_idx'] and s['line']==hit['source_line'] and s['seconds']==hit['time_secs'] and s['text']==hit['text']]
            hit['source_sha256']=hashlib.sha256(raw).hexdigest()
            hit['source_text_verified']=len(exact)==1
            if len(exact)==1:
                si,ss=exact[0]
                source_ctx=source_subs[max(0,si-context_window):si+context_window+1]
                hit['source_line']=ss['line']
                hit['quote']='\n'.join(physical[source_ctx[0]['line']-1:source_ctx[-1]['line']])
                hit['context']=[{'line_idx':i,'source_line':s['line'],'time_raw':s['raw'].split(']')[0][3:],'time_secs':s['seconds'],'text':s['text']} for i,s in enumerate(source_ctx,max(0,si-context_window))]
                hit['line_idx']=si
            else:
                hit['context']=[]
                hit['quote']=None  # stale/ambiguous candidates never become quotes
            results.append(hit)

        return results

    def get_full_part(self, part_id: str) -> Optional[Dict[str, Any]]:
        p_row = self.conn.execute("SELECT * FROM parts WHERE id = ?", (part_id,)).fetchone()
        if not p_row:
            return None
        res = dict(p_row)
        corrected=self.conn.execute('SELECT * FROM metadata_corrections WHERE part_id=?',(part_id,)).fetchall()
        res['verified_metadata']=[dict(r) for r in corrected]
        res['warning']='Parts metadata is legacy; subtitles are source-complete by ordinal. Use verified_metadata for match mapping.'
        s_rows = self.conn.execute("""
            SELECT line_idx, source_line, source_path, time_raw, time_secs, text, is_bp
            FROM subtitles
            WHERE part_id = ?
            ORDER BY line_idx ASC
        """, (part_id,)).fetchall()
        res["subtitles"] = [dict(r) for r in s_rows]
        return res

def main():
    parser = argparse.ArgumentParser(description="Query KPL Subtitles DB")
    parser.add_argument("keywords", nargs="+", help="Keywords to search")
    parser.add_argument("--team", help="Team slug (e.g. jdg, estar)")
    parser.add_argument("--season", help="Season ID (e.g. kpl-2026-summer)")
    parser.add_argument("--year", type=int, help="Year (e.g. 2026)")
    parser.add_argument("--type", help="Content type (game, interview, pre-show)")
    parser.add_argument("--bp", type=int, choices=[0, 1], help="Filter by BP phase (1) or game (0)")
    parser.add_argument("--limit", type=int, default=20, help="Max results")
    parser.add_argument("--context", type=int, default=3, help="Context lines window (default: 3)")
    parser.add_argument("--json", action="store_true", help="Output JSON format")
    args = parser.parse_args()

    db = SubtitleDB()
    results = db.search(
        keywords=args.keywords,
        team=args.team,
        season=args.season,
        year=args.year,
        content_type=args.type,
        is_bp=args.bp,
        limit=args.limit,
        context_window=args.context
    )

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        db.close()
        return

    print(f"=== 找到 {len(results)} 条匹配结果 ===")
    for idx, r in enumerate(results, 1):
        print(f"\n[{idx}] 比赛源日期={r['source_date']}（上传={r['publish_date']}） | {r['season_id']} | {r['home_team_raw']} vs {r['away_team_raw']} | {r['part_title']}")
        print(f"    Part ID: {r['part_id']} | 局号: G{r['game_no']} | 阶段: {r['phase']} | 来源: {r['source_path']}")
        print(f"    匹配行 [{r['time_raw']}]: {r['text']}")
        print("    --- 上下文 ---")
        for ctx in r["context"]:
            mark = ">>" if ctx["line_idx"] == r["line_idx"] else "  "
            print(f"    {mark} [{ctx['time_raw']}] {ctx['text']}")
    db.close()

if __name__ == "__main__":
    main()

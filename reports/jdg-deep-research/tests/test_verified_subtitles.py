import hashlib
import json
from pathlib import Path
import sqlite3
import unittest

ROOT=Path(__file__).resolve().parents[1]
SOURCE=Path('/Users/kuangqie/Documents/VibeCoding/B站字幕提取/KPL解说')

class VerifiedSubtitleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result=json.loads((ROOT/'processed/verified_subtitles.json').read_text())
        cls.audit=json.loads((ROOT/'processed/subtitle_audit.json').read_text())

    def test_all_quotes_reconstruct_from_physical_lines(self):
        self.assertGreaterEqual(len(self.result['evidence']),24)
        for e in self.result['evidence']:
            raw=(SOURCE/e['path']).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(),e['source_sha256'],e['id'])
            physical=raw.decode('utf-8-sig').splitlines()
            self.assertEqual('\n'.join(physical[e['line_start']-1:e['line_end']]),e['quote'],e['id'])
            self.assertEqual(e['review_status'],'本次文本上下文复核')
            if e['phase']=='pre_show': self.assertIsNone(e['game_id'])

    def test_manifest_covers_local_files_not_full_league(self):
        conn=sqlite3.connect(ROOT/'processed/subtitles.db')
        rows=conn.execute('select path,source_sha256 from source_manifest').fetchall()
        self.assertEqual(len(rows),len(list(SOURCE.rglob('*.md'))))
        for path,sha in rows:self.assertEqual(hashlib.sha256((SOURCE/path).read_bytes()).hexdigest(),sha,path)
        import sys
        sys.path.insert(0,str(ROOT/'scripts'))
        from verify_subtitles import read_source
        self.assertEqual(conn.execute('select count(*) from subtitles').fetchone()[0],6109608)
        self.assertEqual(conn.execute('select count(*) from subtitles_fts_verified').fetchone()[0],6109608)
        self.assertEqual(conn.execute('select count(*) from subtitles_fts_verified f join subtitles s on s.id=f.rowid').fetchone()[0],6109608)
        for path,sha in rows:
            _,_,_,ss=read_source(SOURCE/path)
            indexed=conn.execute('select line_idx,source_line,time_secs,text from subtitles where source_path=? order by line_idx',(path,)).fetchall()
            self.assertEqual(indexed,[(i,s['line'],s['seconds'],s['text']) for i,s in enumerate(ss)],path)
            digest=hashlib.sha256(json.dumps([(s['seconds'],s['text'].strip()) for s in ss],ensure_ascii=False).encode()).hexdigest()
            self.assertEqual(conn.execute('select source_text_digest from source_manifest where path=?',(path,)).fetchone()[0],digest)
        conn.close()

    def test_repaired_fts_and_phase_sampling(self):
        conn=sqlite3.connect(ROOT/'processed/subtitles.db')
        sql=conn.execute("select sql from sqlite_master where name='subtitles_fts_verified'").fetchone()[0]
        self.assertIn("content=''",sql)
        hits=conn.execute("select count(*) from subtitles_fts_verified f join subtitles s on s.id=f.rowid where subtitles_fts_verified match '\"女 娲\"'").fetchone()[0]
        self.assertGreater(hits,0)
        self.assertEqual(self.audit['source_index']['rows'],6109608)
        backup=[json.loads(l) for l in (ROOT/'processed/legacy_subtitle_overrides.jsonl').read_text().splitlines()]
        self.assertEqual(len(backup),11)
        self.assertEqual({x['path'] for x in backup},set(self.audit['cache_text_disagreement_paths']))
        for part in backup:
            now=conn.execute('select line_idx,time_secs,text from subtitles where part_id=? order by line_idx',(part['part_id'],)).fetchall()
            self.assertNotEqual(now,[(r['line_idx'],r['time_secs'],r['text']) for r in part['rows']])
            self.assertEqual(conn.execute('select count(*) from subtitles_fts_verified f join subtitles s on s.id=f.rowid where s.part_id=?',(part['part_id'],)).fetchone()[0],len(now))
        self.assertEqual(conn.execute("select count(*) from metadata_corrections where content_type='pre-show' and game_id is not null").fetchone()[0],0)
        conn.close()
        seasons={s['season'] for s in self.audit['bp_boundary_samples'] if s['review_status'].startswith('本次')}
        self.assertGreaterEqual(len(seasons),8)

    def test_old_quotes_not_reissued(self):
        self.assertEqual(len(self.audit['old_quote_audit']),12)
        self.assertTrue(all(not q['literal_found'] for q in self.audit['old_quote_audit']))
        self.assertEqual(len(self.result['draft_cases']),8)
        games={g['game_id']:g for g in json.loads((ROOT/'processed/verified_analysis.json').read_text())['games']}
        for d in self.result['draft_cases']:
            self.assertEqual(d['phase'],'draft_context')
            self.assertTrue(d['verified_analysis_actions'])
            actual=games[d['game_id']]['bp']['actions']
            self.assertEqual(d['verified_bp_full_order'],[{k:a.get(k) for k in ['step_index','action_type','side','hero_name']} for a in actual])
        self.assertIs(self.result['quality']['field_conflicts'][0]['verified_analysis_mid_stats_mvp'],False)
        for z in self.result['comparisons']:
            self.assertEqual(z['games'],len(set(z['game_ids'])))
            self.assertGreater(z['characters'],0)

if __name__=='__main__':unittest.main()

import hashlib,json,re,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def load(path):return json.loads((ROOT/path).read_text())
def pointer(obj,path):
    if not path:return obj
    for k in path.lstrip('/').split('/'):
        k=k.replace('~1','/').replace('~0','~');obj=obj[int(k)] if isinstance(obj,list) else obj[k]
    return obj
class ReportContract(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.r=load('evidence_registry.json');cls.d=load('processed/reader_data.json');cls.v=load('processed/verified_analysis.json');cls.fields=load('processed/source_field_audit.json')
 def test_registry_selectors_resolve(self):
  for c in self.r['claims']:
   for s in c['statistic_selectors']:self.assertIsNotNone(pointer(load(s['source_file']),s['json_pointer']),s)
 def test_registry_hashes_and_precise_support(self):
  for f in self.r['artifacts']:self.assertEqual(hashlib.sha256((ROOT/f['path']).read_bytes()).hexdigest(),f['sha256'],f['path'])
  c={x['id']:x for x in self.r['claims']};self.assertEqual(c['C09']['supporting_game_ids'],['kpl-20260003-2026083001-g5']);self.assertEqual(len(c['C08']['supporting_game_ids']),14)
  for x in c.values():
   if x['scope'] in ['summer','year']:self.assertTrue(set(x['supporting_game_ids'])<=set(g['game_id'] for g in self.v['games']))
 def test_reader_projection_and_ban_totals(self):
  for scope in ['summer','year']:
   for p in ['清融','昊昊']:
    a=[g for g in self.d['games'] if g['mid_player']==p and g['bp']['legal_complete'] and (scope=='year' or g['season_id']=='kpl-2026-summer')];b=self.v['samples'][scope]['draft'][p]
    self.assertEqual(len(a),b['n']);self.assertEqual(sum(g['bp']['opponent_mid_usable_ban_count'] for g in a),b['mage_or_mid_usable_ban_count'])
  for a,b in zip(self.d['games'],self.v['games']):
   self.assertEqual(a['game_id'],b['game_id']);self.assertEqual(a['is_winner'],b['is_winner'])
   for pos,p in a['positions'].items():
    self.assertTrue(all(b['positions'][pos][k]==v for k,v in p.items() if k!='display_name'))
 def test_supplemental_raw_fields(self):
  f=self.fields;self.assertEqual(f['checks_count'],2110);self.assertEqual(f['discrepancies'],[])
  for x in f['checks']:
   self.assertLessEqual(abs(x['computed_participation_pct']-x['raw_participation_pct']),.0201)
   self.assertEqual(x['camp_kills'],x['sum_team_kills']);self.assertEqual(x['camp_gold'],x['sum_team_gold']);self.assertEqual(bool(x['raw_is_mvp']),x['db_mvp'])
  m=[x for x in f['checks'] if x['game_id']=='kpl-20260003-2026062102-g1' and x['team_id']=='jdg'];self.assertEqual([x['player_id'] for x in m if x['raw_is_mvp']],['无双'])
 def test_final_html_and_subtitle_payload(self):
  html=(ROOT/'jdg_mid_deep_research.html').read_text();data=json.loads(re.search(r'<script id="research-data" type="application/json">(.*?)</script>',html,re.S).group(1))
  self.assertEqual(data,self.d);self.assertIn((ROOT/'assets/report.js').read_text(),html);self.assertNotRegex(html,r'@@[A-Z_]+@@');self.assertNotIn('<script src=',html)
  for e in data['subtitles']['evidence']:
   self.assertIn('match_reason',e);self.assertTrue(e['source_sha256']);self.assertGreater(e['line_start'],0)
 def test_known_editorial_repairs_present(self):
  md=(ROOT/'jdg_mid_deep_research.md').read_text();self.assertIn('DPM约1909对1933',md);self.assertNotIn('显著高于清融',md)
if __name__=='__main__':unittest.main()

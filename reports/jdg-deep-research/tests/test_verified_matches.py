import json,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'scripts'))
from verify_matches import bp_audit,agg
class VerifiedTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.p=json.loads((ROOT/'processed/verified_analysis.json').read_text());cls.a=json.loads((ROOT/'processed/db_audit.json').read_text())
 def test_contract(self):
  self.assertTrue(set(['coverage','methods','audit','samples','games','inference','strata','rotations','history','limitations'])<=self.p.keys())
 def test_all_series(self):
  self.assertEqual(len(self.a['series']),46)
  self.assertTrue(all(s['score_verified'] and sum(s['jdg_score'])==len(s['game_ids']) for s in self.a['series']))
 def test_flip_reconciliation(self):
  self.assertEqual(self.a['reproduced_flips'],104);self.assertEqual(self.a['schedule_vs_battle_camp_swapped_games'],105)
  self.assertEqual(self.a['swapped_but_db_already_correct_game_ids'],['kpl-20260004-2026100902-g2'])
 def test_bp(self):
  valid=[g for g in self.p['games'] if g['bp']['legal_complete']];self.assertEqual(len(valid),207)
  for g in valid:
   self.assertEqual(g['bp']['action_counts'],{'ban':10,'pick':10});self.assertTrue(g['bp']['db_matches_raw']);self.assertEqual(len(g['lineups']),2)
  for g in self.p['games']:
   if not g['bp']['legal_complete']:self.assertIsNone(g['bp']['mid_team_pick_order'])
 def test_bp_partial_rejected(self):
  raw={'bp_list':[{'camp':1,'hero_id':1,'is_ban_or_pick':1}]}
  self.assertFalse(bp_audit(raw,[],[],{})['legal_complete'])
 def test_bootstrap(self):
  for scope in ['summer','year']:self.assertTrue(self.p['inference'][scope]['joint_mixed_BO_sampling'])
 def test_sample(self):
  self.assertEqual({p:v['n'] for p,v in self.p['samples']['summer']['players'].items()},{'清融':37,'昊昊':43})
  self.assertEqual({p:v['n'] for p,v in self.p['samples']['year']['players'].items()},{'清融':160,'昊昊':51})
 def test_raw_mapping(self):
  self.assertTrue(all(len(g['source']['player_raw_mapping'])==10 and all(r['db_fields_match'] for r in g['source']['player_raw_mapping']) for g in self.p['games']))
if __name__=='__main__':unittest.main()

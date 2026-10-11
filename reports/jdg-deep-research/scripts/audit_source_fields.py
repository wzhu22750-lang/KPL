#!/usr/bin/env python3
"""Supplemental read-only checks; separate field accuracy from source authenticity.
Uses existing credential reader, never writes to the match DB or prints secrets.
"""
import json, math, hashlib
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
import psycopg2, psycopg2.extras
from verify_matches import url
ROOT=Path(__file__).resolve().parents[1]

def run():
    d=json.loads((ROOT/'processed/verified_analysis.json').read_text())
    conn=psycopg2.connect(url()); conn.set_session(readonly=True,autocommit=False,isolation_level='REPEATABLE READ')
    c=conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    c.execute('SELECT id, raw FROM games WHERE id=ANY(%s)',([g['game_id'] for g in d['games']],))
    raw={r['id']:r['raw'] for r in c.fetchall()}
    c.execute('SELECT id,name,primary_pos,roles FROM heroes'); heroes=[dict(r) for r in c.fetchall()]
    mageids=[h['id'] for h in heroes if h['primary_pos']=='中路' or '法师' in (h['roles'] or [])]
    conn.rollback(); conn.close()
    checks=[]; discrepancies=[]; kda_diffs=[]; identity_labels=[]
    for g in d['games']:
        r=raw[g['game_id']]
        for tid,pp in g['lineups'].items():
            assert len(pp)==5 and len({v['position'] for v in pp.values()})==5
            K=sum(v['kills'] for v in pp.values()); gold=sum(v['gold'] for v in pp.values())
            for pos,p in pp.items():
                hit=[x for x in r['battle_player_list'] if str(x['hero_id'])==p['hero_id'] and x['camp']==(1 if p['side']=='blue' else 2)]
                assert len(hit)==1
                s=hit[0]; camp=r['camp'+str(s['camp'])]
                part=100*(p['kills']+p['assists'])/K if K else 0
                row={'game_id':g['game_id'],'team_id':tid,'player_id':p['player_id'],'position':pos,
                     'raw_player_name':s['player_name'],'raw_position_desc':s['position_desc'],
                     'raw_camp':s['camp'],'raw_team_id':s['team_id'],'computed_participation_pct':part,
                     'db_participation_pct':p['participation_rate'],'raw_participation_pct':s.get('participation_rate'),
                     'raw_kda':s.get('kda'),'defined_kda':p['kda'],'raw_damage_share':s.get('hurt_to_hero_total_rate'),
                     'computed_damage_share_pct':p['damage_share'],'raw_is_mvp':s.get('is_mvp'),'db_mvp':p['mvp'],
                     'camp_kills':camp['kill_num'],'sum_team_kills':K,'camp_gold':camp['gold'],'sum_team_gold':gold}
                if abs(part-p['participation_rate'])>0.02: discrepancies.append(row|{'field':'participation'})
                if s['position_desc']!=pos: discrepancies.append(row|{'field':'position'})
                if s['player_name']!=p['player_id']:
                    identity_labels.append(row|{'field':'raw_display_name_vs_database_id'})
                    # Non-JDG imported IDs (nbw-*, A七, fly) are not display names.
                    if tid=='jdg': discrepancies.append(row|{'field':'jdg_name'})
                if abs(float(s['hurt_to_hero_total_rate'])*100-p['damage_share'])>0.0051:
                    discrepancies.append(row|{'field':'damage_share_rounding'})
                if K!=camp['kill_num'] or gold!=camp['gold']: discrepancies.append(row|{'field':'team_total'})
                if bool(s.get('is_mvp'))!=p['mvp']: discrepancies.append(row|{'field':'MVP_import'})
                if s.get('kda') is not None and abs(float(s['kda'])-p['kda'])>0.051:kda_diffs.append(row)
                checks.append(row)
    sensitivity={}
    for scope in ['summer','year']:
        gs=[g for g in d['games'] if scope=='year' or g['season_id']=='kpl-2026-summer']
        sensitivity[scope]={}
        for dim in ['mid_hero_name','hero_side']:
            cell=lambda g:g['mid_hero_name'] if dim=='mid_hero_name' else str((g['mid_hero_name'],g['side']))
            common=set(d['sensitivity'][scope][dim]['common_cells']); retained=[g for g in gs if cell(g) in common]
            counts={}; means={}; excluded={}
            for p in ['清融','昊昊']:
                a=[g for g in retained if g['mid_player']==p];counts[p]=len(a)
                means[p]=sum(g['mid_stats']['dpm'] for g in a)/len(a)
                excluded[p]=[g['game_id'] for g in gs if g['mid_player']==p and cell(g) not in common]
            sensitivity[scope][dim]={'retained_counts':counts,'excluded_game_ids':excluded,
                'common_sample_unweighted_dpm_difference':means['清融']-means['昊昊'],
                'standardized_dpm_difference':d['sensitivity'][scope][dim]['standardized_descriptive_difference']['dpm']}
    out={'retrieved_at':datetime.now(timezone.utc).isoformat(),'database_read_only':True,'checks_count':len(checks),
         'discrepancies':discrepancies,'mid_usable_hero_ids':mageids,
         'mid_usable_rule':'heroes.primary_pos=中路 OR 法师 in heroes.roles; not actual ban intended lane',
         'raw_kda_differs_from_defined_kda_count':len(kda_diffs),
         'raw_kda_examples':kda_diffs[:5],'raw_KDA_rounding_tolerance':0.051,
         'opponent_database_ids_differing_from_raw_display_names':identity_labels,
         'checks':checks,'sensitivity_sample_decomposition':sensitivity,
         'source_authenticity_limit':'Mirror embedded raw vs DB is import-consistency validation, not independent official live response or video validation. SHA verifies this snapshot only.',
         'MVP_conflict':{'game_id':'kpl-20260003-2026062102-g1','raw_MVP':'无双','subtitle_claim':'清融（VS-18）','status':'unresolved; MVP excluded from comparative findings'}}
    (ROOT/'processed/source_field_audit.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
    assert not discrepancies, f'{len(discrepancies)} field discrepancies: inspect output'
    print(json.dumps({k:out[k] for k in ['checks_count','raw_kda_differs_from_defined_kda_count','MVP_conflict']},ensure_ascii=False))
if __name__=='__main__':run()

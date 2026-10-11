#!/usr/bin/env python3
"""Render checked numeric tables into the editorial research manuscript."""
import json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def fmt(v,n=2):return '—' if v is None else f'{v:,.{n}f}'
def table(head,rows):return '\n'.join(['|'+'|'.join(head)+'|','|'+'|'.join(['---']*len(head))+'|']+['|'+'|'.join(map(str,r))+'|' for r in rows])
def main():
 d=json.loads((ROOT/'processed/verified_analysis.json').read_text());s=json.loads((ROOT/'processed/verified_subtitles.json').read_text());c=json.loads((ROOT/'processed/verified_community.json').read_text());r=json.loads((ROOT/'processed/reader_data.json').read_text())
 ps=['清融','昊昊'];pos=['对抗路','打野','中路','发育路','游走'];out={}
 rows=[]
 for scope,title in [('summer','夏季同四队友'),('year','全年所有JDG阵容')]:
  for p in ps:
   a=d['samples'][scope]['players'][p];bp=d['samples'][scope]['draft'][p]
   rows.append([title,p,a['n'],a['wins'],fmt(a['win_rate_pct'])+'%',bp['n'],sum(v[p]['n']>0 for v in d['strata'][scope]['mid_hero_name'].values())])
 out['SAMPLE_TABLE']=table(['范围','中单','小局n','胜局','胜率','有效BP n','使用英雄数'],rows)
 rows=[]
 for scope,title in [('summer','夏季'),('year','全年')]:
  for k,label,unit in [('win_rate_pct','胜率','pp'),('dpm','mean DPM',''),('gpm','GPM',''),('damage_share','伤害份额','pp'),('gold_share','经济份额','pp'),('damage_per_1000_gold','伤害/千金币',''),('participation_rate','参团率','pp')]:
   a=d['samples'][scope]['players'];ci=d['inference'][scope]['metrics'].get(k if k=='win_rate_pct' else '中路.'+k)
   vals=[a[p][k] if k=='win_rate_pct' else a[p]['means'][k] for p in ps]
   rows.append([title,label,fmt(vals[0]),fmt(vals[1]),fmt(vals[0]-vals[1])+unit,'['+','.join(fmt(x) for x in ci['ci95'])+']' if ci else '未计算'])
 out['METRIC_TABLE']=table(['范围','指标','清融','昊昊','差(清融−昊昊)','BO聚类95%CI'],rows)
 rows=[]
 for p0 in pos:
  for key,label in [('dpm','DPM'),('gold_share','经济%'),('damage_share','伤害%'),('participation_rate','参团%')]:
   ci=d['inference']['summer']['metrics'].get(p0+'.'+key)
   vals=[sum(g['positions'][p0][key] for g in d['games'] if g['season_id']=='kpl-2026-summer' and g['mid_player']==p)/d['samples']['summer']['players'][p]['n'] for p in ps]
   rows.append([p0,label,fmt(vals[0]),fmt(vals[1]),'['+','.join(fmt(x) for x in ci['ci95'])+']' if ci else '未计算'])
 out['TEAM_TABLE']=table(['位置(夏季)','指标','清融样本','昊昊样本','差值95%CI'],rows)
 rows=[]
 heroes=d['strata']['summer']['mid_hero_name'];order=sorted(heroes,key=lambda h:-sum(v['n'] for v in heroes[h].values()))
 for h in order:
  row=[h]
  for p in ps:
   a=heroes[h].get(p);row += [str(a['wins'])+'/'+str(a['n'])+' '+fmt(a['win_rate_pct'],1)+'%' if a and a['n'] else '未使用',fmt(a['means']['dpm'],0) if a and a['n'] else '—']
  rows.append(row)
 out['HERO_TABLE']=table(['夏季英雄','清融胜/n','清融DPM','昊昊胜/n','昊昊DPM'],rows)
 rows=[]
 for scope,title in [('summer','夏季'),('year','全年')]:
  for p in ps:
   a=d['samples'][scope]['draft'][p]
   rows.append([title,p,a['n'],str(a['top3_count'])+'/'+str(a['n']),fmt(a['top3_count']/a['n']*100),fmt(a['mean_team_pick_order']),str(a['mage_or_mid_usable_ban_count'])+'/'+str(a['n']),fmt(a['mage_or_mid_usable_ban_count']/a['n'])])
 out['BP_TABLE']=table(['范围','中单','BP n','全场前三手','%','平均队内顺位','对手中路可用英雄ban数/n','每局'],rows)
 rows=[]
 for x in s['comparisons']:
  if x['season_id'] not in ['kpl-2026-summer','kpl-2026-annual']:continue
  a=x['discussion_lines_per_10000_chars'];rows.append([x['season_id'],x['mid_player'],x['scope'],x['games'],fmt(a.get('mid_jungle_support')),fmt(a.get('adc_protection')),fmt(a.get('resources'))])
 out['TEXT_TABLE']=table(['文本范围','中单','完整性','局n','中野辅','保射候选','资源讨论'],rows)
 rows=[]
 # All four mixed series: do not attribute final result to a majority player.
 for group in d['series_groups']['mixed']['match_ids']:
  gs=[g for g in d['games'] if g['match_id']==group]
  row=[gs[0]['date'],r['teams'].get(gs[0]['opponent_id'],gs[0]['opponent_id'])]
  row += ['；'.join('G'+str(g['game_no'])+' '+g['mid_player']+'('+g['positions']['对抗路']['player_id']+') '+('胜' if g['is_winner'] else '负') for g in gs),':'.join(map(str,gs[-1]['post_game_series_score']))]
  rows.append(row)
 out['ROTATION_TABLE']=table(['日期','对手','每局中单(对抗路)/结果','JDG比分'],rows)
 rows=[]
 for opp,values in d['strata']['summer']['opponent_id'].items():
  row=[r['teams'].get(opp,opp)]
  for p in ps:
   a=values.get(p);row += [str(a['wins'])+'/'+str(a['n']) if a and a['n'] else '无样本',fmt(a['means']['dpm'],0) if a and a['n'] else '—']
  rows.append(row)
 out['OPPONENT_TABLE']=table(['夏季对手','清融胜/n','清融DPM','昊昊胜/n','昊昊DPM'],rows)
 out['COMMUNITY_TABLE']=table(['类型','短引文','证据定位','可说/不可说'],[[x['classification'],x['exact_quote'],x['id']+' / '+x['url'],x['interpretation']] for x in c['sources']])
 body=(ROOT/'assets/research_body.md').read_text()
 for key,val in out.items():body=body.replace('@@'+key+'@@',val)
 assert not re.search(r'@@[A-Z_]+@@',body)
 (ROOT/'jdg_mid_deep_research.md').write_text(body)
 print('Research manuscript built from verified tables.')
if __name__=='__main__':main()

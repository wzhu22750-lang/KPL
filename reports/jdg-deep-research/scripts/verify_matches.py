#!/usr/bin/env python3
"""Independent read-only audit. No imported statistical findings or credentials."""
import os,json,hashlib
from pathlib import Path
from collections import Counter,defaultdict
from datetime import datetime,date
from decimal import Decimal
import psycopg2,psycopg2.extras
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'processed'
PLAYERS=['清融','昊昊']
def url():
 if os.getenv('DATABASE_URL'): return os.environ['DATABASE_URL']
 p=ROOT.parents[1]/'kpl-intelligence/.env'
 for line in p.read_text().splitlines():
  if line.strip().startswith('DATABASE_URL='): return line.strip().split('=',1)[1].strip().strip('\"\'')
 raise RuntimeError('DATABASE_URL missing')
def enc(x):
 if isinstance(x,(date,datetime)):return x.isoformat()
 if isinstance(x,Decimal):return float(x)
 if isinstance(x,np.generic):return x.item()
 raise TypeError(type(x).__name__)
def dump(name,x): (OUT/name).write_text(json.dumps(x,ensure_ascii=False,indent=2,default=enc))
def mean(xs):return float(np.mean(xs)) if xs else None
def agg(gs,pos='中路',pid=None):
 rows=[(g,g['positions'][pos]) for g in gs if pos in g['positions'] and (pid is None or g['positions'][pos]['player_id']==pid)]
 if not rows:return {'n':0,'game_ids':[]}
 rr=[r for g,r in rows]; n=len(rr)
 keys=['kills','deaths','assists','dpm','gpm','damage_share','gold_share','participation_rate','kda','damage_per_1000_gold','share_efficiency']
 return {'n':n,'game_ids':[g['game_id'] for g,r in rows], 'wins':sum(g['is_winner'] for g,r in rows),'win_rate_pct':100*mean([g['is_winner'] for g,r in rows]),'means':{k:mean([r[k] for r in rr]) for k in keys},'pooled_dpm':sum(r['damage'] for r in rr)/sum(g['duration_secs']/60 for g,r in rows),'total_kda':(sum(r['kills']+r['assists'] for r in rr)/sum(r['deaths'] for r in rr)) if sum(r['deaths'] for r in rr) else None,'player_counts':dict(Counter(r['player_id'] for r in rr))}
# Official 2026 two-ban then three-ban phases, 10 picks. No inference from player order.
PATTERN=[('ban',1),('ban',2),('ban',1),('ban',2),('pick',1),('pick',2),('pick',2),('pick',1),('pick',1),('pick',2),('ban',2),('ban',1),('ban',2),('ban',1),('ban',2),('ban',1),('pick',2),('pick',1),('pick',1),('pick',2)]
def bp_audit(raw,db,players,heroes):
 source=raw.get('bp_list') or []; actions=[]
 for i,b in enumerate(source):
  typ='pick' if b['is_ban_or_pick']==1 else 'ban'; camp=int(b['camp']); hid=str(b['hero_id'])
  hit=[p for p in players if p['side']==('blue' if camp==1 else 'red') and p['hero_id']==hid]
  actions.append({'step_index':i+1,'raw_order':i,'action_type':typ,'camp':camp,'side':'blue' if camp==1 else 'red','hero_id':hid,'hero_name':heroes.get(hid,{}).get('name',b.get('hero_name',hid)),'player_id':hit[0]['player_id'] if typ=='pick' and len(hit)==1 else None,'source_raw':b})
 errors=[]
 if len(actions)!=20:errors.append('not_20_actions')
 if Counter(a['action_type'] for a in actions)!=Counter({'ban':10,'pick':10}):errors.append('not_10ban_10pick')
 if [(a['action_type'],a['camp']) for a in actions]!=PATTERN:errors.append('illegal_action_side_pattern')
 if len({a['hero_id'] for a in actions})!=len(actions):errors.append('duplicate_hero')
 if any(a['action_type']=='pick' and a['player_id'] is None for a in actions):errors.append('pick_not_unique_in_final_lineup')
 db_sorted=sorted(db,key=lambda b:b['step_index'])
 same=len(db_sorted)==len(actions) and all(b['step_index']==a['step_index'] and b['raw_order']==a['raw_order'] and b['action_type']==a['action_type'] and b['side']==a['side'] and b['hero_id']==a['hero_id'] for b,a in zip(db_sorted,actions))
 if not same:errors.append('db_raw_order_mismatch')
 return {'actions':actions,'db_actions':db_sorted,'raw_count':len(source),'action_counts':dict(Counter(a['action_type'] for a in actions)),'has_full_bp':len(actions)==20,'legal_complete':not errors,'errors':errors,'db_matches_raw':same}
def bootstrap(gs,B=3000):
 clusters=defaultdict(list)
 for g in gs:clusters[g['match_id']].append(g)
 ids=list(clusters); metrics=[('win_rate_pct',None,None)]+[(pos+'.'+k,pos,k) for pos in ['中路','对抗路','打野','发育路','游走'] for k in ['dpm','damage_share','gold_share','kills','participation_rate']]
 # Per-cluster sums/counts preserve mixed BO dependence under ONE joint draw.
 sums=np.zeros((len(ids),2,len(metrics))); counts=np.zeros_like(sums)
 for i,mid in enumerate(ids):
  for g in clusters[mid]:
   p=PLAYERS.index(g['mid_player'])
   for j,(name,pos,key) in enumerate(metrics):
    if pos is None:v=100*int(g['is_winner'])
    elif pos not in g['positions']:continue
    else:v=g['positions'][pos][key]
    sums[i,p,j]+=v;counts[i,p,j]+=1
 rng=np.random.default_rng(20261010); vals=[]
 for _ in range(B):
  ix=rng.integers(0,len(ids),len(ids)); c=counts[ix].sum(0)
  if np.any(c==0):continue
  m=sums[ix].sum(0)/c; vals.append(m[0]-m[1])
 arr=np.array(vals);base=sums.sum(0)/counts.sum(0)
 return {'iterations':B,'valid_draws':len(vals),'cluster_count':len(ids),'joint_mixed_BO_sampling':True,'difference':'清融减昊昊','metrics':{name:{'difference':float(base[0,j]-base[1,j]),'ci95':np.percentile(arr[:,j],[2.5,97.5]).tolist()} for j,(name,_,_) in enumerate(metrics)}}
def main():
 OUT.mkdir(exist_ok=True)
 conn=psycopg2.connect(url());conn.set_session(readonly=True,autocommit=False,isolation_level='REPEATABLE READ')
 cur=conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
 def sql(s,args=None):cur.execute(s,args);return [dict(r) for r in cur.fetchall()]
 tables=['games','matches','player_games','bp_actions','heroes','players','player_honors','seasons','teams']
 schema=sql("select table_name,column_name,data_type from information_schema.columns where table_schema='public' and table_name=any(%s) order by table_name,ordinal_position",(tables,))
 coverage=sql('select s.id,s.year,count(distinct m.id) matches,count(g.id) games from seasons s left join matches m on m.season_id=s.id left join games g on g.match_id=m.id group by s.id,s.year order by s.year,s.id')
 teams={r['id']:r for r in sql('select id,name,external_id from teams')}; ex={str(r['external_id']):r['id'] for r in teams.values()}
 heroes={r['id']:r for r in sql('select id,name,roles,primary_pos from heroes')}
 ms=sql("select * from matches where season_id like 'kpl-2026-%%' and (team_a_id='jdg' or team_b_id='jdg') order by played_at")
 mids=[m['id'] for m in ms]
 gg=sql('select * from games where match_id=any(%s) order by match_id,game_no',(mids,)); gids=[g['id'] for g in gg]
 pp=sql('select * from player_games where game_id=any(%s)',(gids,)); bb=sql('select * from bp_actions where game_id=any(%s)',(gids,))
 pb=defaultdict(list);bp=defaultdict(list)
 for p in pp:pb[p['game_id']].append(p)
 for b in bb:bp[b['game_id']].append(b)
 history={'current_players':sql("select id,real_name,current_team_id,debut_at,bio,created_at from players where id=any(%s)",(PLAYERS,)),'honors':sql('select * from player_honors where player_id=any(%s)',(PLAYERS,)),'observed_appearances':sql('select pg.player_id,pg.team_id,min(m.played_at) first_observed,max(m.played_at) last_observed,count(*) games from player_games pg join games g on g.id=pg.game_id join matches m on m.id=g.match_id where pg.player_id=any(%s) group by pg.player_id,pg.team_id',(PLAYERS,))}
 conn.rollback();conn.close()
 cache=json.loads((OUT/'match_analysis.json').read_text()); cache_games={g['game_id']:g for g in cache['games']}
 mm={m['id']:m for m in ms}; games=[]; bo_games=defaultdict(list)
 for gr in gg:
  raw=gr['raw'];m=mm[gr['match_id']]; pl=pb[gr['id']]; own=[p for p in pl if p['team_id']=='jdg']; mid=[p for p in own if p['position']=='中路' and p['player_id'] in PLAYERS]
  if not mid:continue
  assert len(mid)==1 and len(own)==5 and len(pl)==10
  wc=int(raw['win_camp']);winner=ex[str(raw['camp'+str(wc)]['team_id'])];camp=next(i for i in (1,2) if ex[str(raw['camp'+str(i)]['team_id'])]=='jdg')
  assert raw['camp'+str(wc)]['is_win'] is True
  lineup={}; raw_checks=[]
  for p in pl:
   teamrows=[x for x in pl if x['team_id']==p['team_id']];r={k:p[k] for k in ['player_id','team_id','hero_id','side','position','kills','deaths','assists','gold','participation_rate','mvp','lose_mvp']};r['hero_name']=heroes[r['hero_id']]['name'];r['damage']=p['damage_to_hero'];r['damage_taken']=p['damage_taken'];minutes=gr['duration_secs']/60
   for key,src in [('dpm','damage'),('gpm','gold')]:r[key]=r[src]/minutes
   r['kda']=(r['kills']+r['assists'])/max(r['deaths'],1)
   r['damage_share']=100*r['damage']/sum(x['damage_to_hero'] for x in teamrows);r['gold_share']=100*r['gold']/sum(x['gold'] for x in teamrows);r['damage_per_1000_gold']=1000*r['damage']/r['gold'];r['share_efficiency']=r['damage_share']/r['gold_share'];r['participation_rate']=float(r['participation_rate'])
   lineup.setdefault(p['team_id'],{})[p['position']]=r
   rp=next(x for x in raw['battle_player_list'] if str(x['team_id'])==str(teams[p['team_id']]['external_id']) and str(x['hero_id'])==p['hero_id'])
   ok=all(p[k]==rp[rk] for k,rk in [('kills','kill_num'),('deaths','death_num'),('assists','assist_num'),('gold','gold'),('damage_to_hero','hurt_to_hero_total'),('damage_taken','be_hurt_total')]);assert ok
   raw_checks.append({'player_id':p['player_id'],'camp':rp['camp'],'team_id':rp['team_id'],'hero_id':rp['hero_id'],'player_name':rp['player_name'],'position_desc':rp['position_desc'],'kill_num':rp['kill_num'],'death_num':rp['death_num'],'assist_num':rp['assist_num'],'gold':rp['gold'],'hurt_to_hero_total':rp['hurt_to_hero_total'],'be_hurt_total':rp['be_hurt_total'],'db_fields_match':ok})
  bpa=bp_audit(raw,bp[gr['id']],pl,heroes);pos=lineup['jdg']; side=mid[0]['side']; assert side==('blue' if camp==1 else 'red')
  picks=[a for a in bpa['actions'] if a['action_type']=='pick'];myp=[a for a in picks if a['side']==side]
  bpa['mid_overall_pick_order']=next((i+1 for i,a in enumerate(picks) if a['side']==side and a['hero_id']==mid[0]['hero_id']),None) if bpa['legal_complete'] else None
  bpa['mid_team_pick_order']=next((i+1 for i,a in enumerate(myp) if a['hero_id']==mid[0]['hero_id']),None) if bpa['legal_complete'] else None
  bpa['opponent_bans']=[a for a in bpa['actions'] if a['action_type']=='ban' and a['side']!=side]
  g={'game_id':gr['id'],'match_id':gr['match_id'],'game_no':gr['game_no'],'date':m['played_at'],'played_at':m['played_at'],'season_id':m['season_id'],'stage':m['stage'],'stage_seq':m['stage_seq'],'bo':m['bo'],'mid_player':mid[0]['player_id'],'mid_hero_name':pos['中路']['hero_name'],'side':side,'winner':winner,'is_winner':winner=='jdg','duration_secs':gr['duration_secs'],'opponent_id':m['team_b_id'] if m['team_a_id']=='jdg' else m['team_a_id'],'positions':pos,'team_positions':pos,'mid_stats':pos['中路'],'lineups':lineup,'bp':bpa,'source':{'battle_id':gr['source_key'],'game_raw_sha256':hashlib.sha256(json.dumps(raw,sort_keys=True,default=enc).encode()).hexdigest(),'win_camp':wc,'camp1':{k:raw['camp1'][k] for k in ['team_id','is_win','kill_num','gold']},'camp2':{k:raw['camp2'][k] for k in ['team_id','is_win','kill_num','gold']},'db_winner_id':gr['winner_id'],'db_winner_mismatch':winner!=gr['winner_id'],'player_raw_mapping':raw_checks,'video_list':raw.get('video_list',[]),'game_duration_raw':raw['game_duration']}}
  assert raw['game_duration']/1000==gr['duration_secs']
  games.append(g);bo_games[g['match_id']].append(g)
 series=[];rotations=[]
 for m in ms:
  gs=sorted(bo_games.get(m['id'],[]),key=lambda g:g['game_no'])
  if not gs:continue
  a=sum(g['winner']==m['team_a_id'] for g in gs);b=len(gs)-a; mr=m['raw'];schedule_scores={ex[str(mr['camp1']['team_id'])]:mr['camp1']['score'],ex[str(mr['camp2']['team_id'])]:mr['camp2']['score']}
  ok=[a,b]==[m['score_a'],m['score_b']] and a==schedule_scores[m['team_a_id']] and b==schedule_scores[m['team_b_id']]
  assert ok,(m['id'],a,b)
  jw=0;ow=0;prev=None
  for g in gs:
   g['pre_game_series_score']=[jw,ow];g['series_context']='ahead' if jw>ow else 'behind' if jw<ow else 'tied'
   g['teammate_changes_from_previous']=[] if prev is None else [pos for pos in g['positions'] if pos!='中路' and g['positions'][pos]['player_id']!=prev['positions'][pos]['player_id']]
   jw+=int(g['is_winner']);ow+=int(not g['is_winner']);g['post_game_series_score']=[jw,ow];prev=g
  counts=dict(Counter(g['mid_player'] for g in gs));group='mixed' if len(counts)>1 else next(iter(counts))
  record={'match_id':m['id'],'game_ids':[g['game_id'] for g in gs],'mid_counts':counts,'group':group,'jdg_score':[jw,ow],'score_a_b':[a,b],'schedule_raw':{k:mr.get(k) for k in ['camp1','camp2','win_camp','status','match_stage_desc']},'score_verified':ok,'jdg_win':jw>ow,'status':m['status']};series.append(record)
  if group=='mixed':rotations.append(record|{'timeline':[{'game_id':g['game_id'],'mid_player':g['mid_player'],'hero':g['mid_hero_name'],'pre_game_series_score':g['pre_game_series_score'],'win':g['is_winner'],'teammates':{p:r['player_id'] for p,r in g['positions'].items() if p!='中路'},'teammate_changes':g['teammate_changes_from_previous']} for g in gs]})
 def pair(gs):return {p:agg([g for g in gs if g['mid_player']==p]) for p in PLAYERS}
 def strata(gs,key):return {str(v):pair([g for g in gs if g[key]==v]) for v in sorted({g[key] for g in gs},key=str)}
 summer=[g for g in games if g['season_id']=='kpl-2026-summer']; assert len(summer)==80
 samples={}; inference={};st={}
 for name,gs in [('summer',summer),('year',games)]:
  teammates={pos:{pid:{p:agg([g for g in gs if g['mid_player']==p],pos,pid) for p in PLAYERS} for pid in sorted({g['positions'][pos]['player_id'] for g in gs})} for pos in ['对抗路','打野','发育路','游走']}
  drafts={}
  for p in PLAYERS:
   vg=[g for g in gs if g['mid_player']==p and g['bp']['legal_complete']]; n=len(vg)
   bans=Counter(a['hero_name'] for g in vg for a in g['bp']['opponent_bans']);mageids={h for h,r in heroes.items() if r['primary_pos']=='中路' or '法师' in (r['roles'] or [])}
   drafts[p]={'n':n,'game_ids':[g['game_id'] for g in vg],'mean_team_pick_order':mean([g['bp']['mid_team_pick_order'] for g in vg]),'top3_count':sum(g['bp']['mid_overall_pick_order']<=3 for g in vg),'first_pick_count':sum(g['bp']['mid_overall_pick_order']==1 for g in vg),'opponent_hero_ban_counts':dict(bans),'mage_or_mid_usable_ban_count':sum(a['hero_id'] in mageids for g in vg for a in g['bp']['opponent_bans']),'priority_yield':{label:agg([g for g in vg if g['bp']['mid_team_pick_order'] in orders]) for label,orders in [('team_1_2',[1,2]),('team_4_5',[4,5])]}}
  samples[name]={'players':pair(gs),'teammates':teammates,'draft':drafts,'n':len(gs),'same_four_teammates':dict(Counter('|'.join(g['positions'][pos]['player_id'] for pos in ['对抗路','打野','发育路','游走']) for g in gs))}
  inference[name]=bootstrap(gs)
  st[name]={key:strata(gs,key) for key in ['side','mid_hero_name','stage','opponent_id','series_context']}
  st[name]['hero_side']={str((h,s)):pair([g for g in gs if g['mid_hero_name']==h and g['side']==s]) for h,s in sorted({(g['mid_hero_name'],g['side']) for g in gs})}
 flips=[g['game_id'] for g in games if g['source']['db_winner_mismatch']]
 camp_mapping_proof=[{'game_id':g['game_id'],'battle_win_camp':g['source']['win_camp'],'battle_camp1_team':g['source']['camp1']['team_id'],'battle_camp2_team':g['source']['camp2']['team_id'],'schedule_camp1_team':mm[g['match_id']]['raw']['camp1']['team_id'],'schedule_camp2_team':mm[g['match_id']]['raw']['camp2']['team_id'],'winner_from_battle':g['winner'],'winner_from_wrong_schedule_mapping':ex[str(mm[g['match_id']]['raw']['camp'+str(g['source']['win_camp'])]['team_id'])],'db_winner_id':g['source']['db_winner_id']} for g in games]
 diffs=[{'game_id':g['game_id'],'old':cache_games[g['game_id']]['is_winner'],'verified':g['is_winner']} for g in games if g['game_id'] in cache_games and cache_games[g['game_id']]['is_winner']!=g['is_winner']]
 audit={'camp_mapping_proof':camp_mapping_proof,'swapped_but_db_already_correct_game_ids':[r['game_id'] for r in camp_mapping_proof if r['winner_from_battle']!=r['winner_from_wrong_schedule_mapping'] and r['db_winner_id']==r['winner_from_battle']],'schema':schema,'database_coverage':coverage,'read_only':True,'isolation':'REPEATABLE READ','series':series,'upcoming_or_unobserved_matches':[{'match_id':m['id'],'status':m['status'],'score_a':m['score_a'],'score_b':m['score_b']} for m in ms if not bo_games.get(m['id'])],'flipped_game_ids':flips,'cache_win_differences':diffs,'old_report_claimed_flips':105,'reproduced_flips':len(flips),'schedule_vs_battle_camp_swapped_games':sum(str(mm[g['match_id']]['raw']['camp1']['team_id'])!=str(g['source']['camp1']['team_id']) for g in games),'db_winner_equals_schedule_camp_interpretation':sum(g['source']['db_winner_id']==ex[str(mm[g['match_id']]['raw']['camp'+str(g['source']['win_camp'])]['team_id'])] for g in games),'bp_errors':dict(Counter(e for g in games for e in g['bp']['errors'])),'bp_action_count_distribution':dict(Counter(g['bp']['raw_count'] for g in games)),'cache_all_records_read':len(cache_games),'cache_sha256':hashlib.sha256((OUT/'match_analysis.json').read_bytes()).hexdigest()}
 # Same-season/actual-stage full-league descriptive benchmark; source ordering independently rechecked.
 c=psycopg2.connect(url());c.set_session(readonly=True,autocommit=True);q=c.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
 q.execute("select g.id,g.raw,m.season_id,m.stage from games g join matches m on g.match_id=m.id where m.season_id=any(%s)",(list({g['season_id'] for g in games}),));league=[dict(r) for r in q.fetchall()];c.close()
 league_groups=defaultdict(list)
 for r in league:league_groups[(r['season_id'],r['stage'])].append(r)
 benchmark=[]
 for (season,stage),rows in league_groups.items():
  valid=[r for r in rows if len(r['raw'].get('bp_list') or [])==20 and [('pick' if b['is_ban_or_pick']==1 else 'ban',int(b['camp'])) for b in r['raw']['bp_list']]==PATTERN and len({b['hero_id'] for b in r['raw']['bp_list']})==20]
  counts=Counter(); ranks=[]
  for r in valid:
   picks=[b for b in r['raw']['bp_list'] if b['is_ban_or_pick']==1]
   for i,b in enumerate(picks):
    ppraw=[p for p in r['raw']['battle_player_list'] if p['camp']==b['camp'] and p['hero_id']==b['hero_id']]
    if len(ppraw)==1 and ppraw[0]['position_desc']=='中路':ranks.append(i+1)
   for b in r['raw']['bp_list']:counts[(str(b['hero_id']),'pick' if b['is_ban_or_pick']==1 else 'ban')]+=1
  benchmark.append({'season_id':season,'stage':stage,'all_games':len(rows),'legal_complete_games':len(valid),'game_ids':[r['id'] for r in valid],'mid_pick_observations':len(ranks),'mid_top3_rate_pct':100*mean([x<=3 for x in ranks]) if ranks else None,'hero_bp':[{'hero_id':hid,'hero_name':heroes.get(hid,{}).get('name',hid),'ban_count':counts[(hid,'ban')],'pick_count':counts[(hid,'pick')],'bp_rate_pct':100*(counts[(hid,'ban')]+counts[(hid,'pick')])/len(valid)} for hid in sorted({k[0] for k in counts})]})
 sensitivity={}
 for scope in ['summer','year']:
  sensitivity[scope]={}
  for dimension in ['side','mid_hero_name','hero_side']:
   cells=st[scope][dimension];common={k:v for k,v in cells.items() if all(v[p]['n']>0 for p in PLAYERS)};total=sum(sum(v[p]['n'] for p in PLAYERS) for v in common.values())
   sensitivity[scope][dimension]={'common_cells':list(common),'overlap_games':total,'pooled_common_cell_weights':{k:sum(v[p]['n'] for p in PLAYERS)/total for k,v in common.items()},'standardized_descriptive_difference':{metric:sum((sum(v[p]['n'] for p in PLAYERS)/total)*(v[PLAYERS[0]]['win_rate_pct']-v[PLAYERS[1]]['win_rate_pct'] if metric=='win_rate_pct' else v[PLAYERS[0]]['means'][metric]-v[PLAYERS[1]]['means'][metric]) for v in common.values()) for metric in ['win_rate_pct','dpm','damage_share','gold_share']},'warning':'Common-cell pooled weights; sparse cells; descriptive only, stage not controlled, no causal identification.'}
 cov={'total_games':len(games),'total_matches':len(series),'scheduled_matches':len(ms),'total_player_games':len(pp),'db_flips_detected':len(flips),'bp_complete_games':sum(g['bp']['has_full_bp'] for g in games),'bp_legal_complete_games':sum(g['bp']['legal_complete'] for g in games),'date_min':min(g['date'] for g in games),'date_max':max(g['date'] for g in games)}
 methods={'aggregation':'Unrounded per-game arithmetic means; pooled DPM=sum damage/sum minutes; mean KDA uses max(deaths,1), total KDA uses total deaths and null for zero deaths. Shares are percent, differences pp.','efficiency':'damage_per_1000_gold is damage/gold*1000; share_efficiency is damage_share/gold_share (dimensionless). 1105.7% damage/gold equals 11057 damage per 1000 gold, NOT 1105.7 damage per 1000.','bootstrap':'Joint BO-cluster percentile bootstrap, 3000 draws, seed 20261010; mixed BO sampled once with all players retained; intervals describe associations, not causal effects/posterior probabilities.','BP':'Only legal complete original game.raw.bp_list order, crosschecked against step_index/raw_order, ten bans ten picks and final side+hero lineup; raw position/player list is not draft order.','opponents':'Exact opponent ID strata, no subjective top-tier grouping.','series_context':'Pre-game series score ONLY. Not in-game economic advantage or comeback.','regression':'No causal regression: player and stage have minimal overlap; descriptive hero/side sensitivity only.'}
 limitations=['Same four teammates is not a controlled experiment: summer stage overlap is only first round, Haohao 3 games there; Qingrong absent third round/playoffs.','DB mirror fields agree with embedded raw but were not independently video-verified.','Honor rows and current player bio may be incorrect; first observed date is DB coverage floor, not debut/transfer date.','105 schedule/battle camp swaps versus 104 actual DB winner mismatches: kpl-20260004-2026100902-g2 is swapped but DB winner already correct. This reconciles counts in current snapshot; absent archived legacy raw cannot prove when that record changed.','No evidence of coaching motives, personal targeted bans, active resource yielding, or spatial jungle coordination from aggregate statistics.']
 payload={'coverage':cov,'methods':methods,'audit':{'all_completed_BO_score_verified':all(s['score_verified'] for s in series),'cache_win_differences':diffs,'db_audit_path':'processed/db_audit.json'},'samples':samples,'games':games,'inference':inference,'strata':st,'rotations':rotations,'history':history,'series_groups':{group:{'n':sum(s['group']==group for s in series),'wins':sum(s['group']==group and s['jdg_win'] for s in series),'match_ids':[s['match_id'] for s in series if s['group']==group]} for group in PLAYERS+['mixed']},'league_bp_benchmark':benchmark,'sensitivity':sensitivity,'limitations':limitations}
 dump('db_audit.json',audit);dump('verified_analysis.json',payload)
 print(json.dumps({'coverage':cov,'summer':pair(summer),'year':pair(games),'bp_errors':audit['bp_errors'],'cache_diffs':diffs,'series_groups':payload['series_groups']},ensure_ascii=False,default=enc))
if __name__=='__main__':main()

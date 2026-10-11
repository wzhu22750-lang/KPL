#!/usr/bin/env python3
"""Build offline reader data and an explicit claim -> statistic -> source registry."""
import json, hashlib, sqlite3
from pathlib import Path
from datetime import datetime,timezone
from collections import Counter,defaultdict
ROOT=Path(__file__).resolve().parents[1]
P=['清融','昊昊']; POS=['对抗路','打野','中路','发育路','游走']
def load(p):return json.loads((ROOT/p).read_text())
def save(p,x):(ROOT/p).write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def average(a):return sum(a)/len(a) if a else None

def main():
    d=load('processed/verified_analysis.json');s=load('processed/verified_subtitles.json');c=load('processed/verified_community.json');f=load('processed/source_field_audit.json')
    conn=sqlite3.connect('file:'+str(ROOT/'processed/subtitles.db')+'?mode=ro',uri=True)
    reasons=dict(conn.execute('SELECT path,reason FROM metadata_corrections').fetchall());conn.close()
    s['evidence']=[e|{'match_reason':reasons.get(e['path'],'未匹配，保留源资料')} for e in s['evidence']]
    display={(r['game_id'],r['team_id'],r['player_id']):r['raw_player_name'] for r in f['checks']}
    games=[]
    for g in d['games']:
        x={k:g[k] for k in ['game_id','match_id','game_no','date','season_id','stage','mid_player','mid_hero_name','side','is_winner','duration_secs','opponent_id','pre_game_series_score','post_game_series_score','teammate_changes_from_previous']}
        x['positions']={pos:{**{k:v for k,v in r.items() if k not in ['mvp','lose_mvp']},'display_name':display.get((g['game_id'],'jdg',r['player_id']),r['player_id'])} for pos,r in g['positions'].items()}
        x['lineups']={tid:{pos:{'player_id':r['player_id'],'display_name':display.get((g['game_id'],tid,r['player_id']),r['player_id']),'hero_name':r['hero_name'],'kills':r['kills'],'deaths':r['deaths'],'assists':r['assists']} for pos,r in rows.items()} for tid,rows in g['lineups'].items()}
        x['bp']={'opponent_mid_usable_ban_count':sum(a['hero_id'] in f['mid_usable_hero_ids'] for a in g['bp']['opponent_bans']),
                 'legal_complete':g['bp']['legal_complete'],'errors':g['bp']['errors'],'team_pick_order':g['bp']['mid_team_pick_order'],'overall_pick_order':g['bp']['mid_overall_pick_order'],'actions':[{k:a[k] for k in ['step_index','action_type','side','hero_name','player_id']} for a in g['bp']['actions']]}
        x['source']={k:g['source'][k] for k in ['battle_id','win_camp','camp1','camp2','db_winner_id','db_winner_mismatch','game_raw_sha256']}
        games.append(x)
    # Teammate hero sensitivity is separate from mid-hero sensitivity; sparse common cells.
    extra={}
    for scope in ['summer','year']:
        gg=[g for g in d['games'] if scope=='year' or g['season_id']=='kpl-2026-summer']; z={}
        for pos in POS:
            hsets=[{g['positions'][pos]['hero_name'] for g in gg if g['mid_player']==p} for p in P];common=hsets[0]&hsets[1]
            weights={h:sum(g['positions'][pos]['hero_name']==h for g in gg) for h in common};total=sum(weights.values())
            diff=0;cells=[]
            for h in sorted(common):
                rows={p:[g for g in gg if g['mid_player']==p and g['positions'][pos]['hero_name']==h] for p in P}
                means={p:average([g['positions'][pos]['dpm'] for g in rows[p]]) for p in P};diff+=weights[h]/total*(means[P[0]]-means[P[1]])
                cells.append({'hero':h,'weight':weights[h]/total,'counts':{p:len(rows[p]) for p in P},'dpm':means,'game_ids':{p:[g['game_id'] for g in rows[p]] for p in P}})
            z[pos]={'common_cell_games':total,'difference_q_minus_h_dpm':diff,'cells':cells,'warning':'Descriptive pooled-common-cell weighting; teammate name/stage/full lineup not controlled; no causal inference.'}
        extra[scope]=z
    save('processed/teammate_hero_sensitivity.json',extra)
    teams={'ag':'成都AG超玩会','estar':'武汉eStarPro','wb':'北京WB','wolves':'重庆狼队','ttg':'广州TTG','edgm':'上海EDG.M','dyg':'深圳DYG','drg':'佛山DRG','ksg':'苏州KSG','lgd-nbw':'杭州LGD.NBW','tes-a':'长沙TES.A','hero':'Hero久竞','we':'西安WE','rw':'济南RW侠','rngm':'上海RNG.M','qingjiu':'情久','tcg':'TCG','xyg':'XYG'}
    payload={'coverage':d['coverage'],'games':games,'inference':d['inference'],'sensitivity':d['sensitivity'],'sample_decomposition':f['sensitivity_sample_decomposition'],'teams':teams,'subtitles':s,'community':c,'league_bp_benchmark':[{k:v for k,v in x.items() if k!='game_ids'} for x in d['league_bp_benchmark']],'series_groups':d['series_groups'],'history':d['history'],'teammate_hero_sensitivity':extra}
    save('processed/reader_data.json',payload)
    # Claims are bounded by snapshot and scope; no categorical player superiority or coaching intention.
    claims=[
        ('C01','胜率差不确定','夏季清融22/37、昊昊23/43；差+5.97pp的BO成簇95%CI为[-18.68,+27.26]pp。没有检出确定的胜率优势，也不能证明等效。','association','summer',[],['samples.summer.players','inference.summer.metrics.win_rate_pct']),
        ('C02','中路经济近似，射手份额略增','夏季中路经济18.25%/18.38%；小寒23.70%对22.89%，昊昊样本多0.81pp；输出份额多2.50pp。不是四保一或中路主动让钱的证据。','association','summer',['VS-10','VS-13','VS-14'],['samples.summer.teammates','inference.summer.metrics.发育路.damage_share','inference.summer.metrics.发育路.gold_share']),
        ('C03','边野输出关联仍值得解释','清融夏季样本无双DPM高984、光明高748；换成各自共同英雄权重后差仍约788、633。缺动作时间线，不能定位上半区或归因于清融。','association','summer',['VS-15','VS-16','VS-04'],['samples.summer.teammates','inference.summer.metrics.打野.dpm','inference.summer.metrics.对抗路.dpm','processed/teammate_hero_sensitivity.json']),
        ('C04','总体输出差高度依赖英雄与范围','全年均值DPM差+483；先筛共同英雄(153/51)差+526，再同权重约-34；夏季共同英雄(36/38)约+331。不能混称所有差异被英雄解释。','sensitivity','year',['VS-07'],['sensitivity.year.mid_hero_name','processed/source_field_audit.json:sensitivity_sample_decomposition','strata.summer.mid_hero_name.沈梦溪']),
        ('C05','BP早选差异不是全年恒定待遇','全年前三手清融24/158、昊昊20/49；夏季11/37、15/41；夏季队内均序2.97/3.05，并非昊昊恒定早选。','direct_record','summer',['VS-D02','VS-D03'],['samples.summer.draft','samples.year.draft','league_bp_benchmark']),
        ('C06','Ban能观察，动机不能认证','夏季对手法师或中路可用英雄禁用39/37与52/41；属于英雄元数据分类，不是个人吃Ban或对手恐惧指标。','direct_record','summer',['VS-D01','VS-D02','VS-D06'],['samples.summer.draft']),
        ('C07','两名中单均能参与控制与支援','昊昊7/4全突脸阵容、10/3前期中野辅；清融6/21控区防突进。反驳永久炮台/永久侵略标签；不比较真实动作频率。','qualitative','year',['VS-D08','VS-D03','VS-01','VS-19','VS-16','VS-17','VS-21'],[]),
        ('C08','同BO轮换并非中单单变量','四场年总混合BO单列；10/3先负胜负，G4上中同时换、扳2:2，G5再负；后续三场3:0中G3换清融常伴边路变化。不能认证固定首发最优或收官能力。','direct_record','year',['VS-01','VS-02','VS-04','VS-05'],['rotations','series_groups']),
        ('C09','女娲墨子案例不等于专保射手','8/30 G5女娲32.47%输出全队第一，小寒18.26%；BP末轮女娲和墨子、解说复盘控制闭环，胜条件更像控制和线权配合而非只有射手收割。','case_inference','summer',['VS-D04','VS-D05','VS-11','VS-12'],[]),
        ('C10','词频敏感性不能排个人战术能力','夏季保射候选每万字2.52/2.95，完整BO2.89/2.95；年总方向相反。关键词承载行可能描述对手；不是保射事件计数。','text_descriptive','summer',['VS-10','VS-19'],['processed/verified_subtitles.json:comparisons']),
        ('C11','历史是情境，不是当前实力先验','2022-2025源案例含支援双边、藏视野和掉点；两名中单没有可比历史字幕全覆盖，不与当前样本混算。','qualitative','history',['VS-H22A','VS-H22B','VS-H23A','VS-H23B','VS-H24A','VS-H24B','VS-H25A','VS-H25B','VS-22'],['history']),
        ('C12','社区是争议谱不是赛训证据','互补评价与公平竞争诉求均有短引文；未确认工资、续约、偏心指控，无支持率或平台人口画像。','community_opinion','community',[],['processed/verified_community.json']),
        ('C13','胜负与MVP应分别审计','当前DB有104个winner错位；105次schedule/battle阵营交换另含一条已正确例外。6/21MVP raw指无双、字幕指清融，未解决；不比较MVP次数。','audit','year',['VS-18'],['processed/db_audit.json:camp_mapping_proof','processed/source_field_audit.json:MVP_conflict']),
    ]
    statistics=[]
    for scope in ['summer','year']:
        for p in P:
            statistics.append({'id':f'ST-{scope}-{p}','data_file':'processed/verified_analysis.json','json_pointer':f'/samples/{scope}/players/{p}','scope':scope,'game_ids':d['samples'][scope]['players'][p]['game_ids'],'values':{k:v for k,v in d['samples'][scope]['players'][p].items() if k!='game_ids'}})
    def selector(v):
        if v.startswith('processed/'):
            file,_,path=v.partition(':')
            return {'source_file':file,'json_pointer':'/'+path.replace('.','/') if path else ''}
        if v.startswith('inference.') and '.metrics.' in v:
            prefix,key=v.split('.metrics.',1)
            pointer='/'+prefix.replace('.','/')+'/metrics/'+key
        else:pointer='/'+v.replace('.','/')
        return {'source_file':'processed/verified_analysis.json','json_pointer':pointer}
    def supporting(scope,refs,id):
        if id=='C08':return [g['game_id'] for g in d['games'] if g['match_id'] in d['series_groups']['mixed']['match_ids']]
        if id=='C09':return ['kpl-20260003-2026083001-g5']
        if refs:return sorted({e['game_id'] for e in s['evidence'] if e['id'] in refs and e['game_id']})
        return [g['game_id'] for g in d['games'] if scope=='year' or scope=='summer' and g['season_id']=='kpl-2026-summer']
    registry={'schema_version':2,'generated_at':datetime.now(timezone.utc).isoformat(),
      'source_limits':['比赛为本地项目可访问PostgreSQL镜像和embedded raw；两者可能同源，未独立抓官方实时面板或观看录像。','所有时间戳是源分P视频时间，不是游戏时钟。','high表示匹配身份可靠，不是统计真实性或因果置信度。'],
      'claims':[{'id':id,'title':title,'statement':text,'type':typ,'scope':scope,'subtitle_ids':refs,'statistic_selectors':[selector(v) for v in sels],
                 'supporting_game_ids':supporting(scope,refs,id),'population_game_ids':[g['game_id'] for g in d['games'] if scope=='year' or scope=='summer' and g['season_id']=='kpl-2026-summer'],
                 'report_section':{'C01':'results','C02':'structure','C03':'structure','C04':'heroes','C05':'bp','C06':'bp','C07':'relationships','C08':'rotations','C09':'cases','C10':'text','C11':'history','C12':'community','C13':'audit'}[id]} for id,title,text,typ,scope,refs,sels in claims],
      'statistics':statistics,'games':[{'game_id':g['game_id'],'match_id':g['match_id'],'battle_id':g['source']['battle_id'],'raw_sha256':g['source']['game_raw_sha256'],'verified_data_pointer':'/games/'+str(i),'source_file':'processed/verified_analysis.json'} for i,g in enumerate(d['games'])],
      'subtitles':s['evidence'],'community_sources':c['sources'],
      'artifacts':[{'path':path,'sha256':hashlib.sha256((ROOT/path).read_bytes()).hexdigest()} for path in ['processed/verified_analysis.json','processed/verified_subtitles.json','processed/verified_community.json','processed/db_audit.json','processed/source_field_audit.json','processed/teammate_hero_sensitivity.json','processed/reader_data.json','source_reports/legacy_teamwork.html','source_reports/legacy_comparison.md']]}
    save('evidence_registry.json',registry)
    print('Reader data, teammate sensitivity and 13-claim registry generated; '+str(len(s['evidence']))+' exact subtitle excerpts.')
if __name__=='__main__':main()

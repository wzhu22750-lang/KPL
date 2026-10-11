#!/usr/bin/env python3
"""Read-only Markdown audit; repairable local source-complete subtitles/FTS index.
Quotes are exclusively sliced from physical source lines. Parts metadata is legacy.
"""
from pathlib import Path
import argparse, collections, hashlib, json, re, sqlite3, sys
from build_subtitles_db import parse_season_dir, parse_content_type, parse_teams, resolve_team_slug, space_tokenize_cjk
ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path('/Users/kuangqie/Documents/VibeCoding/B站字幕提取/KPL解说')
SUB = re.compile(r'^- \[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$')
def seconds(t):
    v=list(map(int,t.split(':'))); return sum(n*60**i for i,n in enumerate(v[::-1]))
def dump(p,x):
    p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n')
def read_source(p):
    raw=p.read_bytes(); text=raw.decode('utf-8-sig'); ls=text.splitlines()
    subs=[]
    for n,l in enumerate(ls,1):
        m=SUB.match(l)
        if m: subs.append({'line':n,'seconds':seconds(m[1]),'text':m[2],'raw':l})
    return raw,text,ls,subs

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--rebuild-fts',action='store_true'); args=ap.parse_args()
    out=ROOT/'processed'; out.mkdir(exist_ok=True)
    matches=json.loads((out/'matches_db_cache.json').read_text())
    # Reuse cached parsing only as a comparison input, not as authoritative text/metadata.
    parsed=ROOT.parents[1]/'data/commentary_parsed.jsonl'; cached={}; duplicate_cache=0
    with parsed.open() as f:
        for line in f:
            x=json.loads(line); duplicate_cache+=x['id'] in cached
            cached[x['id']]={k:v for k,v in x.items() if k!='subtitles'}
            cached[x['id']]['source_text_digest']=hashlib.sha256(json.dumps([(s.get('timeSecs'),s.get('text')) for s in x.get('subtitles',[])],ensure_ascii=False).encode()).hexdigest()
    conn=sqlite3.connect(out/'subtitles.db'); conn.row_factory=sqlite3.Row
    legacy={x['id']:dict(x) for x in conn.execute('select * from parts')}
    columns={r[1] for r in conn.execute('pragma table_info(subtitles)')}
    for name,kind in [('source_line','INTEGER'),('source_path','TEXT')]:
        if name not in columns: conn.execute(f'ALTER TABLE subtitles ADD COLUMN {name} {kind}')
    fts_exists=bool(conn.execute("select 1 from sqlite_master where name='subtitles_fts_verified'").fetchone())
    repaired=[]; indexed_digests={}
    backup=out/'legacy_subtitle_overrides.jsonl'
    backed=set()
    if backup.exists():
        backed={json.loads(l)['part_id'] for l in backup.read_text().splitlines()}

    conn.executescript('''
    DROP TABLE IF EXISTS source_manifest;
    CREATE TABLE source_manifest(path TEXT PRIMARY KEY,source_sha256 TEXT,byte_size INTEGER,part_id TEXT,subtitle_lines INTEGER,char_count INTEGER,first_seconds INTEGER,last_seconds INTEGER,duplicate_of TEXT);
    DROP TABLE IF EXISTS metadata_corrections;
    CREATE TABLE metadata_corrections(path TEXT PRIMARY KEY,part_id TEXT,season_id TEXT,year INTEGER,split TEXT,source_date TEXT,publish_date TEXT,team_a TEXT,team_b TEXT,content_type TEXT,game_no INTEGER,match_id TEXT,game_id TEXT,confidence TEXT,reason TEXT,game_start_seconds INTEGER,phase_method TEXT,cache_differences TEXT);
    DROP TABLE IF EXISTS subtitle_phase;
    CREATE TABLE subtitle_phase(path TEXT PRIMARY KEY,part_id TEXT,content_type TEXT,game_start_seconds INTEGER,rule TEXT);
    ''')
    seen_hash={}; seen_pid={}; records=[]; season_counts=collections.Counter(); differences=collections.Counter(); total_lines=0; asr_counts=collections.Counter()
    for p in sorted(SOURCE.rglob('*.md')):
        raw,text,ls,subs=read_source(p); rel=p.relative_to(SOURCE).as_posix(); sha=hashlib.sha256(raw).hexdigest()
        season=parse_season_dir(p.relative_to(SOURCE).parts[0]); title=re.search(r'^#\s+(.+)$',text,re.M); title=title[1] if title else ''
        def field(name):
            m=re.search(r'\*\*'+name+r'\*\*[：:]\s*`?([^\s`]+)',text); return m[1] if m else ''
        bvid=field('BVID'); pn=re.search(r'^P(\d+)',p.name); pid=f'{bvid}_P{int(pn[1]):02d}' if bvid and pn else None
        ct,gn,_=parse_content_type(p.name,title)
        if any(k in p.name for k in ['赛前评论','评论席','赛前节目','赛前预测']): ct,gn='pre-show',None
        a,b=parse_teams(p.parent.name,title); a,b=resolve_team_slug(a),resolve_team_slug(b)
        # Directory/title calendar dates outrank upload dates. Conflicting dates are rejected.
        dates=set(re.findall(r'(20\d\d-\d\d-\d\d)',p.parent.name))
        md=re.findall(r'(\d{1,2})月(\d{1,2})日',p.parent.name+' '+title)
        dates.update(f"{season['year']:04d}-{int(mm):02d}-{int(dd):02d}" for mm,dd in md)
        date=next(iter(dates)) if len(dates)==1 else None
        candidates=[m for m in matches if date and m.get('played_at')==date and m.get('season_id')==season['seasonId'] and set([m.get('team_a_id'),m.get('team_b_id')])==set([a,b])]
        mid=gid=None; confidence='unmatched'; reason='missing/conflicting source calendar date, teams, season or no candidate'
        game=None
        if len(candidates)==1:
            m=candidates[0]; mid=m['id']; confidence='high_bo'; reason='unique source calendar date + season + both teams; no upload-date fallback'
            gs=[g for g in m.get('games',[]) if g.get('game_no')==gn] if ct=='game' else []
            if len(gs)==1: game=gs[0]; gid=game['id']; confidence='high'; reason+=' + unique game number'
            elif ct=='game': reason+='; missing/ambiguous game rejected'; confidence='high_bo'
        elif len(candidates)>1: reason='ambiguous match candidates: rejected'
        start=None; method='unknown'
        if ct=='game':
            # Avoid caster introductions (can occur before draft). Explicit launch is still estimated.
            for si,s in enumerate(subs):
                nearby=' '.join(x['text'] for x in subs[max(0,si-8):si+4])
                if ('全军出击' in s['text'] and s['seconds']>30
                    and any(w in nearby for w in ['进入比赛','进入双方','蓝色方','红色方','到达战场','请做好准备'])
                    and not any(w in nearby for w in ['微信公众号','注册会员','buff全军出击','嘉豪'])):
                    start=s['seconds']; method='contextual_battle_cry_estimated'; break
        dup=seen_hash.get(sha); seen_hash.setdefault(sha,rel)
        if pid: seen_pid.setdefault(pid,[]).append(rel)
        dif={}; old=cached.get(pid,{})
        fields={'publishDate':field('发布时间')[:10],'seasonId':season['seasonId'],'gameNo':gn,'contentType':ct,'subtitleLineCount':len(subs),'homeTeamSlug':a,'awayTeamSlug':b}
        # Cache historically strips edge whitespace; compare semantic text separately from exact byte SHA.
        fields['source_text_digest']=hashlib.sha256(json.dumps([(s['seconds'],s['text'].strip()) for s in subs],ensure_ascii=False).encode()).hexdigest()
        for k,v in fields.items():
            if old and old.get(k)!=v: dif[k]={'cached':old.get(k),'source':v}; differences[k]+=1
        if season['year']==2026 and 'jdg' in [a,b]:
            for s in subs:
                for term in ['昊昊','浩浩','豪豪','小寒','小韩','小孩','清融','金融','花缘','花园']:
                    asr_counts[term]+=s['text'].count(term)
        chars=sum(len(s['text']) for s in subs); first=subs[0]['seconds'] if subs else None; last=subs[-1]['seconds'] if subs else None
        assert pid and len(seen_pid[pid])==1, 'source index requires unique non-null part ID'
        oldrows=[dict(x) for x in conn.execute('select * from subtitles where part_id=? order by line_idx',(pid,))]
        expected=[(i,s['seconds'],s['text']) for i,s in enumerate(subs)]
        actual=[(x['line_idx'],x['time_secs'],x['text']) for x in oldrows]
        if actual!=expected:
            semantic_old=[(x['line_idx'],x['time_secs'],x['text'].strip()) for x in oldrows]
            semantic_source=[(i,s['seconds'],s['text'].strip()) for i,s in enumerate(subs)]
            if pid not in backed and semantic_old!=semantic_source:
                with backup.open('a') as bf: bf.write(json.dumps({'part_id':pid,'path':rel,'source_sha256':sha,'rows':oldrows},ensure_ascii=False)+'\n')
                backed.add(pid)
            if fts_exists:
                conn.executemany("insert into subtitles_fts_verified(subtitles_fts_verified,rowid,spaced_text) values ('delete',?,?)",[(x['id'],space_tokenize_cjk(x['text'])) for x in oldrows])
            conn.execute('delete from subtitles where part_id=?',(pid,))
            conn.executemany('insert into subtitles(part_id,line_idx,time_secs,time_raw,text,is_bp,source_line,source_path) values (?,?,?,?,?,?,?,?)',[(pid,i,s['seconds'],s['raw'].split(']')[0][3:],s['text'],int(start is not None and s['seconds']<start),s['line'],rel) for i,s in enumerate(subs)])
            if fts_exists:
                conn.executemany('insert into subtitles_fts_verified(rowid,spaced_text) values (?,?)',[(x['id'],space_tokenize_cjk(x['text'])) for x in conn.execute('select id,text from subtitles where part_id=?',(pid,))])
            repaired.append({'part_id':pid,'path':rel,'before_lines':len(oldrows),'source_lines':len(subs)})
        elif any(x.get('source_line')!=s['line'] or x.get('source_path')!=rel for x,s in zip(oldrows,subs)):
            conn.executemany('update subtitles set source_line=?,source_path=? where id=?',[(s['line'],rel,x['id']) for x,s in zip(oldrows,subs)])
        indexrows=conn.execute('select time_secs,text from subtitles where part_id=? order by line_idx',(pid,)).fetchall()
        digest=hashlib.sha256(json.dumps([(x[0],x[1].strip()) for x in indexrows],ensure_ascii=False).encode()).hexdigest()
        assert digest==fields['source_text_digest'], rel
        indexed_digests[rel]=digest
        conn.execute('insert into source_manifest values (?,?,?,?,?,?,?,?,?)',(rel,sha,len(raw),pid,len(subs),chars,first,last,dup))
        conn.execute('insert into metadata_corrections values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(rel,pid,season['seasonId'],season['year'],season['split'],date,fields['publishDate'],a,b,ct,gn,mid,gid,confidence,reason,start,method,json.dumps(dif,ensure_ascii=False)))
        conn.execute('insert into subtitle_phase values (?,?,?,?,?)',(rel,pid,ct,start,'pre-show=>pre_show; game before battle cry=>bp_estimated; after=>game_estimated; otherwise unknown'))
        r={'path':rel,'source_sha256':sha,'part_id':pid,'season_id':season['seasonId'],'year':season['year'],'source_date':date,'team_a':a,'team_b':b,'content_type':ct,'game_no':gn,'match_id':mid,'game_id':gid,'confidence':confidence,'reason':reason,'game_start_seconds':start,'video_url':field('视频链接'),'chars':chars,'lines':len(subs),'duration_seconds':last-first if subs else 0,'duplicate_of':dup,'game':game}
        records.append(r); season_counts[season['seasonId']]+=1; total_lines+=len(subs)
    # Duplicate part IDs can refer to different files: never silently use one.
    collisions={p:rs for p,rs in seen_pid.items() if len(rs)>1}
    for r in records:
        if r['part_id'] in collisions:
            r.update(confidence='ambiguous_source',match_id=None,game_id=None)
            conn.execute("update metadata_corrections set confidence='ambiguous_source',match_id=NULL,game_id=NULL,reason='duplicate source part ID: rejected' where path=?",(r['path'],))
    conn.executescript('CREATE INDEX IF NOT EXISTS source_manifest_part ON source_manifest(part_id); CREATE INDEX IF NOT EXISTS metadata_game ON metadata_corrections(game_id);')
    conn.commit()
    conn.execute('CREATE INDEX IF NOT EXISTS subtitles_source_path ON subtitles(source_path,line_idx)')
    conn.execute('ALTER TABLE source_manifest ADD COLUMN source_text_digest TEXT')
    conn.executemany('update source_manifest set source_text_digest=? where path=?',[(v,k) for k,v in indexed_digests.items()])
    # A default run updates all changed source rows and FTS; flag forces full FTS rebuild.
    fts_status='source-complete verified FTS updated'
    if args.rebuild_fts or not fts_exists:
        conn.execute('DROP TABLE IF EXISTS subtitles_fts_verified')
        conn.execute("CREATE VIRTUAL TABLE subtitles_fts_verified USING fts5(spaced_text,content='')")
        cur=conn.execute('select id,text from subtitles'); n=0
        while True:
            batch=cur.fetchmany(20000)
            if not batch: break
            conn.executemany('insert into subtitles_fts_verified(rowid,spaced_text) values (?,?)',[(s['id'],space_tokenize_cjk(s['text'])) for s in batch]); n+=len(batch)
        conn.commit(); fts_status=f'contentless verified FTS rebuilt: {n} source rows; retrieval joins subtitles, never FTS content'
    elif conn.execute("select 1 from sqlite_master where name='subtitles_fts_verified'").fetchone(): fts_status=f'contentless verified FTS updated: {total_lines} source rows; retrieval joins subtitles' 
    # Audit old quotation strings without accepting normalization as exact evidence.
    old_quote_audit=[]
    old_results=out/'subtitle_results.json'
    if old_results.exists():
        for e in json.loads(old_results.read_text()).get('evidence',[]):
            p=SOURCE/e.get('path',''); status='missing_source'; exact=False
            if p.is_file():
                _,_,_,ss=read_source(p); joined=''.join(s['text'] for s in ss)
                exact=e.get('quote','') in joined
                status='literal_contiguous_text_found' if exact else 'not_literal_contiguous_source_quote_rejected'
            old_quote_audit.append({'id':e.get('id'),'path':e.get('path'),'status':status,'literal_found':exact})
    # Source-derived evidence ranges explicitly chosen after text-context inspection.
    specs=json.loads((ROOT/'scripts/subtitle_selections.json').read_text()) if (ROOT/'scripts/subtitle_selections.json').exists() else []
    bypath={r['path']:r for r in records}; evidence=[]
    for spec in specs:
        r=bypath[spec['path']]; _,_,ls,subs=read_source(SOURCE/r['path']); a,b=spec['line_start'],spec['line_end']
        chosen=[s for s in subs if a<=s['line']<=b]
        assert chosen and chosen[0]['line']==a and chosen[-1]['line']==b
        assert all(SUB.match(l) for l in ls[a-1:b]), 'quote must be continuous subtitle lines'
        quote='\n'.join(ls[a-1:b]); phase='pre_show' if r['content_type']=='pre-show' else ('unknown' if r['game_start_seconds'] is None else 'bp_estimated' if chosen[0]['seconds']<r['game_start_seconds'] else 'game_estimated')
        e={k:r[k] for k in ['path','source_sha256','part_id','match_id','game_id','confidence','video_url']}
        e.update(id=spec['id'],start_seconds=chosen[0]['seconds'],end_seconds=chosen[-1]['seconds'],timestamp_kind='video_part',line_start=a,line_end=b,quote=quote,context='\n'.join(ls[max(0,a-4):min(len(ls),b+3)]),type=spec['type'],category=spec['category'],interpretation=spec['interpretation'],review_status='本次文本上下文复核',phase=spec.get('phase',phase))
        evidence.append(e)
    # Entire observed, uniquely mapped 2026 JDG corpus; no sampling on favorable clips.
    verified_path=out/'verified_analysis.json'
    verified_games=json.loads(verified_path.read_text()).get('games',[]) if verified_path.exists() else []
    verified_by_id={g['game_id']:g for g in verified_games}
    expected_by_match=collections.defaultdict(set)
    for g in verified_games: expected_by_match[g['match_id']].add(g['game_id'])
    observed_by_match=collections.defaultdict(set)
    for r in records:
        if r['confidence']=='high' and r['game_id'] and not r['duplicate_of']: observed_by_match[r['match_id']].add(r['game_id'])
    complete_bo={m for m,gs in expected_by_match.items() if gs and gs.issubset(observed_by_match[m])}
    categories={'bp':['禁用','ban','BAN','BP','阵容','选择'], 'mid_jungle_support':['中野辅','中野','联动','无双','无畏'], 'adc_protection':['保护','拆火','保射','输出环境'], 'resources':['经济','兵线','资源','野区']}
    group={}; eligible=[]
    for r in records:
        if r['year']!=2026 or 'jdg' not in [r['team_a'],r['team_b']] or r['confidence']!='high' or r['duplicate_of']: continue
        game=r['game']; mids=[m for m in game.get('mids',[]) if m.get('team_id')=='jdg']
        vg=verified_by_id.get(r['game_id']); player=vg.get('mid_player') if vg else (mids[0]['player_id'] if len(mids)==1 else None)
        if player not in ['清融','昊昊']: continue
        _,_,_,subs=read_source(SOURCE/r['path']); key=(r['season_id'],player)
        z=group.setdefault(key,{'season_id':key[0],'mid_player':player,'scope':'all_observed_high_confidence','complete_bo_game_ids':[],'verified_game_duration_seconds':0,'game_ids':[],'paths':[],'characters':0,'observed_video_seconds':0,'cached_game_duration_seconds':0,'mentions':collections.Counter(),'phase_mentions':{},'phase_characters':collections.Counter()})
        if r['game_id'] in z['game_ids']: continue
        if r['match_id'] in complete_bo: z['complete_bo_game_ids'].append(r['game_id'])
        z['verified_game_duration_seconds']+=(vg.get('duration_secs') or 0) if vg else 0
        z['game_ids'].append(r['game_id']);z['paths'].append(r['path']);z['characters']+=r['chars']; z['observed_video_seconds']+=r['duration_seconds']; z['cached_game_duration_seconds']+=game.get('duration_secs') or 0
        for s in subs:
            ph='unknown' if r['game_start_seconds'] is None else 'bp_estimated' if s['seconds']<r['game_start_seconds'] else 'game_estimated'
            z['phase_characters'][ph]+=len(s['text']); q=z['phase_mentions'].setdefault(ph,collections.Counter())
            for cat,terms in categories.items():
                if any(t in s['text'] for t in terms): z['mentions'][cat]+=1;q[cat]+=1
        eligible.append(r)
    comparisons=[]
    for z in group.values():
        z['games']=len(z['game_ids']);z['discussion_lines_per_10000_chars']={k:round(v*10000/z['characters'],3) for k,v in z['mentions'].items()};z['discussion_lines_per_observed_video_hour']={k:round(v*3600/z['observed_video_seconds'],3) for k,v in z['mentions'].items()};z['game_estimated_discussion_lines_per_verified_game_hour']={k:round(v*3600/z['verified_game_duration_seconds'],3) for k,v in z['phase_mentions'].get('game_estimated',{}).items()} if z['verified_game_duration_seconds'] else None
        z['method']='keyword-bearing subtitle lines, not actions; video span includes draft/postgame; verified_analysis game duration calibrates game_estimated discussion only (estimated segment still may include postgame)';comparisons.append(z)
    # Complete-BO sensitivity: exclude series with any missing source game part.
    complete_groups={}
    for r in eligible:
        if r['match_id'] not in complete_bo: continue
        vg=verified_by_id[r['game_id']]; key=(r['season_id'],vg['mid_player'])
        z=complete_groups.setdefault(key,{'scope':'complete_bo_high_confidence','season_id':key[0],'mid_player':key[1],'game_ids':[],'characters':0,'observed_video_seconds':0,'verified_game_duration_seconds':0,'mentions':collections.Counter()})
        z['game_ids'].append(r['game_id']);z['characters']+=r['chars'];z['observed_video_seconds']+=r['duration_seconds'];z['verified_game_duration_seconds']+=vg.get('duration_secs') or 0
        _,_,_,ss=read_source(SOURCE/r['path'])
        for s in ss:
            for cat,terms in categories.items():
                if any(t in s['text'] for t in terms):z['mentions'][cat]+=1
    for z in complete_groups.values():
        z['games']=len(z['game_ids']);z['discussion_lines_per_10000_chars']={k:round(v*10000/z['characters'],3) for k,v in z['mentions'].items()};z['discussion_lines_per_observed_video_hour']={k:round(v*3600/z['observed_video_seconds'],3) for k,v in z['mentions'].items()};z['method']='complete series source coverage; keyword-bearing lines across full part, not execution frequency';comparisons.append(z)
    # Do not label automatic boundary samples as manual audio/video verification.
    bp_samples=[]
    for season in sorted(season_counts):
        candidates=[r for r in records if r['season_id']==season and r['game_start_seconds'] is not None]
        if not candidates: continue
        r=next((r for r in candidates if 'jdg' in [r['team_a'],r['team_b']] or 'estar' in [r['team_a'],r['team_b']]),candidates[0]);_,_,ls,subs=read_source(SOURCE/r['path']);s=next(s for s in subs if s['seconds']==r['game_start_seconds'] and '全军出击' in s['text']);i=s['line']
        bp_samples.append({'path':r['path'],'season':season,'source_sha256':r['source_sha256'],'source_line':i,'estimated_start_seconds':s['seconds'],'context':'\n'.join(ls[max(0,i-5):i+4]),'review_status':('本次文本上下文复核；边界仍为估计，非音视频核验' if season in ['kpl-2022-challenger','kpl-2022-spring','kpl-2022-summer','kpl-2023-challenger','kpl-2023-spring','kpl-2023-summer','kpl-2024-annual','kpl-2024-challenger','kpl-2024-spring'] else '自动候选边界；尚未逐条人工文本复核')})
    audit={'source_root':str(SOURCE),'parsed_cache_path':str(parsed),'cached_records':len(cached),'duplicate_cache_ids':duplicate_cache,'source_md_count':len(records),'source_subtitle_lines':total_lines,'source_unique_sha256':len(seen_hash),'duplicate_files':[{'path':r['path'],'duplicate_of':r['duplicate_of']} for r in records if r['duplicate_of']], 'part_id_collisions':collisions,'cache_metadata_differences':dict(differences),'asr_surface_counts_2026_jdg':dict(asr_counts),'cache_text_disagreement_paths':[r[0] for r in conn.execute("select path from metadata_corrections where cache_differences like '%source_text_digest%'")],'legacy_parts':len(legacy),'source_parts_absent_from_legacy':[r['path'] for r in records if r['part_id'] not in legacy],'legacy_parts_absent_from_source':sorted(set(legacy)-set(seen_pid)),'source_seasons':dict(season_counts),'match_confidence_counts':dict(collections.Counter(r['confidence'] for r in records)),'fts_status':fts_status,'cache_digest_rule':'timeSecs + text stripped at edges only; exact source bytes covered by source_manifest SHA256','bp_boundary_rejected_example':{'path':'2022世界冠军杯/2022-12-10_【2022王者世冠】 南京Hero vs Isurus 12月10日小组赛_BV1wD4y1a7ky/P01_第一局.md','source_line':328,'reason':'全军出击 occurs in sponsor advertising; naive battle-cry boundary rejected by nearby launch-context requirement'},'bp_boundary_samples':bp_samples,'old_quote_audit':old_quote_audit,'legacy_quotes_status':'deprecated; hand-written strings rejected, including silently corrected/composite quotes','matching_rule':'unique source calendar date + season + team pair; games additionally unique game_no; upload date unused; pre-show BO-only'}
    audit['source_index']={'rows':conn.execute('select count(*) from subtitles').fetchone()[0],'fts_rows':conn.execute('select count(*) from subtitles_fts_verified').fetchone()[0],'repaired_this_run':repaired,'legacy_override_parts':len(backed),'digest_verified_parts':len(indexed_digests),'backup':'processed/legacy_subtitle_overrides.jsonl'}
    assert audit['source_index']['rows']==audit['source_index']['fts_rows']==total_lines
    conn.commit()  # persist manifest digests also on incremental/default runs
    limitations=['源目录存在不代表赛季比赛齐全；2026春季等大量缺失，coverage仅指本地已有文件。','源ASR原样保留；浩浩/豪豪可作为昊昊检索候选，非全库身份认证；小孩不自动映射小寒。','解说观点不等于队内指令；单句不解释组均值；事件与观点分开。','没有观看音视频；全部review_status仅指字幕文本上下文。','比赛缓存winner/MVP/时长存在冲突；匹配置信度仅识别身份，不认证统计字段。','全军出击边界只是估计；无明确边界为unknown，赛前评论始终pre_show且不算BP。','实际源视频时长未知，用末首字幕秒差及verified_analysis实际小局时长校准讨论密度；game_estimated可能含赛后评论，不冒称真实比赛执行频率。']
    result={'coverage':{'source_md_count':len(records),'source_subtitle_lines':total_lines,'source_seasons':dict(season_counts),'2026_jdg_high_confidence_game_parts':len(eligible),'2026_jdg_unique_game_ids':len(set(r['game_id'] for r in eligible)),'verified_jdg_games_denominator':len(verified_games),'complete_bo_match_ids':sorted(complete_bo),'high_confidence_game_ids':[r['game_id'] for r in eligible]},'quality':{'quote_generation':'physical source line slicing, SHA256 verified','fts_status':fts_status,'phase':'pre_show/bp_estimated/game_estimated/unknown','matching_rule':audit['matching_rule']},'comparisons':comparisons,'evidence':evidence,'cases':[e for e in evidence if not e['category'].startswith('history')],'history':[e for e in evidence if e['category'].startswith('history')],'limitations':limitations}
    draft_cases=[]
    for e in evidence:
        if e['phase']!='draft_context': continue
        spec=next(s for s in specs if s['id']==e['id']); vg=verified_by_id.get(e['game_id'])
        actions=[{k:a.get(k) for k in ['step_index','action_type','side','hero_name']} for a in (vg or {}).get('bp',{}).get('actions',[])]
        relevant=[a for a in actions if a['hero_name'] in spec['bp_heroes']]
        draft_cases.append({'evidence_id':e['id'],'game_id':e['game_id'],'phase':'draft_context','phase_review':'人工字幕文本核实：进入禁选后的连续语境；未看音视频','research':e['interpretation'],'verified_analysis_actions':relevant,'cross_check':'相关英雄及先后顺序见结构化BP；预测与实际禁选不同不得当矛盾事实，解说counter效果/英雄池胜率未独立认证','verified_bp_full_order':actions})
    result['draft_cases']=draft_cases
    mvp=next(e for e in evidence if e['id']=='VS-18')
    result['quality']['field_conflicts']=[{'evidence_id':'VS-18','game_id':mvp['game_id'],'field':'MVP','subtitle_claim':'清融王昭君MVP','verified_analysis_mid_stats_mvp':verified_by_id[mvp['game_id']]['mid_stats']['mvp'],'status':'冲突未解决；字幕不是MVP认证'}]
    dump(out/'subtitle_audit.json',audit);dump(out/'verified_subtitles.json',result);conn.close()
    from render_subtitle_report import render
    render(result,audit,ROOT/'subtitle_analysis.md')
    print(json.dumps({'sources':len(records),'lines':total_lines,'evidence':len(evidence),'eligible_jdg_2026':len(eligible)},ensure_ascii=False))
if __name__=='__main__': main()

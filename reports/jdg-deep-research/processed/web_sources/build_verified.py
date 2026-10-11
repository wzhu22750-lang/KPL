"""Rebuild the six source records from immutable saved HTTP/CLI output, not old community.json."""
import json, hashlib, pathlib, datetime
ROOT = pathlib.Path(__file__).resolve().parents[2]
P = ROOT / 'processed/web_sources'
logs=[]
for f in sorted(P.glob('retrieval_batch*.json')):
    logs.extend(json.loads(f.read_text()))
by={x['id']:x for x in logs}
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def record(id, artifact_id, url, title, published, platform, needle, classification, interpretation, metrics=None, author=None):
    log=by[artifact_id]; path=ROOT/log['artifact']; text=path.read_text(); start=text.index(needle); end=start+len(needle)
    return dict(id=id,url=url,title=title,published_at=published,retrieved_at=log['retrieved_at'],platform=platform,author=author,exact_quote=text[start:end],metrics=metrics or {'views':None,'comments':None,'likes':None,'reposts':None},verification={'status':'retrieved_text_quote_checked','scope':'仅核对保存文本中的引文；不验证作者评价或指控属实','source_sha256':sha(path),'quote_char_start':start,'quote_char_end':end,'line_start':text[:start].count('\n')+1,'line_end':text[:end].count('\n')+1},local_artifact=log['artifact'],classification=classification,interpretation=interpretation)
sources=[
record('VC-HUPU-824518','hupu_discussion','https://bbs.hupu.com/642824518.html','[JR热议]瓜主爆料：北京JDG明日中上首发为昊昊/花缘，你是否看好？','2026-10-08 08:41:37（页面原值，时区未注明）','Hupu','jdg真是幸福的烦恼啊，不过清融和昊昊也都够努力的','fan_comment','双中单同时被肯定的个案；不能据此认定多数队粉支持轮换。',{'views':18759,'comments':74,'lights':28,'recommendations':32,'quote_lights':47,'likes':None,'reposts':None},'竹山堂（回帖）；断线流老庄周（楼主）'),
record('VC-HUPU-839424','hupu_preview','https://bbs.hupu.com/642839424.html','[前瞻]JDG冲击大场三连胜，狼队能否拿下关键积分脱离危险区？',None,'Hupu','只能说两位选手风格正好互补，也难怪化学反应这么好。当然，变成替补的清融表现也同样不差','editorial_opinion','作者以互补/化学反应解释表现，是媒体观点而非控制变量后的协同因果结论。页面无可核作者/发布时间/互动，均不继承旧值。'),
record('VC-WEIBO-099691','renata_full','https://www.sina.cn/news/detail/5350996910801176.html','粉丝不想闹只想公平：清融的 BP 环境，真的只是运气吗','2026-10-06 12:22（页面原值）','Weibo via Sina mirror','清融粉丝不想闹，只想为他争取一个公平竞争的机会','fan_opinion','公平竞争诉求可核；BP偏心、热搜打压、教练嫡系等为博主指控，未获事实确认。搜索结果曾误将相关推荐后援会当本文作者。',author='qov2u'),
record('VC-BILI-PERR','bili_jina','https://www.bilibili.com/video/BV1tDpt6pERR','北京JDG 3-0 深圳DYG 赛后数据雷达图+虎扑热评',None,'Bilibili','零封！北京JDG 3-0 深圳DYG 赛后数据雷达图+虎扑热评丨KPL年度总决赛','video_title_only','只核页面标题/列表出现该标题，未读到视频说明、评论、弹幕或观看视频。不能确认5.8万人评分、作者及发布日期。Jina Published Time 2024与赛事语境冲突，不用作视频发布日期。'),
record('VC-CLUB-SUMMER','summer_club','https://bbs.hupu.com/642306823.html','[流言板]JDG长文：夏季赛一路走来，我们打破队史，冲破外界的质疑',None,'Hupu repost of club statement','七月的尾巴，我们让二追三锁定第三轮S组。那是阿融去集训前，能参与的最后一场夏季赛。','club_statement_repost','正文标来源微博，为俱乐部长文转载；支持清融夏季赛末进入集训的背景，不能证明集训日程/金牌或国家队完整公告。',{'views':13709,'comments':25,'lights':11,'likes':None,'reposts':None}),
record('VC-MATCH-1003','match_scores','https://www.988zbw.com/dianjingzhanbaoba/446620.html','EDG五局拉满战胜JDG EDG 3-2 JDG','2026-10-03（页面赛事日）','988直播','第四局：EDG 2-2 JDG【赛后数据】','secondary_match_report','正文逐局累计EDG比分1-0、1-1、2-1、2-2、3-2：JDG G1负/G2胜/G3负/G4胜/G5负。与中国电竞网大比分一致，仍为非官方二手战报；需比赛数据库/官方原始记录终审。')]
sources[-1]['verification']['supporting_artifacts']=[{'path':'processed/web_sources/match_report.txt','sha256':sha(P/'match_report.txt'),'scope':'另一个二手正文确认EDGM 3:2及G4昊昊安琪拉'}, {'path':'processed/web_sources/weibo_rotation.txt','sha256':sha(P/'weibo_rotation.txt'),'scope':'JDG认证官博镜像正文确认第四局中上换人，不证明该局输赢'}]
for log in logs:
    path=ROOT/log['artifact'];log['sha256']=sha(path)
    text=path.read_text()
    log['content_status']='retrieved_not_automatically_verified'
    if log['exit_code']!=0: log['content_status']='command_failed'
    elif 'Sina Visitor System' in text: log['content_status']='login_wall_no_body'
    elif 'AbuseAlleviationError' in text or 'Forbidden' in text: log['content_status']='blocked_no_body'
    elif log['id']=='exa_asian': log['content_status']='irrelevant_search_results_no_official_confirmation'
    elif log['id'].startswith('exa_'): log['content_status']='search_excerpts_only_not_full_body'
limitations=[
'六条登记中五条取得正文/原始文字，一条B站仅标题；未完成微博原站或B站评论/弹幕覆盖。bili命令未安装；未启用浏览器。',
'互动数字只来自抓取页面显示，并非独立用户人数或实时API；虎扑页头28亮与推荐32为不同字段，不强行统一。其余未知均null。',
'微博/Sina正文后的推荐流不能归入主帖；旧5350017357317094实际是多樂的10月3日轮换动态，不是旧稿声称的10月4日教练信任/七冠超话贴。',
'后援会原微博被访客系统阻挡；10740赞/425评没有重新核实，删除。B站58000参与者、dense_danmaku、thousands均删除。',
'不外推全平台性别、人数、支持率、主流阵营或粉圈动机；粉丝指控不能解释教练真实动机、合约、薪资或不续约。',
'10月3日JDG 2:3已由两份二手正文确认；G4二手累计比分为JDG胜，旧2-0领先叙事错误。尚未取得官方逐局胜负原始公告，不把二手战报包装为官方终审。',
'规则辅助：Exa命中署名王者荣耀赛事的腾讯新闻20261001A0ASAJ00，摘录“擂台赛每一轮BO5对局里，大师组7人大名单全部选手，都需要至少登场一小局。”Jina被403阻挡，直连未取得正文；此为官方候选检索摘录，不是完成官方正文验证。',
'亚运官方查询返回无关体育赛程，失败已存；仅俱乐部长文转载可核集训背景，不独立确认亚运名单、金牌或集训具体日期。',
'未访问本地articles/comments数据库；原community.json仅作待审输入，不是原始抓取缓存。UTC抓取日2026-10-09，对应北京时间2026-10-10。']
result={'sources':sources,'retrieval_log':logs,'limitations':limitations}
(ROOT/'processed/verified_community.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
manifest={str(f.relative_to(ROOT)):sha(f) for f in sorted(P.iterdir()) if f.is_file() and f.name!='manifest.json'}
(P/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
for s in sources:
    text=(ROOT/s['local_artifact']).read_text();v=s['verification'];assert text[v['quote_char_start']:v['quote_char_end']]==s['exact_quote']
print('Verified six exact saved-text quotes and hashes; five body sources plus one title-only source.')

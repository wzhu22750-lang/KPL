"""Render only source-generated quotes; reusable from verify_subtitles pipeline."""
def render(result,audit,path):
    c=result['coverage']
    lines=['# JDG 中单字幕再核验：来源审计与连续原文','',
    '> 已有字幕加工草稿的12条引文（不是两份用户原报告）全部撤回：均不能作为逐字原文使用。其中2022世冠第二局路径不存在，10/3 12:15安琪拉救主及6/21小寒随意输出文字不受该段源字幕支持。不得把新材料描述成音视频核验。','',
    '## 可靠结论与边界','',
    '- **10/3 EDG.M G4：本地源字幕明确祝贺JDG获胜，并说比分来到2:2（VS-02）。** 不能为了纠正旧稿，反过来制造G4败结论。旧稿那段12:15救场引文仍应删除（VS-03）；胜负与引文真伪是不同问题。',
    '- **年总轮换不是单独替换中单**：解说称光明与浩浩登场（VS-01/05）；两套中野辅为解说对合作经验的评价，不意味着辅助位置换人，也不说明效果完全由中单造成。',
    '- **8/30 女娲墨子**：有控制闭环与拆火的真实复盘（VS-11）；手长优势与光明处理兵线另属一段（VS-12），不得拼成单段原文。评论席的小寒地位提升是观点（VS-10），不是均值差异的因果解释。',
    '- **7/4 资源反证**：光明与浩浩经济超前、照顾新人（VS-13），但同局也提小韩经济高（VS-14）；不支持恒定让钱/恒定吃钱二分法。',
    '- **6/21 清融王昭君**：河道分割、控住进场者、赛后不吃钱评价可查（VS-16/17/18）。旧稿虚构的射手安全输出句不能保留；四局零死等统计需比赛核验层，字幕不证明。',
    '- **反证**：昊昊放线双边支援和拿命留人的评论（VS-01/19），清融的下路中野辅推进（VS-15）及历史掉点（VS-H25B），都提醒避免把两人固定为单一风格。',
    '- **2026 eStar补充**：找到2026评论回顾上赛季换浩浩（VS-22）和年总评论回忆其eStar指挥属性（VS-08）；不是2026代表eStar的小局。7/22 eStar对RNG.M的豪豪附近实际出现航航、杨戬等，不确认为昊昊，不纳入其个人证据。','',
    '## 可复跑流程','',
    '```bash','python3 scripts/verify_subtitles.py','python3 scripts/verify_subtitles.py --rebuild-fts','python3 scripts/query_subtitles.py 女娲 --team jdg --year 2026 --limit 5 --json','```','',
    '原字幕只读。`scripts/subtitle_selections.json`只保存经过文本阅读的行区间与解释，不保存原文；每次生成quote都重新读取原文件，取连续物理行，计算SHA256。`deep_jdg_analysis.py`及旧构建器CLI转入此流程，不再产出手写引文。','',
    '## 来源、缓存与索引审计','',
    f"- 本地MD：**{c['source_md_count']:,}**；按物理字幕行重数：**{c['source_subtitle_lines']:,}**。旧索引6,109,597行已修复；当前源加工字幕和FTS均6,109,608行，逐分P序列digest复核。",
    f"- 唯一源SHA256：{audit['source_unique_sha256']:,}；文件重复：{len(audit['duplicate_files'])}；part_id冲突：{len(audit['part_id_collisions'])}。这只排除文件字节级重复，不证明跨视频重复赛事不存在。",
    f"- 复用缓存{audit['cached_records']:,}条作为待审计输入。元数据差异：`{audit['cache_metadata_differences']}`。队名差异含旧缓存支持、当前保守映射未知的海外别名，不能把所有差异说成缓存错误。text digest只允许边缘空格剥离；引用始终保留源行原貌。",
    '- `source_manifest`逐文件记录路径、哈希、大小、物理字幕行数与重复归属；`metadata_corrections`记录源比赛日期、双方、赛季、局号、唯一匹配置信度及理由；`subtitle_phase`独立存估计规则。旧parts仅为元数据缓存；本地subtitles已修为完整源序列，source_path/source_line/line_idx对应原文件与0起字幕ordinal。旧11分P行备份于processed/legacy_subtitle_overrides.jsonl，切勿用旧match_confidence/is_bp作最终统计。',
    '- 上传日期不作为比赛日期：优先目录日期与标题月日，冲突则拒匹；双方+赛季+源赛日必须唯一，小局还需唯一game_no。评论席至多关联BO，game_id始终为空。high仅认证关联身份，不认证旧缓存胜负、MVP。',
    f"- 匹配结果：`{audit['match_confidence_counts']}`。FTS：{audit['fts_status']}。新FTS为contentless，检索必须join字幕行，避免旧external-content中spaced_text实际不存在的错误。全源行均参与检索；查询按ordinal及物理行再次读取源文核验，不再因重复秒数/文本误判歧义。",
    '- 阶段仅为pre_show / bp_estimated / game_estimated / unknown。评论席不能当BP。9个不同赛季文件的开局上下文已文本抽样复核（详见subtitle_audit）；全军出击也会出现在广告中，2022世冠一例已拒为开局。未逐条审核全库边界，BP统计仍有估计误差。','',
    '### 本地目录覆盖，不等于比赛全集','',
    '| 赛季 | 本地分P |','|---|---:|']
    for season,n in c['source_seasons'].items():lines.append(f'| {season} | {n} |')
    lines+=['','2026春季仅78分P、2025挑战者杯仅3分P，明显不能称完整覆盖20赛期。部分BO缺偶数小局。', '',
    f"2026 JDG当前唯一高置信正赛样本 **{c['2026_jdg_unique_game_ids']}小局**；赛事核验层分母为**{c.get('verified_jdg_games_denominator',0)}小局**（全年的两名中单样本；不是全联盟）。完整BO源文件覆盖为{len(c.get('complete_bo_match_ids',[]))}场，完整BO不意味着音视频或字幕语义无缺漏。所有game_ids可见JSON。",'',
    '## 讨论密度，不是战术执行频率','',
    '检索字典：BP=禁用/ban/BAN/BP/阵容/选择；中野辅=中野辅/中野/联动/无双/无畏；保射候选=保护/拆火/保射/输出环境；资源=经济/兵线/资源/野区。每条字幕每类最多记1，指标为关键词承载行数。它可能谈对手，也可能是赞助/赛后评论；不是逐事件编码，保射候选也不一定涉及射手。',
    '下表按每万字校准。全分P观察时长（末首字幕差）以及estimated-game行数/verified_analysis实际小局时长的敏感性指标另存JSON；后者仍可能含赛后讨论，不把讨论密度偷换成执行次数。','',
    '| 范围 | 赛季 | 中单 | 小局 | BP | 中野辅 | 保射候选 | 资源 |','|---|---|---|---:|---:|---:|---:|---:|']
    for z in result['comparisons']:
        d=z['discussion_lines_per_10000_chars']; scope='完整BO' if z['scope']=='complete_bo_high_confidence' else '全部已观测'
        lines.append(f"| {scope} | {z['season_id']} | {z['mid_player']} | {z['games']} | {d.get('bp',0):.2f} | {d.get('mid_jungle_support',0):.2f} | {d.get('adc_protection',0):.2f} | {d.get('resources',0):.2f} |")
    lines+=['','夏季全部观测样本里昊昊保射候选讨论密度略高；完整BO子集两人的差距显著缩小。年总样本甚至清融更高。不能概括成稳定的个人保护能力排序，阵容、对手、解说、局长均混杂。','',
    '## ASR：检索候选与身份认证分开','',f"2026 JDG源分P字面出现次数：`{audit.get('asr_surface_counts_2026_jdg',{})}`。这些是字形次数，不是识别正确率或选手动作次数。浩浩/豪豪可检索昊昊候选但必须看上下文；金融、青龙区、女王等均保留原文。**小孩不自动归小寒**，也不假称全库100%身份映射。",'',
    '## 连续原文台账','',
    '共38条：新增8条人工文本核实draft_context禁选语境，其余为原30条。类型区分解说事件与评论观点；没有音视频观看声明。以下原文均由源行自动生成，所有省略、拼接与静默纠错禁止。']
    lines+=['','## BP阶段原文与真实禁选时序交叉','',
    '新增8条draft_context均人工读字幕确认禁选语境，未观看音视频。评论席仍为pre_show。counter效果/英雄池胜率是观点，结构化BP只交叉实际选人顺序。',
    '- 10/3 G4：司空震先出，红方第11步ban海月；蓝方第18/19步太乙真人+安琪拉，红方第20步姜子牙。VS-D01提处理海月和盾山，没有说首ban海月；不能把红方首ban关羽写成预测落空。VS-D02/03的选人顺序与数据一致，counter与节奏强弱解释仍为观点。',
    '- 8/30 G5：红方第17步女娲、蓝方第18/19步虞姬+嬴政、红方第20步墨子（VS-D04/05）；线权射程与对线代价是预测，不是胜因认证。',
    '- 6/21 G1：红方第6/7步张良+王昭君，蓝方第9步武则天（VS-D06）。最终打野杨戬并非候选马超，不把候选当最终阵容。',
    '- 7/4 G1：蓝方第8/9步海月+夏洛特，红方第10步狂铁、第20步梦奇，蓝方后补苏烈+赵云（VS-D07/08）。双前排后排风险为观点；对新人友善不等于能力结论。',
    '- **MVP字段冲突**：VS-18字幕称清融王昭君MVP，原记录mid_stats.mvp=False。冲突未解决，不能认证MVP。','']
    for d in result.get('draft_cases',[]):
        lines.append(f"- {d['evidence_id']} · {d['game_id']}：`{d['verified_analysis_actions']}`")
    for e in result['evidence']:
        lines+=['',f"### {e['id']} · {e['category']}",'',f"`{e['path']}` · 源行{e['line_start']}–{e['line_end']} · 分P秒{e['start_seconds']}–{e['end_seconds']} · {e['phase']}",f"{e['type']} · {e['confidence']} · match={e['match_id']} · game={e['game_id']} · 本次文本上下文复核",'', '```text', e['quote'],'```','',e['interpretation']]
    lines+=['','## 限制与下一步','']+[f'- {s}' for s in result['limitations']]
    lines+=['- 首要使用verified_subtitles.json而不是subtitle_results.json/retrieval_candidates.json/quality_audit.json；旧文件保留只为追责审计，不参与成品证据登记。','- 源字符/关键词密度仍是探索性描述。若要比较真实动作，需逐事件人工编码并核对游戏时钟/画面，而不是给字幕词频换一个战术名称。','']
    path.write_text('\n'.join(lines),encoding='utf-8')

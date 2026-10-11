# JDG最终产物独立验收

## 最终复验：VICTORY CONFIRMED

复验日期：**2026-10-10 UTC**（实测开始05:14:37；独立补充检查见`final-contract-pass.log`时间）。结论针对当前离线磁盘产物：**已知修复全部落盘，未发现新的重大数值或归因错误，最终 VICTORY CONFIRMED。** 首次REJECTED及其证据全文保留在下方历史段，不撤销、改写或冒充首次即通过。

### 实际执行与复核结果

|门禁|结果与证据|
|---|---|
|独立运行unittest|**18/18，87.838秒，OK，退出0**；`.agents/teamwork/final-review/final-unittest.log`|
|独立Node语法检查|`node --check assets/report.js`退出0；`final-node-check.log`、`final-exits.log`|
|schema 2 / RFC 6901|实际为**13项claim、23次selector引用（21个不同selector）**，并非13条selector；所有`source_file + json_pointer`逐条严格解析通过，含空串根指针及含点号的完整对象键；`final-contract-pass.log`|
|注册artifact|**9/9 SHA256一致**，包括新增`teammate_hero_sensitivity.json`和`reader_data.json`；同上|
|支持集 / population|逐项检查唯一性、作用域population和支持集身份；**C09仅8/30 G5，C08精确等于四个混合BO的14局**。历史C11三局按其字幕关联核验，不误要求属于2026年211局。跨赛季机制例子不冒充夏季统计population；同上|
|字幕新增匹配理由|38条reader引文按原对象全部保留字段投影一致；新增字段仅`match_reason`，逐条等于SQLite `metadata_corrections.reason`（`mode=ro`）。registry引文也按保留字段一致；没有修改或判定verified_subtitles原对象为不同引文；同上|
|HTML与可信载荷|生成HTML嵌入reader逐对象相等，内联JS与当前`assets/report.js`全文一致；211局位置/BP投影、4项statistics与game_ids、比赛注册pointer/raw哈希通过；`final-projections-normalized.log`|
|数值独立反算|夏季胜局22/37、23/43，全年92/160、30/51；合法BP前三手夏季11/37、15/41，全年24/158、20/49；共同cell先筛再加权DPM夏季+331.24988/+298.30217、全年−33.57715/−85.26170，与可信结果一致；同上|
|逐字来源|38条字幕物理行切片及源SHA、六条社区本地留存行范围重新核验通过；同上|
|既有浏览器实测记录|实际读取并解析`output/playwright/browser-results.json`和`browser-check.log`，两者结果完全一致，**100/100 assertion为true，errors为空**；导出CSV实际211条且game_id集合一致，七张截图文件存在；`final-contract-pass.log`。这是对已有CLI实测日志的验收，**不是本复验重新启动浏览器独立跑了100项**。|
|清理记录|`cleanup.log`明确记录`jdg-check-96720`关闭；只读进程/8176监听检查无匹配输出，见`final-cleanup-inspection.log`。本复验未启动浏览器或HTTP服务。|

复验HTML SHA256：`47ee54e9c4c5ee8003903710984f57a3fdcd352eb62350b19bd4202ed4aa1951`。

### 已知问题关闭情况

- `jdg_mid_deep_research.md:105`已为“DPM约1909对1933”，`:154`为全年描述性差“多25.63pp”，不再宣称显著高于。可信精确值与舍入相符。
- `assets/report.html:31`及生成HTML均为“重叠有限 / 仅第一轮有有限重叠”；`:57`及生成HTML均为“分母字符含BP和赛后文本”，没有把字符密度当时长频率。
- 原点号selector歧义已由JSON Pointer修复；支持集与population已分开，新增可复现依赖哈希全部一致。
- `assets/report.js`筛选render实际再次调用`gameDetail()`；详情明确提示“当前详情不在统计筛选内”，既有浏览器记录亦覆盖该断言。

### critical与非阻断warnings

**新增critical：无。** MVP边界依然保留：6/21 G1可信raw无双为True、清融为False，字幕VS-18仍指清融；不以双MVP、官方认证或视频复核虚构解决冲突。未把比赛相关、共同英雄敏感性或解说观点升级为个人因果能力。

**非阻断warning：固定案例文字数值与夏季关系图队友常量仍存在。** 本次回归核对四个固定案例的伤害/KDA、女娲32.47%与射手18.26%、王昭君7149经济与MVP边界，以及夏季光明/无双/小寒/无畏标签均相符。它们有明确固定范围，不是上方全局筛选数据；后续数据更新仍需回归维护，不能因此误判当前动态筛选错误。

### 审计边界与失败记录透明性

仅写`review.md`及`.agents/teamwork/final-review/`日志/命令文档；未运行会生成业务文件的build/render脚本，`python -B`避免pyc写入，未联网，未观看音视频，也未独立核验官方MVP、版本或轮换规则。此次结论是本地来源溯源、数值与交互记录验收，不是独立官方认证。

新补充检查的中途失败日志全部保留：`final-projections.log`遗漏registry新增字段投影；`final-contract.log`误将13个claim当成13条selector；`final-contract-normalized.log`误把历史支持局要求属于2026样本；`final-contract-complete.log`误从verified位置对象读取reader专有`display_name`。这些属于审计脚本适配错误，修正后完整成功记录为`final-projections-normalized.log`、`final-contract-pass.log`；没有删日志或把失败改写成通过。实际命令与补充检查代码见`final-commands.md`，退出码见`final-exits.log`。

## 历史：首次审查快照（REJECTED，原文完整保留）

首次文档落盘时间据复验开始前文件mtime为**2026-10-10 12:27:51 +0800（04:27:51 UTC）**；这是文件mtime，不冒称首次测试起止时间。以下全文属于该快照，里面的“当前”、12项测试、7项artifact、浏览器未覆盖等均描述当时状态，**不代表本次最终状态**。

### 首次报告原文

**结论：REJECTED（审查时的磁盘快照；不是新增研究阻断错误）。**

12项现有unittest均真实通过，耗时67.867秒；全源字幕核验实际运行。可信加工数据、交互载荷、注册表的数值和逐字证据检查通过。**未发现额外重大数值/归因错误。** 但最后一次检查的Markdown仍包含委托人已声明正在修复的两处旧文案，不能把尚未落盘的修复当作最终版本通过。它们不列为新发现；完成修复并复核生成物后可重新裁决。浏览器验收由委托人负责，不在本次只读验收结论中。

## critical

### 新发现

无新增critical。不存在“raw双MVP已解决矛盾”的新证据；本次读取的可信记录中该局只有无双为MVP，清融为False。VS-18确实说清融王昭君MVP，冲突仍然未解决。

### 已知修复的交付门禁（非重复报错）

最后一次实际执行的综合检查见 `.agents/teamwork/final-review/reproducible.log`：

- `jdg_mid_deep_research.md:105`仍为旧游走DPM文字；表格`:98`和可信数据已是1908.55/1932.96。此处按委托人已有修复计划处理，建议最终引用可信值或按明确精度舍入。
- `jdg_mid_deep_research.md:154`仍为“显著高于”；委托人拟改为描述性差25.63pp，方向正确，不需要额外假造显著性检验。

当前生成HTML的JS和嵌入JSON与源文件一致，**不意味着随后Markdown改动自动更新其他生成物**。门禁是确认最终落盘快照，不是要求重做研究。

## warnings

1. **轮次重叠的界面文字过度绝对。** `assets/report.html:31`写“轮次不交叉”，但Markdown`:37`明确第一轮清融18局、昊昊3局，存在有限重叠。建议改“轮次重叠有限，第二/三轮和季后赛不重叠”。非因果结论仍成立，不应以零重叠的错误表述支撑它。
2. **文本分母单位文案不准确。** `assets/report.html:57`“分母时长含BP和赛后”，而`assets/report.js:52`、Markdown`:190`实际是每万字符的关键词承载行密度。建议改“分母字符包含BP与赛后文本”，不要把字符密度写成时间频率。
3. **统计selector存在点号键歧义。** `evidence_registry.json:118–119,218–219`采用`inference.summer.metrics.发育路.damage_share`等字符串；真实metrics键是完整的`发育路.damage_share`，不是嵌套对象。字段真实存在、数值正确；但按普通点号逐层解析会失败。建议注册为JSON Pointer，例如`/inference/summer/metrics/发育路.damage_share`。`additional.log`中的False仅表示这种解析歧义，不是数据不存在。
4. **case支持集与population未分开。** `evidence_registry.json:1195`的C09指8/30 G5，却将整个夏季80局填入`game_ids`；C08同样填全年211局而非四个混合BO小局。证据字幕能准确定位，未发现比赛配错，但建议区分`population_game_ids`与`supporting_game_ids`。C03引用的`processed/teammate_hero_sensitivity.json`亦未列入注册表末尾`:4784`的artifact哈希清单，建议补齐可复现依赖。
5. **固定案例与动态选择的状态提示可更明确。** `assets/report.js:48,54,56–57`更新筛选下拉但不清空`state.game`或重新绘制详情；`assets/report.html:47`已声明案例固定，所以不构成错误统计。但用户从“其他小局”选局后再筛选，可留下不属于当前下拉样本的详情；建议显示“当前详情不在统计筛选内”，或明确分开固定案例与动态详情。
6. **硬编码的回归风险，不是当前数值错误。** `assets/report.js:42–45`案例伤害、KDA、份额等均为固定文字；`:50`证据总数写死38，`:47`JDG raw team_id写死10020，`:39`关系图队友写死夏季四人。当前核对相符；关系图已标夏季机制示意，敏感性面板在`assets/report.html:40`明确不受蓝红/胜负筛选影响，不能把这两处固定范围误报为动态计算错误。建议后续用可信载荷生成案例数值和证据总数。

## coverage

### 已实际执行的命令与结果

工作目录：`/Users/kuangqie/Documents/VibeCoding/KPL/reports/jdg-deep-research`。

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s tests -v > .agents/teamwork/final-review/unittest.log 2>&1
node --check assets/report.js > .agents/teamwork/final-review/node-check.log 2>&1
```

- unittest：退出0，**Ran 12 tests in 67.867s / OK**。日志`unittest.log:1–17`；包括7891个源文件逐文件SHA、物理字幕序列与索引/FTS的6109608条对应核验，不是只检查38引用。
- Node语法检查：退出0；`node-check.log`。
- 自写只读Python检查实际经stdin执行；完整可复跑命令及代码在`.agents/teamwork/final-review/commands.md`，最后综合运行输出`reproducible.log`。早期两次检查对整个对象作严格相等比较，在投影移除字段处中止；保留原日志以避免隐瞒失败，之后按保留字段投影核验成功，不把它们误报为数据错误。
- 没有运行build/render/verify写入脚本，没有访问网络、浏览器或连接数据库。

### 数值、来源和归因

- `processed/reader_data.json`与可信`verified_analysis.json`的coverage/inference/sensitivity/series_groups/history一致；207合法BP和211小局保留的选手数值、BP顺位别名、行动顺序投影一致。联盟BP基准仅删除game_ids，无数值变化。
- HTML嵌入reader JSON逐对象一致，内联JS包含当前`assets/report.js`全文；注册表7项artifact SHA全部一致，211 game pointer/battle_id/raw哈希一致，4项statistics数值及各自game_ids一致。
- 夏季胜局22/37与23/43；全年92/160与30/51。夏季四队友确为光明/无双/小寒/无畏，但环境非随机，不把同四队友升级为因果。
- BP全场前三手分母仅合法BP：夏季11/37、15/41；全年24/158、20/49。夏季队内均序2.97297/3.04878，全年3.29747/2.89796。`assets/report.js:37`正确区分整体顺位和队内顺位；211局对手中路可用英雄ban计数按可信分类再算一致。
- 标准化独立重算：先排除非共同cell，再用保留合并样本权重。夏季共同英雄36/38局，DPM差331.24988；英雄×阵营27/28局，298.30217。全年153/51局，−33.57715；英雄×阵营119/49局，−85.26170。未把筛样本效应与加权效应混称，也未宣称因果个人能力差。
- 队友自身共同英雄检验：夏季无双78局差788.16796、光明76局差633.16464，与文案相符；不将其归为清融个人提升。
- 纯清融33BO24胜、纯昊昊9BO5胜、混合4BO3胜，与Markdown`:219`叙述和可信series_groups相符。混合BO不按出场多数归个人；联合BO bootstrap由unittest核验标志和原方法说明，未在本次重新跑3000次抽样。
- MVP边界：`processed/source_field_audit.json:51842–51846`、`verified_subtitles.json`quality、Markdown`:53`及JS`:45`均保留冲突；当前可信两队阵容的每队MVP最大数量为1，不存在可用“双MVP”解释。原始raw此前审计的结论不被本次替换。
- 六条社区exact_quote均出现在对应本地留存的注册物理行范围；全文保存、标题仅有、作者/互动未核等边界在页面和正文中已明确，没有把社区观点升级为赛训事实。

### 六条定向源文件回读

除了38条引文全量切片/hash核验，还通过read工具实际回读以下源文件上下文。源根目录：`/Users/kuangqie/Documents/VibeCoding/B站字幕提取/KPL解说/`。全文切片留在`independent.log`。

|证据|源根目录下文件路径|引用物理行|回读判断|
|---|---|---|---|
|VS-01|`2026年度总决赛/2026-10-03_【2026KPL年度总决赛】10月3日 北京JDG VS 上海EDG.M_BV19FHv61Efx/P04_第四局.md`|55–65|昊昊放线双边支援、GANK成功率为解说观点，前文排名不被当认证数据|
|VS-D03|同上|138–163|安琪拉/太乙前期中野辅是解说阵容评价，保留ASR，不补写技能事件|
|VS-11|`2026夏季赛/2026-08-30_【2026KPL夏季赛】8月30日 广州TTG VS 北京JDG_BV1PttH6rEwH/P05_第五局.md`|703–716|墨子女娲两套控制连续原文，与归因边界相符|
|VS-16|`2026夏季赛/2026-06-21_【2026KPL夏季赛】6月21日 北京JDG VS 长沙TES.A_BV1HGjt6oEhw/P01_第一局.md`|511–523|王昭君盖河道、无双拿龙，未冒充观看画面|
|VS-18|同上|862–871|确说“本局的IQMVP也是给到了清融的王昭君”；与raw无双冲突，不擅自裁决|
|VS-H25B|`2025夏季赛/2025-06-06_【2025KPL夏季赛】6月6日 北京JDG vs 广州TTG_BV1rZTMzcEo5/P02_第一局.md`|603–609|清融被击杀、掉点、对手拿龙的负面案例确实存在|

### 原数据保护与未覆盖项目

本审查仅新增`review.md`及`.agents/teamwork/final-review/`审查日志；`-B`避免新增pyc。未修改比赛、字幕源、加工数据、正文、页面或脚本。原数据库历史未改的断言依赖已有只读审计，不冒称本次做了前后数据库hash快照比较。浏览器布局、交互实测、截图、导出下载及实际打印仍由委托人验收；未观看音视频，也没有独立获取官方MVP、版本或轮换规则。

## 五步交接

1. **Observation**：现有12项测试真实通过；可信数据与最终载荷一致，38条逐字引文和六条社区定位一致。审查快照仍有两项已知修复未落盘。
2. **Logic**：从可信加工数据反算胜率/BP分母/共同cell权重，核对注册hash/pointer及源文件，不用旧稿故事补证据；固定案例和探索筛选的边界分别评价。
3. **Caveats**：ASR并非视频认证，镜像与raw非独立官方认证；第一轮有限重叠仍不够识别因果；浏览器未测试。日志中的投影比较中止与点号selector歧义已解释，不是隐藏测试失败。
4. **Conclusion**：**REJECTED：仅针对当前未完成修复的最终磁盘快照。新增critical为零，warnings如上。** 不把已声明修复当新缺陷，也不在尚未落盘时声称VICTORY CONFIRMED。
5. **Verification**：先完成既定文字修复、检查相关模板/生成物同步，再复跑`commands.md`里的只读综合检查；委托人完成浏览器验收。若修复过程中改变可信加工数据，必须重跑12项unittest及artifact注册核验。

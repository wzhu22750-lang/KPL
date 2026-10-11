# JDG双中单研究交付

**先读专题：[jdg_mid_deep_research.html](jdg_mid_deep_research.html)**。自包含，约1.8MB；数据、原文和图表都在HTML内，不请求外网。可以直接打开；自动化验收使用本地HTTP，因为Playwright CLI默认阻止file协议。

核心结论：更换中单改变的是阵容组合、部分BP时点与输出权重，不是必然切换一整套胜利公式。英雄构成解释一部分全年伤害差，夏季边野差并未被共同英雄检验消除；个人能力与比赛环境无法独立分解，也不能估出可信的因果解释百分比。

> 比赛为项目数据库镜像及其embedded raw，不是独立官方实时认证。字幕为文本复核，未观看录像。MVP、精确版本、轮换规则与教练动机仍有不能确认的部分。

## 交付文件

|文件|用途|
|---|---|
|[jdg_mid_deep_research.html](jdg_mid_deep_research.html)|体育编辑专题：样本/阵营/结果切换，真实SVG，英雄、两队阵容、完整BP、轮换、38条源证据，深浅主题、CSV和打印|
|[jdg_mid_deep_research.md](jdg_mid_deep_research.md)|完整论证、数值表、反例、历史、社区与最终回答|
|[data_audit.md](data_audit.md)|两份旧报告冲突、胜负映射、BP合法性、字段、样本和来源等级|
|[subtitle_analysis.md](subtitle_analysis.md)|全源索引、匹配/ASR/覆盖审计、讨论密度和38条逐字原文|
|[evidence_registry.json](evidence_registry.json)|13项结论→统计JSON Pointer→来源哈希/游戏ID/字幕ID；区分支持集与总体|
|[community_notes.md](community_notes.md)|六条社区/背景来源，抓取日期、原文、互动与失败日志|
|[review.md](review.md)|独立两轮验收，保留首次未修复快照与最终通过结论|

`processed/subtitles.db`为2.8GB本地SQLite/FTS索引，不是发布HTML的依赖。`source_reports/`保留用户旧报告快照；原MD路径在任务期间不可用的状态已写入审计，未恢复可能的外部改动。

## 验收

- **18项Python测试通过**，包含7891个源文件SHA、6109608行索引与FTS覆盖、比赛映射、注册指针/哈希和最终载荷。
- **100项真实Chromium交互断言通过**：18种样本组合、数值更新、共同英雄、原文/上下文、20步BP与10人阵容、缺失BP不补造、211行CSV、键盘主题、持久化、打印、减少动态效果、360/390/768/1440宽度。
- 七张截图和原始执行日志在`output/playwright/`；无JS运行错误、失败请求或外部请求。每次自动化结束已关闭本任务浏览器、CLI守护进程和HTTP预览。
- 独立复验实际执行18项测试、核验23次selector引用及9项注册哈希，最终`VICTORY CONFIRMED`；不是只读一份交接自称通过。

## 重建报告

在本目录执行，已交付可信加工JSON和索引可直接复用：

```bash
python3 scripts/build_report_data.py
python3 scripts/render_research.py
python3 scripts/build_html.py
python3 -B -m unittest discover -s tests -v
bash scripts/check_browser.sh
```

无Node前端构建依赖。比赛重新核验需Python3、`psycopg2-binary`和原项目已有连接配置；连接取自环境或`kpl-intelligence/.env`，不会打印或硬编码凭证。

```bash
python3 scripts/verify_matches.py
python3 scripts/audit_source_fields.py
```

字幕核验复用本机原始Markdown与`KPL/data/commentary_parsed.jsonl`解析缓存；缓存仅比较用，原文从Markdown读取。重跑会更新**本研究目录的加工表/FTS**，不改源Markdown。当前脚本默认源根为本机`B站字幕提取/KPL解说`，迁移机器需调整`verify_subtitles.py`的SOURCE和`build_subtitles_db.py`的BASE_DIR；同时带入解析缓存、比赛缓存和已交付SQLite。未声称可在缺这些输入时空目录独立复原。

```bash
python3 scripts/verify_subtitles.py
# 强制重建FTS会遍历610万行，默认只维护变化行
python3 scripts/verify_subtitles.py --rebuild-fts
python3 scripts/query_subtitles.py 女娲 --team jdg --year 2026 --limit 5 --json
python3 scripts/query_subtitles.py 中野辅 --team jdg --season kpl-2026-summer --type game --context 5 --limit 10
```

`query_subtitles.py`先检索候选再回读源文件，输出source_line/source_path、比赛ID、匹配理由、分P秒、上下文和SHA。`--bp 1`只是估计阶段过滤，不认证真实BP；评论席与未知边界不混入正赛。

## 修改时保留的约束

源资料只读；引用必须连续逐字切片；BO成簇区间不是个人胜出概率；同队友不称因果实验；胜/败筛选不叫优势/逆风；混合BO不归多数出场者；Ban不认证针对个人；标准化要同时说明排除样本与重加权。固定案例不随统计筛选改变，页面会提示当前详情是否在筛选内。

旧`match_analysis.json`、`subtitle_results.json`和手写findings仍作为不可信历史审计输入留存，不能替换verified开头的新证据。生成物有改动后必须重建HTML，并重跑测试；不要只改模板不更新交付页。

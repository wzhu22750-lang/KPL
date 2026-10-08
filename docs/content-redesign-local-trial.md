# 查看内容改版真实本地试跑

> 本轮使用真实公开素材及现有模型，不是合成演示。公众号全部禁用，生产库、原 3000 端口服务和部署均未改动。评分仍未做用户标注校准，仓库中的雷达开关仍默认关闭，仅本地进程开启。

## 打开页面

- [10 月 7 日内容雷达](http://127.0.0.1:3100/?radarDay=2026-10-07)：2 个圈内话题、3 个比赛大场、24 份比赛关联素材、9 条独立动态。
- [AG–LGD 比赛详情](http://127.0.0.1:3100/matches/kpl-20260004-2026100703)：总比分 2:3，5 个小局及关联报道。
- [全部动态](http://127.0.0.1:3100/all) · [本地管理后台](http://127.0.0.1:3100/admin)

10 月 8 日没有赛程；首页日期切换可查看前一天，不将昨日内容伪装成今日消息。日期归档只显示该日雷达，隐藏不适用的旧精选分类/搜索，避免筛选后产生空白页面。两个圈内话题来自选手赛后发言/趣评，不宣称本轮已经发现经核实的重大争议。

## 本轮实际结果

快照时间：2026-10-08 11:35 北京时间；[数据库汇总证据](audit-artifacts/content-redesign-local-trial/actual-run-summary.txt)。

| 项目 | 结果 |
|---|---|
| 信源窗口 | 23 个启用源；最近采集 19 成功、4 失败；微博最多 1 页，不是渠道全量 |
| 真实素材 | 199 条；113 已分析、49 跳过、36 被阻断、1 失败 |
| 雷达判断 | 39 接受、102 拒绝、5 待复核；53 条较旧首次导入素材没有强制历史重评 |
| 话题/官方赛程 | 2 个话题；36 个赛程大场；本轮补齐 10 月 7 日 3 场的 12 个小局 |
| 旧发布投影 | 77 eligible、13 selected；不等同新雷达的 accepted 数量 |
| 主要队列 | content.analyze / content.radar / events.group 的 created、active、retry 均为 0 |
| LLM 回执尝试 | live：813 received、19 failed、1 unknown；不是 813 条发布内容或金额账单 |
| 现有向量模型 | dashscope：67 received |

未知结果保留在既有回执机制中，不当作成功、不删除账目；本轮经历过既有的有限自动恢复，没有人工无限释放/重买。剩余失败需要人工决定，不能声称全部处理成功。

B 站 Hero、KPL 官方、WB 三源返回 HTTP 412；eStar 微博未取得正常列表响应。没有绕过平台限制。公众号的 4 个账号与 9 个 RSS 均关闭。

本地请求次数限制：LLM 每分钟 120、每小时/日 1000；现有 dashscope 向量模型每分钟 30、每小时/日 100。其它付费采集服务仍为 0。这不是金额预算；未取得可验证的代理账单金额，不能报告为零费用。

周期采集的 sources.schedule、mp-reconcile、discover-teams 已暂停，避免一轮试跑变成持续抓取。API、Web 和受限 worker 保留运行，便于查看效果。

## 实测修复

| 问题 | 证据与修复 | 验证 |
|---|---|---|
| 微博清洗阻塞 CPU | 5 秒采样的 3992 次命中均在 cleanWeiboText；嵌套可空重复正则导致灾难回溯；改为有限末尾标签匹配和线性扫描 | 子进程限时红测试复现，微博 11 项全绿；worker 恢复低 CPU |
| 默认首页隐藏雷达 | 默认 channel=all 被误当成显式筛选；前端显示与后端去重同时修正 | 新集成回归验证 all 排除实际雷达重复，显式 news 筛选保留旧列表；真实浏览器已显示雷达 |
| 小局换边导致胜方/统计错队 | 误用大场 A/B 顺序解释每局 camp1/camp2；改按小局官方 team_id 映射，并将击杀/经济对齐大场 A/B；缺失、陌生或重复队伍拒绝覆盖有效对局 | 红绿回归及不完整身份保护；通过 KB 的 upsertGame 重放已有真实官方原始响应，修复 12 局，额外模型调用 0 |
| 代理并发拒绝与向量预算 | 原 worker 多队列叠加触发 gateway_concurrency_limit；仅本地启动钩子降低并发；开启现有向量模型的有界预算 | 队列继续完成，保留真实失败/未知回执，不改生产并发配置 |

修复后逐局胜方汇总与大场比分一致：KSG–TES 3:0、WB–EDG.M 1:3、AG–LGD 2:3。没有直接手改比分或创造比赛素材。

## 验证与截图

- 主站完整回归：764 项，710 通过、54 跳过、0 失败。
- Web：29 通过；typecheck、Web build、git diff --check 通过。
- [日志目录](audit-artifacts/content-redesign-local-trial/)包含全量测试、红绿回归、小局修复及数据库快照。
- 真实页面截图：[桌面](../output/playwright/content-redesign/real-oct7-desktop.png)、[390px 手机](../output/playwright/content-redesign/real-oct7-mobile.png)、[AG–LGD](../output/playwright/content-redesign/real-ag-lgd.png)、[比赛时间线完整展开](../output/playwright/content-redesign/real-ag-lgd-expanded.png)、[手机话题展开](../output/playwright/content-redesign/real-topic-mobile-expanded.png)。390px 页面宽度实测为 390，没有横向溢出；实际点击“前一天”从 10 月 7 日进入 10 月 6 日，逐局页面及 MVP 已渲染；自动化浏览器已显式关闭。

## 停止试跑

**临时 PostgreSQL 容器带 --rm，停止后会删除本轮数据库。需要保留完整账目/数据时先做备份。** 当前服务只监听 loopback；此管理后台使用本地开发管理员，不可对外暴露。

```bash
bash /tmp/kpl-local-trial/stop.sh
```

脚本先停采集/Web/API/worker，等待 API 与 worker 排空后才停临时库；超时则保留数据库，不强杀付费请求。脚本及进程日志位于 `/tmp/kpl-local-trial/`，属于本机临时运行环境，不是生产部署或可长期依赖的发布包。

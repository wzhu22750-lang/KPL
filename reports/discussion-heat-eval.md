# DiscussionHeatScore Offline Evaluation Report

> **Offline Experimental Model**: Version `discussion-heat-v1-offline-exp`
> Evaluation Reference Time: `2026-10-09T14:00:00.000Z` (deterministic)
> Benchmark Ground Truth: **SYNTHETIC BENCHMARK FIXTURE (NOT ACTUAL USER LABELS)**
> Production Rollout: **DISABLED** (Never deploy without calibrated holdout)

## 1. Coverage Metrics

| Metric | Count | Percentage |
| :--- | :--- | :--- |
| Total Snapshots Evaluated | 8 | 100% |
| Observed Interaction Heat | 7 | 87.5% |
| Partial Interaction Metrics | 0 | 0% |
| Missing Heat (Unobserved / Null) | 1 | 12.5% |
| Metric Anomaly Detected | 2 | 25% |

## 2. Pairwise Ranking Evaluation (Synthetic Benchmark Labels)

| Pairwise Metric | Value |
| :--- | :--- |
| Evaluated Labelled Pairs | 21 |
| Concordant Pairs (Correct Order) | 20 |
| Discordant Pairs (Inverted Order) | 1 |
| Tied Predictions | 0 |
| **Pairwise Ranking Accuracy** | **95.2%** |
| **Kendall's Tau Correlation** | **0.905** |

## 3. Top Ranked Discussions (Top 8)

| Rank | Score | Platform | Heat | Growth | Value | Quality | Rel | Conf | Title | Anomalies |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- | :--- |
| 1 | 95 | hupu | 99 | 100 | 100 | 80 | 80 | 100 | 【赛后热议】成都AG超玩会击败WB，决胜局BP与选手发挥深度复盘 | - |
| 2 | 94 | bilibili | 97 | 100 | 100 | 80 | 80 | 100 | 【战术拆解】为什么一诺公孙离决胜团敢直接肉身开团？逐帧细节拆解 | - |
| 3 | 72 | weibo | 71 | 66 | 74 | 80 | 80 | 100 | 选手后台赛后采访抓拍花絮与互动 | - |
| 4 | 61 | hupu | 57 | 24 | 100 | 80 | 80 | 100 | 日常训练赛赛果水帖讨论 | - |
| 5 | 50 | weibo | 49 | *null* | 46 | 80 | 80 | 75 | 【官方售票】2026年KPL年度总决赛鸟巢场次观赛须知与入场检票规则 | - |
| 6 | 47 | weibo | 71 | 0 | 80 | 80 | 80 | 70 | 疑似引战带节奏争议帖（评论遭遇大面积删除） | negative_counter |
| 7 | 0 | hupu | 75 | *null* | 100 | 0 | 80 | 75 | 【广告】王者代练包上百星看个人主页进群加管理 | spam_content |
| 8 | *NULL* | hupu | *null* | *null* | *null* | 80 | 80 | 0 | 抓取失败或缺失指标快照的待补充帖子 | - |

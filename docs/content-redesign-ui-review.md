# 内容改版 UI：阅读层级整理

> 本文记录上一轮设计。最新反馈已取消首页日期分期，并重构比赛详情，见[首页实时概览与比赛档案](content-home-match-archive.md)。

本轮只调整展示，不改变模型评分、内容排序、公开权限、数据接口或站点导航。沿用已有青色品牌、字体、圆角及深浅主题，没有新增依赖。

## 主要变化

| 原来 | 现在 |
|---|---|
| 话题、比赛、技术说明都在同级卡片里 | 圈内焦点 → 比赛速览 → 更多动态 |
| 标题折叠后看不出内容，展开又重复标题 | 首条话题直接显示摘要；其它话题降低字号和边框层级；来源按需展开 |
| 大场逐张纵向堆叠、比分不醒目 | 桌面三列比分卡；点开后占满该行，再按小局展开 |
| 比赛详情重复显示大场标题和比分 | 已有比分保留，新增部分精简为“比赛报道” |
| 官方加分、热度计数、依据说明占首屏 | 归入“来源与判断依据”；传闻/观点分类仍可直接看到 |
| 额外战队条和旧热点抢占雷达阅读区 | 雷达页面不再重复插入，原导航及非雷达页面保留 |
| 空话题、空比赛分别占位置 | 合并为空状态，提供明确的“回看前一天”入口 |

## 查看真实页面

- [10 月 7 日内容回顾](http://127.0.0.1:3100/?radarDay=2026-10-07)
- [AG–LGD 比赛页](http://127.0.0.1:3100/matches/kpl-20260004-2026100703)
- 截图：[桌面](../output/playwright/content-redesign/ui-refined-desktop.png)、[手机](../output/playwright/content-redesign/ui-refined-mobile.png)、[深色](../output/playwright/content-redesign/ui-refined-dark.png)、[空状态](../output/playwright/content-redesign/ui-refined-empty-mobile.png)、[比赛报道展开](../output/playwright/content-redesign/ui-refined-match-mobile.png)。均为现有真实本地数据。

## 验证

- 320 / 390 / 768 / 1280px 无页面级横向溢出。
- 键盘 Enter 可展开话题；原文、来源、评分依据仍可访问。
- 比赛卡展开占满栅格；即使内部小局保持展开，收起大场后也恢复紧凑卡片。
- 比赛页等待展开动画完成后核对：G2 为成都AG超玩会胜，MVP 大帅。
- 深浅主题及手机空状态已检查；自动化浏览器已显式关闭。
- typecheck、Web build、29 项 Web 测试、全站 smoke 通过。
- 主站回归 764 项：710 通过、54 跳过、0 失败。
- [验证日志](audit-artifacts/content-redesign-ui/)。

改动文件：`apps/web/app/features/feed/ContentRadar.tsx`、`apps/web/app/routes/home.tsx`、`apps/web/app/routes/match.tsx`，均位于 `kpl-intelligence/` 下。

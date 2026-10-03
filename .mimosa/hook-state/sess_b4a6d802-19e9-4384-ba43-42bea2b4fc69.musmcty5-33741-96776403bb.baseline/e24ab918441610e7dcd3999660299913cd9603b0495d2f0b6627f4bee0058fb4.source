// 可选模块。它们只对 AIHOT 的 AI 行业版有意义：做其他行业时两项都设为 false。
// 关掉以后：导航里不再出现入口，对应的定时任务不再运行，页面与接口返回 404。
// KPL Intelligence 自有的新模块（赛事数据库、AI 问答）不经过这两个开关，见 packages/backend/src/kb/ 与 qa/。

export const FEATURES = {
  /** 模型榜：汇总公开评测，按公开方法 v17 给出参考位次与 0–100 评分（/leaderboard）。每天抓 4 次评测来源。 */
  leaderboard: false,
  /** Codex 重置监控：盯 OpenAI Codex 负责人在 X 上的额度重置公告（/codex-reset）。需要 SocialData。 */
  codexResetMonitor: false,
} as const;

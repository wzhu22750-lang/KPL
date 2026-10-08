// 首页混合信息流（P4）的配置：总开关与各分桶的配比软目标。
// 配比是软目标：桶位不足时按热度/时间回填，不硬凑（见 publication/homefeed.ts 的 mixFeed）。
// 改动这里不需要迁移，重启 API/Web 生效。
export const HOMEFEED = {
  /** 总开关：false 时 /api/site/homefeed 返回空流，首页回退到原来的时间线。 */
  enabled: true,
  /**
   * 分桶配比（软目标，和为 1）：
   * dispute 争议话题、other 其余精选（赛果/阵容/版本/联盟等）、opinion 评论类（观点/战术）、fun 趣评。
   */
  ratios: { dispute: 0.5, other: 0.2, opinion: 0.15, fun: 0.15 },
} as const;

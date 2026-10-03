// 精选的门槛。评分标准本身写在 prompts/selection-score.md；这里只决定“多少分算入选”。
// 每篇资料由评分模型独立打两次分（0–100），两次之和 ≥ 2 × 门槛、并确认不是精选里已有新闻的重复报道才进精选
// （见 docs/selection.md），卡片上显示两次的平均分。
// 门槛按信源分级区分：官方一手信源的门槛低一些，媒体和个人的高一些。改了门槛或评分提示词，
// 用 scripts/eval-selection.ts 在你自己标注的样本上重跑一遍，再决定上线（见 docs/selection.md）。

export const SELECTION = {
  /**
   * 信源分级 → 入选门槛（平均分）。分级在后台“信源”里给每个源设置：
   *   T1 官方一手（KPL 官网、联盟公告、官方赛事数据）· T1_5 官方账号、俱乐部官微 · T2 媒体与个人。
   * KPL 的一手信源信息密度高（赛果、公告本身就是硬新闻），门槛定得比媒体略低；
   * 这是上线初值，用 scripts/eval-selection.ts 在标注样本上校准后再调（见 docs/selection.md）。
   */
  thresholds: { T1: 58, T1_5: 64, T2: 74 } as Record<string, number>,
  /**
   * 没入选、但平均分高于这个数的资料，也用精选的写法（内容理解：标题、摘要、推荐理由）来写，
   * 其余用更便宜的“标题摘要翻译”。
   */
  understandFloor: 50,
} as const;

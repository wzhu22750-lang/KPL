# 首页混合信息流（P4）

首页（无筛选时）不再是"时间线 + 热榜条带"的简单拼接，而是按分桶配比混排的**热点优先信息流**。
有筛选（channel/category/tag）时保持原来的时间线语义；`/all` 继续用 `/api/site/timeline`（语义不变）。

## 链路

```
素材 → 归组（P2）→ 评分 v2（P3，写 score_components）→ 争议抽取（P3，写 stories.topic_kind）
   → 热榜 latestHotRanking() ─┐
                              ├→ mixFeed（纯函数，加权轮询）→ GET /api/site/homefeed
   → 时间线 queryGroupedAnchors ┘
```

- `GET /api/site/homefeed`（`packages/backend/src/publication/homefeed.ts` 的 `loadHomeFeed`）：
  输入 ① 热榜 entries（storyId/heat/参与者），② 时间线 cards（`loadTimeline` 复用，limit=40，多取再混排）。
- 分桶：`dispute`（story.topic_kind='dispute'）、`fun`（topic_kind='fun'）、`opinion`（category 属评论类，
  由 `industry/taxonomy.ts` 的 `commentary` 标记决定：opinion/tactics）、`other`（其余精选）。
- 配比软目标（`industry/homefeed.ts` 的 `HOMEFEED.ratios`，可配置；总开关 `enabled` 默认 true）：
  dispute 50% / other 20% / opinion 15% / fun 15%。桶位不足时按热度/时间回填，**不硬凑**。
- 去重：同一 story 一屏只出现一次；热榜已覆盖的 story 在时间线部分跳过（按故事 public_id 判重）。
- 游标：`hf1.<base64url>`，负载 `{o: offset, r: rankingId, b: binding}`；与产生它的热榜 ranking 绑定，
  ranking 变化（新一轮榜单）时自动从头开始，避免错位。
- `enabled=false` 时返回空流，首页回退到时间线。

## 状态标识（卡片展示）

每条 `HomeFeedEntry` 携带：

- `topicKind`：`dispute` → 「争议」徽标（hot 色），`fun` → 「趣评」徽标（accent 色）；`general` 不打扰。
- `heat`：热榜条目与上榜故事的时间线卡片展示「N 热度」。
- `coverage`：`known`（有热度观测数据）、`unknown`（已入选但暂无热度观测数据 → 「热度未知」）、
  `pending_review`（未经过编辑精选 → 「待复核」）。复用 `Badge` 组件，不引入新设计语言。

## 今日比赛

- `GET /api/site/kb/schedule?day=today`：北京时间当日的 `scheduled`/`live`/`finished` 比赛，按开赛时间排序；
  今日无比赛（休赛期）时回退最近 5 场（`loadUpcomingAndRecent` 语义），响应带 `day` 与 `fallback: true`。
  旧参数（season/team/upcoming）语义不变。
- 首页 `MatchStrip` 标题改为「今日比赛」；回退时标题旁注明「今日无比赛 · 最近赛事」。

## 关注动态（无账号方案）

- 关注的战队 slugs 只存本浏览器（`local-state.ts` 的 `aihot-follow-teams`，沿用 `/starred` 的 localStorage 思路，
  非法 slug 丢弃、上限 30）。
- `GET /api/site/followed?teams=ag,wolves`：`entity_mentions` 桥联每支战队最近的已列出报道，
  复用时间线卡片形态（`FeedItemSummary`），单队默认 6 条。
- 首页 `FollowStrip`：有本地关注才展示「关注动态」横滑条；无关注时不展示（客户端按需拉取）。

## 验证边界（2026-10-08，本地无 Postgres）

- ✅ 纯函数单测：`tests/homefeed.test.ts`（8 个：配比、去重、桶空回填、游标分页、非法配比、合成数据端到端分类→混排→分页），
  `node --test tests/homefeed.test.ts` 直接跑，不依赖 DB。
- ✅ 本地关注状态：`apps/web/tests/follow-teams.test.ts`（3 个），`node --test apps/web/tests/*.test.ts` 全过（32/32）。
- ✅ `npm run typecheck` 通过；`npm run build -w @aihot/web` 通过。
- ⚠️ DB 相关未执行（本地无 Postgres）：`loadHomeFeed` 的 SQL 路径、`/api/site/homefeed` 与 `/api/site/followed` 的真实响应、
  `?day=today` 的日期边界、`mixFeed` 在真实热榜/时间线数据下的配比表现。DB 测试写好后按 `tests/` 约定标注未执行。
- ⚠️ 未做真实浏览器验证：首页混合流渲染、FollowStrip 横滑、移动端布局（沿用现有响应式结构，理论上可用）。

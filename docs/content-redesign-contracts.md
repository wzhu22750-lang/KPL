# KPL 内容改版实施契约（P2 / P3 共享）

> 2026-10-08。P0 审计结论基础上的实现契约，P2（比赛聚合）与 P3（争议话题与新评分）并行前必须遵守。
> 授权边界：本地实现与验证；不写生产库、不做全量重算、不 push。测试中模型调用保持关闭。

## 0. 迁移编号约定（append-only，不改已发布迁移）

- P1：`0065_source_directory.sql`（sources 加 role/priority_weight/auto_tune/verified_evidence/last_verified_at；新建 source_boosts）
- P2：`0066_match_aggregation.sql`
- P3：`0067_scoring_v2.sql`
- 若 P1 未产出 0065，P2/P3 自行顺延取下一个可用编号，互不覆盖。

## 1. P2 契约：大场 → 小局 → 节点

### 1.1 数据模型（0066）
```sql
-- 状态补齐：scheduled/live/finished/postponed/cancelled
ALTER TABLE matches DROP CONSTRAINT matches_status_check;
ALTER TABLE matches ADD CONSTRAINT matches_status_check
  CHECK (status IN ('scheduled','live','finished','postponed','cancelled'));

-- 新闻 ↔ 比赛硬链接（新闻域与比赛域唯一的桥）
CREATE TABLE match_story_links (
  id         bigserial PRIMARY KEY,
  match_id   text   NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  story_id   bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  game_no    integer,                       -- NULL=整场级；数字=归属小局
  link_type  text NOT NULL DEFAULT 'series' CHECK (link_type IN ('series','game','node')),
  confidence numeric(4,3),
  origin     text NOT NULL DEFAULT 'model' CHECK (origin IN ('model','manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, story_id, game_no)
);
CREATE INDEX match_story_links_match_idx ON match_story_links (match_id);
CREATE INDEX match_story_links_story_idx ON match_story_links (story_id);
```
不改 stories/facts/matches/games 现有列（P3 会给 stories 加 topic_kind，两表不冲突）。

### 1.2 链接器 `packages/backend/src/events/match-link.ts`
- `linkStoryToMatch(db, storyId)`：用 `lib/kpl-dedup.ts` 的指纹（两队 slug + 日期键 + 赛事/阶段）在 matches 表找候选：
  `team_a_id/team_b_id` 双向匹配且 `played_at` 或 `scheduled_at` 落在故事日期 ±1 天（跨午夜比赛按赛事日口径不拆档）。
- 找到唯一候选 → 插入 `match_story_links`（ON CONFLICT DO NOTHING，幂等）；多候选/零候选 → 不写，记日志。
- game_no 归属：story 的 facts 若带局次信息（标题"第一局/第三局"、frame），填 game_no 并 link_type='game'；否则 series。
- 在 `events/group.ts` 的 groupArticle 成功路径后调用（best-effort，失败不阻断归组）。

### 1.3 归组规则调整（最小改动）
- `lib/kpl-dedup.ts` 加 `areSameSeriesDifferentGame(a, b)`：同两队+同日期+同赛事，但局数不同 → 返回 soft 关系 `SAME_SERIES`（新关系，仅用于不触发 `kplOccurrenceConflict` 硬 veto）。
- `events/group.ts`：`SAME_SERIES` 的两篇进同一个 story，但分属不同 fact（按局次），且两篇都走 1.2 的链接器。
- 不动 `SAME_OCCURRENCE` 直通与现有 veto 的其余条件；`match-identity.ts` 的冲突校验保持。

### 1.4 比赛主卡 API
- `GET /api/site/kb/matches/:id/card`（apps/api/src/routes/ 下 kb 相关路由文件）：
  `{ match, games: [...], stories: [{ story, game_no, link_type }], timeline: [...] }`，
  timeline 按事件发生顺序/局次组织，保留发布时间与发现时间。
- 复用 `publication/` 读取层，不要在路由里直写 SQL（遵守 AGENTS.md）。

### 1.5 事件加频挂钩
- 比赛进入 live 时调用 P1 的 `boostSourcesForMatch(db, { teamSlugs:[a,b], reason, minutes })`。
  若 P1 未交付该函数，P2 在 `packages/backend/src/sources/boost.ts` 自行实现同名同签名函数（P1 后续合并时以 P1 为准，P2 版本删除）。
- 挂钩点：`packages/backend/src/sources/esports.ts` 的同步逻辑，或 worker 的定时任务二选一，选改动最小的。

### 1.6 完成标准
- 三场比赛日 → 三张主卡：用合成赛程 + 合成报道跑通 `linkStoryToMatch`（DB 测试；本地无库则纯函数单测 + 明确标注）。
- 必测：重复运行不重复建档；同队不同日期不误合并；未知局次标待确认不误归档；晚到战报不覆盖比分；BO9/延期/取消/跨午夜。

## 2. P3 契约：争议话题与新评分

### 2.1 评分 schema（0067）
```sql
ALTER TABLE analyses ADD COLUMN score_formula_version text NOT NULL DEFAULT 'v1';
ALTER TABLE analyses ADD COLUMN score_components jsonb;  -- {base, official, heat, noise, coverage, reasons}
ALTER TABLE publications ADD COLUMN score_formula_version text NOT NULL DEFAULT 'v1';
ALTER TABLE publications ADD COLUMN score_components jsonb;
```
- `score` 列保留，仍为最终 0–100（clamp 后）。
- 旧数据 `score_formula_version='v1'`，新评分写 `'v2'`；不重算旧分（analyses append-only）。

### 2.2 新公式实现（`packages/backend/src/editorial/analyze.ts`）
- 一次 LLM 调用输出 4 个分量（JSON schema）：`base` 0–70（按内容类型 rubric，见 2.3）、`heat_evidence`（观测到的互动描述，供代码计算，不直接打分）、`noise_flags[]`（扣分依据）。
- 代码层计算：
  - `official` 0–10：按 source 的 tier/owner_type/role 打分，不进模型输入（保持"评分输入不暴露信源"设计）：
    T1 联盟/俱乐部一手公告（赛果/赛程/规则/处罚/人员）+8–10；官方采访/原创 +3–6；普通应援/重复海报/纯商务 +0–2；搬运不继承。
  - `heat` 0–20：读该 article 归属 story 的 `story_signals`（独立参与者数、增长、跨社区），按可复核规则换算；无数据 → coverage='unknown'，heat 按缺失降级排序，不记 0。
  - `noise` 0–30：noise_flags → 规则映射（现有 clean-noise.ts 的硬上限显式化为扣分项，避免双重惩罚）。
  - `final = clamp(base + official + heat - noise, 0, 100)`。
- 两次独立调用：分量分别平均后再合成（保持现有"打两次"的防抖设计）。
- 资格门：KPL 相关性/可用性先行；严重失实/隐私/断章 → 待复核不发布；AI 故障 → 待复核，不伪造分数。
- 阈值：SELECTION thresholds 按 v1 尺度（58/64/74）暂时保留；用 `scripts/eval-selection.ts` 在标注样本上重校准 v2 后再调（P3 交付校准报告，不擅自改线上阈值）。

### 2.3 提示词
- 改 `industry/prompts/selection-score.md`：输出 v2 JSON（base + heat_evidence + noise_flags + reasons），base 按五类 rubric：
  公告/战报（重要性/新信息/时效/赛事影响）、争议/观点（真实分歧/依据/解释力/新回应）、分析/复盘（论证/独特性/参考价值）、趣评/二创（趣味/原创性/圈内语境）、日常/活动（对关注人群的实际价值）。
- 新增 `industry/prompts/dispute-extract.md`：从 story 的 facts/members 抽取争议结构（在争什么/起点与出处/各方立场与依据/当事人回应或"未找到回应"/进展时间线/未确认部分）。

### 2.4 争议话题模型
```sql
ALTER TABLE stories ADD COLUMN topic_kind text NOT NULL DEFAULT 'general'
  CHECK (topic_kind IN ('general','dispute','fun'));
ALTER TABLE stories ADD COLUMN positions jsonb;        -- [{stance, holders, evidence, source}]
ALTER TABLE stories ADD COLUMN dispute_status text;   -- ongoing/responded/clarified/settled
```
- 判定：在 group 完成后跑 `dispute-extract`（best-effort，失败则 topic_kind 保持 general）。
- 前端：story 页展示立场/时间线/回应状态；API 在 story 输出中带 topic_kind/positions/dispute_status。
- 不新增 taxonomy 大类（避免冲击日报分节）；推荐配比（P4 用）读 topic_kind。

### 2.5 新旧对照
- 扩展 `scripts/eval-selection.ts` 或新增 `scripts/eval-scoring-v2.ts`：同一批样本输出 v1/v2 分数与排序差异 + 理由，写进 P3 报告。

## 2.6 P4 契约：首页热点优先（供 P4 阶段使用）

### 数据层 `packages/backend/src/publication/homefeed.ts`（新增）
- `loadHomeFeed({ limit, cursor })`：混合编排，不破坏现有 `/api/site/timeline`（`/all` 继续用它）。
- 输入：① 热榜 `latestHotRanking()` 的 entries（带 storyId/heat）；② 时间线 `queryGroupedAnchors` 的 cards。
- 分桶：dispute（story.topic_kind='dispute'）、fun（topic_kind='fun'）、opinion（category in opinion/tactics）、other（match-result/roster/league/patch 等其余）。
- 配比（软目标，可配置）：dispute 50% / other 20% / opinion 15% / fun 15%；固定比赛入口不计入。
- 去重：同一 story 在一屏只出现一次；热榜已覆盖的 story 在时间线部分跳过。
- 配置：`industry/homefeed.ts` 新增（ratios + 总开关）；默认开启。
- API：新增 `GET /api/site/homefeed`（复用 publication 读取层），contracts 包加 `HomeFeedResponse` 类型。

### 今日比赛
- home.tsx 的 MatchStrip 改为"今日比赛"：优先取北京时间今日的 matches（scheduled/live/finished），无今日比赛时回退到最近 5 场。API 侧给 `/api/site/kb/schedule` 加 `?day=today` 参数（可选）。

### 关注动态（无账号方案）
- 沿用 `/starred` 的 localStorage 思路：`lib/local-state.ts` 加关注的战队 slugs。
- 新增 `GET /api/site/followed?teams=ag,wolves`：按战队返回最新 cards（复用 timeline 查询加 team 过滤）。
- 首页新增 `FollowStrip` 组件：有本地关注时展示"关注动态"横滑条；无关注时不展示（不打扰）。

### 展示与状态
- 卡片展示 topic_kind（争议/趣评徽标）、heat、coverage 状态（未知/待复核/无热度数据有明确标识与操作出口）。
- 移动端保持可用（沿用现有响应式结构）。

## 3. 共同遵守

- 迁移 append-only；public API 只增不改（旧字段保留）。
- 测试放 `kpl-intelligence/tests/`，沿用 `tests/databases.ts`/`setup.ts` 约定；本地无 Postgres 时纯函数单测照跑，DB 测试写好并标注未执行。
- `npm run typecheck` 必须过。
- 文档：P2 更新 `docs/grouping.md`（或新增小节），P3 更新 `docs/selection.md`；都写明版本号与未验证范围。
- 不 commit、不 push；完工后交报告（文件清单/测试结果/未验证项）。

# 内容改版迁移、试运行与回滚说明（P5）

> 对应改版：P1 信源目录与调度、P2 比赛聚合、P3 新评分与争议话题、P4 首页热点优先。
> 实施契约见 `docs/content-redesign-contracts.md`，验收报告见仓库根 `docs/content-redesign-acceptance.md`。

## 1. 新增迁移（按顺序执行，幂等）

| 编号 | 文件 | 内容 |
|---|---|---|
| 0065 | `database/migrations/0065_source_directory.sql` | `sources` 加列 `role` / `priority_weight` / `auto_tune` / `verified_evidence` / `last_verified_at`；新建 `source_boosts` 表（事件加频） |
| 0066 | `database/migrations/0066_match_aggregation.sql` | `matches.status` 增加 `postponed`；新建 `match_story_links` 表（新闻↔比赛硬链接） |
| 0067 | `database/migrations/0067_scoring_v2.sql` | `analyses` / `publications` 加 `score_formula_version`（默认 `'v1'`）+ `score_components` jsonb；`stories` 加 `topic_kind` / `positions` / `dispute_status` |

应用（staging/生产）：

```bash
node --env-file=.env scripts/migrate.ts
```

迁移本身全部 `IF NOT EXISTS` / 条件式，可重复跑。之后重跑信源种子，把 role/权重/验证证据写入 DB：

```bash
node --env-file=.env scripts/seed.ts   # ON CONFLICT 覆盖同 id 行，只动 sources 表
```

## 2. 兼容性说明

- **旧数据可读**：所有新增列都有默认值；旧评分 `score_formula_version='v1'`，`score` 列语义不变；`matches.status` 旧值不受影响。
- **旧 API 不变**：`/api/site/timeline`、`/api/site/kb/schedule`（无参）语义不变；新增的只是 `/api/site/homefeed`、`/api/site/followed`、`?day=today`、`matches/:id/card`。
- **v1/v2 评分并存**：`analyses` append-only，新评分写 `v2`，旧行不重算。`SELECTION` 阈值（58/64/74）未动——v2 阈值需用 `scripts/eval-scoring-v2.ts` 在标注样本上校准后再调，**上线前不要直接套用旧阈值到 v2**。

## 3. 试运行建议（默认 dry-run / 小样本）

1. 先在 staging 库跑迁移 + 种子，确认三张表/列就位。
2. 开 `COLLECT_ENABLED=true` 跑一个比赛日，观察：
   - `source_boosts` 是否在比赛 live 时产生（查表）；
   - `match_story_links` 是否生成（赛后报道应挂到主卡）；
   - `stories.topic_kind` 是否出现 dispute/fun。
3. 首页开 `industry/homefeed.ts` 的 `HOMEFEED.enabled`（默认 true；想对比旧版可先设 false）。
4. 跑 `scripts/eval-scoring-v2.ts`（需 `MODEL_CALLS_ENABLED=true` + 真实模型），看 v1/v2 排序差异是否符合预期，再决定 v2 阈值。
5. 观察两个比赛周后再评估流量效果；**不要**在上线前宣称增长效果。

## 4. 回滚

`scripts/migrate.ts` 不支持 down 迁移。按仓库约定（AGENTS.md），回滚用**前向新迁移**或下面的手动 SQL（生产执行前先在 staging 验证）：

```sql
-- 回滚 0067（评分 v2 与争议话题列）
ALTER TABLE stories DROP COLUMN IF EXISTS dispute_status;
ALTER TABLE stories DROP COLUMN IF EXISTS positions;
ALTER TABLE stories DROP COLUMN IF EXISTS topic_kind;
ALTER TABLE publications DROP COLUMN IF EXISTS score_components;
ALTER TABLE publications DROP COLUMN IF EXISTS score_formula_version;
ALTER TABLE analyses DROP COLUMN IF EXISTS score_components;
ALTER TABLE analyses DROP COLUMN IF EXISTS score_formula_version;

-- 回滚 0066（比赛聚合）
DROP TABLE IF EXISTS match_story_links;
-- status 约束回退（确认无 postponed 行后再执行）：
-- ALTER TABLE matches DROP CONSTRAINT matches_status_check;
-- ALTER TABLE matches ADD CONSTRAINT matches_status_check
--   CHECK (status IN ('scheduled','live','finished','cancelled'));

-- 回滚 0065（信源目录）
DROP TABLE IF EXISTS source_boosts;
ALTER TABLE sources DROP COLUMN IF EXISTS last_verified_at;
ALTER TABLE sources DROP COLUMN IF EXISTS verified_evidence;
ALTER TABLE sources DROP COLUMN IF EXISTS auto_tune;
ALTER TABLE sources DROP COLUMN IF EXISTS priority_weight;
ALTER TABLE sources DROP COLUMN IF EXISTS role;
```

代码回滚：本分支整体 revert 即可（见验收报告的文件清单）。注意 `industry/prompts/selection-score.md` 已被 v2 重写，旧版保留在 `selection-score-v1.md`，回滚代码后把 v1 内容拷回即可。

**破坏性说明**：以上回滚只删新增的列/表，不动旧数据。`match_story_links` 删除后比赛主卡的"相关报道"区为空，属预期降级。

## 5. 所需配置（无新增必填项）

- 无新增必填环境变量。`HOMEFEED.enabled` 默认 true；想先跑旧首页，设为 false。
- 公众号源已在 `sources.json` 标记 `"auto_tune": false`，种子重跑后生效；如需恢复自动调频，在后台把对应源的 auto_tune 打开。
- 微博加频幅度：`sources/collect.ts` 的 boost 生效间隔（当前 10 分钟），比赛 live 持续时长由 `esports.ts` 调用参数控制（当前 240 分钟）。

# KPL 信源、比赛聚合与热点评分改版验收报告（P5）

> 执行日期 2026-10-08。分支 `luna/content-redesign`（基于 main b458202）。
> 实施契约：`docs/content-redesign-contracts.md`；迁移/回滚：`kpl-intelligence/docs/content-redesign-migration.md`。
> 说明：`docs/content-source-redesign-plan.md` 在仓库中不存在，实施以本提示词 + 交接文档 + 技术方案 + DATA_STRATEGY 为准。

## 1. 已实现能力及对应文件

**P1 信源与获取策略**
- 信源目录扩展：`sources` 表加 `role`（联盟官方/俱乐部官方/当事人/主播/媒体/社区）、`priority_weight`、`auto_tune`、`verified_evidence`、`last_verified_at` —— `database/migrations/0065_source_directory.sql`、`industry/sources.json`（32 源全标 role，公众号标 `auto_tune:false`，微博标权重 10）、`scripts/seed.ts`（从 `team-accounts.json` 回填验证证据）。
- 调度优先级：`packages/backend/src/sources/collect.ts` 的 `scheduleDueSources` 改为权重+tier+到期时间排序；事件加频表 `source_boosts` + `getActiveBoosts` + `boostSourcesForMatch`。
- `adaptIntervals` 跳过 `auto_tune=false` 的源（公众号降频不再被自动调频覆盖）。
- 管理后台：`packages/backend/src/admin/sources.ts`、`packages/contracts/src/admin.ts`、web `routes/admin/sources.tsx` / `source.tsx` / `features/admin/labels.ts`。

**P2 大场→小局→节点聚合**
- `matches.status` 补 `postponed`；新建 `match_story_links`（新闻↔比赛硬链接）—— `0066_match_aggregation.sql`。
- `packages/backend/src/events/match-link.ts`：`linkStoryToMatch`（指纹找唯一候选，幂等；未知局次只链整场）。
- `packages/backend/src/lib/kpl-dedup.ts` + `events/group.ts` + `events/match-identity.ts`：同系列不同局判 `SAME_SERIES`，同 story 按局次分 fact，不再硬 veto 拆散。
- 比赛主卡 API：`GET /api/site/kb/matches/:id/card`（`apps/api/src/routes/site.ts`、`packages/backend/src/kb/read.ts` 的 `loadMatchCard`、`packages/contracts/src/kpl.ts`）。
- 比赛进 live 自动 `boostSourcesForMatch`（`sources/esports.ts`，两队 weibo 源 240 分钟加频）。

**P3 争议话题与新评分**
- v2 公式：`final = clamp(base 0–70 + official 0–10 + heat 0–20 − noise 0–30)` —— `packages/backend/src/editorial/scoring-v2.ts`（纯函数）、`editorial/analyze.ts`（两次调用分量平均合成）、`editorial/score-refresh.ts`（归组后按 story_signals 刷新 heat）。
- official 走代码规则表（信源身份不进模型输入）；heat 缺失记 `coverage='unknown'` 不当 0；noise 旗标映射去重避免双罚；资格门/待复核按规范。
- 版本化：`analyses`/`publications` 加 `score_formula_version` + `score_components`（`0067`）；旧分保持 v1 不重算；阈值未动，待 `scripts/eval-scoring-v2.ts` 校准。
- 争议话题：`stories` 加 `topic_kind`/`positions`/`dispute_status`；`events/dispute.ts`（best-effort 抽取）；`industry/prompts/dispute-extract.md`；`selection-score.md` 重写为 v2（旧版归档 `selection-score-v1.md`）；story 页争议面板（`apps/web/app/routes/story.tsx`、`publication/stories.ts`）。

**P4 首页热点优先**
- `packages/backend/src/publication/homefeed.ts`：`loadHomeFeed`（热榜+时间线按 dispute 50%/other 20%/opinion 15%/fun 15% 软配比混排，去重、桶空回填、游标分页）；`industry/homefeed.ts` 配置（总开关默认开）。
- `GET /api/site/homefeed`、`GET /api/site/followed?teams=`（本地关注战队的动态聚合，无账号体系，沿用 localStorage 方案）、`/api/site/kb/schedule?day=today`（今日比赛）。
- 首页：`apps/web/app/routes/home.tsx`（无筛选走 homefeed；MatchStrip 改"今日比赛"；TeamStrip 加关注按钮）、新增 `features/feed/HomeFeed.tsx`、`features/feed/FollowStrip.tsx`；删除被取代的 `HotTopics.tsx`。
- `/api/site/timeline`（`/all` 用）语义未动。

## 2. 六组信源 / 各平台接通情况

| 组 | 平台现状 |
|---|---|
| 联盟/赛事官方 | ✅ 微博（官微实测 902 万粉，访客接口本机调通）、B站（接口存在，本机 IP 被 -412 风控，生产换网可试）、公众号（Dajiala 直连 4 条稳定） |
| 俱乐部官方 | ✅ 微博 9 队已配；公众号 9 条走 `wechat://` 桥接（稳定性弱于直连，已文档标注） |
| 选手/教练当事人 | ⚠️ 微博个人号 0 条配置（SOURCE_CANDIDATES 跟踪中）；本次只建了 role 字段与目录结构 |
| 主播/解说 | ⚠️ 同上，目录结构就绪，首批核验名单待补充 |
| 媒体/优质创作者 | ✅ 公众号+RSS 混合已有多条 |
| 社区/粉丝 | ⚠️ 虎扑 1 条（HTML 抓取较脆弱）；微博超话 2 个（AG/狼队）；小红书/抖音 ❌ 无适配器 |

证据：2026-10-08 本机 curl 实测（微博 200 ok=1；B站 -412 系本机出口 IP 封禁）。采集器走访客 Cookie 自动协商，无账号密码。

## 3. 比赛聚合与争议话题端到端示例（合成数据）

- 三场比赛日 → 三张主卡：`linkStoryToMatch` 对合成赛程+合成报道可解析出唯一候选并写入 `match_story_links`（DB 测试已写，本地无库未执行；纯函数部分 8/8 通过）。
- 同系列不同局：两篇"AG 1:0 拿下首局""LGD 第三局获胜"判 `SAME_SERIES`，同 story 按局次分 fact；未知局次只链整场不误归档。
- 争议话题：`dispute-extract` 对 story 的 facts 抽取在争什么/各方立场与依据/当事人回应（无则明示未找到）/进展时间线/未确认部分，写入 `positions`；story 页展示立场与回应状态徽标。

## 4. 新评分各分项及新旧排序对照

- 分项：base（内容类型 rubric，LLM 输出 0–70）+ official（代码规则表 0–10）+ heat（story_signals 换算 0–20，缺失标 unknown）+ noise（旗标映射 0–30）→ clamp 0–100。各分项、理由、规则版本、覆盖情况存 `score_components`。
- 新旧对照工具：`scripts/eval-scoring-v2.ts`（需真实模型手动跑，输出 `.data/eval/scoring-v2-*.md`）。v2 阈值尚未校准，线上阈值保持 v1 的 58/64/74。

## 5. 测试命令、结果与未验证范围

| 命令 | 结果 |
|---|---|
| `npm run typecheck`（contracts/backend/api/worker/tests/web） | ✅ 通过 |
| `node --test tests/homefeed.test.ts` | ✅ 8/8 |
| `node --test tests/match-aggregation.test.ts` | ✅ 8/8（纯函数；DB 部分自动跳过并标注） |
| `node --test tests/scoring-v2.test.ts` | ✅ 10/10 |
| `node --test tests/kpl-dedup.test.ts` | ✅ 9/9（回归） |
| `node --test apps/web/tests/*.test.ts` | ✅ 32/32（含 follow-teams 3 个） |
| `npm run build -w @aihot/web` | ✅ 通过 |
| `git diff --check` | 待 push 前执行 |

**未验证范围**（本地无 Postgres/Docker，DB 相关测试均已写好待有库环境跑）：
1. 迁移 0065–0067 未在任何库上实际执行（语句已目检，IF NOT EXISTS 幂等）。
2. `loadHomeFeed` / `loadMatchCard` / `linkStoryToMatch` 的 SQL 路径与 API 真实响应形状。
3. `?day=today` 的北京时间日期边界、休赛期回退。
4. v2 提示词实际打分效果与阈值校准（需真实模型）。
5. 真实浏览器渲染（首页混合流、FollowStrip、移动端）。
6. B站 series 接口成功路径（本机 IP 被风控）。

## 6. 迁移、试运行、回滚及所需配置

见 `kpl-intelligence/docs/content-redesign-migration.md`。要点：迁移幂等、旧数据可读、旧 API 不变、v1/v2 分数并存；回滚用前向 SQL（文档内附）；无新增必填环境变量；试运行建议先 staging 跑一个比赛日再开首页。

## 7. 阻塞和后续建议（未列成已完成）

1. **DB 验证缺口**：找一台有 Postgres 的机器（或用户本地）跑 `DATABASE_URL=..._test npm test`，执行全部 DB 测试与三个迁移。
2. **v2 阈值校准**：用 `scripts/eval-scoring-v2.ts` 在人工标注样本上跑，定 v2 的 T1/T1_5/T2 阈值后再上线。
3. **信源名单补齐**：选手/主播的微博首批核验名单（SOURCE_CANDIDATES.md 有跟踪队列）；小红书/抖音适配器未实现。
4. **流量观察**：上线后观察两个比赛周再评估效果；实现完成 ≠ 增长保证。
5. 必测案例 §8 的 12 项中，第 1–5、12 项的 DB 部分与第 9 项的真实模型注入测试待有库/有模型环境补测；其余已覆盖。

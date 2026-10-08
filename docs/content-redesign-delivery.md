# 内容改版研发交付与验收

> **交付的是已实现、离线集成验证的链路，不是已经上线的产品。** `industry/radar.ts`默认`enabled=false`：评分门槛、各类型权重、平台热度饱和值和展示配比都是待校准的试验配置。尚未执行生产迁移、部署、push 或历史全量重算。初始研发验收未调用真实付费模型；用户随后批准了无公众号的真实本地试跑，结果、实测修复与最新回归见[本地试跑记录](content-redesign-local-trial.md)。

## 已实现什么

| 范围 | 实现 | 验证/边界 |
|---|---|---|
| P0审计 | 旧源、评分、事实身份与社区绕行审计 | [审计报告](content-redesign-p0-audit.md) |
| P1信源 | 微博优先、公众号每日固定策略、显式配置应用、个人观点账号首批4个 | 不覆盖管理员身份/启停；[能力目录](content-redesign-source-capabilities.md)明确覆盖缺口 |
| P1观测 | 独立互动快照，未知与零分开，正文hash短路前入库，保留30天和最后观测 | 不增加revision，不重复买模型判断；部分采集失败保留内容但不推进健康时钟 |
| P2比赛 | 独立大场投影，队伍/日期/赛事/唯一赛程匹配，小局、MVP/操作材料在大场展开 | 不放宽旧facts的小局隔离；身份模糊或局数超BO留待确认 |
| P2时序 | BO1/3/5/7/9；延期状态；比分观测时间顺序保护 | 新的更正允许下调比分；赛事接口只映射已知状态，不臆测官方延期编码 |
| P3话题 | 社区`hot_signal`可独立生成话题，立场、原文依据、比赛背景和实质进展 | 点赞变化不刷新“新进展”；已有主题目录参与保守归并，不凭同队合并所有争议 |
| P3/P4评分 | 内容类型、五维判断、安全与去噪、官方奖励、真实热度增量和配比 | 基础最多70、官方最多10、热度最多20；官方广告不因身份霸榜；分类不等于事实核实 |
| P4页面 | 首页“圈里在聊什么”、一场一档、动态/趣评；比赛详情时间线；评分与计数展开 | 前端只经HTTP，读时不调用模型；分类/频道筛选保留旧读取逻辑 |
| P4去重 | 精选只排除当前雷达实际展示的素材ID | 避免日期下界误排未来内容，未展示素材仍可进入旧精选；同局多来源折叠保留原文 |
| P5工具 | 源策略dry-run、新账号只插不改、有限重评、版本失效、开关回退 | 每次重评最多100条；不启动全量历史回算 |

材料 → 独立观测/统一素材入口 → worker单次类型判断 → 独立雷达投影 → public读取层 → 首页/比赛页。旧分析、事实、publication与hot-ranking链路保留；这是增量投影，不是把小局事实强行合并成大场，也没有声称日报/RSS/公开MCP全部切换到新评分。

### 核心文件

- `kpl-intelligence/database/migrations/0065_engagement_observations.sql`：独立互动观测。
- `0066_content_radar.sql`：话题、材料判断、失败记录；判断关联模型回执。
- `0067_match_observation_order.sql`：比分观测时间与延期状态。
- `industry/collection.ts`、`sources/collection-policy.ts`：固定策略和局部配置应用。
- `editorial/radar.ts`、`radar-score.ts`、`industry/prompts/radar-judge.md`：正文提取、原文引用逐字核验、类型评分、版本与幂等。
- `events/radar-match.ts`：比赛身份匹配，不改旧`match-identity`与facts隔离。
- `publication/radar.ts`、`publication/timeline.ts`：公开权限、当期版本/正文revision/撤稿过滤、当前展示集合去重。
- `apps/web/app/features/feed/ContentRadar.tsx`：话题和大场折叠、官方小局赛况/MVP、评分解释。

## 怎样在受控环境应用

以下命令在`kpl-intelligence/`执行，先明确目标`DATABASE_URL`。**生产应用需要管理员批准和备份；本次未替用户执行。** 不要为了改频率直接运行`seed.ts`，其UPSERT会覆盖现有管理员字段。

```bash
# 查看帮助，无数据库写入
node scripts/apply-source-policy.ts --help
node scripts/install-radar-sources.ts --help
node scripts/review-radar.ts --help

# 预览既有源的频率差异；保存before/after作为恢复依据
node scripts/apply-source-policy.ts > source-policy-preview.json
# 批准后，仅更新频率、collectionPolicy、next_fetch_at
node scripts/apply-source-policy.ts --apply > source-policy-applied.json

# 只插入本次核验的Gemini/李九/天云/英凯，已存在则不修改
node scripts/install-radar-sources.ts
node scripts/install-radar-sources.ts --apply

# 默认只读配置报告。公开探测须显式允许采集，不写库
node scripts/probe-weibo.ts --source weibo-gemini
COLLECT_ENABLED=true MODEL_CALLS_ENABLED=false node scripts/probe-weibo.ts --source weibo-gemini --live

# 列出最多20个最近未评估/失败/版本过期素材，不调用模型
node scripts/review-radar.ts --limit 20 > radar-review-before.json
```

迁移使用项目原有`node scripts/migrate.ts`，增量编号0065–0067；不能改写已经发布的0064及以前迁移。先迁移，再启动新版本API/worker/web。开关关闭时，新API返回503，首页/比赛详情走旧页面；新互动观测和信源固定策略仍可单独使用。

要启动模型试运行：先在标注集上校准`industry/radar.ts`并确认预算，设置`enabled=true`，重新启动进程，才运行`node scripts/review-radar.ts --limit 20 --apply`。该脚本只排队；消费任务才经既有回执/预算服务调用模型，仍受`MODEL_CALLS_ENABLED`安全阀约束。每个新正文revision或新判断版本最多买一次正常判断；纯互动刷新复用判断。失败最多重试3次，不能把技术失败当成不相关内容。

修改提示词/判断规则需同时升级`RADAR.version`。旧判断版本不会在新公开雷达展示；重评脚本会列出过期项并输出旧版本/状态/基础/官方/噪声分，保存应用前后日志比较。没有自动触碰历史全文或批量改revision。观察增长仅比较同平台完整计数快照，缺失保留未知，不凭平台名奖励热度。

## 怎样回退

1. `RADAR.enabled=false`并重启API/worker/web，停止新雷达判断消费和页面使用；旧精选/热点/比赛页继续读取旧链路。待处理雷达任务不意味着可以删旧素材、facts或回执。
2. 先以`source-policy-applied.json`核对当前值与`after`；只在管理员字段没有另行修改时恢复对应`before.intervalMinutes`、`before.collectionPolicy`与`before.nextFetchAt`。不整块覆盖`config`，避免抹掉新凭据/配置。源调度可能已经推进，不要盲目重放旧下一次采集时间。
3. 新个人账号可在后台停用，不删除来源关联素材/观测。移除数据库投影或列需要新的迁移和明确数据删除批准；不能直接回写旧迁移。0067回退还需先处理已存的`postponed`状态，不能直接收紧约束。
4. 保留本次回执、失败和观测作审计依据；恢复旧代码前确认其不写未知状态。未实现自动生产回滚执行器。

## 验收证据

证据目录：[audit-artifacts/content-redesign-final](audit-artifacts/content-redesign-final/)。所有模型集成测试使用本地假provider，不代表真实模型准确率。

| 门禁 | 最终结果 |
|---|---|
| 主站全量 | 759项，705通过，0失败，54跳过；跳过项不计作已验证 |
| 新功能与相关定向 | 43项通过；含3个大场、不同小局/MVP/未知局次、社区独立争议、纯热度刷新、原文依据检查、乱序/更正/延期、源策略与长列表队列 |
| Typecheck | contracts/backend/API/worker/tests/web通过 |
| Web build | 通过 |
| Web tests | 29通过 |
| 根目录Python | `uv run --offline pytest tests_py -q`，88通过（与主站评分链路独立；不采集reference-projects的测试） |
| UI | 本地合成样本390px/1280px，折叠展开和未知热度，无横向溢出；不是已部署主页截图 |

初始16项基线失败为环境变量模板同步、readpath detail原文、14项X授权断言；HEAD导出副本也复现，日志`baseline-failures.txt`和`baseline-readpath.txt`。用户要求继续修复后：①两份环境模板补齐Web服务读取的PORT；②普通公开页的readingMode与来源全文许可分离，保留原有正文/译文/引用/媒体授权和人工summary-only/撤稿边界；③性能样本明确声明全文许可和正文ok状态，而不是去掉线上body_status校验。新增旧全文快照不得覆盖unconfirmed正文状态的回归断言。定向授权/架构回归40通过、1跳过，最终主站0失败。

中间3个长列表队列测试因新增独立队列而失败，已分别断言旧处理与雷达队列各自幂等，最终复跑通过。版本失效检查也经SQL实际列名/typecheck修正后重新完整回归。临时基线/工作树测试不能用同一数据库名并行运行：全局清理会删除另一组测试克隆；最终回归使用单一测试运行。

集成样本：AG–LGD第1/3局及九尾操作归同大场，小局不相互覆盖；KSG–TES、WB–EDG.M是独立比赛；争议社区观点先生成主题，官方回应补入；点赞增长既不买新模型判断也不刷新实质进展；模型无依据引文和隐私素材留复核；正文revision改变后旧判断不可见。BO9、比分回退更正、过期观测和延期有本地数据库断言。

## 尚不能宣称完成的上线验收

- 真实模型精度、安全/幻觉率、用用户标注的holdout校准门槛与配比；未花费真实模型预算。
- 完整参赛队、选手/二路/解说目录，真实超话/评论楼中楼、小红书/抖音稳定采集；详见能力目录。
- 赛事触发加频、官方更正与MVP纠错的端到端真实源样本、完整赛季归并误判率。比分使用请求起点顺序，不能检测官方上游“较新请求返回缓存旧数据”的所有情况。
- 首页流量/点击率、重复率、话题立场覆盖与真实p95性能；视觉验收仅覆盖合成组件样本。
- 日报、RSS等旧出口迁移到新推荐体系、生产迁移与部署、历史全量重算。

以上未验证范围是明确的发布门禁/覆盖缺口，不以“整个任务完成”代替线上证据。

# KPL Intelligence 社区化审计与增量优化交付

## 1. 结论与真实审计

**这是代码级第一轮交付，不是已经上线的完整社区热点产品。** 实际修改位于 `kpl-intelligence/`；保留原有 sources → candidates/materials → articles → extraction → analysis/radar → publications/facts/stories → API/web 架构，未重建采集系统、未删除历史、未改电竞资料库或 RAG 存量。

发现并修复的关键断点：

| 原问题 | 本轮处理 |
|---|---|
| 虎扑采集到的楼层数被当作平台总评论数，完整性过度声明 | 独立 `totalReplies`、`fetchedReplies`、coverage/cursor；缺失为 null |
| 虎扑真实 Next.js 数据未被稳定识别，引用可能误作楼层正文 | 适配实测 `detail.thread/detail.replies.list`，线程绑定、独立引用/作者/媒体解析 |
| 微博跨轮恢复未使用持久断点，可能跳过 backlog | stable/pending 水印、恢复游标、重复 token 和非法 API envelope 的保守处理 |
| 关键词搜索被表述为超话 | 更正来源语义；未伪造超话接口 |
| 正文身份混入互动/评论，或新评论被旧判断背书 | 主体身份与讨论证据 hash 分离，判断绑定 revision/version/evidence |
| 互动没有形成稳定观察序列 | 追加 engagement observations，未知不补旧值，不把累计快照相加 |
| hot_signal 无详情，社区评论跨类型呈现不一致 | 受控详情准入、共用反馈组件、明确真实评论与 AI 摘要 |
| 整活/二创等按词机械排除 | 移除相应泛化过滤；保留明确广告/刷量交易等判断 |

旧 `social-analyzer.ts` 的权威性启发式仍是兼容模块，不是新讨论热度算法。事实流的来源可靠性与社区讨论热度没有强行合并。

## 2. 已实施内容与路径

- `packages/backend/src/content/extractors/hupu.ts`：真实结构、DOM/受限后备、线程身份、OP/补充/楼层/引用、安全媒体、覆盖声明。
- `content/community-comments.ts`：微博/B站真实评论形态、稳定 ID/父子关系、点赞、去重、限量递归；配置化接口、HTTPS/精确 host/守卫传输；错误不能伪装成空评论。
- `content/community-refresh.ts`、`jobs/community.ts`、worker：持久刷新与断点，来源/全局阀门，串行评论任务、请求/页数/评论数限制、冷热冷却。巡检每 **10 分钟**，按来源预算选择文章；优先 accepted，其次最新已观察评论数，未知排后。列表不再绕过预算逐条入队。
- `content/materials.ts`、`canonical.ts`、`engagement.ts`：重放去重与旧 hash 兼容、计数快照、证据身份，计数变化不制造文章修订或重跑正文分析。
- `editorial/radar.ts`、`publication/{rules,detail,items,radar}.ts`：新证据重判；旧证据撤出雷达公开面。**任何 collection-bearing 讨论均需匹配当前审核才展示评论**，包括 editorial 虎扑。未审核时 OP 保留，正文及 Markdown 不泄露被扁平化的评论；许可不足仍只显示许可摘要。
- `apps/web/app/features/item/CommunityFeedback.tsx` 及三种内容组件：来源链接、时间、点赞、父层/引用、采集范围、未知与待审核状态；真实评论与 AI 提炼分区。
- `ContentRadar.tsx`：社区材料呈现和平台筛选，重要事实另行保留；原 facts/stories 聚合与电竞导航保持。

回复选择是有限样本的点赞/内容/作者多样性启发式，**没有实现经验证的观点立场聚类**。本轮也没有新建完整的多平台事件合并模型。

## 3. 平台实测、权限与失败边界

详见 [平台验证](community-platform-verification.md)、[评论接口验证](community-comment-entry-verification.md)。其中“当日内容”是新鲜度线索，不能单凭它保证 Jina 无缓存；一次 HTTP 200 不证明长期稳定性或平台许可。

| 平台 | 实测与落地 | 未完成/阻断 |
|---|---|---|
| 虎扑 | `/kog-postdate` 与 `/kog-hot`；帖子 `642828440` 的原始 HTML；新增热点发现来源；离线真实结构及原捕获字节验证 | 高频生产稳定性、复杂媒体跨正文位置还需更多样本；不会宣称分页采样覆盖全站 |
| B站 | 搜索 pubdate/totalrank、View API 与有评/零评 Reply API 的一次公开 HTTP 200；保留实际 aid，禁止拿播放量作 ID | totalrank 是平台综合排序，不保证纯讨论排序；作者自身基线异常爆发、长期接口稳定性未验证。新增 hot 来源保持禁用 |
| 微博 | 现有关键词容器适配器一次访客协议探针成功；游标改进；评论解析具备离线覆盖 | 无 Cookie hotflow 返回 302 访客墙，记为不可用而非零评论；超话/话题榜和真实评论生产闭环未打通；不新增绕墙机制 |

没有伪造评论、点赞或观看量，没有把 mock 标为 live。平台成功记录属于本次样本，不是持续可用性承诺。现有微博访客握手是原有代码；本轮未证明它构成平台许可。

## 4. 讨论热度算法与现网区别

`industry/discussion-heat.ts` + `editorial/discussion-heat.ts` 是 **离线实验算法，未接入生产排序**：

1. 平台分别配置指标基线，用 log1p 缩放，或使用外部提供、且有真实依据的分位数；缺失指标不造零。
2. 用相同平台、相同指标、有效时间间隔的快照比较增长；计数下降不作正增长，不能跨平台相减或累加累计数。
3. 按年龄衰减，结合讨论量、增长、评论社区价值、噪声/相关性/质量/安全信息，输出明细与 review/reject 状态。
4. 不给官方或大账号额外权威加分；事实可信度保留在原事实准入路径。

实验默认因子权重 H/G/V/Q/R = **0.35/0.25/0.15/0.15/0.10**；缺失的 G/V 移出分母。总分 = 可用因子加权平均 × `(0.4 + 0.6×confidence/100)`，其中 H 已含时间衰减。默认半衰期 24h、最大年龄 168h、衰减地板 0.10，准入阈值 45、上线需至少 200 个留出样本；这些都是实验配置，不是实测定律。Q/R 缺省策略仍需改进，公开准入不能依赖该离线分数替代当前证据审核。

现网 radar 本轮只修正了可比较指标的增长处理；仍沿用原评分体系。离线算法的基线、质量因子缺省策略、衰减地板与阈值尚未完成真实标注校准，不能直接作为上线标准。只有一张快照时，增长未知；有计数但无有效评论时，社区价值未知。

`industry/discussion-heat-gold.example.jsonl` 与根目录 `reports/discussion-heat-eval.md` **全部是明确标注的 synthetic 控制样例**，不是人工标注真实金标，也不是留出集成绩。真实校准应分平台收集低/中/高热与广告、谣言、辱骂、短梗等样本，固定留出集，评价 Precision@K、NDCG、审核误放率、未知指标覆盖和排名稳定性，再决定是否切换。

## 5. 数据迁移与开启方案

新增迁移：

- `0068_community_collection_runs.sql`：尝试时间、请求数/耗时、采样条数、平台总数、失败/断点。
- `0069_radar_evidence_hash.sql`：审核输入证据绑定；旧记录保持 null，必须重新审核，不能回填伪证据。

没有删除原表/历史、没有自动回写历史内容修订。运行日志里的 fetched 总和仅代表多次采样工作量，不代表去重后的评论总数。

**未执行生产迁移、部署、push 或生产数据库修改。** 上线前备份并在 staging 按现有 `npm run db:migrate` 执行，核验存量官方发布、社区待审、全文撤权、Markdown 和历史去重。

默认 `COMMUNITY_COLLECTION_ENABLED=false`、`COMMUNITY_PUBLICATION_ENABLED=false`。还需要 `COLLECT_ENABLED`、来源 `enabled`、非 isolated、`communityComments.enabled` 及许可。`industry/radar.ts` 的 `RADAR.enabled` 原本也是 false，本轮没有擅自开启。

授权 staging 的来源配置示例（不是已应用的生产配置）：

```json
{"communityComments":{"enabled":true,"maxPostsPerRun":3,"maxPages":2,"maxComments":40,"hotRefreshMinutes":30,"normalRefreshMinutes":120}}
```

B站还需已验证的 `endpointTemplate`（`https://api.bilibili.com/x/v2/reply?type=1&oid={aid}&sort=2&pn={pn}&ps={ps}`）；微博没有已获准的可用入口，不应照抄一个“假定可用”的配置。逐源小预算开启，再审核、观测、开放展示。关闭阀门即可停止新增社区采集/公开详情，不需要删除历史。

## 6. 测试与证据

最终执行结果记录于 `tmp/community-*-final.log`：

- 后端全量隔离 PostgreSQL 测试：**920 项，865 passed / 0 failed / 55 skipped**。跳过包含现有非本行业测试和默认关闭的原捕获验证；不等于 920 项全部执行。新增调度回归验证：抽正文前按最新真实观察数选 800 回复而非 50 回复，旧 9999/最新未知不得复活，并守住来源单帖预算。
- 全仓 `npm run typecheck`：通过；Web production build：通过；`node --test apps/web/tests/*.test.ts`：**44/44 通过**。
- `HUPU_CAPTURE_VERIFY=true node --test tests/hupu-live-shape.test.ts`：5/5，包括 `/tmp/hupu-642828440.html` 原捕获字节；这是捕获重放，不是本次新联网探测。
- 社区回归覆盖身份/重放、引用证据、计数不重修订、微博断点/非法响应、楼层去重、B站零评/真实 aid、默认守卫传输本地替身、全局开关/source isolation、待审评论正文/导出不泄露、旧审核拒绝、许可矩阵与来源预算。
- `git diff --check`。

浏览器检查详见根目录 [UI 验证](../../docs/community-ui-verification.md)，截图 `output/playwright/community/`。采用真实组件 + synthetic 本地 harness，桌面 1440×900 / 移动 390×844，**不是完整生产 API 页面验收**；浏览器与 harness 已显式关闭。最后新增的待审核提示文字只有类型/构建验证，没有重新截图。

补充：Web workspace 没有 `npm test` 脚本；尝试该命令返回 Missing script，不能计为通过。实际执行的是上面的显式 web tests 命令。没有执行真实付费模型或生产评论流量压力测试。

原捕获 SHA-256：

- Hupu HTML：`64f674a62894e2de47b2b6491923a445304560a5eea9ba129cf9b7ed7fc1af34`
- B站 View：`128ac8f28bc8be8fcfacd0912917a4b5df72680c05a41bc738bcab0f3008f559`
- B站有评 Reply：`54a9961732794dddb3a06b3557fddb1521233c7581de88d8ea3c73a9f31b22bb`

临时捕获可能被系统清理，仓库保留脱敏虎扑 fixture；哈希不是永久托管保证。

## 7. 处理示例

- **实测虎扑帖子** `https://bbs.hupu.com/642828440.html`：解析主帖与真实楼层，平台回复总数与已采集数独立；引用不重复成为楼层。正常离线测试不悄悄依赖临时 live 文件。
- **实测 B站零评论视频** `BV1t3Hd6fEJm`：真实 View 返回 aid；`code:0 + count:0 + replies:null` 才承认空评论。网络/访客失败返回 unavailable，不能显示“0 评论”。
- **实测 B站有评对照** aid `117400330570314`：抓取样本返回 20 条顶层评论、平台 count 44；嵌套是限量预览，不能称完整楼中楼。
- **实测微博 hotflow**：302 访客墙 → 不可用、停止，不生成评论。
- **合成回归**：新评论/引用文字变化 → 证据失效并重审；仅赞数变化 → 留存新快照，不更改文章修订。审核完成前正文/详情反馈/Markdown 不显示新评论。

## 8. 未满足项与风险

本轮不能声称完成原目标的全部生产能力：微博真实超话/热点榜/评论；B站作者自身异常爆发；跨平台先进事件归并与观点聚类；人工金标及留出集；完整 staging 端到端；持续稳定性/授权；正式主排序切换均未完成。评论 AI 摘要的自动回填与逐观点证据映射也未完成，界面只能展示已有的真实提炼字段。原资料库/RAG 保留，没有新增评论直接入 RAG 路径；但既有 editorial 正文分析/RAG 是否会因抽取正文含评论而污染事实，还需要 staging 验证与隔离，不能保证已经解决。

评论刷新模块较大，应后续拆出平台刷新/调度/持久化边界。现有解析/刷新串行与冷却不等于分布式平台级全局限速；更严格的独立平台预算、429 熔断/指数退避、抽取阶段内联评论的统一预算、数据保留期/用户删除流程仍需完善。公开高热来源、评论与媒体也需许可审查。

## 9. 后续优先级

- **P0 上线前**：授权与许可；staging 迁移；小规模虎扑/B站真采集→存储→实际模型审核→详情/导出完整验收；隔离 editorial 评论对事实/RAG 的影响；平台级总预算/限流/失败熔断；确认关闭后不再请求；禁止未经验证的微博评论开启。
- **P1 排序切换前**：真实金标/留出集、平台基线与小账号爆发、旧帖衰减校准；监控成功率、延迟、429、unknown 与审核等待；完整路由桌面/移动复测。
- **P2 产品深化**：授权超话/榜单入口、观点多样性与同事件跨平台聚合、媒体原位置、模块拆分、审查后讨论 RAG。

并行出现的根目录赛事档案/渲染修复文档属于其他工作，未覆盖或回滚。所有变更仍在工作区，未提交。

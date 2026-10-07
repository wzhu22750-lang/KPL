# 当前精选系统审查报告

## 结论与审查边界

**主站已经具备 AIHOT 的多阶段框架；这次应补齐专业内容价值评估和知识准入闭环，而不是重新建设双评分、聚类或全部动态。**

本报告响应新版需求，在修改主站运行代码前编写。只读审查了根目录 Python 归档系统、`kpl-intelligence/` 主站及 `AIHOT/` 参考实现；没有调用付费模型、进行真实采集、连接生产数据库或迁移既有数据。

工作区已有上一轮 Python 评分升级和未完成的 `curation_eval.py` 草稿；审查期间其他任务还在修改信源、账号档案和 `kb/chunks.ts` 等文件，本报告区分已存在机制与新增未提交变动，不覆盖其他任务成果。

## 一、当前流程图

### 主站生产链路

```text
多信源采集：sources.collect / 外部提交
  ↓ URL身份、内容与版本去重
articles + CanonicalContent
  ├─ content_kind：文章/论坛/社交帖/视频等形态
  ├─ content_quality_score：规则抽取质量
  └─ content_completeness：全文/部分/仅简介/失败
  ↓ 缺正文先排队抓正文
runAnalysis
  ↓ prefilter LLM：PASS / UNKNOWN继续，BLOCK停止
  ├─ structure LLM：分类、标签、实体、事实与逐字证据
  └─ score LLM：同一标准独立调用两次（与structure并行）
       ↓ attentionScore 1 + attentionScore 2 ≥ 2×来源门槛
  ↓ understand / summarize：中文标题、摘要、推荐理由
analyses（追加判断，记录输入版本、回执、分数与output）
  ↓ classifyClaim：规则识别事实类型、转载与原出处
  ↓ entity_mentions：战队/选手/英雄关联
publishArticle：先进入可读的全部动态，聚类未完成不能精选
  ↓ events.group：事实/故事聚类，新增信息判断、主源与传闻状态
  ↓ 再次发布：selected + 分组完成 + 信息增量准入
publications
  ├─ 全部动态：/all，按文章展示
  ├─ 精选：/，按同一事实折叠，选代表报道
  ├─ 事件页：stories → facts → reports
  └─ RSS / API / MCP：一个事实一个精选席位

RAG（目前另一条未闭环链）
结构化赛事/实体数据 → chunks → embeddings → QA混合检索
文章 → rebuildArticleChunks（有函数，未找到生产调用入口）
```

主站并没有一个自动持续写入文件系统 `kpl_vault/` 的阶段。知识精选目前主要表达为 publications.selected；物理 vault 是独立的 Python 归档产物。

### Python 归档链路（上一轮升级后现状）

```text
候选URL → 微信正文清洗 → 规则粗筛
  → 一次LLM六维JSON评分 → 分类加权准入、正文指纹去重
  → 暂存下载与一致性校验 → kpl_vault/增量归档
  → metadata / INDEX / AUDIT / QUALITY_AUDIT
```

根目录 `curator.py` 已不再使用800字准入门槛；但主站不调用此函数，不能因此宣称主站已升级。

## 二、证据与当前优点

| Evidence：代码位置 | Finding：当前能力 | Path：本轮如何复用 |
|---|---|---|
| `editorial/analyze.ts:runScores`（主站backend内） | SCORE_CALLS=2；独立attemptTag；均值展示、分数和判断门槛 | 保留两次调用、回执、重试与关停处理 |
| `industry/selection.ts` | T1=58、T1_5=64、T2=74；understandFloor=50 | 保留来源层级，新增内容价值策略，不无证据改阈值 |
| `editorial/analyze.ts:normalizeStructure` | 事实证据必须真的出现在原文和模型可见材料，避免编造引用 | 新内容分类仍遵循正文证据，不靠标题猜完整视频 |
| `providers/receipts.ts`、`providers/llm.ts` | 付费回执、预算熔断、JSON/schema校验、请求恢复 | 所有新增评估必须经chatJson，禁止另起裸HTTP调用 |
| `jobs/content.ts:processRevision` | 正文抓取、版本保护、分析失败和未知回执不会自动准入 | 质量评价故障继续走待处理/恢复，不退回关键词 |
| `events/group.ts:groupArticle/decide` | SAME_OCCURRENCE / SAME_STORY、事实和故事、信息增量、历史归档 | 保留现有事件实体和分组，勿重复建event_clusters表 |
| `publication/publish.ts`、`timeline.ts` | 聚类完成后精选；事实代表席位；同事实多来源折叠 | “AG夺冠三篇”已有折叠基础；新增评价用于优先级 |
| `sources/authority.ts`、`claims.ts`、迁移0063 | 权威随声明类型变化；来源范围/所属实体、转载、传闻状态 | 官方不一律100分，谈自己与谈别人应区别处理 |
| `kb/entity-mentions.ts` | 已有新闻与赛事实体的可追溯关联 | 质量评价不替代实体提取，实体数量不是加分标准 |
| `content/extractors/quality.ts` | 公告、社交帖、视频分别评完整性，不共用800字标准 | 只将抽取质量作为可用材料证据，不冒充编辑价值分 |

以上路径中未注明完整前缀的 backend 文件均位于 `kpl-intelligence/packages/backend/src/`。

## 三、当前问题与误选/漏选风险

### P0：知识检索准入和退载闭环缺失

`kb/chunks.ts:rebuildArticleChunks` 有文章切块实现，但全仓 `rg rebuildArticleChunks` 只命中声明，未发现发布后自动触发。文章精选不能保证进入RAG。

`qa/retrieval.ts:semanticPassages/keywordPassages` 直接查询 chunks，没有对 article 块校验：publication存在、当前公开、当前精选、来源许可、最新文章版本以及正文可用性。若文章块已写入，撤回/取消精选后可能仍被QA检索引用。

审查期间另一任务新增了 social_post 的 `content_quality_score>=70` 切块检查。这只是局部抽取质量检查：未解决所有文章形态的编辑价值准入、自动触发和检索退载问题；也不能认为高抽取分等于有比赛事实。该修改不是本任务新增，未回滚。

**改进路径**：发布变更排队同步article chunks；取消资格时删除；检索读取层仍实时校验公开/知识准入，防止删除延迟或失败造成泄露。模型与embedding只在worker运行，不放在读页面或发布事务内。索引版本必须与当前article revision对应。

### P1：事件注意力不等于专业知识价值

`ScoreSchema` 只接收 `{attentionScore}`；`selection-score.md` 明确评价事件注意力，内部五轴为sig/nov/cred/reson/act。虽然已写KPL战术和噪声示例，但没有持久化逐维评价，不能检查信息价值、战术因果、原创增量和长期参考价值。

Prompt中同时存在“五轴严格加权”和“硬新闻>85”等分段指引，存在模型被分段目标锚定的风险；这是提示词层面的潜在风险，尚无真实评测证明发生频率。

可能误选：文章事件非常热门，却主要是夸张标题和情绪。可能漏选：影响面较小但解释清楚的BP克制分析。不能仅用降低门槛解决两种错误。

### P1：分类顺序与新需求不一致

现有structure与评分并行。content_kind在采集/抽取层已有形态分类，但用户要求的official_news/tactical_analysis等是**编辑用途分类**，不是同一枚举。

若直接把articles.content_kind改成tactical_analysis，现有social/forum/video视图、抽取器、类型和测试会被破坏。

**改进路径**：保留content_kind；新增editorialKind/knowledge content kind，在评分前由structure阶段识别并校验，不在collector硬编码评分。后台存储与公开接口明确区分两套分类。

### P1：T3来源的精选评分断链

迁移0063和后台source schema已支持T3；`tierThreshold`仍只读T1/T1_5/T2配置。T3得到null，当前不会调用精选评分。

此外，现有T3的含义是“选手/教练/工作人员认证账号”，并不是新提示词里的“一切普通个人/社区”。不能在数据库不迁移来源的情况下重新解释T3。

**改进路径**：保留历史来源等级语义，补齐T3策略；结合owner_type、认证、claim_types、owner_entity_id判断来源权威。对社区增加更严格质量门禁，不能靠把名称写成官方获得较低门槛。

### P1：来源权威在评分输入中缺席

`buildScoreInput`故意不提供来源；author/source元数据虽然在structure中可用，claimType/originType却在评分完成后才计算。现有权威矩阵主要服务事件确认，不直接服务稿件价值评分。

新权威维度需要来源身份的可信数据库字段及声明类型；必须在模型外约束，不能让模型单凭正文自称官方打满分。

### P1：Python评价与主站存储未打通

Pythonmetadata新增quality_score、quality_dimensions、content_category、ai_reason等；`scripts/import-kpl-vault.ts`只读取基础材料字段，未把专业质量分写入analyses或公开投影。导入并创建publications记录不等于已经得到精选判断。

导入器还根据战队目录推断信源，在不存在时创建T1来源。目录归档不证明原作者官方，媒体文章可能因此被错误标成官方信源。

### P2：事件上下文在卡片层丢失

数据库与`ItemSummary`已有story引用，事件页可展示进展。`toFeedItemSummary`没有把story引用传到feed卡片。用户难以看出所属宏观事件。

首页按**fact**折叠是刻意设计：同一次发生的重复报道折叠，赛果和后续采访等不同事实仍可见。不能简单全部按story_id折叠，否则长期故事会吞掉有价值的新进展、破坏锚点与分页。

**建议**：保留fact级精选与代表席位，补充卡片story链接；宏观事件视角复用已有story页。若需要独立“事件精选流”，新增明确的读视图，不能悄悄更改既有时间线语义。

### P2：真实评测材料不足

本地vault仅14篇，且均来自已有精选，存在严重选择偏差；`kpl_articles/`当前未找到本地候选材料。上一轮88个Python测试使用模拟输出，不能证明真实模型准确率。

上一轮尚未完成的`curation_eval.py`草稿当前有7条Ruff问题，尚未列为已验收能力。应优先使用/扩展主站既有SelectBench和回执机制，不把Python裸HTTP批处理作为主站生产评测入口。

## 四、与AIHOT机制的真实差距

| 能力 | AIHOT参考实现 | KPL主站当前状态 | 实际工作 |
|---|---|---|---|
| 双评分 | 两次独立调用同一标准，不强制两个不同模型 | 已继承 | 不是新增次数；扩展专业维度，允许A/B不同模型但同标准 |
| 来源门槛 | T1/T1_5/T2 | 已继承，新增T3后策略不完整 | 补T3并结合主体身份，不重定义原等级 |
| 结构化 | 分类、主体、事实 | 已继承，增加实体关联 | 评分前识别编辑内容类型 |
| 聚类 | facts/stories及代表报道 | 已继承，另有KPL赛事指纹和权威/传闻体系 | 复用，不重复建设 |
| 精选/全部分离 | publications投影与范围 | 已继承 | 保留宽召回池，质量不合格不精选 |
| 稿件价值维度 | 注意力单分，不公开逐维 | 主站仍是单分；Python另有六维 | 新增KPL专业价值双评价 |
| RAG知识准入 | 非此框架的核心闭环 | 已有pgvector和实体/比赛块，文章未闭环 | 自动索引、撤载、实时读取守卫 |

因此，“复制AIHOT架构”不是本次主要工程量；专业评价与RAG闭环才是。

## 五、建议实施方案（尚未修改主站代码）

### 目标流程

```text
Content Ingestion → Pre-filter
  → Structure + Content Classification（先于评分）
  → 两次独立 AI Evaluation（同一个评分标准和同一份材料）
  → 保存独立评价、均值、来源策略和证据理由
  → Event Clustering（复用facts/stories与增量判断）
  → Knowledge Selection（公开资格、质量、分组完成、非重复）
  → RAG Index Worker（可引用正文及版本）
  → QA读时再次校验知识资格
```

### A. 评分契约与计算

- 编辑类型：official_news、match_report、tactical_analysis、player_story、community_discussion、social_update。
- 新需求中的示例六维和电竞六维并不完全相同。建议统一保留：information_value、analysis_depth、originality、timeliness、reference_value、tactical_depth、competitive_impact、authority、community_value、noise_penalty；每维0–100整数。
- analysis_depth评价一般论证；tactical_depth评价BP/阵容/运营专业因果，不能仅数术语。competitive_impact评价具体竞技影响，不用明星名气代替。authority受数据库资格约束；community_value只评可追溯舆情，不用点赞数代表真实性。
- 原有attentionScore继续表示事件注意力；新qualityScore独立表示知识价值，禁止覆盖articles.content_quality_score抽取分。
- 两次输入与标准一致，A不能看到B结果，B不能看到A结果；允许同模型独立两次，配置不同模型也可。同标准、独立调用才是AIHOT本质。
- 优先把attentionScore与专业quality嵌在**现有两次评分响应**中，避免再增加两次重复调用。先执行现有structure（加入编辑分类），总流程仍可维持预筛1+结构1+评价2+写作1。新增schema版本，旧回执不能冒充完整质量结果。
- 模型score/should_select只作建议；代码按类型加权、噪声扣分、最低维度、可信authority和来源门槛重算。任一评价缺失/失败/越界都不自动精选。
- 数据不完整、视频只有简介时明确证据范围，不根据标题编出复盘；短公告、短微博不因字数拒绝。失败完整度是材料不可用信号，不能把抽取分70用作全类型统一价值门槛。

### B. 信源策略与重复

保留既有T1/T1_5/T2/T3语义，不直接照抄新提示词里的映射。专业质量门槛单独配置且需标注样本校准；社区有更严格信息/参考/舆情门禁。官方资格只降低可信事实的证据门槛，不豁免广告、无信息或噪声。

正文精确重复拒绝新增知识；同事件有独立BP分析、新数据或新增采访信息可保留。事件有多个来源不意味着每篇都有增量，已有selection_adds_value与代表席位仍决定准入/展示。

### C. 数据库与前端

- 保留旧content_kind、score、content_quality_score以及事实/故事表，不删旧迁移。
- analyses.output保存完整A/B专业评价、均值、分类、政策/Prompt版本和依据；原receipt_ids完整归集。
- 新迁移给publications增加独立专业质量投影（字段或JSONB），使用统一publication读取层公开质量分、编辑类型、维度、AI理由、既有story/fact公开ID。
- 私有模型信息、回执、门槛和原始response不直接暴露给前端。Feed卡片展示质量类型/分数并链接所属story；详情展示维度与推荐/未选理由。
- Python旧六维不能伪装成新增电竞十维；旧metadata保留，导入标记legacy评价或排队主站重评。信源身份不能继续只靠战队目录推断。

### D. RAG准入与撤载

publish变更后投递索引任务，worker读取当前公开投影：精选、可引用、质量通过、正文非空、版权允许；仅索引可验证正文。索引与article revision/text_hash关联。取消精选、撤回、隔离来源、全文许可撤销时删除文章块。

QA语义与关键词通道增加文章块实时范围校验，其他比赛/实体档案不受文章规则影响。事件同一原文不重复索引；多来源不同增量可分别保留并附事件/来源/实体引用。

## 六、实施与验收顺序

1. 确认并固化新契约：专业分独立、编辑分类独立、T3语义不重定义；追加迁移和行业配置。
2. 修改structure与评分运行模块：分类先行、双评价、严格schema、回执/版本/预算闭环；不改collector。
3. 发布投影和公开契约：质量信息、事件链接、旧记录兼容；失败绝不回退旧关键词准入。
4. RAG索引worker、取消资格删除与QA读时守卫；覆盖陈旧任务/修订/撤载。
5. 本地假模型测试六类样本：短BP通过、粉丝吹捧拒绝、官方公告通过、转载降优先级、官方微博赛程通过、普通粉丝微博拒绝。
6. 再验证两次独立请求、均值边界、不同来源门槛、错误JSON/一次失败、内嵌提示注入、事件去重与新增信息、版本变化、撤回与版权撤销。
7. 全量类型检查与后端测试；前端构建与本地测试；数据库与模型全用测试环境，不开生产采集/推送。
8. 准备100–200个人工样本（开发/留出分离，包含未精选难例），先影子运行，再校准上线；14篇旧精选不足以证明有效性。

## 七、本轮实际验证与交付

- Python现有测试：88通过。没有新增真实模型判断能力验证。
- 主站 `cd kpl-intelligence && npm run typecheck`：通过，包含contracts/backend/api/worker/tests/web。
- 新Python评测草稿静态检查：未通过，7条问题（闭包绑定和长行）；本轮暂停实现，未声称已完成。
- 未运行数据库测试、前端构建或真实模型评测；不把类型检查当成运行验收。
- 本轮新增交付为本审查报告；没有修改主站运行代码、AIHOT只读参考、数据库或线上配置。

# 第一阶段（P0）：KPL 内容改版现状审计与实施基线

状态：P0完成（代码审计与离线验证）；生产状态、真实平台可用性及数据库集成测试未验证。

审计时间：2026-10-08（本机北京时间）。需求依据：[产品方案](content-source-redesign-plan.md)、[执行提示词](../prompts/luna-content-redesign.md)。本阶段只增加审计文档和测试证据，不修改业务代码、信源配置或数据库。

## 1. 结论先行

这次改版不应重写采集系统，也不能只改评分提示词。现有系统已有微博适配器、赛事大场/小局表、通用事件与权威判断，但几个关键连接尚未打通：

1. **资讯按事实折叠，不按系列赛聚合。** 小局隔离是现有去重机制的正确约束；需要在上面增加大场组织层，而不是删除隔离条件。
2. **社区当前是辅助信号，不是可独立呈现的核心内容。** 虎扑和两个微博社区源配置为 `hot_signal`，正常流程跳过正文分析、不能创建新事件，也没有公开内容详情页。只加分无法改变这一点。
3. **点赞评论已能获取部分，但不进入主评分，而且纯互动变化可能不落库。** 必须先解决观测保存、时间与缺失状态，再做真实热度加分。
4. **“超话”当前实际上是战队关键词搜索。** 名称不等于访问到了具体超话，也没有验证评论覆盖；需在下一阶段明确能力边界。
5. **公众号降频不能只改 `mp_account`。** 仓库中的公众号同时走付费账号和RSS两条路径，RSS频率会被每日自适应任务改写。
6. **AI评分有多套口径。** 主站事件注意力分、Python知识归档分、内容抽取质量分及未接主链路的社交评分函数不能混成一套。

推荐实施顺序：先补信源调度与观测底座，再做比赛关联层；随后让合格社区内容进入话题处理与新评分，最后整合首页和迁移验证。

## 2. 工作区与验证边界

开始时HEAD：`b458202e85c1ab148c0936fae9c6ca1550b32f45`。

开始时已有6个未提交前端文件：
- `apps/web/app/app.css`
- `apps/web/app/components/shell/PhoneBar.tsx`
- `apps/web/app/components/shell/PullToRefresh.tsx`
- `apps/web/app/components/ui/OutlineSheet.tsx`
- `apps/web/app/features/search/SearchOverlay.tsx`
- `apps/web/app/routes/admin/layout.tsx`

以上路径相对 `kpl-intelligence/`。审计期间观察到HEAD变为 `05457295dec130d5bdc1de65e6901d13b23e2683`，该提交恰好包含上述6个文件。本次未执行git提交、暂存、回退或业务文件编辑；记录为审计期间的外部提交变化。测试针对当时工作区运行，并非声称工作区全程冻结。

已有 `docs/content-source-redesign-plan.md` 和 `prompts/luna-content-redesign.md` 仍保留，本阶段不改其需求。

未读取生产凭据、未加载 `.env` 启动worker、未采集真实平台、未调用付费模型、未执行迁移/回填/部署、未进行浏览器自动化。构建和类型检查会生成正常的本地构建/类型产物，不属于业务源代码变更。

## 3. 实际数据链路

下列路径相对 `kpl-intelligence/`，根目录Python路径另行注明。

```text
industry/sources.json -- scripts/seed.ts --> sources配置（数据库为运行时真源）
  │
  ├─ worker/schedules.ts
  │   ├─ sources.schedule 每分钟 --> scheduleDueSources --> collectSource
  │   │     ├─ RSS / JSON列表 / 微博适配器 --> upsertMaterial
  │   │     └─ esports_api --> matches / games / BP / player_games
  │   └─ mp-reconcile 每15分钟检查到期账号 --> Dajiala --> upsertMaterial
  │
  └─ articles + canonical_content
      ├─ editorial：必要正文抽取 → analyzeArticle → publishArticle → groupArticle
      │     ├─ 相关性预筛、两次attentionScore、结构抽取、摘要
      │     └─ facts / stories / story_signals → 重新整理发布资格与热点
      └─ hot_signal：通常跳过正文分析 → groupSignal（只附着已有事件）

publications → publication/* → API → 首页事实时间线、资讯详情、事件页
matches/games → kb/read.ts → /api/site/kb/* → 赛程与比赛数据详情

根目录独立路径：
dajiala_client.py / kpl_scraper.py → curator.py / quality_scoring.py
  → kpl_vault → scripts/import-kpl-vault.ts → articles / publications
```

注意：`publishArticle`的调用不等于立即成为精选。`publication/publish.ts`中精选还受到归组完成、信息增量和公开资格约束。改版须沿用这些发布边界。

### 当前可复用的模块

| 能力 | 代码落点 | 本阶段确认范围 |
|---|---|---|
| 统一素材身份、修订、时间保真 | `content/materials.ts` | 已有统一入口，不应建立旁路入库 |
| 微博主页与关键词搜索 | `sources/adapters/weibo.ts` | 有实现、离线解析测试通过；真实平台未测 |
| 付费公众号调度与回执 | `sources/mp.ts`、`providers/dajiala.ts` | 到期间隔、待处理积压及失败逻辑已有 |
| 赛事同步与数据 | `sources/esports.ts`、`kb/upsert.ts`、`kb/read.ts` | 大场/小局/BP/MVP已有；不是从零建赛事库 |
| 通用事件/事实与去重 | `events/group.ts`、`events/match-identity.ts` | 有错误交手隔离、身份冲突与修复功能 |
| 事实类型权威与传闻状态 | `sources/authority.ts`、`events/rumor.ts` | 权威规则及状态记录已有，不等同完整争议产品 |
| 账号档案与缺口发现 | 迁移0063、`kb/discover.ts`、`industry/team-accounts.json` | 应扩充现有体系；账号真实性本阶段未联网复核 |
| 虎扑正文与回复结构 | `content/extractors/hupu.ts`、`forum.ts` | 有解析及评论排序能力，但当前信号路由不保证调用 |
| 热榜与趋势覆盖 | `events/hot.ts`、`publication/hot.ts` | 当前衡量独立来源参与，不是互动量热度 |
| 统一内容公开出口 | `publication/*`、API `routes/site.ts` | 新闻公开读取沿用此层；现有赛事接口走kb层 |

## 4. 仓库信源盘点（非线上配置快照）

`industry/sources.json`共32条：`mp_account` 4、`rss` 9、`json_list` 6、`esports_api` 1、`weibo` 12。3条明确停用，1条省略enabled并由种子脚本默认启用，其余启用；不能据此断言线上实际运行29条。

| 分组 | 配置情况 | 当前间隔 | 主要缺口 |
|---|---|---|---|
| 联盟/游戏官方微博 | 2条：KPL、王者荣耀 | 30分钟 | 需实测可靠性、核验账号与内容范围 |
| 俱乐部微博 | 8条：AG、狼队、eStar、TTG、WB、Hero、KSG、DRG | 30分钟 | 未覆盖全部参赛俱乐部；下一阶段对照当前名单核验 |
| 微博社区入口 | 2条：AG、狼队关键词搜索 | 60分钟 | 非已验证的具体超话入口；无完整评论覆盖证明 |
| 虎扑王者荣耀版 | 1条JSON列表源，hot_signal | 60分钟 | 主帖与评论获取、独立话题创建及公开呈现未贯通 |
| B站 | 官方、社区搜索及WB/Hero/DRG，共5条 | 60/125/130/135分钟 | 非主播全名单；解析器读取视频评论数量，不代表抓到评论正文 |
| 付费公众号 | KPL、狼队、DYG、Hero，共4条 | 120分钟 | 尚未按每日低频策略运行 |
| RSS公众号 | 9条，6启用、3停用 | 种子120分钟 | 启用的非付费editorial RSS会被自适应任务调整到15—60分钟 |
| 官方赛事接口 | 1条年度赛事配置 | 30分钟 | 需核对赛季切换与比赛日刷新，不可默认覆盖所有赛事 |
| 选手/教练/二路/解说 | 在这32条可执行种子源中未见专项名单 | — | 账号档案不等于已接调度的信源 |
| 小红书/抖音 | 账号表允许平台值；未见相应种子源或专用采集适配器 | — | 作为后续补充，不宣称已接通 |

运行时读的是数据库 `sources`，不是每次直接读JSON。`scripts/seed.ts:37–50`会upsert并更新间隔等字段。因此后续需提供明确的配置应用/dry-run差异机制，防止重新seed覆盖管理员设置。

## 5. 核心发现与改进落点

### F01：小局隔离正确，大场聚合层缺失

证据：
- `lib/kpl-dedup.ts:154–160`将局次放入指纹；`:224`附近把不同局次判为 `different game scope`。
- `publication/timeline.ts:48–61`按 `fact_id`或独立article分卡，不按 `match_id`。
- `packages/contracts/src/kpl.ts:137`附近的 `MatchDetailResponse`只有比赛、双方、games、videos，没有资讯时间线。
- `kb/read.ts:264`的比赛详情读结构化数据；`apps/web/app/routes/match.tsx`展示BP、数据和视频，不是聚合战报详情。

实际执行合成示例：同日AG对LGD的第一局、第三局得到两个含局次的指纹，冲突结果为 `different game scope`。这是代码行为复现，不是对线上某三场的数据库复现。

改进：新增比赛与素材/事实的关联组织层，保留“不同小局不是同一个事实”的规则；以大场ID构造卡片和小局章节。下一阶段设计关联状态、证据、原始时间及更正记录，不删除原文和事实。

### F02：社区信号被挡在独立内容与事件创建之外

证据：
- `industry/sources.json:566–594`及`:869`之后，虎扑、AG/狼队社区为 `hot_signal`。
- `jobs/content.ts:46–53,79–85`：非editorial通常不抽取页面，跳过分析进入信号归组。
- `events/group.ts:275–276,346`：signalOnly只附着已有story，不创建新story。
- `publication/rules.ts:24–35`：公开池和详情限定editorial；`publication/stories.ts:74–78`明确不列出hot_signal材料。

影响：一个先在社区爆发、尚无媒体报道的争议，不能靠现有信号流程成为完整新话题；已有虎扑解析器不代表当前路由已把评论送到读者眼前。

改进：区分“社区原始信号”与“达到内容资格的社区素材/话题候选”，受控进入抽取、评估、话题创建和公开读取。不得简单把所有hot_signal改成editorial以放开全部低质帖子。

### F03：主评分没有观测热度，官方优待已以门槛体现

证据：
- `editorial/analyze.ts:47–110`：两次单字段 `attentionScore`，输入主要为发布时间、标题、正文，特意不带来源信息。
- `editorial/input.ts:14–38,57–78`：没有热度观测输入。
- `industry/selection.ts`：T1=58、T1_5=64、T2=74；T3未配置精选门槛。
- `industry/prompts/selection-score.md`：七类五轴，不输出分项；对饭圈互撕及无新事实情绪站队明显压分。

影响：只改prompt无法实现可复核的官方+10与观测热度+20；给官方再加分时还需处理已有较低门槛，避免双重优待。T3当事人账号即使将来加入，也不能默认已能参加现行精选。

改进：保留类型化基础价值与安全边界，新增代码可计算的来源/热度分项和评分版本；讨论热度、内容资格、事实可信状态分别管理。70+10+20只是建议试验方案，需新旧样本对照并重新校准门槛。

### F04：存在其他“评分”，但不能误认为已经接通

- 根目录 `quality_scoring.py:17–22,75–83`：Python分类权重与准入；社区要求信息和参考价值均至少70，仍偏知识归档用途。
- `scripts/import-kpl-vault.ts:20–30`：元数据接口没有Python质量评价字段；导入不把六维评价接到主站评分。
- `editorial/social-analyzer.ts`的 `evaluateSocialPost`有互动量启发式，但代码调用检索仅发现 `tests/weibo-adapter.test.ts`，未发现生产入口调用。不能通过只改它交付主站评分升级。
- `articles.content_quality_score`属于抽取质量，与推荐分含义不同。

改进：主站为本次推荐改版主路径。Python维持知识归档用途并明确契约边界；若共享新增字段，单独定义导入映射。新评分不能覆盖抽取质量字段。

### F05：纯互动量变化会被文本去重短路

证据：
- `sources/adapters/weibo.ts:663–666`可归一化赞、评、转，但缺失值用0补齐。
- `content/materials.ts:108–110`内容hash仅含标题、正文、摘要。
- `content/materials.ts:216–220`文本hash相同直接返回；canonical更新在后面的修订分支。
- `content/extractors/types.ts`的Engagement无观测时间、统计口径或历史快照字段。

推论（静态代码路径，数据库回归待补）：帖子正文不变、评论数从低变高时，当前upsert不会因此刷新canonical里的互动量，也不会触发热度重算。增加采集频率未必让评分看见热度增长。

改进：把互动观测更新与内容修订解耦；保留未知、观测时间、指标口径及必要快照，不因每次点赞变化重新调用全文LLM。

### F06：现有热榜不是平台热度；参与者口径可能混淆

证据：
- `events/hot.ts:1–4,57–60`：48小时独立参与来源、24小时半衰期，至少2个参与者。
- `events/hot.ts:112`附近按 `signal_group_id`、`owner_entity_id`、source顺序构造参与者键，不是评论作者数。
- 社区AG源和AG官方源均使用owner_entity_id=ag，可能被归为同一owner；虎扑板块下不同作者也不会自动成为不同参与者。
- `events/hot.ts:91–95`覆盖时钟只包含RSS/web_list/json_list/x_search，未包含weibo/mp_account。

改进：保留已有来源独立性与时间衰减能力，但分清“账号所有者、内容提及对象、社区范围、原发作者”；把新增微博覆盖纳入观测完整性。平台互动热度不得冒充独立来源佐证。

### F07：“超话”实现为关键词搜索，部分失败会成为空结果

证据：`sources/adapters/weibo.ts:409–469`，topic/search统一使用微博搜索container；非200、JSON异常、ok=false会break，随后返回结果和抓取时间，而不是明确失败状态。

影响：仅凭名字或空结果不能确认已巡检具体超话，也不能断言“当前没有热点”。

改进：为真实超话、关键词搜索、账号主页明确能力标签；区分正常空、访问失败、受限、截断。本阶段不评估外网是否可用，下一阶段用授权样本验证。

### F08：降频策略会与现有定时自适应冲突

证据：
- `apps/worker/src/schedules.ts:74–77`常规到期扫描每分钟、公众号到期检查每15分钟；这些不是每源实际抓取间隔。
- `sources/collect.ts:444–465`每天按产量重写RSS等间隔，非付费editorial最大60分钟；weibo和mp_account不在该集合。
- `sources/mp.ts:149`按自身interval安排下一次成功检查。

改进：按内容渠道族而非只按kind设置频率策略；明确固定/自适应/赛事临时加频的优先级，覆盖公众号RSS和付费账号两种实现。保留现有退避，不再造重复调度器。

### F09：比赛底座已有，状态与更新语义需补齐

证据：迁移0054有matches、games、唯一match_id/game_no；0060允许BO9。`kb/upsert.ts:166`的状态不含postponed；`:192–195`冲突更新直接写入传入比分和状态，没有在此检查观测先后。

改进：复用现有表，必要时追加迁移；建立延期表示与来源/时间优先级，测乱序回退与更正两类不同情况，不用“比分只能增加”掩盖真实更正。

### F10：来源身份不能仅由tier或导入目录决定

证据：
- 微博归一化 `sourceAuthority`只按T1判official，其余community（`weibo.ts:675`）；T1_5俱乐部被归到community。
- `editorial/input.ts:74`的一手性按tier===T1，不能直接代表全部已核验官方账号。
- `scripts/import-kpl-vault.ts:54–65`按目录推断官方源，无匹配默认KPL官方。
- 迁移0063已提供entity_accounts核验字段，但没有证据表明上述所有路径都使用其认证结果。

改进：在官方加分前统一受核验身份口径、声明类型和一手出处；尤其旧库不得只凭目录享受官方加分。

## 6. 后续阶段及具体落点

| 阶段 | 本阶段后的具体工作 | 主要落点 | 验收标准 |
|---|---|---|---|
| P1 信源与观测底座 | 频率策略、公众号双路径降频、社区入口能力/失败状态、名单核验、互动独立更新与未知值 | `industry/sources.json`、`sources/collect.ts`、`sources/mp.ts`、`sources/adapters/weibo.ts`、`content/materials.ts`、contracts/新增迁移 | 配置能作用于调度；适配器能区分空/失败；同文互动增长可记录且不重做全文分析；真实能力与缺口有证据 |
| P2 大场聚合 | 复用matches/games，建立素材/事实关联与局次待确认；大场时间线、状态和更正 | `kb/upsert.ts`、新增关联模块/迁移、`events/match-identity.ts`、`publication/`、`contracts/kpl.ts`、`routes/match.tsx` | 三场三主卡；同一大场多局各自保留；次日复盘、重复交手、乱序、更正、BO9不误归档 |
| P3 话题与评分 | 社区内容候选资格、独立建话题、观点与回应、来源及热度分项、新旧评分对照 | `jobs/content.ts`、`events/group.ts`、`editorial/input.ts`、`analyze.ts`、`industry/selection.ts`及prompts、`publication/rules.ts`、`stories.ts`、`events/hot.ts` | 社区先发话题能受控呈现；评分作用于生产主路径；分项可追溯；澄清回写；无观测不编造热度 |
| P4 页面与全链路 | 热点优先、赛事入口稳定、精简/展开时间线、实体动态与来源状态 | `apps/api/src/routes/site.ts`、`apps/web/app/routes/home.tsx`、`match.tsx`、事件页、feed组件 | 从入库到真实API再到页面可验证，非静态样稿；独立争议能回到比赛背景 |
| P5 迁移与试运行交付 | dry-run、增量兼容、回滚、新旧评估与运行说明 | scripts、database新增迁移、docs | 历史可读、评分有版本、无自动全量回算；生产操作经用户确认 |

P1的互动观测为P3前置；P2/P3只有关联契约固定后才适合并行。首轮不追求一次铺满全部平台，更不以未经核验的账号列表充当覆盖完成。

### 在进入对应实现前固定的契约

1. **来源**：账号所有者、内容提及对象、核验依据、渠道族、支持能力、调度策略分开。
2. **热度观测**：素材/平台/观测时间、可空指标、覆盖状态、统计口径；与正文revision分开。
3. **比赛关联**：稳定matchId、可空gameId、内容角色、关联证据、待确认状态、事件发生顺序和原帖时间。
4. **评分**：基础类型与分项、官方/热度加分、扣分、规则版本、观测覆盖、可信状态、收录和推荐分别决策。
5. **社区公开资格**：原始信号不等于公开稿；定义从候选到可见话题的明确门禁，并统一公开读取规则。

具体表名和字段设计留到实现阶段结合迁移确定，本报告不以未经验证的schema取代实际设计。

## 7. 本阶段实际验证

环境：Node `v25.9.0`，Python `3.12.2`。使用已安装依赖，无安装或升级操作。

| 验证 | 结果 | 证据 |
|---|---|---|
| 根目录 `python3 -m pytest tests_py -q` | 88通过 | [python-tests.txt](audit-artifacts/content-redesign-p0/python-tests.txt) |
| 主站 `npm run typecheck` | 通过 | [typecheck.txt](audit-artifacts/content-redesign-p0/typecheck.txt) |
| 主站 `npm run build -w @aihot/web` | 通过 | [web-build.txt](audit-artifacts/content-redesign-p0/web-build.txt) |
| 构建后 `node --test apps/web/tests/*.test.ts` | 29通过 | [web-tests.txt](audit-artifacts/content-redesign-p0/web-tests.txt) |
| `COLLECT_ENABLED=false MODEL_CALLS_ENABLED=false node --test tests/kpl-dedup.test.ts tests/weibo-adapter.test.ts` | 19通过，无数据库/真实采集 | [pure-backend-tests.txt](audit-artifacts/content-redesign-p0/pure-backend-tests.txt) |
| `git diff --check` | 通过 | 运行时无输出 |
| 本机 `127.0.0.1:5432` TCP检查 | ConnectionRefusedError | 本地常规PostgreSQL端口未开放 |

共136个测试用例通过，不含数据库集成套件。前端测试在构建前后各执行一次，这里只计构建后的29项。

未运行完整 `npm test`：它通过 `tests/databases.ts`创建、迁移和克隆测试数据库，要求专用 `_test`或`_ci`库。本地常规端口不可用且未配置新的隔离库，本阶段不擅自连接环境中的其他数据库。后续可使用明确授权的本地pgvector测试库，按README命令运行，不能用生产库替代。

未启动web/api/worker，因此没有站点HTTP smoke、浏览器端到端和在线信源成功率证据。适配器离线测试通过不意味着平台当前真实可抓。

### 合成归组行为复现

在主站目录执行（不连接数据库）：

```bash
node --input-type=module <<'JS'
import { extractMatchFingerprint, kplOccurrenceConflict } from './packages/backend/src/lib/kpl-dedup.ts';
const date = new Date('2026-10-07T12:00:00+08:00');
const first = '成都AG超玩会战胜杭州LGD.NBW，以1:0拿下第一局';
const third = '杭州LGD.NBW第三局战胜成都AG超玩会，断雨杨戬获MVP';
console.log(extractMatchFingerprint(first, date)?.matchKey);
console.log(extractMatchFingerprint(third, date)?.matchKey);
console.log(kplOccurrenceConflict(first, third, date, date));
JS
```

输出分别为 `match:ag-vs-lgd:20261007:game-1`、`match:ag-vs-lgd:20261007:game-3`、`different game scope`。

## 8. P0完成清单与下一步

- [x] 找到真实采集、入库、抽取、评分、归组、公开读取和页面落点。
- [x] 识别所有与本次改版相关的评分口径及旁路，避免只修改无调用函数。
- [x] 盘点种子源数量、渠道间隔、角色及与目标的缺口。
- [x] 为比赛碎片化给出代码机制与可重复的离线行为证据。
- [x] 列出分阶段改动、依赖、兼容风险与验收标准。
- [x] 运行可安全执行的本地检查，明确数据库与在线验证缺口。
- [x] 保留既有工作区，不修改业务代码，不操作生产数据。

**建议下一步启动P1：微博主通道与低成本获取策略。** 首先修订调度策略及社区失败状态，并补互动观测的独立更新能力；同时核验首批账号与真实获取能力。先把输入和观测做对，再调整推荐评分，避免给失真或冻结的热度加权。

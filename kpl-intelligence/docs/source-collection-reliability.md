# 信源采集可靠性与完整性

本文记录 2026-10 对信源采集的一次可靠性修复：自动调度缺口、"假成功"（失败/降级被当成无更新）、
第三方内容冒充官方账号、分页/增量截断导致的静默漏抓、以及赛事数据"记录数够了但字段不全"。
目标是让采集结果**可区分、可恢复、可排查**，不是扩充信源数量，也不是改 UI 或 AI 评分。

## 1. 问题与根因

| 问题 | 是否存在 | 代码证据（修复前） | 影响 |
|---|---|---|---|
| 微博不在自动调度白名单 | 是 | `sources/collect.ts` 的 `scheduleDueSources()` 只选 `rss/web_list/json_list/x_search/esports_api` | 10 个启用的 weibo 源永不自动入队，只能靠手动脚本 |
| 微信 RSS 桥吞掉故障 | 是 | `wechat2rss/bridge.ts`：适配器全失败返回旧缓存、无缓存生成空 RSS、缓存命中刷新 `cachedAt` | 上游挂了也记 `ok` 并刷新 `last_ok_at` |
| 搜狗结果冒充官方账号 | 是 | `wechat2rss/adapters/sogou.ts`：不校验作者、`author \|\| 目标名`、摘要填进 `contentHtml` | 第三方文章以官方源入库、摘要冒充正文 |
| 微博长文/时间"假完整" | 是 | `adapters/weibo.ts`：所有结果 `completeness:"full"`；日期解析失败返回 `now`；相对时间用服务器本地时区；硬编码话题→战队映射 | 截断内容被当完整；未知时间被伪造；实体 id 误绑 |
| 微博游标语义错误 | 是 | `lastMid = rawItems[0].id` 直接当 `since_id` | 置顶旧帖使水位倒退/提前终止；重复 token 死循环 |
| B 站/公众号只读第一页 | 是 | `json-list.ts` 只发一次请求；`mp.ts` 每轮仅 8 篇且**直接丢弃**其余候选 | 高产期静默漏抓 |
| 赛事只看小局数量 | 是 | `esports.ts` `incompleteMatches()` 只比较 `count(games)`；失败请求直接抛出中断整轮 | 有小局但缺 BP/选手数据永不补；单场失败阻塞整轮 |
| 运维看不出降级/积压 | 是 | 无区分"最近成功/最近尝试/吃旧缓存/分页未追平"的查询 | 故障不可见 |

## 2. 实际修复范围

- `sources/collect.ts`：`scheduleDueSources()` 白名单加入 `weibo`；`loadSource()` 补上 `owner_type/owner_entity_id`；
  RSS 分支识别 `wechat://` 桥的 `stale` 状态并判为失败。
- `sources/wechat2rss/{types,bridge,generator}.ts` + `adapters/{weread,sogou}.ts`：引入 `status`（`ok/empty/stale`）
  与 `identity`（`mp_id/display_name/unknown`）；真实 `fetchedAt` 与降级解耦；摘要不再写入 `content:encoded`；
  搜狗只收作者精确匹配的文章、不再伪造作者与正文；微信读书要求精确同名才解析 `mpId`。
- `sources/adapters/weibo.ts`：时区无关的健壮日期解析（无法解析返回 `null`）；长文标记 `partial` + warning；
  水印与分页 token 分离、逐页追平、置顶/重复 token/中途失败都安全；实体只绑定有效 `owner` 实体。
- `sources/mp.ts`：每轮溢出候选落 `cursor.mpBacklog`，下轮继续，正文不重复付费。
- `sources/json-list.ts`：新增**显式** `pagination` 配置（默认单页），有上限地按页追平、空页即边界、跨页去重。
- `sources/esports.ts`：字段级完整度（局数/BP/选手/MVP）；请求预算按**尝试**计；持续失败比赛 attempts 递增并
  最终记为 `coverageLimited`；近期完赛比赛独立额度复查。
- `sources/config-keys.ts`：weibo 增加 `maxPages`，json_list 增加 `pagination`。
- `scripts/audit-collection-reliability.ts`：只读诊断。
- 回归测试见 §8。

未改：队列、HTTP 工具、付费回执与预算、内容入库/去重、健康与告警机制、前端。

## 3. 成功 / 正常无更新 / 降级 / 失败

| 结果 | 判定 | `fetch_runs.status` | `last_ok_at` | `fail_count` |
|---|---|---|---|---|
| 成功取得新数据 | 上游 200 且解析出候选 | `ok` | 刷新 | 归零 |
| 经确认的正常无更新 | 上游明确返回空（如微信读书列表 JSON 的数组为空、RSS 304） | `ok` | 刷新 | 归零 |
| 降级（吃旧缓存） | 适配器/上游全部失败但桥有旧缓存 | `failed` | **不刷新** | +1 |
| 失败 | 请求失败/解析失败/HTTP 非 2xx | `failed` | 不刷新 | +1 |
| 预算熔断 | `BudgetExceededError` | `failed` | 不刷新 | 不计 | 

要点：**HTTP 200 ≠ 采集成功**；**空结果必须来自可验证的正常响应**（`status:"empty"`），
由异常转换出来的空不能算正常无更新。微信桥公开 Feed 在降级时仍展示缓存（可用性），
但采集路径会把它记为失败，展示可用性不冒充采集成功。

## 4. 各平台增量与补漏方式

- **微博（weibo 适配器）**：`cursor.lastMid` 是"已覆盖到的最新博文"水印；`cursor.pageSinceId` 是服务端
  `cardlistInfo.since_id` 分页 token，两者分开。每轮先读第 1 页做最新检查，再沿 token 向旧追到水印或页预算；
  置顶旧帖不会让水印倒退，服务端重复返回同一 token 即结束，后页失败保留已读页并保存断点。水印只在整轮
  成功入库后随游标持久化（失败路径不写游标）。
- **公众号（mp_account，Dajiala 付费）**：每账号一次列表调用；新文章正文一并取回。超过每轮 8 篇的候选写入
  `cursor.mpBacklog`，按最新在前排序，下轮继续；已知正文按 `identity_key` 去重，不重复付费。付费列表调用
  仍走 10 分钟窗口回执去重。
- **JSON 列表（B 站等）**：默认单页，行为不变。需要分页时显式配置
  `"pagination": { "pageParam": "page", "startPage": 1, "maxPages": 5 }`；按页追平，空页即边界，跨页按 URL 去重，
  不会无限翻页。B 站搜索接口无游标，维持每轮全量重扫 + `bvid` 去重。
- **X（x_search）**：沿用既有 shard + `since_id` 水印 + backlog 机制，未改动。
- **赛事（esports_api）**：每轮整季赛程赛果对齐；再用预算补字段。预算限制**对局详情请求次数**（失败也计），
  持续失败的比赛按 attempts 排到后面，达到上限记为覆盖受限；近期完赛比赛用独立额度复查，接收官方迟到数据。

## 5. 已知覆盖边界

- 微博：`m.weibo.cn` 主页列表的历史窗口由服务端决定，`maxPages` 之外的内容无法保证；置顶/风控可能导致
  页面非严格倒序，已用"本页最后一条"和数字 id 比较降低风险，但**未对真实账号做协议级验证**。
- 微博长文：**没有**接入经验证的长文补取接口，因此 `isLongText: true` 一律标记 `partial` + `long_text_truncated`，
  保留已取得的短内容，不补全文也不丢内容。
- 搜狗通道：只能提供展示名称，无法证明官方身份，因此**默认整通道拒收**（可排查计数 `droppedUnverified`）。
  只有微信读书解析出 `mpId` 的结果才算可信。若某账号在微信读书中不存在，该 `wechat://` 源会降级/失败而不是
  混入第三方内容。
- 微信读书：按精确同名解析 `mpId`，找不到精确同名即失败，不再回退到第一个搜索结果。
- 公众号历史：`mpHistory` 可见的历史深度由服务商决定；`mpBacklog` 上限 200，超出即覆盖边界。
- 赛事：官方对局详情若长期缺失，重试 5 次后记为 `coverageLimited`；平台可见的历史范围是覆盖边界，不承诺无限补全。

## 6. 数据完整度定义

- `content_completeness`：`full`（完整） / `partial`（部分，如长文截断） / `summary_only`（只有摘要） /
  `failed`（抽取失败）。微信列表只有摘要时 `contentHtml/contentText` 为 `null`，由内容管道的形态判断给出
  `summary_only`，不会因为有 `description` 就标 `full`。
- 微博：`isLongText && !补全文` → `partial` + `long_text_truncated`；短微博 → `full`。
- 比赛完整度（字段级，非"记录数"）：赛程/比分已取得 → 小局列表已取得 → 小局基本信息 → BP 已取得
  （standard 满 20 步；pinnacle 有 `pinnacle_picks`）→ 选手数据已取得（每局 10 行）→ MVP 已解析。
  任一缺失即为补全候选；空/异常响应不会清空已取得的有效数据。

## 7. 诊断命令

时间字段的含义：`last_fetch_at` 最近一次采集尝试、`last_ok_at` 最近一次真正成功访问上游、
`articles.discovered_at` 最近一次发现新内容。

只读诊断（推荐，一次回答 §9 的全部问题）：

```bash
node --env-file=.env scripts/audit-collection-reliability.ts
```

它输出的分区：① 启用但最近没尝试的源（调度缺口）② 最近 24h 吃过旧缓存的源 ③ 分页/补漏积压与覆盖受限
④ 近 7 天内容不完整（缺正文/部分/失败）⑤ 缺比赛详情（字段级）⑥ 失败类别 ⑦ 付费请求成本与产出。
脚本只读、不调用上游、不输出密钥。

关键 SQL（可单独执行）：

```sql
-- 最近一次尝试 / 最近一次真正成功 / 最近一次发现新内容
SELECT s.id, s.last_fetch_at, s.last_ok_at, max(a.discovered_at) AS last_new_content
FROM sources s LEFT JOIN articles a ON a.source_id = s.id
WHERE s.enabled GROUP BY s.id, s.last_fetch_at, s.last_ok_at;

-- 近期降级（吃旧缓存）
SELECT s.id, s.name, max(r.finished_at)
FROM fetch_runs r JOIN sources s ON s.id = r.source_id
WHERE r.detail @> '{"wechat":{"status":"stale"}}'::jsonb AND r.finished_at > now() - interval '24 hours'
GROUP BY s.id, s.name;

-- 分页 / 补漏积压
SELECT id, kind, cursor ? 'xBacklog' AS x_backlog, cursor->>'pageSinceId' AS weibo_page,
       jsonb_array_length(coalesce(cursor->'mpBacklog','[]'::jsonb)) AS mp_backlog, cursor ? 'coverageLimited' AS coverage_limited
FROM sources WHERE enabled;
```

## 8. 验证结果

在本地 `*_test` 库（`docker compose --profile local-db up -d db`）上运行，全部通过：

- `tests/weibo-adapter.test.ts`、`tests/weibo-collect.test.ts`：日期（标准/相对/今天/昨天/跨年/非法→null）、
  长文 `partial`、实体绑定、多页追平、置顶旧帖不倒退、重复 token 结束、后页失败保留断点、首页失败抛出。
- `tests/wechat2rss.test.ts`：桥的 `ok/empty/stale` 区分、stale 不刷新 `fetchedAt`、display_name 拒收、
  摘要不写 `content:encoded`。
- `tests/collection-wechat.test.ts`：`scheduleDueSources` 调度微博（到期入队、禁用/未到期不入队、重复调度去重）；
  `wechat://` 降级使运行失败且不刷新 `last_ok_at`，恢复后记录真实成功时间。
- `tests/mp-backlog.test.ts`：溢出候选入 backlog、下轮继续、正文不重复计费。
- `tests/json-pagination.test.ts`：默认单页；显式分页遇空页停止、跨页去重。
- `tests/esports-sync.test.ts`（新增用例）：小局存在但缺 BP/选手数据可补全；单场持续失败不阻塞近期比赛、
  失败也计入预算、整轮不失败。

协议不确定性：微博 `since_id` 语义、`isLongText` 补取接口、搜狗/微信读书可用性均**未对真实服务在线验证**，
以固定响应样本/本地 stub 测试，并如实标注为覆盖边界。

命令与结果：

```bash
# 97 个信源采集相关用例全绿（含本次新增）
DATABASE_URL="postgres://postgres@127.0.0.1:5432/kpl_test" \
  node --test-global-setup=tests/databases.ts --import ./tests/databases.ts --test \
  tests/collection*.test.ts tests/sources.test.ts tests/source-*.test.ts tests/weibo-*.test.ts \
  tests/wechat2rss.test.ts tests/mp-backlog.test.ts tests/dajiala.test.ts tests/json-pagination.test.ts \
  tests/esports-sync.test.ts tests/rss-*.test.ts tests/x-shards.test.ts
# → tests 97 / pass 97 / fail 0

npm run build -w @aihot/web && node --test apps/web/tests/*.test.ts   # → 29 pass / 0 fail
node scripts/audit-collection-reliability.ts                           # 只读诊断可运行
```

typecheck：`npm run typecheck` 在本会话后期只剩**另一个进程正在编辑的** `tests/match-identity.test.ts` 两处类型错误；
本次修改的 `sources/*`、`scripts/*` 均无错误（早先还会因另一进程改坏的 `kb/read.ts` 语法错误整体失败，见 §9）。

完整 `npm test`（735 用例）：665 通过 / 16 失败 / 54 跳过。16 个失败为 `tests/x-fulltext-license.test.ts`（14）与
`tests/readpath-performance.test.ts`（1）、`tests/collection-tail.test.ts`（1）。其中 `collection-tail` 的失败已定位为
本次 JSON 分页去重引入了不该有的单页内去重，已修正并复跑通过；`x-fulltext-license` / `readpath-performance` 依赖
`kb/read.ts`、`kb/chunks.ts` 等被另一进程同时修改的阅读链路，与本次信源采集改动无关。

## 9. 部署注意事项

- **迁移**：无需新迁移。游标新增 `weibo` 的 `containerid/lastMid/pageSinceId`、`mpBacklog`、赛事 `backfill` 都写在
  既有 `sources.cursor` JSON 中；`weibo` 源类型迁移 `0064_weibo_source_kind.sql` 已在工作区。
- **重启 worker**：需要。调度白名单、适配器与桥的改动在 worker 进程生效。API 进程只有在对外
  `/feed/wechat/*` 需要新行为时重启。
- **游标兼容/回填**：旧微博游标只有 `lastMid`，新代码按水印继续，`pageSinceId` 缺失时从第 1 页顺序追平，
  幂等入库；公众号旧游标无 `mpBacklog`，按空处理。无需手工回填。
- **付费请求**：不新增付费调用类型。公众号每轮仍最多 8 篇正文（其余转入 backlog，跨轮累计不变多）；
  微博/JSON 为免费通道。赛事预算从"成功写入数"改为"请求尝试数"，单轮请求数上限不变。
- **可观测**：上线后跑一次 `scripts/audit-collection-reliability.ts` 建立基线；关注 §7 的降级与积压分区。
- **并行改动冲突**：本次会话期间 `packages/backend/src/kb/read.ts` 被另一进程改出语法错误（`loadHeroDetail`
  之后遗留一段孤儿 `return {...}`），为让 typecheck 可跑做了最小修复（删除孤儿块，不改语义）；
  `packages/backend/src/events/repair-match-groups.ts` 在同一时段也出现无关的类型错误（`other` 可能为 null），
  未改动。这些文件不属于本次任务范围。

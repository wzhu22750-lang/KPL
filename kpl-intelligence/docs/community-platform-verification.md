# 社区平台信源可用性验证报告 (Hupu / Bilibili / Weibo)

**验证时间**：2026-10-08T18:35:00Z  
**执行原则**：
- 严格遵循验证/调研任务要求，不修改任何业务/生产代码（No product edits）；
- 不改动任何既有测试用例（Don't alter tests）；
- 绝不绕过鉴权/验证码或注入非法的浏览器模拟登录（No auth/captcha bypass）；
- 首选 Jina Reader Web 路由与公开允许的轻量工具进行实测对照；
- 绝不读取 `.env` 凭据，通过 Docker 运行态及项目文档探查本地测试数据库；
- 严守浏览器清理规范（0 无头浏览器残留，显式确认进程状态）；
- 真实记录并区分高鲜活真字节（genuine live bytes）、Jina 陈旧缓存（stale cache）与鉴权拦截（Sina Visitor System 拦截）。

---

## 1. 信源配置路径与数据结构核验 (Real Source Config Paths)

| 平台 | 配置文件路径 | 配置 ID / 关键路径 | 声明模式与字段结构 | 鲜活真字节核验结果 |
| :--- | :--- | :--- | :--- | :--- |
| **虎扑 (Hupu)** | `industry/sources.json` | `id: "hupu-kog"`<br>`url: "https://bbs.hupu.com/kog-postdate"` | `mode: "html_window_var"`<br>`windowVar: "$$data"`<br>`itemsPath: "topic.threads.list"`<br>`authorPaths: ["author.puname"]`<br>`publishedAtPath: "createdAt"` (`epoch_ms`)<br>`urlTemplate: "https://bbs.hupu.com{raw:url}"` | **真实匹配**：返回 220KB 页面内联 `window.$$data`，平衡大括号解析出 42 条帖子，最新发帖时间为 2026-10-08T18:25:28Z（即分钟前发帖）。详情页通过 Next.js `__NEXT_DATA__` (`props.pageProps.detail.thread` / `detail.replies.list`) 包含完整正文及楼层评论。 |
| **哔哩哔哩 (Bilibili)** | `industry/sources.json` | `id: "bilibili-search-kpl"`<br>`url: "https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=KPL&order=pubdate&page=1"` | `mode: "json_api"`<br>`itemsPath: "data.result"`<br>`titlePaths: ["title"]`<br>`authorPaths: ["author"]`<br>`publishedAtPath: "pubdate"` (`epoch_s`)<br>`urlTemplate: "https://www.bilibili.com/video/{bvid}"` | **真实匹配**：直接调用搜索 API 返回 HTTP 200、`code: 0, message: "OK"`，`data.result` 包含 20 条视频，最新时间戳为 2026-10-08T16:37:26Z（`BV1t3Hd6fEJm`）。Web 路由经 Jina 亦解析出实时赛事信息。 |
| **微博 (Weibo)** | `industry/sources.json`<br>`packages/backend/src/sources/adapters/weibo.ts` | `id: "weibo-topic-ag"`<br>`id: "weibo-topic-wolves"` | `kind: "weibo"`<br>`mode: "search"`<br>Query: `"成都AG超玩会"` / `"重庆狼队"`<br>`owner_type: "community"` | **分化**：<br>1. **Web / Jina 路由**：强制重定向至 `visitor.passport.weibo.com`（`Title: Sina Visitor System`，正文为空），被访客墙拦截；<br>2. **Adapter 内部移动端 API 路由**：通过自动协议交换（`visitor.passport.weibo.cn/visitor/genvisitor2` 获取 `SUB`/`SUBP` 临时访客态）访问 `m.weibo.cn/api/container/getIndex`，返回 11 条真字节数据，最新为 2026-10-08T10:51:06Z。 |

---

## 2. 外部访问证据（URL / 时间 / 实测证据）

### 2.1 虎扑 (Hupu)

#### (1) 列表页 (Listing)
- **请求目标**：`https://bbs.hupu.com/kog-postdate`
- **Jina Reader 路由**：`https://r.jina.ai/https://bbs.hupu.com/kog-postdate`
  - **实测响应状态**：HTTP 200
  - **标题**：`王者荣耀 - 虎扑社区`
  - **时间戳新鲜度核验**：返回多条 2026-10-08 当天帖子（`10-08 18:25`、`10-08 18:24`、`10-08 17:35`、`10-08 17:28`）。**确认为实时抓取，非陈旧缓存（Not stale cache）**。
  - **样例证据**：
    - `[加油](https://bbs.hupu.com/642832287.html) 0 / 3 Aurora汐 10-08 18:25`
    - `[我的2026 KPL年总擂台赛排名预测](https://bbs.hupu.com/642832023.html) 0 / 118 虎扑JR1311062256 10-08 17:35`
    - `[我在《合成康平路》拿到了 47328 分！](https://bbs.hupu.com/642831972.html) 0 / 66 虎扑JR1513982997 10-08 17:28`（证明了 `sources.json` 中配置的 `"dropMarkersTitleOnly": ["合成康平路"]` 过滤规则的真实必要性）
- **直接 HTTP / 内联结构核验**：
  - HTTP/2 200，HTML 长度 220,172 字节。
  - 提取 `window.$$data` 并通过 balanced-brace 扫描：
    - `threads.length`: 42
    - `tid`: `'642832287'`
    - `createdAt`: `1791483928000` (ISO: `2026-10-08T18:25:28.000Z`)
    - `read`: 3, `replies`: 0, `lights`: 0

#### (2) 详情页 (Detail)
- **请求目标**：`https://bbs.hupu.com/642828440.html`
- **Jina Reader 路由**：`https://r.jina.ai/https://bbs.hupu.com/642828440.html`
  - **标题**：`[流言板]AG发布赛后返图：面对眼前的坎坷，找到方向大步迈过去-王者荣耀丨KPL-虎扑社区`
  - **发布时间**：`2026-10-08 13:08:06 发布于 上海`
  - **评论鲜活度**：包含最新至 `2026-10-08 17:53:04 发布于 河南` 的高亮/普通回帖（如 JR [千冠中单九尾]、[我就kpl] 讨论 AG 擂台赛状态）。
- **直接 HTTP / Next.js 结构核验**：
  - 返回 Next.js `__NEXT_DATA__`：
    - 主帖对象 `props.pageProps.detail.thread`：`tid: '642828440'`, `author.puname: '虎扑游戏电竞资讯'`, `lights: 2`, `replies: 11`。
    - 评论列表 `props.pageProps.detail.replies.list`：包含完整的楼层回帖、点亮数（`allLightCount`）、客户端平台及发布时间。

---

### 2.2 哔哩哔哩 (Bilibili)

#### (1) Web 搜索路由 (Jina Reader)
- **请求目标**：`https://search.bilibili.com/all?keyword=KPL`
- **Jina Reader 路由**：`https://r.jina.ai/https://search.bilibili.com/all?keyword=KPL`
  - **实测响应状态**：HTTP 200
  - **标题**：`KPL-哔哩哔哩_bilibili`
  - **时间戳新鲜度核验**：页面渲染出最新的官方赛程组件：
    - `2026KPL年度总决赛 擂台赛 已结束 成都AG超玩会 2 : 3 杭州LGD.NBW`
    - `2026KPL年度总决赛 擂台赛 已结束 北京WB 1 : 3 上海EDG.M`
    - `【KPL年度总决赛TOP5】擂台赛W1D6：神目破敌所向无前，枭雄浴血大杀四方 (BV1csHy6nEEx)` 昨天
    - **确认为实时抓取，非陈旧缓存**。

#### (2) 搜索 API 路由 (Direct API)
- **请求目标**：`https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=KPL&order=pubdate&page=1`
- **请求头**：`Referer: https://www.bilibili.com/`，标准桌面 User-Agent
- **实测响应状态**：HTTP 200，`code: 0, message: "OK"`
- **解析结果**：`data.result` 顺利返回 20 条视频，按发布时间倒序：
  - `BV1t3Hd6fEJm`：`KPL赛事官网赛后第一视角｜成都AG vs 杭州LGDNBW｜12P`（作者：胜负之外，发布时间：`2026-10-08T16:37:26.000Z`）
  - `BV1XAHd6PE52`：`陈穿聊KPL现在替补和首发之间的关系...`（作者：孤独的根号二点九，发布时间：`2026-10-08T16:31:45.000Z`）
  - `BV1DPHd6YEdt`：`【预告】KPL十大年度记忆人物专题片Cat篇——《热爱》10月9日11点即将上线 20261008`（作者：夏之月，发布时间：`2026-10-08T16:26:39.000Z`）

---

### 2.3 微博 (Weibo)

#### (1) Web 搜索路由 (Jina Reader)
- **请求目标**：
  - `https://s.weibo.com/weibo?q=KPL`
  - `https://s.weibo.com/weibo?q=%E6%88%90%E9%83%BDAG%E8%B6%85%E7%8E%A9%E4%BC%9A`
  - 单条博文详情：`https://weibo.com/5878848794/RlK3R4vbm` / `https://m.weibo.cn/status/RlK3R4vbm`
- **Jina Reader 路由**：
  - `https://r.jina.ai/https://s.weibo.com/weibo?q=KPL`
  - `https://r.jina.ai/https://s.weibo.com/weibo?q=%E6%88%90%E9%83%BDAG%E8%B6%85%E7%8E%A9%E4%BC%9A`
- **实测响应状态**：
  - 页面标题均为：`Title: Sina Visitor System`
  - 正文：Markdown Content 为空。
  - **结论**：新浪微博 PC 端与移动端网页搜索对未带已验证 Cookie / 无头代理的爬取直接重定向至访客验证系统（`visitor.passport.weibo.com`），**Jina Reader 无法直接穿透访客墙，标记为 BLOCKED / AUTH REQUIRED，非有效成功**。

#### (2) 探针与适配器 API 路由 (Probe & Adapter Route)
- **机制原理**：`WeiboAdapter`（`packages/backend/src/sources/adapters/weibo.ts`）内置了合规的非登录访客握手流程：向 `https://visitor.passport.weibo.cn/visitor/genvisitor2` 发送 `POST` 请求交换获得合法的访客 `SUB` 与 `SUBP` Cookie，之后带 Cookie 请求移动端容器接口 `https://m.weibo.cn/api/container/getIndex?containerid=100103type%3D1%26q=...&page_type=searchall`。
- **命令行探针实测**：`COLLECT_ENABLED=true node scripts/probe-weibo.ts --source weibo-topic-ag --live`
  - 检查时间：`2026-10-08T18:30:08.861Z`
  - 状态：`status: "ok"`, `count: 11`
  - 样本证据：
    - `https://weibo.com/5878848794/RlK3R4vbm`（作者：成都AG超玩会，发布时间：`2026-10-08T10:51:06.000Z`，转评赞：6630 赞 / 663 评 / 113 转）
    - `https://weibo.com/6074356560/RlChj4Dvm`（作者：KPL王者荣耀职业联赛，发布时间：`2026-10-07T15:02:16.000Z`，转评赞：10319 赞 / 1906 评 / 2702 转）
- **狼队关键词实测**：`COLLECT_ENABLED=true node scripts/probe-weibo.ts --source weibo-topic-wolves --live`
  - 检查时间：`2026-10-08T18:30:18.174Z`
  - 状态：`status: "ok"`, `count: 11`
  - 样本证据：
    - `https://weibo.com/6180100850/RlJJc6Zyk`（作者：狼队王者荣耀分部，发布时间：`2026-10-08T10:00:12.000Z`，转评赞：1408 赞 / 228 评 / 655 转）

---

## 3. 本地测试环境与测试运行情况 (Local Test Setup & Suite Runs)

### 3.1 运行中测试数据库探测 (No .env credentials read)
- **进程 / 容器检查**：
  - 通过 `docker ps` 检测到正在运行的容器：
    `70d6320ec4d3 pgvector/pgvector:pg17 ... 127.0.0.1:5432->5432/tcp (kpl-intelligence-db-1)`
  - 查验 `docker-compose.yml` 与 `docs/architecture.md` / `AGENTS.md`：
    - 配置明确指明本地测试数据库容器（`profile: local-db`）绑定在 `127.0.0.1:5432`，环境变量 `POSTGRES_HOST_AUTH_METHOD: trust`，免密开放给本地测试。
    - 数据库测试 URL 规范：`DATABASE_URL=postgres://127.0.0.1:5432/<name>_test` 或 `postgres://postgres@127.0.0.1:5432/kpl_test`。
    - 绝未读取任何 `.env` 敏感文件。

### 3.2 类型检查 (Typecheck)
- **命令**：`npm run typecheck`
- **日志输出文件**：`tmp/community-typecheck.log`
- **真实结果**：存在 2 处类型错误（源于之前未完成的测试文件修改，本任务严格遵循只读调研不改动任何测试）：
  - `tests/content-extractors.test.ts(391,16): error TS18049: 'fullView.community.originalPost' is possibly 'null' or 'undefined'.`
  - `tests/content-pipeline-e2e.test.ts(85,16): error TS18049: 'item.content.community.originalPost' is possibly 'null' or 'undefined'.`

### 3.3 前端构建与前端测试 (Build & Web Tests)
- **命令**：`npm run build -w @aihot/web`
- **日志输出文件**：`tmp/community-build.log`
- **构建结果**：**构建全部成功（✓ built in 577ms）**。
- **Web 测试**：`node --test apps/web/tests/*.test.ts`
- **日志输出文件**：`tmp/community-web-tests.log`
- **测试结果**：**44 passed / 0 failed / 0 skipped**。

### 3.4 后端全量测试套件 (Full Backend Test Suite)
- **命令**：`DATABASE_URL="postgres://postgres@127.0.0.1:5432/kpl_test" npm test`
- **日志输出文件**：`tmp/community-test.log`
- **真实统计结果**：
  - **总用例数 (tests)**：856
  - **通过数 (pass)**：795
  - **跳过数 (skipped)**：54
  - **失败数 (fail)**：7
- **7 项失败用例真实归因分析**（未做任何测试修改）：
  1. `tests/architecture.test.ts`: `COMMUNITY_PUBLICATION_ENABLED` 未在 `.env.example` 声明；
  2. `tests/architecture.test.ts`: `packages/contracts/src/site.ts` 存在未被消费的字段 `parentCommentId`, `collectedAt`；
  3. `tests/content-extractors.test.ts`: 虎扑主帖评论提取断言预期值不匹配（`null !== 4`）；
  4. `tests/discussion-heat.test.ts` (4项): 社区讨论热度阈值算法与预设金标基准存在分值偏移（如 `Expected totalScore >= 60, got 58`、`Bili video value should be >= 50, got 29`）。

---

## 4. 浏览器生命周期清理确认 (Browser Cleanup Compliance)

- 本次调研全流程采用轻量网络探测（`curl`、Node.js 原生 `fetch` 以及 Jina Reader API），**未启动任何 Playwright / Puppeteer / Chrome 无头浏览器自动化会话**；
- 检查系统进程树确认：**无任何后台残留的自动化 Chrome 或 `cliDaemon.js` 进程**，彻底保障宿主机浏览器的单实例排他锁正常。

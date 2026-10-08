# 信源

信源在后台“信源”页管理：新建、试抓一次看看抓到什么、改频率、启停、看失败原因和最近的条目。首次启动时，`industry/sources.json` 里的示范信源会被导入。

## 六种信源

| 类型 | 适合 | 需要 |
|---|---|---|
| `rss` | 有 RSS / Atom 的博客、媒体、Substack、公众号转 RSS 服务 | 无 |
| `web_list` | 没有 RSS 的网页列表（新闻页、博客列表、更新日志） | 写选择器；按需配置 Jina Reader 渲染（按次计费） |
| `json_list` | 返回 JSON 的接口（GitHub Releases 等） | 写字段路径 |
| `x_search` | X（推特）账号 | SocialData 的 key，按请求计费 |
| `mp_account` | 微信公众号 | 极致了（Dajiala）的 key，按请求计费 |
| `external` | 你自己的脚本推送进来的内容 | `INGEST_TOKEN`，见下文 |

`json_list` 的地址或配置可能携带凭据，只跟随同源重定向（协议、主机和端口都相同）。若接口搬到另一个来源，请直接更新信源地址；不要依赖跨源跳转传递认证信息。

每种信源认哪些配置项写在 [`config-keys.ts`](../packages/backend/src/sources/config-keys.ts)。填了不认识的配置项，保存会被拒绝、抓取会直接失败并在后台显示原因，不会悄悄退回通用解析。


## 先预览，再创建

进入 `/admin/sources/new`，填写 ID、名称，选择类型，再把下文对应的 JSON 填入“采集配置（JSON）”。这里填的是配置对象，不要包上 `kind` 或 `config`。切换类型会重置配置，先选类型再粘贴。

名称里全角括号中的备注（比如“某媒体（热点 RSS）”）只给后台看，读者在网页、RSS、Agent Markdown、MCP 和搜索里看到的是去掉备注的名字；X 账号写成 `X：显示名 (@handle)` 的，读者只看到显示名。公开 API 的 JSON 里仍是完整的名字。

`rss`、`web_list`、`json_list`、`x_search` 可以点“预览抓取”：显示条目总数和前 20 条的标题、原文链接、发布时间、摘要，不把条目存入文章库。检查抓到的是文章而不是导航，日期与原文一致，再点“创建”。预览不等于完成生产采集，也不经过后续详情补齐、精选和公开发布流程。

预览仍会发出抓取请求；X 和 Jina 预览也可能产生费用，经过付费回执和预算。`COLLECT_ENABLED=false` 只关闭后台自动采集，不能用它来保证手动预览不访问外部服务。下面的本地 HTML/JSON 示例不需要任何 API key。
### rss

```json
{ "feedUrl": "https://example.com/feed.xml" }
```

可选：`summaryIsBody`（订阅里的摘要就是全文）、`allowCategories` / `denyCategories`（按订阅里的分类过滤）。

### web_list

支持普通 CSS 选择器，`div` 列表也能采集。关键是 `itemSelector` 要选中**每条新闻**，而不是包住所有新闻的容器。例如：

```html
<div class="news-list">
  <div class="news-item">
    <h2><a href="/posts/first">第一条示例新闻</a></h2>
    <time datetime="2026-10-01T09:00:00+08:00">10 月 1 日</time>
  </div>
  <div class="news-item">
    <h2><a href="/posts/second">第二条示例新闻</a></h2>
    <time datetime="2026-10-01T10:00:00+08:00">10 月 1 日</time>
  </div>
</div>
```

对应配置（`example.com` 是占位地址，换成目标网页；可运行版本见[本地示例](#本地跑通-htmljson-示例)）：

```json
{
  "url": "https://example.com/news",
  "parseMode": "html",
  "itemSelector": ".news-list > .news-item",
  "linkSelector": "h2 a",
  "titleSelector": "h2 a",
  "publishedAtSelector": "time",
  "allowUrlPrefixes": ["https://example.com/posts/"]
}
```

- `itemSelector` 在整个页面找条目；`linkSelector`、`titleSelector` 在每个条目内取第一个匹配节点，也可以匹配条目自身。选 `.news-list` 只会得到一个容器，通常只取到第一条新闻；只写 `div` 又会混入嵌套容器。要选重复出现的新闻节点。
- 链接取自 `href`；`/posts/first` 等相对链接按列表 `url` 解析，也可用 `baseUrl` 指定基准地址。标题取节点文字。重复链接会合并，指向列表自身的链接通常会跳过。
- 日期在条目内查找 `publishedAtSelector`，依次读取 `datetime` 属性、`title` 属性、文字。没有时区的日期时间可用 `publishedAtUtcOffset`（默认 `+08:00`）；自带时区的时间保留原时区语义，纯 `YYYY-MM-DD` 按 UTC 零点读。
- `parseMode`：普通网页默认 `html`；`markdown` 按 Markdown 链接读；`docusaurus_changelog` 读更新日志标题。需要 Jina 时，显式把 `url` 写成 `https://r.jina.ai/https://目标站/路径` 并配置 `JINA_API_KEY`，不是抓不到就自动切换。Jina 默认返回 Markdown；要继续使用 CSS 选择器，显式设 `parseMode: "html"`。
- `detail`：列表缺日期、标题或摘要时抓详情页补齐（`publishedAtSelector`、`titleSelector`、`summarySelector` 等）。
- `allowUrlPrefixes` / `denyUrlPrefixes`：只收某些路径下的文章。

### json_list

假设接口返回下面的结构，`itemsPath` 指向数组，其他字段路径相对**每个数组元素**填写。路径用点分隔，不是 JSONPath，不写 `$` 或 `[*]`。

```json
{
  "data": {
    "items": [
      {
        "id": "first",
        "title": "第一条示例新闻",
        "url": "https://example.com/posts/first",
        "summary": "第一条新闻的摘要。",
        "published_at": "2026-10-01T09:00:00+08:00"
      }
    ]
  }
}
```

对应配置：

```json
{
  "url": "https://example.com/api/news",
  "mode": "json_api",
  "itemsPath": "data.items",
  "titlePaths": ["title"],
  "urlTemplate": "{raw:url}",
  "summaryPaths": ["summary"],
  "publishedAtPath": "published_at",
  "externalIdPath": "id"
}
```

- 接口本身返回数组时，省略 `itemsPath`。`titlePaths`、`summaryPaths`、`authorPaths` 是候选路径数组，按顺序取第一个非空值，例如 `["title", "name"]`。
- 已有完整网址时用 `{raw:url}`；只有 slug 时可用 `https://example.com/posts/{slug}`。`{字段路径}` 会编码字段值，`{raw:字段路径}` 原样插入。JSON 列表不会自动把相对网址补成绝对网址，模板应产出完整的 HTTP(S) 地址。
- 日期建议返回带时区的 ISO 字符串；数字时间戳分别设 `publishedAtUnit: "epoch_s"`（秒）或 `"epoch_ms"`（毫秒），`20261001` 这类日期设 `"yyyymmdd"`。
- 缺少标题或无法生成链接的条目会跳过。非空数组全部映射失败时，会报 `no items mapped (check title/url paths)`；路径不是数组时，会报 `items path did not resolve to an array`。

### B站（哔哩哔哩）

B站没有免鉴权的开放接口，但站内搜索接口可以直接用，`json_list` 就能接。关键是 `order=pubdate`：不写它返回的是相关度排序，新视频挤不进前 20 条这个窗口，信源会看起来一直没更新。

**跟官方账号的投稿用账号名当关键词**（下面示例的 `keyword=哔哩哔哩王者荣耀赛事`）。搜索会匹配作者名，20 条基本全部来自该账号；比用赛事名当关键词干净——后者混入大量二路解说，而且标题里会留下搜索高亮插桩的空格（`《 KPL 赛事锐评》`）。UP 主投稿接口（`x/space/wbi/arc/search`）要 wbi 签名且过风控，不要走那条路。

```json
{
  "url": "https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=哔哩哔哩王者荣耀赛事&order=pubdate&page=1",
  "mode": "json_api",
  "headers": { "Referer": "https://www.bilibili.com/" },
  "itemsPath": "data.result",
  "titlePaths": ["title"],
  "urlTemplate": "https://www.bilibili.com/video/{bvid}",
  "summaryPaths": ["description", "tag"],
  "summaryIsBody": true,
  "authorPaths": ["author"],
  "publishedAtPath": "pubdate",
  "publishedAtUnit": "epoch_s",
  "externalIdPath": "bvid",
  "publisherRole": "organization",
  "sortByPublishedAt": true
}
```

- `summaryPaths` 按顺序取第一个非空：优先视频简介，简介为空时退回标签（标签含战队与赛事名，对实体关联有用），`tag` 几乎不会为空。
- **`summaryIsBody: true` 可以保留**：列表里的 `description` 会作为摘要存档，不再冒充正文（内容智能管道按来源形态识别出这是视频，正文状态保持 `pending`，由 `bilibili` extractor 去取真正的视频元数据）。视频简介在网页上标注为「视频简介」，AI 提示明确「简介不是完整视频内容」，禁止据此推断视频里说了什么。
- 简介通常很短，质量评估因此给出 `summary_only`——这是如实表达，不是抓取失败。要更完整的正文只能靠已有字幕/文案，页面上会标「AI 整理」。
- 搜索接口单次最多 20 条、没有游标，`json_list` 每轮全量重扫并按 `bvid` 判重；`order=pubdate` 下新视频进入窗口就会被发现。赛事密集期可以按不同关键词多加几个信源扩大窗口。
- 社区向的信源建议配 `participation_mode: hot_signal`，只作热度证据、不进精选。

### 虎扑

虎扑 PC 站（`bbs.hupu.com`）已经是 React 单页应用，HTML 里没有帖子列表——**换成任何板块名返回的都是同一份「步行街」外壳**，所以 `web_list` 抓不到，RSSHub 用的老选择器（`.bbs-sl-web-post-layout`）也随改版失效了。数据在页面内联的 `window.$$data` 里，用 `json_list` 的 `html_window_var` 模式取。

两个前提。一是板块编号：KPL 讨论在**王者荣耀版 `/kog`**（topicId 88），不是 `/kpl`（那个路由不存在，返回的就是上面说的外壳）。二是排序：`/kog` 默认「最新回复」，要用 `/kog-postdate`（「最新发布」）。

```json
{
  "url": "https://bbs.hupu.com/kog-postdate",
  "mode": "html_window_var",
  "windowVar": "$$data",
  "itemsPath": "topic.threads.list",
  "titlePaths": ["title"],
  "urlTemplate": "https://bbs.hupu.com{raw:url}",
  "authorPaths": ["author.puname"],
  "publishedAtPath": "createdAt",
  "publishedAtUnit": "epoch_ms",
  "externalIdPath": "tid",
  "sortByPublishedAt": true
}
```

- `$$data` 是 100 KB 左右的内联 JSON，`itemsPath` 写到 `topic.threads.list`，一次 50 条。`createdAt` 是毫秒时间戳；帖子链接是 `/642745716.html` 这样的相对路径，用 `{raw:url}` 拼成绝对地址。
- **翻页无效**：`?page=2` 仍返回第一页（分页走 XHR），只有最新 50 条可达。
- 这个版块很活跃，50 条大约只覆盖 2 小时。按产出自适应的间隔会把这类源收敛到 15 分钟，窗口足够；但间隔一旦被调到超过 2 小时就会开始漏内容。
- 帖子自带的 `lights`／`replies`／`read` 互动量**不会保存**（`json_list` 的 `raw` 只留 `externalId`），目前也没有地方消费它们。
- 版块是游戏综合讨论，夹杂推广垃圾（如「我在《合成康平路》拿到了…」），用 `ingestNoiseFilter.dropMarkersTitleOnly` 按标题丢弃即可。注意 `keepIfMatches` 的语义是「命中就不丢」，**不能当白名单**拿来只留 KPL 内容。
- 社区讨论建议 `participation_mode: hot_signal`：只作为证据挂到已有事件上，不自己创建事件，也不进分析队列（不花模型钱）。

### 本地跑通 HTML/JSON 示例

仓库提供两份虚构示例：[news.html](examples/sources/news.html) 和 [news.json](examples/sources/news.json)，各有两条新闻。它们用于核对选择器和字段映射，不是运营信源；示例文章链接不提供正文。

在仓库根目录、Node.js 24.11 以上运行以下命令。服务只监听本机，只提供这两份文件；用 `Ctrl+C` 停止。

```bash
node --input-type=module -e '
import http from "node:http";
import { readFileSync } from "node:fs";
const files = {
  "/news.html": ["text/html; charset=utf-8", readFileSync("docs/examples/sources/news.html")],
  "/news.json": ["application/json", readFileSync("docs/examples/sources/news.json")]
};
http.createServer((req, res) => {
  const file = files[req.url];
  res.writeHead(file ? 200 : 404, { "content-type": file ? file[0] : "text/plain" });
  res.end(file ? file[1] : "Not found");
}).listen(8787, "127.0.0.1");'
```

在同一台机器上，按[非 Docker 部署方式](deploy.md#不用-docker)运行开发 API 和网页，保持采集、模型、飞书和 IndexNow 开关关闭，不启动 worker。仅为此次本机示例，在开发 API 进程设置 `ALLOW_PRIVATE_NETWORK_FETCH=true` 后重启；默认禁止抓内网地址，生产环境拒绝启用此项，验证后移除。若 API 在容器或另一台服务器，`127.0.0.1` 指向它自己，此命令的地址不能直接用于该部署。

分别选择 `web_list`、`json_list`，粘贴配置并点“预览抓取”，无需创建信源：

```json
{
  "url": "http://127.0.0.1:8787/news.html",
  "parseMode": "html",
  "itemSelector": ".news-list > .news-item",
  "linkSelector": "h2 a",
  "titleSelector": "h2 a",
  "publishedAtSelector": "time",
  "allowUrlPrefixes": ["http://127.0.0.1:8787/posts/"]
}
```

```json
{
  "url": "http://127.0.0.1:8787/news.json",
  "mode": "json_api",
  "itemsPath": "data.items",
  "titlePaths": ["title"],
  "urlTemplate": "http://127.0.0.1:8787/posts/{id}",
  "summaryPaths": ["summary"],
  "publishedAtPath": "published_at",
  "externalIdPath": "id"
}
```

两次都应显示 **2 条**，依次为下表内容。JSON 示例还显示对应摘要，HTML 示例没有配置摘要提取。预览 API 的日期是 UTC，后台界面按 `+08:00` 显示为 09:00 和 10:00。

| 标题 | 原文链接 | 预览 API 的 publishedAt |
|---|---|---|
| 第一条示例新闻 | `http://127.0.0.1:8787/posts/first` | `2026-10-01T01:00:00.000Z` |
| 第二条示例新闻 | `http://127.0.0.1:8787/posts/second` | `2026-10-01T02:00:00.000Z` |

可以把 HTML 的 `itemSelector` 暂改成 `.news-list` 对照：只会返回第一条。改回 `.news-list > .news-item` 后恢复两条，这就是“列表容器”和“每条新闻”的区别。

抓真实网页时先看原始 HTTP 响应中有没有新闻节点。普通 HTML 模式不执行 JavaScript；浏览器里看得到、响应里没有的内容，不能靠换一个 CSS 选择器生成。优先找 RSS 或 JSON 接口，或按需配置 Jina / 自己维护的外部采集。`no items matched (html)` 还可能是选择器不匹配、没有 `href` 或标题、链接被前缀规则过滤；先核对响应与配置，不必先更换采集器。

### x_search

这类信源使用 SocialData 搜索，不是把 X 个人主页 URL 填入网页列表。以 `https://x.com/SomeAccount` 为例，取用户名 `SomeAccount`，不要包含 `@` 或整段 URL：

```json
{ "query": "from:SomeAccount -filter:replies", "searchType": "Latest" }
```

`SomeAccount` 是占位用户名，换成你要关注的真实账号。`-filter:replies` 排除回复；`Latest` 按最新内容查找。

在后端运行环境的 `.env` 配置 `SOCIALDATA_API_KEY`，重启 API（预览）和 worker（定时采集）后生效；不要把 key 写进信源 JSON 或提交到仓库。先在后台“设置 → 付费请求上限”检查 SocialData 额度，再按需预览。未配置 key 会报 `SOCIALDATA_API_KEY is not configured`；服务拒绝请求或预算熔断时看后台错误原因。预览可能有付费请求，本文不要求用真实服务验证，结果取决于账号和服务当时的返回。

生产自动采集时，普通账号会被自动合并成一次搜索（每次最多二十几个账号），省请求数；单个信源的手动预览不是合并采集。

### mp_account

```json
{ "ghid": "gh_xxxxxxxx", "nickname": "公众号名称" }
```

每个公众号按它的抓取间隔检查一次（查列表按次计费），新文章的正文一并取回。

需要在后端 `.env` 配置 `DAJIALA_KEY`，`ghid` 换成公众号原始 ID。配置字段用上面的 `ghid` / `nickname`，不要写成 `biz` / `name`。当前 `mp_account` 不支持“预览抓取”；`external` 也不支持主动试抓，按下方推送接口接入。

## 内容形态（Content Profile）

信源抓到的链接不是同一种东西：公众号长文、媒体稿、论坛帖、视频、社交动态的正文结构完全不同。内容智能管道按**来源 + 页面结构**判断它是什么，再选对应的抽取器，而不是把一切都交给 Readability：

```
发现链接 → SourceContentProfile → Extractor（专属 → 家族 → 通用文章 → Readability）→ CanonicalContent → 质量评估 → AI 理解 → 来源感知的网页呈现
```

**内置 profile**（按域名自动识别，无需配置）：`mp.weixin.qq.com` → 公众号文章；`bbs.hupu.com` → 社区帖；`bilibili.com` → 视频；`x.com` → 社交动态。其余来源默认按文章语义处理，页面自带 JSON-LD `articleBody`、语义 DOM 评分、Readability 依次兜底，Jina 是最后手段且如实标注来源（`body_provenance`）。

**新增一个来源通常什么都不用配**：只要域名是上面四种之一，Profile 自动命中；普通新闻站走通用文章抽取器。需要更精确时，在 `config` 里加：

- `contentProfile`：直接指定内置 profile id（`wechat-mp`、`hupu-forum`、`bilibili`、`x-social`）。
- `contentFamily`：声明家族（`publisher` / `official` / `forum` / `social` / `video` / `blog` / `aggregator` / `unknown`）。非虎扑的其他论坛写 `forum`，就复用通用 thread 结构与高价值评论排序，不必等专用 adapter。
- `threadSelectors`（论坛专用，可选）：`post` / `author` / `content` / `time` / `likes` / `floor` / `quote` / `title`，覆盖通用帖子选择器。省略时用内置的一套（`[class*='post']` 等）。

**不同形态的呈现**：文章族走正文（`body_html`）；论坛帖分层展示「原帖 / 楼主补充 / 社区讨论焦点（AI 整理）/ 高亮讨论」，评论绝不混入正文；视频展示封面、时长与「视频简介」；社交动态原样呈现文本与引用。正文完整性如实标注（`full` / `partial` / `summary_only` / `failed`），不完整时页面提示「正文提取可能不完整」并给原文入口。

**质量评估按形态分档**：新闻 350 字才算完整、官方公告 120 字即可、社交帖 30 字即 100%、论坛主帖 80 字加丰富评论区就是好内容。评分与完整度、抽取器、版本、fallback、正文来源（`content_extraction_meta`）都落库，后台「内容链路」页可见，可用 `scripts/re-extract-content.ts` 按来源/类型/质量分批量重跑。

## 分级、参与方式与全文

- **分级** `tier`：`T1` 官方一手（官网、官方博客、机构）、`T1_5` 官方账号与准官方创作者、`T2` 媒体与个人、`EXCLUDE_MP` 不参与精选。入选门槛按分级不同（`industry/selection.ts`）。
- **参与方式** `participation_mode`：`editorial` 进精选和全部动态；`hot_signal` 不单独展示，只作为“大家在讨论什么”的热度证据；`isolated` 不进任何公开页面。
- **一手**：只有 `T1` 算一手，不单独设置。同一条新闻有几篇报道时，代表报道优先选一手的，事件页也优先展示一手报道。
- **发布方**（可选，写在 `config` 里）：
  - `publisherUrlPrefixes`：`T1` 信源自己文章网址的前缀，比如 `["https://example.com/blog/"]`。别的信源（聚合站、转帖）带来的这些网址的文章，只要能认定是唯一一个官方信源的，就改记到它名下。网页列表信源不写时，认它自己列表所在的路径（这篇也要在它的列表里出现过）。
  - `publisherRole`：`T1_5` 账号的身份，`organization`（机构官方账号）或 `person`（官方人员）。再填上信源的 `owner_entity_id`（`industry/taxonomy.ts` 的 `ENTITIES` id），这个账号发的、主体正是这家公司的新闻，就能当代表报道（排在 `T1` 之后）。
- **全文**：`site_fulltext` 决定站内能不能显示全文，`syndicate_fulltext` 决定全文 RSS 能不能带正文。两者**默认都关**，只显示摘要和原文链接；来源明确允许时再打开。公众号、付费墙内容不会因为技术上抓得到就获得全文展示。

## 抓取频率

每个信源有自己的抓取间隔。每天 04:20 会按近 7 天的产出自动调整：产出多的抓得勤，最短 15 分钟（经 Jina 读的网页列表最短 60 分钟）；最长的，一般信源 60 分钟，X 账号和经 Jina 读的网页列表 120 分钟，只作热度证据的 180 分钟。合并搜索的 X 账号跟着合并后的节奏：进精选的半小时一次，只作热度证据的一小时一次。

抓取失败不推进位置，下次从同一处继续；连续失败的信源在后台标红，每周一会在运营群发一份信源周报（配置了飞书内部群时）。

## 规则：旧文不刷屏

首次发现时原文已经发布超过 48 小时的资料、新信源第一次导入的存量条目、标记为回灌的推送，都按原文时间归档：不进入“今天”，也不推送。这条规则所有入口共用，防止一次性导入历史内容刷屏。

## 外部推送接口

自己写脚本抓的内容，可以推进站里，走和普通采集一样的判重、精选和归组。

```
POST /api/ingest/items
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json

{
  "sourceId": "my-crawler",
  "sourceName": "我的抓取脚本",
  "items": [
    { "title": "必填", "url": "必填", "publishedAt": "2026-10-01T08:00:00+08:00", "author": "可选" }
  ]
}
```

- `INGEST_TOKEN` 在 `.env` 里设置，至少 16 位；不设置时接口一律返回 401。
- 每次最多 50 条；每个客户端每分钟最多 10 次。
- 返回 `{"ok": true, "created": <新建条数>}`。不是 JSON 对象的条目、缺标题或网址的条目会被跳过，同一请求里重复的网址只取第一条。
- `sourceId` 不存在时会自动建一个 `external` 信源，默认不进公开页面：到后台把它的参与方式改成 `editorial` 才会出现在站上。
- 在后台暂停信源后，推送接口返回 409，不再接收新文章；恢复信源后可以继续推送。
- 条目的 `raw._aihot.backfill` 为 `true` 时按历史回灌处理（不进入“今天”、不推送）。

## P1 信源目录与调度策略（2026-10）

### 新增字段（迁移 0065_source_directory.sql，`sources` 表）

- `role`：信源身份角色，取值 `league_official`（联盟官方）/ `club_official`（俱乐部官方）/ `principal`（当事人：选手/教练/工作人员本人账号）/ `caster`（解说/主播）/ `media`（媒体）/ `community`（社区），默认 `'media'`（最保守身份）。种子数据按 owner_type 映射：league → league_official、club → club_official、community → community（填写约定见 `industry/sources.json` 的 `$comment`）。
- `priority_weight`：调度排序的显式权重，默认 0；weibo 官方源默认 10（官方动态最快最新）。
- `auto_tune`：默认 true；为 false 时每天 04:20 的 `adaptIntervals` 跳过该源（降频保护）。种子数据只给公众号（含 `wechat://` sogou 回退通道）设 false：这些通道要么走付费 API（Dajiala）要么通道脆弱，频率由运营人工定。
- `verified_evidence` / `last_verified_at`：账号真实性的可复核证据；种子导入时从 `industry/team-accounts.json` 按 sourceId 匹配写入（证据文本变化时 last_verified_at 才刷新，见 `scripts/seed.ts`）。

### 调度权重（`scheduleDueSources`，每分钟）

到期源按 `(priority_weight DESC, tier 权重 DESC, next_fetch_at ASC)` 取 40 个：tier 权重 T1=3、T1_5=2、T2=1、其他=0。防重入逻辑不变（入队后重排约 10 分钟后，防止一分钟内重复入队）。

### 事件加频（`source_boosts` 表）

比赛等事件期间给相关信源临时加频。表字段：source_id、reason、interval_override_minutes、starts_at、ends_at、created_at。`getActiveBoosts(db)` 查出当前有效的 boost（starts_at ≤ now < ends_at）；同一个源多个 boost 并存时取最激进的（override 最小）。调度时若源有有效 boost，下一次到期按 `interval_override_minutes` 计算——只影响下一次，`sources.interval_minutes` 本身永不改写；boost 过期后自动恢复原节奏。

`boostSourcesForMatch(db, { teamSlugs, reason, minutes })` 供 P2 的比赛调度调用（进入 live 时，见 `sources/esports.ts`）：按 owner_entity_id 找到两队相关的 weibo 源，每条写入一条持续 `minutes` 分钟的 boost，加频期间 10 分钟一跳；同 reason 重复调用不叠加（幂等）。注意：`minutes` 是加频持续分钟数（调用方如 `match-live` 传 240），不是间隔。

### auto_tune 语义

`adaptIntervals` 每天 04:20 按近 7 天产出自动调速（活跃 15 分钟 … 安静 120 分钟），但跳过 `auto_tune=false` 的源，跳过的数量和名单记在返回结果（`skipped_auto_tune`，随 job_runs 记录）并打一条结构化日志说明原因。这些源的频率只能在后台手工改——公众号走 Dajiala 付费接口，自动提速会直接烧钱；sogou 回退通道脆弱，经不起高频轮询。

### 后台

信源列表新增「角色 / 调度」列（角色徽标、权重数字、auto_tune=false 时显示「手动调频」）；详情编辑页可改 role、priority_weight、auto_tune、verified_evidence（验证证据文本清空即视为未验证）。

### 各平台真实状态（2026-10-08 实测，本机网络）

- **微博 m.weibo.cn 访客接口**：✅ 可达。流程与采集器一致：先 `POST visitor.passport.weibo.cn/visitor/genvisitor2` 换访客凭证（HTTP 200，拿到 SUB/SUBP），再调 `api/container/getIndex?type=uid&value=6074356560`（HTTP 200，`ok=1`，账号「KPL王者荣耀职业联赛」，蓝V，902.3 万粉丝——与 team-accounts.json 的验证证据一致）。注意：不带访客凭证直接调会被 302 到访客系统页面，必须走 negotiation。
- **B站 series 接口**（`api.bilibili.com/x/series/recArchivesByKeywords?mid=392836434`）：❌ 本机被风控。即使带齐浏览器头（Referer/Origin/UA/Accept），返回 `{"code":-412,"message":"request was banned"}`——这是 B站对本机出口 IP 的封禁，不是接口下线。生产环境换网络后可能正常，本机无法验证成功路径；team-accounts.json 里该账号的验证证据（空间页 SSR + 采集实测）仍是此前可用的依据。
- **微信公众号**：Dajiala / sogou 通道未在本机实测（付费与登录态），以 team-accounts.json 的验证证据为准。

# 信源质量小规模联网试抓

> 结论：微博账号可以通过搜索发现，但本次未完成新增账号的实时 UID/身份核验；真实 KPL 超话被访客系统挡住。虎扑读到一帖正文和高亮回复；B站二创检索及视频简介可读，但未获得可确认的评论作者、评论ID与点赞数。不能据此宣称全平台覆盖、评论采集已上线或官方回放已验证。

## 范围与方法

- 本次时间：2026-10-11 05:52–05:55 UTC（北京时间 13:52–13:55）。这是本报告的联网试抓，不是复述 10 月 7 日的旧实测。
- 使用 agent-reach：按 `SKILL.md`、`references/search.md`、`web.md`、`social.md` 路由，Exa `mcporter` 搜索发现，Jina Reader 公开网页阅读。
- doctor 已由委派方运行：Exa/Jina 可用，B站 active backend 为 OpenCLI。本次**不调用 OpenCLI**；为避免干扰用户桌面 Chrome，本轮选择 Jina 做公开网页可读性探测，不将其结果当作 OpenCLI 或生产采集器的成功验证。
- 只读审阅文件，不运行现有采集/安装脚本，不连接数据库、不启用 worker、不调用付费 API/模型。不启动浏览器，因而没有需关闭的浏览器会话。
- 规模：Exa 共 6 个小查询；Jina 共 6 次（微博超话 1、微博候选主页核验 1、虎扑 2、B站 2），每次超时上限 65 秒，无失败重试、深翻或评论 API 请求。
- 原始本次命令输出暂存 `/tmp/kpl-source-live-probe/`；该目录是临时证据，不保证长期保存。报告内保留来源、请求与关键结果，仓库只新增本文件。
- Exa 搜索摘要和 Jina 返回可能来自索引/缓存；请求发生时间不等于原帖发布时间或页面最新更新时间。Jina HTTP 200 是 Reader 响应状态，不是原站身份核验成功。

## 现有能力盘点（代码审阅，不是联网验证）

| 文件 | 审阅所见 | 对本次需求的边界 |
|---|---|---|
| `docs/content-redesign-source-capabilities.md` | 记录旧微博账号/关键词与虎扑列表试抓、既有 UID | 旧记录不算本次成功；不复制旧帖子数作为新结果 |
| `kpl-intelligence/scripts/probe-weibo.ts` | 默认只读配置；live 需显式 `COLLECT_ENABLED=true`，一页列表，可输出作者ID/名字 | 本次未执行；没有因此获得账号核验结果 |
| `kpl-intelligence/packages/backend/src/sources/adapters/weibo.ts` | 账号模式使用移动端 API；topic/search 实际请求 `100103type=1&q=…` 关键词检索 | 不是 `100808…/super_index` 真超话；互动计数不等于评论正文 |
| `kpl-intelligence/industry/sources.json` | `bili-kpl-official` 指向 MID `392836434`，配置 `upMid` 匹配约束；另有 KPL 视频搜索 | 既有配置不证明当期官方回放可读或每条视频是回放 |
| `kpl-intelligence/packages/backend/src/content/extractors/bilibili.ts` | 可读视频元数据/简介；`main=[]`、`discussion=null` | 不直接获取高赞评论；简介不冒充视频全文/转录 |
| `kpl-intelligence/packages/backend/src/content/extractors/hupu.ts` | 支持 Next 数据/DOM 主帖与回复、高亮排名；完整覆盖需总数一致与终末证据 | Jina 的 Markdown 不是此 HTML 解析器的成功运行证明 |
| `kpl-intelligence/packages/backend/src/content/community-comments.ts` | 已存在受控微博/B站评论代码，要求显式启用、许可端点和分页预算 | “有代码”不等于已配置或本次抓通；本次没有开启或调用它 |
| `kpl-intelligence/scripts/fetch-kpl-seeds.ts` | 官方赛季/战队种子生成脚本，不提供独立选手 roster 端点 | 未运行，不用旧战队映射替代当前赛季名单 |

## 微博候选：搜索发现不等于 UID 核验

### 本次查询

使用 `mcporter call 'exa.web_search_exa(query: "…", numResults: N)'`，输出文件在临时目录：

| 输出文件 | 查询 | N / 结果 |
|---|---|---|
| `exa-casters.txt` | `site:weibo.com KPL 瓶子 拖米 潇洒 黄超 狂人 九天 微博` | 8；瓶子、狂人、联盟及博主等，混入无关结果 |
| `exa-casters-more.txt` | `site:weibo.com 拖米 解说潇洒 解说黄超 九天 王者荣耀 微博` | 6；返回李九、Leah、小鹿、天云、萝卜特等，未定位查询目标主页 |
| `exa-players-clubs.txt` | `site:weibo.com KPL 一诺 暖阳 花海 俱乐部 官方 微博` | 6；混入两家后援会、联盟和康平路账号 |
| `exa-players-more.txt` | `site:weibo.com AG一诺ovo 北京WB暖阳 eStar花海 上海EDGM王者荣耀分部` | 5；一诺、EDGM、暖阳两条、AG主页；花海只见被提及 |
| `exa-supertopic.txt` | `site:weibo.com/p/100808 KPL 超话` | 3；无结果 |
| `exa-supertopic-more.txt` | `KPL超话 site:weibo.com/p OR site:chaohua.weibo.com` | 3；发现 KPL 超话路径，另两条为普通主页 |

账号发现共4次、超话路径发现共2次；均为搜索，不是实时原站资料接口核验。

### 候选目录

下面的“链接数字”仅来自本次 Exa 返回的明确 URL，是候选 UID 线索，**均未通过本次实时原站作者字段/身份核验**。别名、短数字路径不能推算 UID。

| 候选名 / 类别 | 本次证据链接 | 链接数字线索 / 状态 | 质量判断 |
|---|---|---|---|
| 解说瓶子 / 解说 | https://weibo.com/bottleme | 无 UID 证据，别名路径 | 摘要称 KPL 官方解说；观点/内容源，不是联盟战报 |
| 老司机狂人 / 主持 | https://weibo.com/119737022 | 不认定短路径为 UID | 摘要称 KPL 官方主持人；样本大量三角洲内容，需近期 KPL 相关性筛选 |
| 手游侦探 / 电竞博主 | https://weibo.com/shouyou666 | 无 UID 证据 | 摘要称超话创作官；不是联盟官方，战果表述必须回查官方 |
| 解说李九 / 解说 | https://weibo.com/u/5687445105 | `5687445105`，索引线索 | 与旧目录一致，但未重新实时验证 |
| 解说天云 / 解说 | https://weibo.com/u/2677652880?refer_flag=1005050010_ | `2677652880`，索引线索 | 同上 |
| Leah莉娅又迟到啦 / 主播解说 | https://weibo.com/u/5876045506 | `5876045506`，索引线索 | 摘要称王者主播、KPL/QGC解说；历史介绍不保证现职/近期活跃 |
| 解说小鹿 / 解说 | https://weibo.com/lushuyuan | 无 UID 证据 | 仅搜索候选 |
| 游戏解说萝卜特 / 解说 | https://weibo.com/huya16476121?refer_flag=1005050010_ | 无 UID 证据 | 仅搜索候选；别名数字不是已核验 UID |
| AG一诺ovo / 选手 | https://weibo.com/u/6010864489 | `6010864489`，索引线索；实时核验失败 | 摘要称 AG 选手；Jina 主页只返回访客系统 |
| 北京WB暖阳 / 选手 | https://weibo.com/u/5656755958?refer_flag=1005050010_ | `5656755958`，索引线索 | 与后援会账号严格区分；未读到实时作者资料 |
| 上海EDGM王者荣耀分部 / 俱乐部 | https://weibo.com/u/6320517591 | `6320517591`，索引线索 | 摘要包含 EDG 移动电竞分部介绍；新增俱乐部候选，待核验 |
| 成都AG超玩会 / 俱乐部 | https://weibo.com/agcwh ; https://weibo.com/p/1006065878848794/home?from=page_100606&mod=TAB | `5878848794`，主页路径线索 | 本次搜索再次发现，非重新 API 核验 |
| KPL王者荣耀职业联赛 / 联盟 | https://weibo.com/u/6074356560?refer_flag=1005050010_ | `6074356560`，索引线索 | 战报基准角色沿用用户要求；本次未抓当日战报 |
| KPL康平路2025 / 场外资讯候选 | https://weibo.com/u/7935702146 | `7935702146`，索引线索 | 摘要自称官方；需联盟关联/身份确认，不能直接提升赛事事实权威 |

搜索未定位：拖米、潇洒、黄超、九天；花海只见 `@eStarPro花海` 被一诺帖子提及，没有直接 UID 证据。它们仍是待查名称，不是“不存在”。本次没有补查 Gemini/英凯等旧目录账号。

**明确排除误认选手**：`心有暖阳丨Nuanyang`（https://weibo.com/u/5123709118）是暖阳超话主持人/应援账号；`一诺·斑马乐园后援会`（https://weibo.com/u/2719326793）是后援会。上述数字证明搜索定位的是后援会主页，不是暖阳/一诺本人 UID，也不是俱乐部官方。

## Jina 本次真实结果

所有请求使用下面的同一形式，无 Cookie/Token、无浏览器：

```bash
curl -sS --max-time 65 -w '\nPROBE_HTTP:%{http_code}\n' 'https://r.jina.ai/原始URL'
```

### 微博真实超话与账号核验：均未获取内容

1. 搜索发现的真实超话路径：
   https://weibo.com/p/100808085007c1bf736035228c50e871b59729/super_index
   - `jina-supertopic.txt`：Reader HTTP 200，标题 `Sina Visitor System`，`Markdown Content` 为空。
   - **结果：不可用**。没有帖子列表、帖子作者、正文、评论、话题热度。该路径是搜索发现的 KPL 超话候选；正文未成功加载，不宣称话题身份已实时验证。
   - 不能用普通 KPL 关键词搜索或“来自 KPL 超话”的账号帖代替本次真实超话结果。
2. 选手候选主页：
   https://weibo.com/u/6010864489
   - `jina-yinuo-profile.txt`：同为 HTTP 200 / `Sina Visitor System` / 空正文。
   - **结果：UID/身份核验未完成**。没有原站 `user.id`、`screen_name` 或认证字段；只能保留 Exa 的链接线索。

### 虎扑：列表、主帖和高亮回复可读，覆盖为部分

1. https://bbs.hupu.com/kog
   - `jina-hupu-list.txt`，Reader HTTP 200，标题“王者荣耀 - 虎扑社区”。
   - 本次返回 50 个唯一帖子链接、标题、作者、回复/浏览数字。页面含“最新回复/最新发布/24小时榜”，当前输出是最新回复列表，**未证明抓到24小时热门榜排序**；版块混合 KPL、游戏和闲聊，不是纯 KPL。
   - 从列表挑选互动较多的帖子进入详情；没有抓取新榜单、评论 API 或第二页。
2. https://bbs.hupu.com/642875767.html
   - `jina-hupu-thread.txt`，Reader HTTP 200；标题“[流言板]九尾后援会维权：导播恶意剪辑带节奏，俱乐部已提交投诉”。列表显示 48 回复 / 18972 浏览；详情显示 **48 回复 / 15 亮 / 18992 浏览**。两次页面观察的数字不同，不强行合并为同一快照。
   - 主帖署名“虎扑游戏电竞资讯”；正文转述后援会向俱乐部反馈及俱乐部回复已向联盟提交投诉。**这是社区转述，未访问原始微博核实，不据此认定指控事实。**
   - “这些回帖亮了”中可见作者、时间、正文、点赞：例如“獭兔永远的总冠军”，时间 `2026-10-10 16:06:24`，正文“感谢导播老师的鞭策，这不是尾少的原话吗”，`亮了(206)`；另一回复显示 `亮了(106)`，包含引用和讨论。
   - 第一页出现 1–20 楼和下一页 `https://bbs.hupu.com/642875767-2.html`。只读第一页；高亮区与楼层区有重复，正文也有重复渲染。**不是48条全量，更不代表楼中楼已全抓**；未得删除/折叠内容。帖子页“15亮”和回复“206亮”是不同对象，不能互换。
   - 主帖显示“虎扑10月11日讯”，高亮回复却标注10月10日：保留原始字段，不擅自校正发布日期或证明时序。

### B站：能发现二创并读简介，未拿到可确认高赞评论

1. https://search.bilibili.com/all?keyword=KPL%20%E4%BA%8C%E5%88%9B&order=click
   - `jina-bili-search.txt`，Reader HTTP 200，标题“KPL 二创-哔哩哔哩_bilibili”；输出包含43个唯一视频链接（此数是输出中链接去重，不是平台全部结果）。
   - 有标题、UP主页、上传日期和播放/另一个计数。第二个数字未保留图标标签，**不认作评论数或点赞数**。检索按 `order=click` 请求，是播放相关排序，不是高赞评论排序。
   - 二创候选：
     - 《再见了 所有的牢九门》：https://www.bilibili.com/video/BV1sE4UeuERD/ ，UP“是鑫酱ya”，https://space.bilibili.com/1587666715 ，搜索页显示205.5万、1183、2024年9月15日。
     - “一张地图带你回顾挑杯名场面：暖阳独占四点位、ES上演神仙团战！”：https://www.bilibili.com/video/BV1EB4y1E7uJ/ ，UP“星辰团战大赏”，https://space.bilibili.com/406889315 ，显示274.1万、428、2022年10月4日。
     - “【Gemini 陪看 团综】…二路解说主播直播录像回放”：https://www.bilibili.com/video/BV1sysje5Ed6/ ，UP“H702z”，https://space.bilibili.com/384117841 ，属于搬运/陪看候选，**不是官方赛事回放**。
   - 同页出现“哔哩哔哩王者荣耀赛事” https://space.bilibili.com/392836434，与既有配置 MID 相同；仅标题和主页线索，**未验证认证身份或某场完整官方回放**。
   - 结果混入无关游戏、泛娱乐和多年前视频。Reader `Published Time` 标为2024-07-25却包含更晚的视频，不能拿该头部日期作为搜索新鲜度。
2. https://www.bilibili.com/video/BV1sE4UeuERD/
   - `jina-bili-video.txt`，Reader HTTP 200；页面标题、UP“是鑫酱ya”、上传时间 `2024-09-15 06:41:00`、简介“牢九门的故事结束了 而我们的故事才刚开始”、原创/剪辑标签可见。
   - 页面含205.5万与1183等计数，另有9.2万/7048/3.3万，但标签未被稳定保留，不给它们强行命名。
   - 出现播放器附近短文本，如“这一期的质量实在是太高了。”，无法确认是弹幕还是其他界面文本；**没有评论作者、rpid、点赞数可配对的评论记录，不能当作高赞评论**。
   - 只得到视频页/简介，不是视频转录。页面提示“未经作者授权，禁止转载”，应保留原链接与短摘要，不整段搬运或转载视频。
   - Reader头部日期为2024-11-13，不等于页面显示的上传日期；保留两者差异。

## 决策建议（尚未实施）

| 证据 → 发现 | 下一步路径 |
|---|---|
| 微博搜索能返回目标姓名/主页，但主页核验遇访客系统 | 将候选作为人工待核验清单；获取原站作者字段或明确官方关联后才安装 UID；不猜数字 |
| 真超话只返回空访客页 | 本阶段保留原链接/人工精选路线，标明不可用；现有 keyword_search 继续明确叫关键词搜索 |
| 虎扑一帖可读正文/高亮作者与亮数，但只到第一页 | 可优先考虑小样本社区补充；去重、标注partial、引用时区分观点/转述/官方事实 |
| B站二创搜索可读，评论不可确认且榜单陈旧/混杂 | 二创作为文化/讨论线索；高赞评论保持未验证，不启动worker或猜评论API |
| B站赛事账号与既有 MID 线索一致，无完整回放样本 | 官方回放仍需按场次核对认证账号、对阵、上传日期及完整性，不能用陪看/切片替代 |

赛事胜负、比分的编辑战报以微博联盟官方战报为准；赛程和规则核对联盟正式公告，阵容和首发核对联盟名单与对应俱乐部官宣。俱乐部/选手适合补充自身公告和第一人称动态；二路、主播、超话、虎扑和二创仅作为观点/社区内容。此次没有获取可用于更新赛事事实的当日官方战报。

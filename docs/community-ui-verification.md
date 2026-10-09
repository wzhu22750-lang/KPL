# KPL 社区组件前端视觉验证报告 (Community UI Visual Verification)

## 1. 验证目标与概述 (Executive Summary)

本报告记录了对 KPL 业务平台中 6 个核心社区与雷达前端组件的桌面端（1440×900）与移动端（390×844）真实视觉渲染验证结果：
- `ForumThread`: 社区帖子（原帖、楼主补充、多行长文本、引文、高亮讨论）
- `SocialPost`: 社交动态（图文/视频、引用帖、互动指标）
- `VideoContent`: 视频内容（封面、播放时长、互动统计、视频简介与字幕隔离）
- `ContentRenderer`: 多形态内容统一分流与专属视图渲染
- `CommunityFeedback`: 社区讨论反馈（已采集/总数、AI整理讨论焦点、部分/不可用空状态、原文直达）
- `ContentRadar`: 圈内雷达（比赛速览轮播、焦点话题、社区热议、事实资讯、依据展开）

**测试原则与边界**：
- **纯隔离本地测试**：在 `tmp/community-visual-harness` 中搭建轻量 Vite 隔离 Harness，不挂载生产应用路由，零生产 DB / API 写入；
- **显式合成标注 (Synthetic Fixtures)**：测试数据均带 `【测试专用 / 合成数据 - SYNTHETIC FIXTURE - NO DB WRITE - NO LIVE CLAIM】` 标识，严禁伪造实时采集；
- **非 E2E 声明 (What is NOT E2E)**：本次验证为**组件级视觉与布局响应性验证**，**未启用实时采集爬虫，未调用大模型（LLM）API**；
- **全生命周期无残留 (Browser Cleanup Compliance)**：严格遵循自动化清理规范，测试执行完毕后立即显式调用 Playwright `close-all` 并终止 Harness 进程，确认系统无孤儿 Chrome / `cliDaemon.js` 残留。
- **外部文档隔离**：同时存在于工作区的外部文档（如 `docs/content-home-match-archive.md`、`docs/render-match-overview-fix.md`、`kpl-intelligence/docs/community-platform-verification.md` 等）属并行任务，本项目未做任何修改。

---

## 2. 核心缺陷修复与契约对齐 (Bug Fixes & Architecture Alignment)

针对移动端/桌面端渲染中暴露的边界问题，按任务要求对相关前端文件进行了精准修复（保持既有视觉语言，无全局重写）：

1. **Flex 容器超长无空格 URL 溢出修复 (`overflow-wrap: anywhere`)**：
   - 在 `CommunityFeedback.tsx`、`SocialPost.tsx`、`VideoContent.tsx`、`ContentRadar.tsx` 中，用户评论正文、引用文本、动态文本及简介应用 `break-words [overflow-wrap:anywhere]`，防止手机屏幕（390px）下长链接撑爆 Flex 子项导致横向滚动。
2. **`community: null` 回退空状态规范与原文直达 (`fallback community null must empty notice original`)**：
   - 修复了此前 `content.community === null` 时 `ContentRenderer` 直接返回 `null` 导致页面留白的缺陷。
   - 现在当 `community: null` 时，统一渲染空状态通知：`评论暂不可用，未生成替代评论。` 并附带具有触控尺寸（`min-h-11`）的高亮原文直达锚点 `前往原文查看讨论 ↗`。
   - `ForumThread.tsx` 增加对 `community?: CommunityView | null` 的安全防御。
3. **AI 生成内容显式区隔 (AI vs Original Differentiation)**：
   - 严格落实"原话必须来自真实抓取"：原帖、楼主补充、精选评论均不带 AI 标识。
   - 仅在由 AI 生成的讨论焦点处呈现带背景色与细边框的 `AI 整理` 标签徽章（`rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-accent`），视觉边界清晰，绝无模棱两可。
4. **架构契约字段消费与呈现 (`parentCommentId` & `collection.collectedAt`)**：
   - 落实消费 `packages/contracts/src/site.ts` 契约中的 `DiscussionPostView.parentCommentId`（展示为 `回复评论 #{parentCommentId}`）；
   - 落实消费 `CommunityCollection.collectedAt`（展示为 `采集于 <time>{fullDateTime}</time>`，若覆盖有限补充 `· 覆盖有限，不代表全部观众`）；
   - 彻底修复 `tests/architecture.test.ts` 中 `every field of the website's own interfaces is read by the website` 断言要求。

---

## 3. 测试用例矩阵与验证结果 (Scenarios & Quantitative Assertions)

所有用例均在 **桌面端 (1440×900)** 与 **移动端 (390×844)** 双分辨率下执行断言，测量 DOM 宽度差 `scrollWidth <= clientWidth`（横向无溢出）、控制台错误数 `consoleErrors === 0` 以及原文直达锚点有效性：

| 用例 ID | 涉及组件与验证重点 | 桌面端 1440 溢出 (px) | 移动端 390 溢出 (px) | 控制台错误数 | 原文锚点 | 截图产物路径 |
|---|---|---|---|---|---|---|
| `forum-rich` | `ForumThread`<br>多行换行评论、楼主引用补充、超长无空格URL、回复楼层、parentCommentId、collectedAt | **0 (1440/1440)** | **0 (390/390)** | **0** | 存在 (`bbs.hupu.com`) | `output/playwright/community/forum-thread-{desktop,mobile}.png` |
| `media` | `ContentRenderer` + `MediaGallery`<br>多图网格、视频预览海报、大图查看器属性 | **0 (1440/1440)** | **0 (390/390)** | **0** | 存在 (`weibo.com`) | `output/playwright/community/media-gallery-{desktop,mobile}.png` |
| `no-comments` | `CommunityFeedback`<br>零评论、部分采集覆盖说明、空提示、原文直达 | **0 (1440/1440)** | **0 (390/390)** | **0** | 存在 (`bbs.hupu.com`) | `output/playwright/community/no-comments-{desktop,mobile}.png` |
| `video-missing-transcript` | `VideoContent`<br>视频缺失字幕：简介独立展示、不篡改正文、禁止伪造 AI 字幕总结 | **0 (1440/1440)** | **0 (390/390)** | **0** | 存在 (`bilibili.com`) | `output/playwright/community/video-missing-transcript-{desktop,mobile}.png` |
| `social-metrics` | `SocialPost`<br>阅读/点赞/评论/转发/收藏指标排布、引用推文、极长链接断行 | **0 (1440/1440)** | **0 (390/390)** | **0** | 存在 (`weibo.com`) | `output/playwright/community/social-metrics-{desktop,mobile}.png` |
| `fallback-null` | `ContentRenderer` (community: null)<br>论坛帖/视频帖/动态帖缺少评论时统一优雅回退 | **0 (1440/1440)** | **0 (390/390)** | **0** | 存在 (直达原文讨论) | `output/playwright/community/fallback-null-{desktop,mobile}.png` |
| `content-radar` | `ContentRadar`<br>焦点话题、BO7比分、比赛快速时间线、社区热议、评论预览、判断依据 | **0 (1440/1440)** | **0 (390/390)** | **0** | 存在 (含平台外链) | `output/playwright/community/content-radar-{desktop,mobile}.png` |
| `all` | 全组件统一堆叠集成视图 | **0 (1440/1440)** | **0 (390/390)** | **0** | 16 个有效锚点 | `output/playwright/community/all-scenarios-{desktop,mobile}.png` |

---

## 4. 详细截图清单 (Visual Artifacts)

截图已完整归档至仓库内目录 `output/playwright/community/`：

```
output/playwright/community/
├── all-scenarios-desktop.png             # 全组件概览 (1440x900)
├── all-scenarios-mobile.png              # 全组件概览 (390x844)
├── content-radar-desktop.png             # 内容雷达桌面端 (1440x900)
├── content-radar-mobile.png              # 内容雷达移动端 (390x844)
├── fallback-null-desktop.png             # 评论为空回退桌面端 (1440x900)
├── fallback-null-mobile.png              # 评论为空回退移动端 (390x844)
├── forum-thread-desktop.png              # 论坛帖子桌面端 (1440x900)
├── forum-thread-mobile.png               # 论坛帖子移动端 (390x844)
├── media-gallery-desktop.png             # 多媒体画廊桌面端 (1440x900)
├── media-gallery-mobile.png              # 多媒体画廊移动端 (390x844)
├── no-comments-desktop.png               # 零评论状态桌面端 (1440x900)
├── no-comments-mobile.png                # 零评论状态移动端 (390x844)
├── social-metrics-desktop.png            # 社交互动指标桌面端 (1440x900)
├── social-metrics-mobile.png             # 社交互动指标移动端 (390x844)
├── video-missing-transcript-desktop.png  # 视频缺失字幕桌面端 (1440x900)
├── video-missing-transcript-mobile.png   # 视频缺失字幕移动端 (390x844)
└── results.json                          # 自动化测试断言度量原始输出
```

---

## 5. 执行命令复现指南 (Exact Reproduction Commands)

### 5.1 运行 Web 端类型检查与单测
```bash
cd kpl-intelligence
# 1. 运行 Web 类型检查
npm run typecheck -w @aihot/web

# 2. 运行 Web 生产构建
npm run build -w @aihot/web

# 3. 运行 Web 单元测试套件 (44 项用例全过)
node --test "apps/web/tests/*.test.ts"
```

### 5.2 运行自动化视觉验证 Harness 与截图生成
```bash
# 根目录下执行
# 1. 构建 Harness
cd tmp/community-visual-harness && npx vite build && cd ../..

# 2. 运行 Playwright 视觉审查自动化脚本 (包含端口自检、浏览器会话打开、双分辨率截图与断言、严格会话关闭)
node tmp/community-visual-harness/run-audit.mjs
```

### 5.3 浏览器与后台进程生命周期确认 (Cleanup Verification)
```bash
# 确认当前无任何活动的 Playwright 浏览器会话
/Users/kuangqie/.codex/skills/playwright/scripts/playwright_cli.sh list
# 输出: (no browsers)

# 确认系统无任何自动化无头 Chrome 或 cliDaemon 驻留
ps aux | grep -iE "(playwright|chrome.*headless|cliDaemon)" | grep -v grep
```

---

## 6. 验证结论 (Conclusion)

- **组件完整性**：6 个目标组件（`ForumThread`、`SocialPost`、`VideoContent`、`ContentRenderer`、`CommunityFeedback`、`ContentRadar`）在真实样式与 DOM 结构下均表现正常；
- **响应式排版**：经修复 `overflow-wrap: anywhere` 后，在 390px 极窄屏幕下面对超长 URL 和深层嵌套评论，`document.horizontal` 溢出量严格为 0px；
- **真实性约束满足**：严格区分真实抓取原话与带有 `AI 整理` 标签的讨论焦点；视频无字幕时严格不生成伪造正文；
- **架构完整性**：`parentCommentId` 与 `collection.collectedAt` 获得完整消费与渲染，满足架构检查；
- **全流程干净合规**：Harness 严格限制在 `tmp/` 下，浏览器会话已全量关闭，未触碰任何 live 模型或数据库写入。

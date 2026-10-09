# Render 部署后比赛速览缺失：赛程与雷达开关耦合

## 已确认的代码问题

仓库的 `industry/radar.ts` 默认 `RADAR.enabled=false`。本地真实试跑曾通过 `/tmp/kpl-local-trial/enable-radar.mjs` 显式开启；该临时脚本不属于部署产物。

旧首页只从 `/api/site/radar?current=true` 获得比赛卡片。默认关闭时，该 API 返回 `503 content radar disabled`，首页将错误降级为 `null`，连不依赖 AI 的比赛速览一起隐藏。

生产 SSR 的 HTTP 夹具复现了完整调用链：雷达 503，独立赛程有比赛，首页仍没有 `radar-matches`。修复前断言失败，修复后同一命令通过：

```bash
cd kpl-intelligence
node --test --test-name-pattern='closed radar never hides' apps/web/tests/cache.test.ts
```

这是已确认的代码缺陷。用户随后提供站点 URL，线上公开接口与浏览器核验已完成，见下方“线上验收”；没有登录 Render 控制台或读取生产库凭据。

## 修复

- 新增 `/api/site/match-overview`，通过 `publication/match-overview.ts` 独立读取既有比赛、队伍及小局数据；不查询雷达投影、不调用模型、不排队。
- 提取并复用原比赛选择规则：最多 3 场进行中、2 场未来赛程、3 场最近赛果。日期模式与单场雷达仍复用同一基础读取，不复制两套规则。
- 首页独立请求比赛概览；仅在雷达可用时附加其已获准公开的报道，不依赖它取得比分、队徽和赛程。
- 雷达原有关闭门禁保持不变，关闭时不暴露其编辑投影、不启动判断。没有通过开启生产模型或放宽公开权限来修复。
- 没有赛程和读取失败分别显示提示，比赛速览标题及全部赛程入口保留，不制造比赛数据。
- 整页共享缓存受所有上游的最早截止时间和 `no-store` 约束，包括新的赛程接口。

## 验证与边界

- 修复前生产 SSR 复现：失败；修复后同一复现：通过。
- Typecheck、Web build 通过；Web 44 项全部通过。
- 独立测试库完整回归：782 项，728 通过、54 跳过、0 失败。
- 后端回归验证 `RADAR.enabled=false` 时雷达仍为 503、赛程概览为 200、有真实数据库夹具中的比赛、无雷达报道，并且 provider 调用计数不增加。
- 另覆盖赛程空数据/接口故障的 UI、来源筛选、缓存最早失效时间与 `no-store`。
- 第一轮完整测试因原本地临时数据库被停止而中断；没有将其记为通过。改用独立的 `kpl-render-schedule-test-db` / `kpl_render_schedule_test` 后重跑通过，测试容器已停止。未重启当前用户服务、未操作生产数据库。
- 默认端口 3000 的 smoke 没有运行中的服务，未能验证；实际 Render 的首页/赛程接口/样式与浏览器专项验收现已完成；没有声称执行了全站 30 项线上 smoke，也没有以模拟 HTTP 测试代替线上验收。

证据：[audit-artifacts/render-match-overview-fix](audit-artifacts/render-match-overview-fix/)。

## 线上验收

站点：`https://kpl-intelligence.onrender.com/`。仅读取公开页面/接口；没有触发采集、模型或管理操作。

- 首页 HTTP 200，HTML 已包含比赛速览、横向轨道和 5 个比赛档案入口，无赛程空数据/失败提示。
- `/api/site/match-overview` HTTP 200，返回 5 场：狼队–Hero、JDG–DYG，及 AG–LGD、WB–EDG.M、KSG–TES 最近赛果。
- `/api/site/radar?current=true` HTTP 503，`content radar disabled`；预期关闭门禁仍有效，赛程不受其影响。
- 既有 `/api/site/kb/schedule?limit=5` HTTP 200，生产公开数据中确有赛程，不是因为生产库空导致当前缺失。
- 真实浏览器：390px 手机与 1160px 桌面比赛速览可见，5 张卡片，手机右移有效且无页面级溢出；两份首页 CSS 均 HTTP 200。
- 自动化浏览器已关闭。若读者仍看到旧页面，应先刷新/新开窗口验证，不直接把个别客户端状态认定为生产接口故障。

截图：[线上手机](../output/playwright/content-redesign/render-match-overview-mobile.png)、[线上桌面](../output/playwright/content-redesign/render-match-overview-desktop.png)。

## 部署后只读核验

确认 API/Web 一起部署到包含本修复的版本（新接口模块也必须包含在内）。工作期间仓库有其它提交推进，当前 HEAD 已包含接口与页面修改；本执行过程没有代为 commit、push 或部署。

```bash
# SITE 指向实际站点；只请求公开数据，不触发采集或模型。
curl -i "$SITE/api/site/match-overview"
curl -i "$SITE/api/site/radar?current=true"
```

默认雷达关闭时，前者应为 200，后者 503 是预期门禁。如果前者 `matches: []`，需另查生产库的比赛数据与官方采集状态；本地试跑数据库不会随 git push 同步到 Render。若前者 404 或 5xx，再核验 API/Web 版本、部署日志、数据库连接与迁移，不应直接启用 AI 雷达来掩盖问题。

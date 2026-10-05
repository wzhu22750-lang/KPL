# KPL Intelligence

KPL（王者荣耀职业联赛）智能信息检索平台：战队 / 选手 / 英雄 / 赛程赛果 / 历史交手 / 积分榜的结构化数据站，叠加精选资讯流与 AI 问答。基于 AIHOT 框架做 KPL 领域化改造而来。

## 功能清单

- **赛事数据库**：赛季、战队、选手、英雄档案；赛程赛果（含每局 BP、选手数据、MVP）
- **战队对决（H2H）**：任意两队历史交手总战绩、小局得失与胜负走势
- **积分榜**：按赛季的胜负与胜率
- **英雄榜**：登场率、胜率与常用选手
- **AI 问答（/ask）**：意图理解 → 三通道检索（结构化查询 / pgvector 语义 / trigram 关键词，RRF 融合）→ 生成 + 一致性护栏（编造数字与张冠李戴自动降级），SSE 流式输出，附来源引用与数据卡片
- **精选资讯流**：多信源采集、AI 质检、事件归组、日报周报

## 架构

```mermaid
flowchart LR
  subgraph 采集
    SMOBA[KPL 官方接口 prod.comp.smoba.qq.com] --> WORKER
    DAJIALA[Dajiala 公众号采集] --> WORKER
    INGEST[外部 ingest] --> WORKER
  end
  subgraph worker 进程
    WORKER[worker：pg-boss 任务队列<br>同步/归组/分析/发布] --> DB[(PostgreSQL 17<br>+ pgvector)]
  end
  subgraph api 进程
    API[apps/api<br>/api/site/* 只读站点 API<br>/api/site/qa/stream AI 问答 SSE] --> DB
    KB[kb 层：read 查询 / chunks 切块 / qa 检索与护栏] --> API
  end
  WEB[apps/web<br>React Router 页面] -->|HTTP| API
  ADMIN[admin 后台] --> DB
```

三个进程（web / api / worker）+ PostgreSQL 17（pgvector 1024 维 HNSW 索引）。web 进程不碰数据库，只经 HTTP 调 api；AI 问答的检索与护栏都在 api 侧的 kb/qa 层。

## 本地跑起来

依赖：Node.js ≥ 24.11、Docker（本地库用 `pgvector/pgvector:pg17`，容器名 `kpl-pg`）。数据库两种模式：本地 Docker（`postgres://postgres:kpl@127.0.0.1:5432/kpl_dev`）或 Supabase（`.env` 的 `DATABASE_URL`），跑批脚本时用 `DATABASE_URL` 环境变量覆盖。

```bash
npm install
docker compose --profile local-db up -d db        # 启动本地库（或用 Supabase）
node --env-file=.env scripts/migrate.ts           # 迁移（幂等）
node --env-file=.env scripts/seed.ts              # 信源种子
node --env-file=.env scripts/seed-kpl.ts          # KPL 实体种子（幂等）

# 三进程
node --env-file=.env apps/api/src/main.ts         # api
node --env-file=.env apps/web/server.ts           # web（前端改动后 npm run build -w @aihot/web）
node --env-file=.env apps/worker/src/main.ts      # worker（采集/归组/日报）

# kpl_vault 精选长文入库（workspace 根目录的 kpl_vault/，切块 + 实体关联）
node --env-file=.env scripts/import-kpl-vault.ts

# 测试（必须指向 *_test 库的本地容器）
DATABASE_URL="postgres://postgres:kpl@127.0.0.1:5432/kpl_test" npm test
npm run typecheck
npm run build -w @aihot/web
```

测试每个文件跑在独立的数据库副本上（`tests/databases.ts` 自动从模板库克隆）；涉及付费模型的测试一律指向本地 stub（`tests/setup.ts`），不触真实 API。

## 数据来源

- **KPL 官方接口**（prod.comp.smoba.qq.com）：赛季 / 战队 / 选手 / 英雄 / 赛程 / 每局 BP 与选手数据，`scripts/import-kpl-history.ts` 幂等回灌
- **Dajiala（大家拉）**：微信公众号文章列表与正文（KPL 官方公众号与俱乐部号，付费 API）
- **kpl_vault 精选语料**：workspace 根目录 Python 流水线（`curator.py` 质检门禁）产出的深度长文，`scripts/import-kpl-vault.ts` 入库切块并建立实体关联

## 文档索引

- `../docs/交接文档.md`（workspace 根仓库）—— 主站现状、已知坑（pg-boss SSL、Supabase 连接池）与遗留事项
- [docs/KPL-Intelligence-技术方案.md](docs/KPL-Intelligence-技术方案.md) —— 领域化改造的架构决策与设计依据
- [docs/deploy.md](docs/deploy.md) —— 部署手册（开头含 Supabase 上线前必做的安全项）
- [docs/architecture.md](docs/architecture.md)、[docs/customize.md](docs/customize.md) —— 上游框架的架构与定制说明（部分章节描述 AIHOT 原版机制，KPL 版已替换/关闭的以文内 ⚠️ 标注为准）
- `../DATA_STRATEGY.md`（workspace 根仓库）—— 采集双通道与质检入库规范

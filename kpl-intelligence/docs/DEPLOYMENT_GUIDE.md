# 康平路情报站 (KPL Intelligence) 生产环境部署与运维手册

本手册为 康平路情报站（KPL Intelligence，王者荣耀职业联赛情报与资讯系统）的生产交付部署与运维标准规程。系统对标商业级交付基准，提供高可用、多信源持续保鲜与安全加固的完整容器化运行环境。

---

## 1. 系统架构总览 (Architecture Overview)

系统采用模块化多服务容器架构：

```
                         Internet (HTTPS / 443, HTTP / 80)
                                      │
                                      ▼
                   ┌──────────────────────────────────────┐
                   │        Caddy 反向代理容器 (Profile: https)  │
                   │    (自动申请/续签 TLS 证书, Gzip/Zstd 压缩)    │
                   └──────────────────┬───────────────────┘
                                      │  反向代理 :3000
                                      ▼
                   ┌──────────────────────────────────────┐
                   │             Web 服务容器              │
                   │   (React Router SSR + Client SPA +   │
                   │    安全静态资源托管，绑定 127.0.0.1:3000)    │
                   └──────────┬───────────────────────────┘
                              │ 内部反代 /api/* :3001
                              ▼
┌─────────────────────────────────────┐      ┌─────────────────────────────────────┐
│             API 服务容器             │      │            Worker 任务容器           │
│   (Fastify, 业务鉴权, RSS, MCP,       │      │   (PgBoss 调度队列, 信源轮询,         │
│    内容抽取，仅内部互通或 127.0.0.1:3001) │      │    模型打分/摘要, 优雅关机 210s)     │
└──────────────────┬──────────────────┘      └──────────────────┬──────────────────┘
                   │                                            │
                   └──────────────────┬─────────────────────────┘
                                      │  DATABASE_URL (SSL/TLS 加密, 连接池隔离)
                                      ▼
                   ┌──────────────────────────────────────┐
                   │    Supabase / 托管 PostgreSQL 17      │
                   │   (pg_trgm 文本检索 + pgvector 语义召回)  │
                   └──────────────────────────────────────┘
```

### 核心服务分工
- **Web (apps/web)**: Node.js 24 + React Router SSR 服务，承载前台高保真阅读器、多形态内容渲染（长文/论坛/社交动态/视频）与暗黑模式。
- **API (apps/api)**: Fastify 极速服务，提供数据聚合、鉴权认证、管理后台接口、MCP Server 与 RSS Feed。
- **Worker (apps/worker)**: PgBoss 异步调度进程，负责信源定时拉取、LLM 分析打分、事件归组、热点榜快照与自动日报生成。
- **Setup (scripts/migrate.ts + seed.ts)**: 串行一次性容器，容器启动前自动执行数据库迁移、信源配置种子与 KPL 战队/选手实体基线灌入。
- **Caddy (deploy/Caddyfile)**: 生产网关，自动化管理 Let's Encrypt 证书并代理外部流量。

---

## 2. 部署前置条件 (Prerequisites)

1. **服务器环境**：
   - 操作系统：Ubuntu 22.04 LTS / Debian 12 / Rocky Linux 9 或更高版本（支持 x86_64 或 ARM64）。
   - 最低配置：2 核 CPU / 4GB 内存 / 20GB SSD（推荐 4 核 8GB）。
   - 依赖工具：Docker Engine >= 26.0、Docker Compose v2 >= 2.24。
2. **托管数据库 (Supabase)**：
   - 创建 Supabase PostgreSQL 17 项目（区域推荐 `AWS ap-southeast-1` 或美西）。
   - 获取带 TLS 的连接串（支持 Session Pooler 或 Direct Connection）。
3. **域名解析**：
   - 将生产域名（如 `kpl.example.com`）解析至服务器公网 IP，确保 80 与 443 端口未被云安全组拦截。
4. **模型 API Key**：
   - DeepSeek API Key（或 OpenAI / 通义千问兼容接口）。
   - 阿里云百炼 API Key（用于 Embedding 向量归组，可选）。

---

## 3. 环境变量配置指南 (.env)

从模板创建生产配置文件：
```bash
cp .env.production.example .env
chmod 600 .env
```

### 关键配置项说明与安全基线

| 配置变量名 | 推荐取值 / 格式 | 说明与安全红线 |
|---|---|---|
| `SITE_URL` | `https://kpl.example.com` | 站点完整外部访问地址（末尾无斜杠） |
| `SITE_DOMAIN` | `kpl.example.com` | 供 Caddy 绑定与申请 TLS 证书的域名 |
| `NODE_ENV` | `production` | 固定为 production，生产环境强制校验安全性 |
| `ADMIN_PASSWORD` | 至少 16 位高强度字符串 | 后台 `/admin` 登录密码，**生产环境严禁弱口令** |
| `SESSION_SECRET` | `openssl rand -hex 32` | 会话签名密钥，必须为 64 位十六进制随机串 |
| `IMG_PROXY_SIGN_SECRET` | `openssl rand -hex 32` | 图片防盗链代理签名密钥 |
| `DATABASE_URL` | `postgres://...?sslmode=require` | 数据库连接串，**必须包含 sslmode=require** |
| `DATABASE_POOL_MAX` | `3` ~ `5` | **连接池上限**：避免容器并发启动撑爆 Supabase 连接 |
| `PGBOSS_POOL_MAX` | `2` | Worker 队列连接池上限 |
| `TRUST_PROXY` | `true` | 置于 Caddy/Nginx 之后必须为 true 以获取真实访客 IP |
| `COLLECT_ENABLED` | `true` | 信源抓取总开关（初次冒烟可先设为 false） |
| `MODEL_CALLS_ENABLED` | `true` | 大模型分析与摘要总开关 |

### 生产安全红线（必查）：
1. **Supabase PostgREST (Data API) 关闭**：
   - 打开 Supabase Dashboard -> **Project Settings** -> **API**。
   - 确认关闭 Data API (PostgREST) 暴露，杜绝外部用户通过公开的 anon key 绕过后端直查数据库。
2. **禁止内网抓取旁路**：
   - 确保 `ALLOW_PRIVATE_NETWORK_FETCH` 未开启（默认 false），杜绝 SSRF 风险。
3. **禁止开发免密登录**：
   - 严禁配置任何以 `DEV_AUTH_` 开头的变量，生产启动时将直接阻断并报错退出。

---

## 4. 一键自动化部署流程 (Automated Deployment)

项目内置生产一键部署与健康验收脚本 `scripts/deploy-production.sh`。

### 首次部署命令：
```bash
# 1. 赋予执行权限并进入项目目录
cd kpl-intelligence
chmod +x scripts/deploy-production.sh

# 2. 一键构建、预检、迁移并拉起 HTTPS 服务
./scripts/deploy-production.sh --profile https
```

### 部署脚本自动化执行步骤：
1. **基础工具与配置检查**：核验 Docker、Docker Compose、`.env` 文件存在性。
2. **Pre-flight (pre-migrate)**：校验环境变量合规性、TLS 参数、连接池预算及网络联通。
3. **Docker 镜像构建**：基于 Node 24 运行时构建优化镜像 `kpl-intelligence-app`。
4. **Setup 串行执行**：自动运行 `scripts/migrate.ts` 应用未执行的迁移，并执行信源和战队实体 Seed。
5. **Pre-flight (post-migrate)**：复核全部 60+ 项迁移完整对齐，核心业务表与向量索引就绪。
6. **拉起服务与网关**：启动 API、Worker、Web 及 Caddy 反代。
7. **健康检查轮询**：等待 `/api/health` 与 Web 前台返回 200 OK，输出部署看板。

---

## 5. 多信源保鲜策略与调度规则 (Source Ingestion)

系统在 `apps/worker/src/schedules.ts` 与 `industry/sources.json` 中配置了三级调度保鲜矩阵：

| 级别 | 信源类型与代表信源 | 轮询频次 | 设计考量与策略 |
|---|---|---|---|
| **Tier 1 (增量赛况)** | 官方赛事 API (`esports-annual-2026`) | **每 30 分钟** | 实时获取积分变动、比赛战报与选手局表现，比赛日高频保鲜 |
| **Tier 1.5 (舆论战报)** | B站赛事动态、虎扑王者荣耀版 (`hupu-kog`) | **每 60 分钟** | 赛后热点舆论、精彩集锦与多角度战术讨论，兼顾社区活跃度 |
| **Tier 1 (深度长文)** | 官方与俱乐部微信公众号 (`mp-kpl-official`, `mp-ag` 等) | **每 120 分钟** | 俱乐部官方公告、深度专访与大宗转会宣发，保护商用接口额度 |

### 优雅关机保证 (Graceful Shutdown)
Worker 容器在 `docker-compose.yml` 中设置了 `stop_grace_period: 210s`。在服务升级或重启时，后台正在调用大模型（单次请求可能耗时 60~180s）的任务将被允许完整交付，杜绝产生半截付费凭证或重复扣费。

---

## 6. 知识库与精选内容导入 (KPL Vault)

系统支持导入 `kpl_vault/` 下的高质量精选纯文本长文，并保留真实发布时间与实体关联：

```bash
# 1. 演练导入（零写库安全验证）
node --env-file-if-exists=.env scripts/import-kpl-vault.ts --dry-run

# 2. 正式导入（支持幂等去重，已存在文章自动跳过）
node --env-file-if-exists=.env scripts/import-kpl-vault.ts
```

---

## 7. 日常运维与监控排障 (Day-2 Operations)

### 常用运维管理命令
```bash
# 查看所有容器实时运行状态
docker compose ps

# 查看各容器日志
docker compose logs -f api       # 业务 API 日志
docker compose logs -f worker    # 后台抓取与模型分析日志
docker compose logs -f web       # 前台渲染与访问日志
docker compose logs -f caddy     # HTTPS 网关与证书日志

# 单独重启某个服务
docker compose restart worker

# 重新拉取并应用最新代码
git pull
./scripts/deploy-production.sh --profile https
```

### 系统健康排查矩阵

| 现象 | 可能原因 | 排查与修复手段 |
|---|---|---|
| **API 报错 `EMAXCONNSESSION`** | Supabase 连接数耗尽 | 检查 `.env` 中 `DATABASE_POOL_MAX` 是否超标，调整为 3，Worker `PGBOSS_POOL_MAX` 调整为 2。 |
| **HTTPS 证书申请失败** | 域名未解析或 80/443 被防火墙拦截 | 检查域名 A 记录，确认云厂商安全组放行 TCP 80 与 443。 |
| **抓取任务暂停或无产出** | `COLLECT_ENABLED` 未开启 | 检查 `.env` 中 `COLLECT_ENABLED=true`，查看 `docker compose logs -f worker`。 |
| **模型调用报错 401/429** | API Key 失效或额度不足 | 检查 `LLM_API_KEY` 有效性，后台“设置”页面可查看调用配额监控。 |
| **数据迁移报错** | 存在未对齐迁移 | 运行 `npm run preflight:production` 进行只读排查，再运行 `npm run db:migrate`。 |

---

*文档版本: 2026-10-07 / KPL Intelligence Production Team*

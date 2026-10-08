# 康平路情报站 (KPL Intelligence)

KPL（王者荣耀职业联赛）内容采集与数据平台：双通道采集微信公众号等信源内容，经统一质检门禁进入精选知识库，并支撑主站的战队/选手/赛程数据与 AI 问答能力。

## 目录结构

| 目录/文件 | 说明 |
| --- | --- |
| `kpl-intelligence/` | 主站核心系统（TypeScript monorepo：web / api / worker / backend / contracts / database / industry） |
| `kpl_vault/` | 精选文章知识库（质检准入后的 Markdown + 离线 HTML + metadata.json + 索引/审计报告） |
| `reference-projects/` | 只读参考项目 |
| `AIHOT/` | 上游原版项目（只读） |
| `curator.py` | 双阶段门禁：规则粗筛 + AI 内容价值评分，保留战队归档 |
| `quality_scoring.py` | 六维评分校验、分类权重、模型调用与准入策略 |
| `dajiala_client.py` | 主通道：大家拉（dajiala.com）商业 API 适配器（微信公众号历史文章 / 官方微博） |
| `kpl_scraper.py` | 辅助通道：curl-cffi 轻量微信文章抓取器（TLS 指纹伪装，无图纯净版） |

## 生产环境部署与运维

详见完整部署手册：[`kpl-intelligence/docs/DEPLOYMENT_GUIDE.md`](./kpl-intelligence/docs/DEPLOYMENT_GUIDE.md)。

```bash
cd kpl-intelligence

# 1. 复制生产配置模板并填入密钥
cp .env.production.example .env

# 2. 运行生产环境预检（验证数据库连通性、TLS、连接池与迁移状态）
npm run preflight:production

# 3. 一键构建、迁移、拉起容器并完成健康检查（带 HTTPS 自动证书）
./scripts/deploy-production.sh --profile https
```

## 主站运行方法（TypeScript Monorepo 开发环境）

```bash
cd kpl-intelligence

# 1. 安装依赖
npm install

# 2. 类型检查与测试
npm run typecheck

# 3. 启动开发服务
# 需要本地 Docker pgvector 或 Supabase 配置（参考 .env.example）
npm run dev
```

## Python 采集流水线用法

架构见 [DATA_STRATEGY.md](./DATA_STRATEGY.md)（双通道采集 + AI 质检准入）：

```bash
# 1. 配置主通道密钥（或写入项目根目录 .env 文件）
export DAJIALA_API_KEY="你的大家拉API密钥"

# 2. 拉取公众号历史文章列表并导出元信息（默认 KPL 官方号，产物供 curator 消费）
python3 dajiala_client.py --export-json discovered_urls.json
#    可选：--biz gh_xxx（逗号分隔指定公众号）、--pages N（翻页数）

# 3. 校准完成后显式启用评分（可能产生模型费用；默认关闭）
# 使用提供 /chat/completions JSON 输出的服务，凭据通过环境变量注入
export KPL_QUALITY_API_BASE="你的模型服务地址（含 /v1 等前缀）"
export KPL_QUALITY_MODEL="你的模型名称"
export KPL_QUALITY_API_KEY="你的模型密钥"
export KPL_QUALITY_MODEL_CALLS_ENABLED=true

# 4. 抓取原文 → 规则粗筛 → AI 六维评分 → 合格文章归档
python3 curator.py
# 不清空旧库；模型未配置、失败或输出非法时待复核，不退回关键词准入。

# 5. kpl_vault/ 下生成 INDEX.md、AUDIT_REPORT.md、QUALITY_AUDIT.json
```

依赖锁定见 `requirements.txt`（运行时）与 `requirements-dev.txt`（开发）。

## 测试

```bash
python3 -m pytest tests_py/ -v
```

全部用例离线运行（不触网、不依赖真实密钥；文件系统测试仅使用临时目录）。
固定模型响应只验证准入策略与管道契约；真实判断能力需要人工标注集及留出集评测。

## 相关文档

- [当前AI精选逻辑审查报告](./docs/ai-curation-review.md) —— 修改前流程、问题与评分方案
- [AI 精选运行与验收说明](./docs/ai-curation-quality.md) —— 配置、字段、测试与上线边界

- [docs/交接文档.md](./docs/交接文档.md) —— 主站现状、已知坑（pg-boss SSL、Supabase 连接池等）与遗留事项
- [DATA_STRATEGY.md](./DATA_STRATEGY.md) —— 采集双通道架构与质检入库规范

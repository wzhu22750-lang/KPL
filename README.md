# KPL Intelligence

KPL（王者荣耀职业联赛）内容采集与数据平台：双通道采集微信公众号等信源内容，经统一质检门禁进入精选知识库，并支撑主站的战队/选手/赛程数据与 AI 问答能力。

## 目录结构

| 目录/文件 | 说明 |
| --- | --- |
| `kpl-intelligence/` | 主站（独立 git 仓库，TypeScript monorepo：web / api / backend / contracts） |
| `kpl_vault/` | 精选文章知识库（质检准入后的 Markdown + 离线 HTML + metadata.json + 索引/审计报告） |
| `reference-projects/` | 只读参考项目 |
| `AIHOT/` | 上游原版项目（只读） |
| `curator.py` | AI 质检与初筛门禁：非 KPL 内容剔除、800 字深度门槛、战队精细归档 |
| `dajiala_client.py` | 主通道：大家拉（dajiala.com）商业 API 适配器（微信公众号历史文章 / 官方微博） |
| `kpl_scraper.py` | 辅助通道：curl-cffi 轻量微信文章抓取器（TLS 指纹伪装，无图纯净版） |

## Python 采集流水线用法

架构见 [DATA_STRATEGY.md](./DATA_STRATEGY.md)（双通道采集 + AI 质检准入）：

```bash
# 1. 配置主通道密钥（或写入项目根目录 .env 文件）
export DAJIALA_API_KEY="你的大家拉API密钥"

# 2. 拉取公众号历史文章列表并导出元信息（默认 KPL 官方号，产物供 curator 消费）
python3 dajiala_client.py --export-json discovered_urls.json
#    可选：--biz gh_xxx（逗号分隔指定公众号）、--pages N（翻页数）

# 3. 运行质检门禁：逐篇抓取原文 → 质检初筛 → 合格文章归档
python3 curator.py
#    ⚠️ curator 每次运行会清空并重建 ./kpl_vault/

# 4. 产物：精选文章位于 kpl_vault/，含 INDEX.md（总目录）与 AUDIT_REPORT.md（质检审计）
```

依赖锁定见 `requirements.txt`（运行时）与 `requirements-dev.txt`（开发）。

## 测试

```bash
python3 -m pytest tests_py/ -v
```

全部用例离线运行（不触网、不依赖真实密钥与文件系统）。

## 相关文档

- [docs/交接文档.md](./docs/交接文档.md) —— 主站现状、已知坑（pg-boss SSL、Supabase 连接池等）与遗留事项
- [DATA_STRATEGY.md](./DATA_STRATEGY.md) —— 采集双通道架构与质检入库规范

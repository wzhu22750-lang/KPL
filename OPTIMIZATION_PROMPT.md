# KPL Intelligence 项目优化任务书（分阶段执行版）

> **使用方式（给布置任务的人看，执行任务的 AI 也要读）**：
> 本任务书分 7 个阶段。每次只把一个阶段完整贴给执行模型，等它通过该阶段验收后再给下一个阶段。不要一次全贴。
> 每个阶段结尾有「验收门禁」，全部通过才允许进入下一阶段。

---

## 全局铁律（每个阶段都生效，违反任何一条都算失败）

1. **工作区根目录是 `/Users/kuangqie/Documents/VibeCoding/KPL`**。下文所有相对路径都相对于它。`kpl-intelligence/` 是独立的 git 仓库（自己的 `.git`），根目录外层还有一个 git 仓库，两个仓库的提交要分开做。
2. **只读目录，一个字节都不许改**：`reference-projects/`、`AIHOT/`、`kpl_vault/`（它是数据资产，只许读）。
3. **不许删除任何未备份的文件；不许执行 `git push`、`git reset --hard`、`git clean`、`rm -rf`；不许改写 git 历史**（rebase / amend / filter-branch 全禁止）。
4. **不许触碰真实外部服务**：不调用真实 LLM API（百炼/DashScope）、不调真实 Dajiala API、不抓真实网页。所有测试用 mock / 假服务。唯一允许的例外是阶段内明确写了「需要真实连接」的步骤。
5. **不许新建文档文件来"汇报"**：验收靠命令输出证明，不靠写总结 markdown。唯一允许新建的文档是本任务书明确点名的（根 README、`kpl-intelligence/README.md`）。
6. **遇到以下情况必须停下来向人报告，不许自行决定**：发现疑似泄露的密钥、需要删除数据、需要付费（Dajiala 充值）、需要登录 Supabase Dashboard 的手动操作、测试失败原因超出本阶段范围。
7. **commit message 用中文，格式仿照各仓库现有风格**（先跑 `git log --oneline -5` 看风格）。每个阶段结束按该阶段指定的提交计划提交。
8. **每改完一个文件，立即跑该阶段指定的验证命令**。红了就立刻修，不许攒到最后一起验。
9. **开始前必读**（每个阶段开工前重读与本阶段相关的部分）：
   - `DATA_STRATEGY.md`（采集与质检规范）
   - `docs/交接文档.md`（主站现状与已知坑，特别是 pg-boss SSL、Supabase 连接池限制）
   - `kpl-intelligence/docs/KPL-Intelligence-技术方案.md`（架构决策依据）

---

# 阶段 0：盘点未提交改动并入库（P0，预计 1–2 小时）

> **为什么最先做**：`kpl-intelligence` 工作区有 49 个未提交改动，其中已经包含 H2H 页（`apps/web/app/routes/h2h.tsx`）、英雄页（`heroes.tsx`/`hero.tsx`）、积分榜（`standings.tsx`）、荣誉迁移（`database/migrations/0061_kpl_honor_enrichment.sql`）、wechat2rss 信源等**后续阶段依赖的半成品**。不入库就没法判断后续阶段哪些已经做完了。

## 步骤

### 0.1 根仓库盘点与提交

```bash
cd /Users/kuangqie/Documents/VibeCoding/KPL
git status --short
```

预期看到：`DATA_STRATEGY.md`、`curator.py`、`dajiala_client.py`、`kpl_scraper.py`、`kpl_vault/` 未跟踪；`docs/交接文档.md` 已修改。

1. 先更新 `.gitignore`。当前完整内容只有 6 行（`.DS_Store`、`.mimosa/`、`/AIHOT/`、`/reference-projects/`、`/kpl-intelligence/`）。**追加**（不许删原有行）：

```gitignore

# Python
__pycache__/
*.pyc

# 环境变量与密钥
.env
.env.*
!.env.example

# 采集中间产物
discovered_urls.json
*.log
```

2. 删除缓存：`rm -rf __pycache__`（这是唯一被允许的删除操作）。
3. 通读 `curator.py`、`kpl_scraper.py`、`dajiala_client.py` 三个文件全文，确认里面**没有硬编码密钥**（搜 `sk-`、`api_key = "`、`Bearer `，命中的只能是环境变量读取逻辑）。若发现真实密钥 → 立即停止并报告（铁律 6）。
4. 分 3 个 commit 提交：
   - commit 1：`.gitignore` 更新 + `docs/交接文档.md` 的修改，message 类似 `chore: 完善 gitignore（Python 缓存/密钥/中间产物）+ 交接文档更新`
   - commit 2：`DATA_STRATEGY.md` + 三个 Python 脚本，message 类似 `feat: 双通道采集流水线（Dajiala 适配器 + 轻量爬虫 + AI 质检门禁）`
   - commit 3：`kpl_vault/` 整个目录（16 篇文章知识库 + INDEX.md + AUDIT_REPORT.md），message 类似 `data: KPL 精选知识库首批 16 篇（含质检审计报告）`
   - ⚠️ 提交前先 `du -sh kpl_vault` 看体积。若超过 100MB，停下来报告，由人决定是否用 Git LFS。

### 0.2 kpl-intelligence 盘点

```bash
cd /Users/kuangqie/Documents/VibeCoding/KPL/kpl-intelligence
git status --short
git diff --stat
```

逐个文件跑 `git diff <file>`（已修改的 28 个）和通读新文件（19 个未跟踪），然后**写一份盘点清单贴在回复里**（不是写文件），格式：

```
| 文件 | 性质（新功能/修复/临时调试/领域迁移残留） | 建议提交组 |
```

判断「临时调试」的依据：含 `console.log` 且无明显产品价值、含硬编码 localhost 地址、含被注释掉的大段旧代码。发现疑似调试残留 → 贴在清单里标注「疑似残留，待人确认」，**不许直接删**。

### 0.3 验证未提交改动的质量

```bash
cd /Users/kuangqie/Documents/VibeCoding/KPL/kpl-intelligence
npm run typecheck
```

- 若 typecheck 通过 → 继续 0.4。
- 若失败 → 修复类型错误（只修类型，不改行为），修到通过为止。

### 0.4 分组提交

按 0.2 的清单分组提交，建议的组（可按实际盘点结果调整，但一个 commit 只做一件事）：

1. 新页面组：`h2h.tsx`、`heroes.tsx`、`hero.tsx`、`standings.tsx`、`entity-links.ts` + `routes.ts`/`nav.ts`/`icons.tsx` 中配套改动
2. 荣誉数据组：`0061_kpl_honor_enrichment.sql`、`seed-kpl-honors.ts`、`industry/kpl-entities/honors.json`
3. wechat2rss 信源组：`packages/backend/src/sources/wechat2rss/`、`wechat2rss-cli.ts`、`tests/wechat2rss.test.ts`、`docs/wechat2rss.md`、`sources.json` 配套改动
4. 后台与批处理组：`admin/dashboard.ts`、`scripts/collect-all.ts`、`process-all-articles.ts`、`reanalyze-all-articles.ts`、`clean-bogus-wechat-articles.ts`、`tests/batch-publication.test.ts`、`batch-run-worker.mjs`
5. 提示词与文案组：`industry/prompts/*` 的修改
6. 剩余修改按模块归组（api 路由一组、web 页面一组、backend 一组）

每组提交前跑 `npm run typecheck`，必须绿。

### 0.5 更新交接文档

`kpl-intelligence/docs/` 里找到交接文档（若与根目录 `docs/交接文档.md` 是两份，以仓库内这份为准），在「未完成工作清单」里把 0.4 中已提交的条目（H2H/英雄页/积分榜/荣誉回填/wechat2rss）标注为「✅ 已完成（提交 xxxxxxx）」。单独一个 commit。

## 验收门禁

- [ ] 根仓库 `git status --short` 输出为空
- [ ] `kpl-intelligence` 仓库 `git status --short` 输出为空
- [ ] `find /Users/kuangqie/Documents/VibeCoding/KPL -name "__pycache__" -not -path "*/node_modules/*"` 输出为空
- [ ] `kpl-intelligence` 下 `npm run typecheck` 退出码 0
- [ ] 盘点清单已贴在回复中，且没有任何文件被删除（`git log --diff-filter=D --name-only` 对本次新增的 commit 输出为空）
- [ ] 交接文档已更新并提交

---

# 阶段 1：测试与 CI 修复（P0，预计 1–2 天）

> **为什么第二个做**：后面的阶段都要改代码，现在测试是红的，没有回归保护寸步难行。

## 背景事实（已侦察确认，直接用，不用重新调研）

- 测试命令（在 `kpl-intelligence/` 下）：`npm test`，实际执行 `node --test-global-setup=tests/databases.ts --import ./tests/databases.ts --test --test-concurrency=6 "tests/*.test.ts"`，每个测试文件跑在独立的数据库副本上。
- 跑测试需要本地 PostgreSQL 17（Docker 容器 `kpl-pg`，镜像 `pgvector/pgvector:pg17`，库 `kpl_test`）。先确认容器在跑：`docker ps | grep kpl-pg`；不在则 `docker start kpl-pg`；不存在则用 `docker-compose.yml` 里的 db 服务定义创建。
- **已知 CI bug**：`.github/workflows/check.yml` 的 postgres service 镜像是 `postgres:17-alpine`，但迁移 `database/migrations/0055_kpl_kb_search.sql` 需要 `vector` 扩展（pgvector）。普通 postgres 镜像没有这个扩展，CI 的 Backend tests 步骤必挂。
- **已知测试债**（交接文档 §3 P2-1）：31 个测试文件引用 AI 行业旧词，其中约 10 个引用旧分类 key 会直接失败。已确认 `tests/` 下有 11 个 `leaderboard-*.test.ts` 文件——leaderboard 功能在 `industry/features.ts` 里 `FEATURES.leaderboard = false` 已关闭，这批测试大概率整批失败。
- `tests/topic-chronicle.test.ts` 是已完成的「KPL 等价改写」范例，改其他测试时照它的模式来。

## 步骤

### 1.1 建立失败基线

```bash
cd /Users/kuangqie/Documents/VibeCoding/KPL/kpl-intelligence
npm test 2>&1 | tail -100
```

把失败文件清单完整贴在回复里，格式：`| 测试文件 | 失败原因分类（旧领域词/旧分类key/真bug/pgvector缺失/其他） |`。

⚠️ 如果失败原因是「连不上数据库」：检查 `DATABASE_URL` 环境变量——测试必须用命令行覆盖指向本地 `kpl_test`，**严禁连 Supabase 跑测试**。正确姿势：

```bash
DATABASE_URL="postgres://postgres@127.0.0.1:5432/kpl_test?sslmode=disable" npm test
```

（密码/端口以 `docker-compose.yml` 里 db 服务的实际配置为准。）

### 1.2 修 CI 镜像

编辑 `.github/workflows/check.yml`：把 `image: postgres:17-alpine` 改为 `image: pgvector/pgvector:pg17`。其余不动。单独一个 commit：`fix(ci): 测试库镜像换 pgvector（迁移 0055 起依赖 vector 扩展）`。

### 1.3 处理 leaderboard 测试批

11 个 `tests/leaderboard-*.test.ts` 文件。功能已关闭，判断标准：

- 读每个文件，若它测试的是 leaderboard 专属逻辑（评分方法 v17、榜单准入、价格抓取）→ 该文件整批属于「已关闭功能的测试」。
- **不许直接删除**。处理方案：在每个文件顶部、现有 import 之后加跳过守卫。先看 `tests/databases.ts` 和任一现有测试怎么 import `FEATURES`，用同样的方式：

```ts
import { FEATURES } from "../industry/features.js";
// leaderboard 功能已关闭（industry/features.ts），相关测试整批跳过
const describeBoard = FEATURES.leaderboard ? describe : describe.skip;
```

然后把文件内顶层 `describe(` 换成 `describeBoard(`。若文件用的是裸 `test(...)` 没有 describe 包层，则改用 `test.skip` 或包一层 describe——照该文件现有结构选改动最小的方式。
- 若其中某个文件测的其实是**通用机制**（如 HTTP 缓存头、判重）只是借了 leaderboard 的数据 → 不许跳过，改数据让它用 KPL 内容，并在清单里标注。

### 1.4 修领域词失败的测试

对 1.1 清单里分类为「旧领域词/旧分类 key」的文件：

1. 先读 `industry/taxonomy.ts` 全文，拿到 KPL 现行六分类的准确 key（已确认其中有 `match-result`，其余以文件为准）。
2. 逐文件把 AI 行业分类 key / 实体名替换成 KPL 等价物，模式照 `tests/topic-chronicle.test.ts`。
3. **只改测试数据与断言里的领域词，不改测试的业务逻辑，更不许改被测源码**——除非失败原因是源码里残留了旧领域词（此时改源码是对的，单独一个 commit 并说明）。

### 1.5 真 bug 处理

清单里分类为「真 bug」的（领域无关的基础设施：判重、URL 规范化、回执、会话）：逐个修复源码，每个 bug 一个 commit，message 写清现象与根因。超出能力或需要架构决策的 → 停下报告。

### 1.6 全绿验证

```bash
DATABASE_URL="postgres://postgres@127.0.0.1:5432/kpl_test?sslmode=disable" npm test 2>&1 | tail -20
npm run typecheck
npm run build -w @aihot/web
node --test apps/web/tests/*.test.ts
```

四条全部退出码 0。然后一个收尾 commit。

## 验收门禁

- [ ] `npm test` 全绿（允许 `.skip` 的 leaderboard 批，跳过数要在回复里报出来）
- [ ] `npm run typecheck` 退出码 0
- [ ] `npm run build -w @aihot/web` 退出码 0
- [ ] `node --test apps/web/tests/*.test.ts` 退出码 0
- [ ] `.github/workflows/check.yml` 镜像已改为 pgvector
- [ ] 回复中包含：1.1 失败基线清单、每个失败文件的处置方式（跳过/改写/修源码）、最终跳过与通过的测试数
- [ ] 没有任何测试文件被删除（`git log --diff-filter=D --name-only HEAD~N..HEAD` 验证，N 为本阶段 commit 数）

---

# 阶段 2：Python 采集流水线工程化（P1，预计 1 天）

> 范围仅限根目录三个 Python 文件 + 新建的测试与配置文件。不许动 `kpl-intelligence/`。

## 背景事实

- `curator.py`（294 行）：核心函数 `evaluate_article_quality(title: str, author: str, text: str) -> tuple[bool, str, str, str]`（第 58 行），返回（是否通过，原因，分类，体裁）；800 字门槛在第 66 行（`len(clean_text) < 800`）；关键词表 `STRICT_EXCLUDE_KEYWORDS`（第 38 行）和 `KPL_CORE_ENTITIES`（第 49 行）在文件顶部；入口读 `discovered_urls.json`（当前不存在，由 `dajiala_client.py` 产出）。
- `kpl_scraper.py`（339 行）：`sanitize_filename(name: str, max_len: int = 60) -> str`（第 80 行）、`format_timestamp(ts: int)`、`extract_publish_time(html: str)`、`process_wechat_html(raw_html: str)`。
- `dajiala_client.py`（320 行）：`class DajialaClient`（第 70 行，key 从环境变量 `DAJIALA_API_KEY` 或 `.env` 读取）、`sanitize_title(text: str, max_len: int = 40)`。
- 运行环境 Python 3.12.2，三方依赖只有 `curl_cffi` 和 `beautifulsoup4`。

## 步骤

### 2.1 锁定依赖

新建 `requirements.txt`，版本号先用 `pip3 show curl-cffi beautifulsoup4 | grep -E "Name|Version"` 查当前已装版本，按 `包名==版本` 格式写入。再加一个 `requirements-dev.txt`，内容：

```
pytest>=8.0
ruff>=0.6
```

新建 `pyproject.toml`，只放 ruff 配置（不做打包配置）：

```toml
[tool.ruff]
target-version = "py312"
line-length = 120

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]
```

跑 `ruff check curator.py kpl_scraper.py dajiala_client.py`，**只修 F 类（未使用 import 等真实问题）**，E501（行宽）这类风格问题如果量大就用 `ruff format` 一次性格式化，单独一个 commit，message 注明「纯格式化，无行为变更」。

### 2.2 写单元测试

新建 `tests_py/` 目录（叫这个名字避免与 `kpl-intelligence/tests/` 混淆），新建 `tests_py/__init__.py`（空文件）和以下三个测试文件。所有测试**不触网、不读写真实文件系统**（用 `tmp_path` fixture 和 monkeypatch）。

`tests_py/test_curator.py`，至少覆盖：

```python
from curator import evaluate_article_quality

class TestExcludeKeywords:
    def test_title_hit_cfs(self):      # 标题含「穿越火线」→ 不通过
    def test_title_hit_lpl(self):      # 标题含「LPL」→ 不通过
    def test_title_hit_valorant(self): # 标题含「无畏契约」→ 不通过
    def test_body_dominant_other_game(self):  # 正文英雄联盟出现 5 次以上 → 不通过

class TestWordCountGate:
    def test_799_chars_rejected(self):   # 正文 799 字 → 不通过
    def test_800_chars_boundary(self):   # 正文恰好 800 字 → 不被字数门槛拦（若被其他规则拦需说明）
    def test_801_chars_passes_gate(self):

class TestCoreEntities:
    def test_zero_kpl_entity_rejected(self):   # 0 次命中核心实体 → 不通过
    def test_strong_kpl_article_passes(self):  # 标题含「KPL」+ 正文多次提战队选手 + 超 800 字 → 通过
```

⚠️ 写断言前先**实际运行** `python3 -c "from curator import evaluate_article_quality; print(evaluate_article_quality('测试标题','测试作者','正文'*500))"` 确认真实返回结构，断言以真实行为为准；如果真实行为与上面用例的预期不符（比如边界是 `<=` 不是 `<`），以代码实际行为为准写断言，并在回复中说明——**不许为了让测试通过而改 curator.py 的阈值**，除非能证明是 bug。

`tests_py/test_scraper.py`，至少覆盖：

- `sanitize_filename`：含 `/\\:*?"<>|` 非法字符被替换、超长截断到 max_len、中文保留、首尾空白处理
- `format_timestamp`：已知时间戳 → 预期字符串（先跑一次拿到真实格式再写断言）
- `extract_publish_time`：构造一段含发布时间标记的微信 HTML 片段 → 能提取；空 HTML → 不崩溃（断言返回默认值/空串，以实际为准）

`tests_py/test_dajiala.py`，至少覆盖：

- `DajialaClient()` 在环境变量和 `.env` 都没有 key 时：`is_configured`（或等价方法，先读源码确认名字）返回 False，且调用需要 key 的方法时给出中文报错提示而不抛出未处理异常
- `.env` 解析：monkeypatch 一个临时 `.env`（`tmp_path` + monkeypatch.chdir），分别测试 `DAJIALA_API_KEY=abc`、`DAJIALA_API_KEY="abc"`（带引号）两种写法都能读到 `abc`
- `sanitize_title`：超长截断、非法字符处理

### 2.3 补链路断层

`curator.py` 的输入 `discovered_urls.json` 无人产出。读 `dajiala_client.py` 的 `main()`，确认它现在把抓到的文章列表输出到哪。然后：

- 给 `dajiala_client.py` 加一个 `--export-json discovered_urls.json` 参数：把已抓取文章的元信息（url/title/author/publish_time）按 `curator.py` 实际 `json.load` 后期望的字段结构落盘（**先读 curator.py 确认它读哪些字段，结构以它为准**）。
- 在 `tests_py/test_dajiala.py` 补一个测试：调用 export 逻辑（mock 掉网络层）后产出的 JSON 能被 `json.load` 且包含 curator 需要的全部字段。

### 2.4 根 README

新建根目录 `README.md`，内容必须包含（不许自由发挥加多余章节）：

1. 项目一句话定位：KPL（王者荣耀职业联赛）内容采集与数据平台
2. 目录结构表：`kpl-intelligence/`（主站，独立 git 仓库，TS monorepo）、`kpl_vault/`（精选文章知识库）、`reference-projects/`（只读参考）、`AIHOT/`（上游原版，只读）、根目录三个 Python 脚本
3. Python 流水线用法（照 `DATA_STRATEGY.md` 的架构写）：设置 `DAJIALA_API_KEY` → `python3 dajiala_client.py --export-json` → `python3 curator.py` → 产物在 `kpl_vault/`
4. 测试：`python3 -m pytest tests_py/ -v`
5. 指向 `docs/交接文档.md` 和 `DATA_STRATEGY.md`

### 2.5 验证与提交

```bash
python3 -m pytest tests_py/ -v        # 全绿
ruff check .                          # 无 F 类错误
python3 -c "import curator, kpl_scraper, dajiala_client"   # 三个模块可导入
```

提交计划：commit 1 = requirements + ruff 配置 +（如有）格式化；commit 2 = tests_py 三个测试文件；commit 3 = `--export-json` 功能 + 测试；commit 4 = README。

## 验收门禁

- [ ] `python3 -m pytest tests_py/ -v` 全绿，测试总数 ≥ 15
- [ ] `ruff check .` 退出码 0
- [ ] `README.md` 存在且含上述 5 节
- [ ] `git status --short` 为空
- [ ] 回复中说明：800 字门槛边界的实测行为、export-json 的实际字段结构

---

# 阶段 3：kpl_vault 语料同步进主站（P1，预计 1–2 天）

> 为 AI 问答（阶段 4）准备语料。把根目录 `kpl_vault/` 的 16 篇 Markdown 文章灌进 `kpl-intelligence` 的数据库并建立实体关联。

## 背景事实

- `kpl_vault` 结构：`kpl_vault/<战队或栏目名>/<日期>_<标题>/` 目录下固定三个文件：`metadata.json`、`<标题>.md`、`offline.html`。
- `metadata.json` 字段（实测）：`title`、`author`、`publish_time`（`YYYY-MM-DD HH:mm:ss`）、`source_url`（mp.weixin.qq.com）、`markdown_file`、`word_count`、`archived_at`、`has_images`。
- 主站已有微信文章采集链路：`packages/backend/src/sources/wechat2rss/`（阶段 0 已提交）和 `dajiala` 相关（`tests/dajiala.test.ts`）——**先读这两处，vault 导入器必须复用现有文章 ingest 通道而不是发明第二套文章表结构**。
- 实体词表在 `industry/taxonomy.ts`（含 `IDENTITY_LEXICON`）和 `industry/kpl-entities/`。
- 测试范例：`tests/esports-sync.test.ts`（假服务模式）、`tests/wechat2rss.test.ts`。
- 数据库迁移下一个可用编号是 `0062`（0061 已存在）。
- embedding：text-embedding-v4，1024 维，走项目已有 LLM/embedding 配置（`packages/backend/src/providers/llm.ts`）。**真实 embedding 调用只在人手动跑导入脚本时发生；测试一律 mock。**

## 步骤

### 3.1 设计确认（先产出方案再动手）

通读 `packages/backend/src/sources/wechat2rss/`、`packages/backend/src/sources/rss.ts`、`packages/backend/src/kb/upsert.ts`，然后在回复里贴出设计（不写文件）：

1. vault 文章走哪条入库通道（复用现有 ingest / 新增 source kind），理由
2. 幂等键选什么（建议 `source_url`，即微信原文链接）
3. chunks 切块策略（按 Markdown 段落切、块大小、重叠）
4. `entity_mentions` 怎么建（词表匹配战队/选手名，大小写与别名规则）
5. 要不要新迁移（如果要，编号 0062，只加表/列不删不改旧的）

**等人确认设计后再继续**（这是本任务书唯一明确要求人工确认的节点）。

### 3.2 实现导入脚本

新建 `kpl-intelligence/scripts/import-kpl-vault.ts`：

- 参数：`--dir <path>`（默认 `../kpl_vault`）、`--dry-run`、可选 `--no-embed`（只入库不生成向量）
- 行为：
  1. 扫描 `<dir>/*/ */metadata.json`（注意目录名含中文和空格，用 `fs.readdir` 不要用 shell glob）
  2. 每篇：读 metadata + 对应 markdown 文件 → 内容 hash（sha256）→ 已存在同 hash 记录则跳过并计入 skipped
  3. 按 3.1 确认的通道入库 → 切块 → 实体匹配写 `entity_mentions` →（非 no-embed 时）生成 embedding 写 `chunks`
  4. 单篇失败不中断整体，记入 failed 列表继续
  5. 结束打印：`imported: N, skipped: N, failed: N`，failed 附文件名与错误
- 断点续跑：靠幂等天然支持，不需要额外状态文件

### 3.3 测试

新建 `tests/kpl-vault-import.test.ts`，照 `tests/esports-sync.test.ts` 的假服务模式，fixture 用 `tmp` 目录手工造两个假的 vault 文章目录（一个含战队名「成都AG超玩会」，一个不含任何实体），覆盖：

- 首次导入 → imported=2
- 原样重跑 → skipped=2, imported=0（幂等）
- 内容改动后重跑 → 该篇重新 imported
- 实体命中：含「成都AG超玩会」的文章在 `entity_mentions` 有对应记录
- `--dry-run`：数据库零写入
- metadata.json 损坏（非法 JSON）→ failed=1，另一篇正常 imported，进程不崩

### 3.4 真实运行（需人开启）

贴出运行命令但**不自己执行**（涉及真实 embedding 计费）：

```bash
cd kpl-intelligence
node --env-file=.env scripts/import-kpl-vault.ts --dir ../kpl_vault --dry-run   # 先干跑
node --env-file=.env scripts/import-kpl-vault.ts --dir ../kpl_vault            # 确认后实跑
```

### 3.5 验证与提交

```bash
DATABASE_URL="postgres://postgres@127.0.0.1:5432/kpl_test?sslmode=disable" npm test
npm run typecheck
```

commit 1 =（如有）迁移 0062；commit 2 = 导入脚本；commit 3 = 测试。

## 验收门禁

- [ ] 3.1 设计方案已贴出并获确认
- [ ] 6 个测试用例全绿，`npm test` 整体不红
- [ ] `npm run typecheck` 退出码 0
- [ ] 脚本 `--dry-run` 对真实 `../kpl_vault` 干跑输出 `imported: 16`（或说明为何不是 16）
- [ ] 未调用真实 embedding/LLM API

---

# 阶段 4：AI 问答 Phase 3c（P1，最大块，预计 5–7 天）

> 严格按 `kpl-intelligence/docs/KPL-Intelligence-技术方案.md` §7 的设计落地。开始前把 §7 完整读两遍。

## 全局约束（本阶段专属）

- 技术方案 §7 是权威设计。实现细节与它有出入时，以「方案意图 + 现有代码机制」为准，不许自创架构（比如不许引入新的向量库、新的队列）。
- **web 进程铁律**：`apps/web` 的 loader 只许 HTTP 调 `apps/api`，不许碰数据库、不许调模型。
- 所有 LLM 调用走项目已有的回执/预算链路（参考 `packages/backend/src/editorial/analyze.ts` 怎么发模型请求）。
- 提示词放 `industry/prompts/`（新增 `kpl-understand.md`、`kpl-answer.md`），格式仿照现有提示词文件（先看 `industry/prompts/selection-score.md` 的结构）。
- 迁移编号从 0063 起（0062 被阶段 3 占用；若阶段 3 没用迁移则从 0062 起）。
- LLM Key 已配置（百炼 MaaS，`LLM_MODEL=qwen3.8-flash`，embedding text-embedding-v4 1024 维已实测可用）——但**开发期间全程 mock，只有最后人验时真实调用**。

## 子阶段与步骤（每个子阶段独立提交、独立验收）

### 4.1 chunks 切块入库

1. 若阶段 3 已建 chunks 写入逻辑，本步只需扩展到比赛/实体档案：比赛综述（matches + games 的关键字段渲染成文本块）、战队档案、选手档案、英雄档案各生成 chunks。
2. 读 `database/migrations/0055_kpl_kb_search.sql` 确认 chunks 表结构与 HNSW 索引现状；pgvector 维度必须 1024，与 text-embedding-v4 一致（搜代码里 `embedding` 相关测试如 `tests/embedding-dimensions.test.ts`，照它的校验方式）。
3. 实现 `packages/backend/src/kb/chunks.ts`（若阶段 3 已建则扩展）：`rebuildEntityChunks(teamId?)` / `rebuildMatchChunks(matchId?)` 等幂等函数（先删旧 chunks 再插新的，用事务）。
4. 测试 `tests/kb-chunks.test.ts`：切块边界（短文本单块、长文本多块）、幂等（跑两遍 chunks 数不变）、维度校验（mock 返回 1024 维数组）。

验收：`npm test` 绿 + typecheck 绿 + commit。

### 4.2 意图理解

1. 新建 `industry/prompts/kpl-understand.md`：输入用户问题，输出结构化 JSON——意图类型（赛果查询/数据对比/H2H/ roster/开放问答）、涉及的实体 slug、时间范围。schema 参考现有 `content-understanding.md` 提示词的输出约定。
2. 实现 `packages/backend/src/qa/understand.ts`：调模型 → JSON 解析 → 解析失败降级为「开放问答」意图（不许抛异常）。
3. 测试：mock 模型返回（合法 JSON /  markdown 包裹的 JSON / 纯文本垃圾）三种情况。

### 4.3 三通道检索 + RRF 融合

1. 结构化通道：按意图路由到 `packages/backend/src/kb/read.ts` 的查询函数（赛果→matches 查询；H2H→阶段 0 已入库的 h2h 数据层；选手→players）。
2. 语义通道：pgvector 余弦检索 chunks，`ORDER BY embedding <=> $1 LIMIT k`。
3. 关键词通道：照现有 trigram 搜索实现（搜代码里 `pg_trgm` 或 `similarity(`）。
4. RRF 融合：`score = Σ 1/(60 + rank)`，三通道结果合并去重取 top N。
5. 测试 `tests/qa-retrieval.test.ts`：三通道各自返回已知 fixture → 融合排序正确；某通道空结果不崩；去重正确。

### 4.4 生成 + 护栏

1. 新建 `industry/prompts/kpl-answer.md`：要求——只许使用给定材料中的事实；数据卡片内容必须逐字来自结构化查询结果；引用格式 `[来源N]`；不知道就说不知道。
2. `packages/backend/src/qa/answer.ts`：组装材料 → 调模型 → grounded 校验（回答中的数字/比分必须能在材料中找到，找不到则触发重试一次，再失败则降级为「只输出数据卡片 + 抱歉文案」）。
3. 防张冠李戴：用 `IDENTITY_LEXICON` 校验回答中的战队/选手名组合是否与材料一致。
4. 测试：mock 模型输出含编造比分 → 触发降级；输出正确 → 通过；引用缺失 → 重试。

### 4.5 SSE 端点与问答页

1. `apps/api` 新增 `POST /api/site/qa/stream`：SSE 流式输出（事件类型：`meta`（意图/命中数据卡片）、`delta`（文本增量）、`citation`（来源）、`done`/`error`）。参考 `apps/api/src/routes/site.ts` 现有路由注册方式与 `apps/api/src/app.ts` 的挂载。
2. 匿名限流：用 `qa_rate` 表（迁移 0055 已建），规则：每 IP 每小时 20 次，超限返回 429 + SSE error 事件。
3. 缓存：`qa_queries` 表，相同问题（规范化后 hash）24h 内直接返回缓存结果（仍走 SSE 格式）。
4. `apps/web` 新增 `/ask` 页：输入框 + 流式渲染回答 + 来源引用列表 + 数据卡片（复用阶段 0 入库的页面组件风格）。loader 只调 api（铁律）。路由注册进 `apps/web/app/routes.ts`，导航加「AI 问答」入口（`apps/web/app/components/shell/nav.ts`）。
5. 测试：SSE 端点用假流断言事件序列（meta→delta*→citation→done）；限流第 21 次返回 429；缓存命中时不再调模型（mock 计数断言）。

### 4.6 真实联调（需人执行）

贴出清单请人工验证：开三个进程 → 问「2025 年 KPL 夏季赛决赛比分」→ 检查回答、引用、数据卡片。**自己不执行真实 LLM 调用。**

## 验收门禁（整个阶段 4）

- [ ] 每个子阶段有独立 commit 且提交时 `npm test` + `typecheck` 双绿
- [ ] 新增测试文件 ≥ 4 个（kb-chunks / qa-understand / qa-retrieval / qa-stream 至少）
- [ ] `/ask` 页面路由已注册且 web build 通过（`npm run build -w @aihot/web`）
- [ ] 限流与缓存有测试覆盖
- [ ] 所有模型调用点都可被 `MODEL_CALLS_ENABLED=false` 完全关闭（照现有开关机制）
- [ ] 回复中贴出：SSE 事件协议示例、意图 JSON schema、降级路径清单

---

# 阶段 5：页面与数据补全（P2，预计 2–3 天）

> ⚠️ 先做存在性检查：阶段 0 已入库 H2H 页、英雄页、积分榜、荣誉迁移——本阶段大部分可能已完成。逐项核对下表，已完成的标注 ✅ 跳过，只补缺口。**不许重做已有功能。**

## 检查清单与补全方法

| # | 功能 | 存在性检查命令 | 若缺失则 |
|---|------|--------------|---------|
| 1 | 荣誉回填 | `ls database/migrations/0061*` 且 `ls industry/kpl-entities/honors.json` | 整理历届冠军/FMVP 种子 JSON（只收录可公开查证的官方结果），`scripts/seed-kpl-honors.ts` 幂等入库 |
| 2 | 英雄详情页 | `ls apps/web/app/routes/hero.tsx apps/web/app/routes/heroes.tsx` | 参考 `team.tsx` 的结构实现：登场率/胜率/常用选手，数据走 `packages/backend/src/kb/read.ts` |
| 3 | H2H 对战 | `ls apps/web/app/routes/h2h.tsx` | 用 `matches_team_*` 双向索引写查询函数 + 战队页区块 |
| 4 | 积分榜 | `ls apps/web/app/routes/standings.tsx` | 按赛季胜率计算；SAB 分组制规则映射若复杂，先出纯胜率版并注明 |
| 5 | 赛季切换器 | `grep -n "season" apps/web/app/routes/matches.tsx` | `loadSchedule({season})` 已支持，只加 UI 下拉 |
| 6 | 比赛视频嵌入 | `grep -rn "match_battle_video_list" apps/web packages/backend` | 从 `matches.raw` 提取官方视频链接，比赛页展示 |
| 7 | og.ts 残留清理 | `grep -n "leaderboard\|codex-reset" apps/api/src/routes/og.ts` | `PAGES` 表第 26–27 行的两张旧卡删除或替换为 KPL 页面卡；第 63 行的 feature 守卫若引用已删条目则同步清理 |
| 8 | 重定向残留 | `grep -n "leaderboard" packages/contracts/src/http-policy.ts` | 第 46–48 行 leaderboard 相关规则删除（功能已关闭，重定向无意义） |

## 每补一项的流程（固定动作）

1. 数据层函数先进 `packages/backend/src/kb/read.ts`（参数绑定，不许拼 SQL 字符串插值）；
2. site API 路由进 `apps/api/src/routes/site.ts`；
3. 页面 loader 只调 api；
4. 每个新查询函数配测试（fixture 照 `tests/esports-sync.test.ts` 造数据的方式）；
5. `npm test` + `typecheck` + `npm run build -w @aihot/web` 三绿后单独 commit。

## 验收门禁

- [ ] 8 项检查全部有结论（✅ 已存在 / 本次补齐 + commit hash）
- [ ] 新增代码均有测试，三绿
- [ ] `grep -rn "leaderboard" apps/api/src/routes/og.ts packages/contracts/src/http-policy.ts` 无残留（FEATURES 定义和 tests 跳过守卫除外）
- [ ] `npm run build -w @aihot/web` 退出码 0

---

# 阶段 6：README 重写与文档收口（P2，预计半天）

## 步骤

### 6.1 重写 `kpl-intelligence/README.md`

当前是 AIHOT 原版。重写为（章节固定）：

1. **KPL Intelligence 是什么**：王者荣耀职业联赛智能信息检索平台，基于 AIHOT 框架领域化改造
2. **功能清单**：以阶段 0–5 完成后的实际功能为准（战队/选手/英雄/赛程/H2H/积分榜/AI 问答/精选资讯）
3. **架构图**：从 `docs/KPL-Intelligence-技术方案.md` §1.1 的 mermaid 图复制并更新（删掉 leaderboard/codex-reset，加上 kb/qa 模块）
4. **本地跑起来**：照 `docs/交接文档.md` §4 运行手册抄关键命令（三进程、迁移、种子、测试），注明 Supabase 与本地库两种模式
5. **数据来源**：KPL 官方接口（prod.comp.smoba.qq.com）、Dajiala 公众号采集、kpl_vault 精选语料
6. **文档索引**：交接文档、技术方案、`docs/` 下各文档一句话说明

### 6.2 文档偏差清理

读 `kpl-intelligence/docs/customize.md`、`architecture.md`、`deploy.md`，把其中明显描述 AIHOT AI 行业版现状（leaderboard、codex-reset、AI 分类）的段落：要么更新为 KPL 现状，要么在段首加 `> ⚠️ 本节描述 AIHOT 原版机制，KPL 版已关闭/替换，见 README。`。**不许整篇删除文档。**

### 6.3 Supabase 安全提醒落文档

在 `kpl-intelligence/docs/deploy.md` 的显著位置（开头第一个注意框）加入：

```markdown
> ⚠️ **上线前必做**：Supabase Dashboard → Settings → API → 关闭 Data API（PostgREST），
> 或给所有表加 deny-all RLS。本项目的数据库表没有 RLS 设计，anon key 暴露即全库泄露。
```

并在 `scripts/sync-kb-to-supabase.sh` 脚本末尾的 echo 输出里加同样的提醒（只加输出文案，不改脚本逻辑）。

## 验收门禁

- [ ] README 六节齐全，`grep -c "leaderboard" README.md` 为 0
- [ ] deploy.md 含安全注意框
- [ ] sync 脚本末尾含提醒输出
- [ ] 三绿（typecheck / test / web build）
- [ ] 全部提交，两个仓库 `git status --short` 均为空

---

## 最终交付汇报模板（阶段 6 完成后按此格式回复）

```
## 执行总结
- 阶段 0：commit 列表（hash + message）
- 阶段 1：失败基线 X 个 → 修复 X / 跳过 X；CI 镜像已修
- 阶段 2：pytest N 个用例；requirements 已锁定
- 阶段 3：vault 16 篇导入链路就绪（dry-run 结果）
- 阶段 4：AI 问答链路完成度（各子阶段状态）
- 阶段 5：8 项检查结论表
- 阶段 6：文档收口完成
## 需要人工操作的遗留事项
1. Supabase 关闭 Data API（Dashboard 手动）
2. 真实跑一次 import-kpl-vault.ts（embedding 计费）
3. AI 问答真实联调
4. Dajiala 充值与剩余 8 个俱乐部公众号接入
5. docker compose 全链路部署验证
```

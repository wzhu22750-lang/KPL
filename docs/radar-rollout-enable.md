# 用户授权开启圈内焦点

用户在确认生产雷达关闭及模型调用影响后，明确要求“可以，现在就打开”。

## 改动

- `kpl-intelligence/industry/radar.ts`：`RADAR.enabled=true`，注释记录用户授权及待样本校准状态。
- 现有版本、门槛、权重、模型、回执及预算熔断不变。没有修改 `.env`，没有额外打开采集/模型总安全阀，也没有执行历史批量回评。
- `tests/content-radar.test.ts` 不再强行覆盖默认开关，新增默认授权开启的断言；关闭门禁、独立赛程和读取不调用模型的回归仍保留。

## 验证

- 默认开关断言：修复前失败、修复后通过。
- Typecheck、Web build 通过；Web 44 项全部通过。
- 独立本地测试库完整回归：933 项，878 通过、55 跳过、0 失败。总数含同期其它工作，不归为本次新增。
- `kpl-radar-rollout-test-db` 已停止；未重启用户现有服务，未连接生产数据库执行 SQL。

## 实际线上状态

公开只读请求 `https://kpl-intelligence.onrender.com/api/site/radar?current=true` 已返回 **200**，不再是 `content radar disabled`。

该次响应：

- `matches: 5`
- `topics: 0`，`standalone: 0`
- `coverage.reviewed: 0`，`coverage.pending: 1331`

因此开关已经上线，但当前没有可公开展示的焦点评估结果。还需生产 worker 在现有总安全阀与预算下生成判断；不能将“功能开启”误报为“已有焦点”。没有自动将 1331 条待评估素材全量入队，也没有伪造焦点或把原热点榜冒充雷达焦点。

工作期间仓库已有其它提交/推送推进，当前开关与测试改动已纳入 HEAD；本执行过程未代为 commit、push 或调用 Render 管理接口，是否生效以实际公开 API 为依据。

证据：`docs/audit-artifacts/radar-rollout-enable/`。后续若需要首轮初始化，应先明确有限近期样本、请求上限及生产操作范围，不进行无界历史回算。

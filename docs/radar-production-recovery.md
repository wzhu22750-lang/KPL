# 圈内焦点生产恢复记录

## 根因与修复

2026-10-11，线上 `/api/site/radar?current=true` 返回HTTP200，但 reviewed=0、pending=2123，无话题和独立素材；首页“圈内焦点”标题也不存在。

只读查库证实：1075条 `radar_failures` 报 `column "input_evidence_hash" does not exist`，3927个 `content.radar` 任务处于failed。最近任务有started/completed时间，证明worker确实消费过；“没有worker”的初始假设被排除。

生产迁移记录停在0067，漏跑0068、0069、0070。Docker默认命令直接启动三个服务，没有先迁移；新评估代码查询0069新增列时失败。

另一个展示问题：`ContentRadar` 使用 `lead && section`；无聚合话题时整块隐藏，而且只要存在比赛就不会显示旧空状态。修复为栏目标题始终显示，并区分接口不可用、待评估、暂无新焦点；不把独立赛果伪装成社区话题。

## 生产操作

- 全库pg_dump超时，未宣称完成全量备份；改为仅备份实际被ALTER的 `radar_materials` 及 `schema_migrations`，custom archive通过pg_restore列表检查，权限0600，保存在git忽略的 `kpl-intelligence/backups/pre-radar-migrations-targeted.dump`。
- 通过既有 `scripts/migrate.ts` 应用0068–0070并查询确认新增列存在；这些迁移仅新增表/索引/可空列，不删除原数据。
- 检测到Supabase默认授予新表公共API角色读取权限，追加0071：社区运行记录和平台控制表启用RLS、撤销PUBLIC及存在的anon/authenticated权限。实测两个角色对两表均无SELECT权限；普通本地Postgres没有这些角色也能迁移。
- 用既有 `review-radar.ts` 对8条明确近期素材入队，观察原生产worker恢复处理，未启动第二个worker或改模型安全阀。
- 用户进一步授权使用现有 `LLM_MODEL=gpt-6-luna`。再补40条近3天、有正文和真实互动的社区候选，交给原质量规则判断；互动阈值只作试运行召回，不作为准入条件，未降质量门槛、改预算或自动全量重算。
- 修复Docker启动门禁：数据库迁移失败立即退出，API/worker/Web均不启动。没有重跑seed覆盖运营信源配置。

## 测试

- 原镜像命令回归测试先失败，修复后通过；使用fake node执行真实Docker CMD，验证迁移失败时服务未启动。
- UI真实SSR回归先4失败、1通过，修复后5/5通过，覆盖有比赛无话题、接口不可用、有话题和独立赛报。
- 首次完整后端测试发现旧微博测试使用固定日期但按当前时钟评分，随样本老化失败；测试冻结Date，未修改业务评分规则。
- 最终后端：942项，887通过、55跳过、0失败；隔离本地 `kpl_release_test`，非生产库。
- Typecheck、Web构建通过；Web测试53/53通过。

## 结果与部署验收

补齐迁移后已观察到14条评估结果：accepted4、rejected9、review1；公开接口已有3条独立素材。该数字是恢复中间快照，不是最终全量覆盖。后续正常采集/评估可能继续增长。

首页显示修复和容器启动门禁需要发布新镜像；最终发布状态以线上SSR栏目、资源版本和公开API再次检查为准。已失效历史任务没有全量重放，旧失败记录在各自成功重评后才清除，不能将历史累计错误数当作修复后仍在失败。

# 真实本地试跑证据

主记录：[content-redesign-local-trial.md](../../content-redesign-local-trial.md)。

- `actual-run-summary.txt`：2026-10-08 11:35 北京时间的本地真实数据库汇总；未包含凭据、正文或密钥。
- `full-tests-after-cleanup.txt`：最新完整回归 764 / 710 pass / 54 skip / 0 fail。
- `typecheck.txt`、`build.txt`、`web-tests.txt`：类型检查、Web 编译、29 项 Web 测试。
- `weibo-clean-red.txt`：修复前 CPU 阻塞的限时子进程回归。绿结果包含在全量测试中。
- `camp-mapping-red.txt`、`camp-mapping-green.txt`：小局换边的红绿回归及缺失/陌生/重复队伍身份保护。
- `radar-regression.txt`：默认 all 频道的真实读取层去重集成回归。
- `battle-repair.txt`：通过领域写入口重放已有真实官方 payload 修复 12 个小局；不调用模型。
- `browser-close-final.log`：自动化浏览器关闭确认。

测试使用隔离测试数据库和显式测试夹具；真实效果截图与本地数据库结果另列，不将夹具冒充真实采集。性能采样原件仍在 `/tmp/kpl-local-trial/worker.cpuprofile`，未提交完整临时进程日志或环境文件。

# 最终验收证据

全部运行在本地一次性测试库/假模型服务；公开微博与虎扑探测为显式允许的只读请求。没有生产库操作、部署或真实付费模型调用。

| 文件 | 用途 |
|---|---|
| `final-full-tests.txt` | 最终主站759项：705通过、0失败、54跳过 |
| `final-targeted-tests.txt` | 新链路及采集/观测/队列43项通过 |
| `license-fix-tests.txt` | 架构、公开详情与X授权40通过、1跳过 |
| `final-typecheck.txt` / `final-build.txt` | 全项目类型检查与Web构建 |
| `final-web-tests.txt` / `final-python.txt` | 前端29通过，根项目tests_py 88通过 |
| `baseline-failures.txt` / `baseline-readpath.txt` | 修复前HEAD副本复现的失败，不是最终状态 |
| `source-install-idempotent.txt` | 新个人账号在本地只插不改、再次预览无差异 |
| `review-preview.txt` / `policy-preview.txt` | 本地只读脚本可运行，不是线上应用证明 |
| `live-*.json` | 公开只读微博分页窗口/身份/互动观测，非全平台覆盖 |
| `hupu-list-shape.txt` | 虎扑列表返回形状，非评论正文覆盖证明 |
| `caster-search.txt` / `caster-more-search.txt` | 个人账号发现来源；以实际UID/作者探测复核 |
| `browser.txt` / `browser-close.txt` | 合成组件390px/1280px检查及浏览器显式关闭 |

截图位于根目录`output/playwright/content-redesign/`。截图内容是合成样本，不是实时赛果或已上线主页；没有横向溢出（390px窗口、390px文档）。本任务创建的`kpl-p1-audit-db`容器已停止并自动删除，没有停止其他容器或用户Docker。

复跑从`kpl-intelligence/`使用`npm test`及文档中的定向命令，测试库名必须以`_test`/`_ci`结尾。不要让基线副本与工作树共用同一个测试库名并行执行；两者的全局清理会互相删除克隆库。公开live日志只能证明记录时的可访问性，不证明未来稳定性。正式启用门禁见../../content-redesign-delivery.md。

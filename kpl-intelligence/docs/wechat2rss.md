# WeChat2RSS 桥 —— 微信公众号免付费 Key 转 RSS 解决方案

本文档说明 KPL Intelligence 中自建微信公众号转 RSS 桥（WeChat2RSS Bridge）的实现原理、配置方法与接入指南。

---

## 1. 方案背景与核心优势

微信公众号官方不提供公开 RSS 接口，市面上的商业第三方抓取 API（如 Dajiala 极致了等）按调用次数收费且成本高昂。

本项目内置的 **WeChat2RSS 桥** 实现了 **零付费 Key、全开源、自建稳定抓取**：
1. **零外部付费 Key**：基于微信公开数据流（微信读书 Web 开放接口 + 搜狗微信搜索多适配器双保险），无需购买任何第三方商业 API。
2. **防盗链自动修复**：内置微信富文本图片防盗链清洗（将 `data-src` 转为 `src`，自动附加 `referrerpolicy="no-referrer"` 与 `loading="lazy"`），解决微信图片“此图片来自微信公众平台 未经允许不可引用”的问题。
3. **原生 RSS 2.0 / Atom 规范**：生成包含完整标题、永久链接、GUID、RFC822 发布时间、作者、摘要以及 `content:encoded` 正文 HTML 的标准 XML。
4. **两级智能缓存与防风控**：内存 LRU 缓存（默认 15 分钟 TTL），防止高频触发上游限频；抓取失败时具备过期数据容灾兜底。
5. **系统原生集成**：支持 `wechat://<公众号名称>` 协议免 HTTP 开销直连，也可以通过 HTTP 端点 `/feed/wechat/:account.xml` 作为标准 RSS 信源无缝接入。

---

## 2. 架构设计与代码结构

```text
packages/backend/src/sources/wechat2rss/
├── types.ts              # 微信公众号与文章的数据接口定义
├── parser.ts             # HTML 提取与微信图片防盗链清洗
├── generator.ts          # 标准 RSS 2.0 / Atom / JSON Feed 生成器
├── bridge.ts             # 核心调度与 LRU 缓存管理器 (wechatBridge)
├── adapters/
│   ├── weread.ts         # 微信读书数据源适配器 (主通道)
│   ├── sogou.ts          # 搜狗微信搜索数据源适配器 (备用双保险通道)
│   └── direct.ts         # 微信公众平台直接页面正文解析器
└── index.ts              # 统一导出入口
```

---

## 3. 使用方式与配置

### 方式 A：在系统信源配置（推荐）

在 `industry/sources.json` 或后台管理系统中，将公众号作为标准的 `rss` 信源添加：

```json
{
  "id": "mp-kpl-official",
  "name": "KPL王者荣耀职业联赛（官方公众号）",
  "kind": "rss",
  "config": {
    "feedUrl": "wechat://KPL王者荣耀职业联赛",
    "summaryIsBody": false
  },
  "tier": "T1",
  "owner_entity_id": "kpl",
  "participation_mode": "editorial",
  "interval_minutes": 60,
  "tags": ["官方", "微信公众号"],
  "site_fulltext": true,
  "syndicate_fulltext": false
}
```

> **提示**：
> - `feedUrl` 支持使用 `wechat://公众号名称`（直连模式，速度极快且无 HTTP 开销）。
> - 也支持使用 HTTP URL，如 `http://127.0.0.1:3001/feed/wechat/KPL王者荣耀职业联赛.xml`。

---

### 方式 B：CLI 命令行调试与预览

在项目根目录下可通过命令行直接测试任意公众号的抓取效果：

```bash
# 1. 终端预览公众号最新文章列表与摘要
npm run wechat2rss -- "KPL王者荣耀职业联赛" --preview

# 2. 搜索公众号
npm run wechat2rss -- "王者荣耀" --search

# 3. 导出 RSS 2.0 XML 到文件
npm run wechat2rss -- "王者荣耀" --output=hok_feed.xml
```

---

### 方式 C：通过 API 路由对外提供 RSS 订阅

当 API 服务启动后（`npm run dev:api` 或 Docker 部署），可以直接在任意外部 RSS 阅读器（Follow、Reeder、NetNewsWire 等）中订阅：

- **单公众号 RSS**：`http://<你的服务器地址>:3001/feed/wechat/KPL王者荣耀职业联赛.xml`
- **JSON Feed 格式**：`http://<你的服务器地址>:3001/feed/wechat/KPL王者荣耀职业联赛.json`
- **搜索公众号 API**：`GET /api/wechat/search?q=王者荣耀`
- **文章预览 API**：`GET /api/wechat/preview?account=王者荣耀`

---

## 4. 常见问题与维护

1. **为什么不需要付费 Key？**
   - 微信公开生态（微信读书与开放搜索）收录了全部公开公众号的文章。WeChat2RSS 桥通过模拟官方正常读取流程获取内容，因此无需第三方商业中介的付费 Key。
2. **如何提升抓取频率与并发？**
   - 默认适配器内置了 15 分钟的 LRU 缓存，避免对上游造成高频请求。
   - 可选：在 `.env` 中配置 `WEREAD_COOKIE`（填入个人微信读书 Cookie）可进一步提升单 IP 的并发限额与历史检索深度。
3. **微信公众号改名或新增公众号如何处理？**
   - 在 `industry/sources.json` 或后台“信源管理”中直接填入新的公众号全称即可，桥会自动匹配并生成 Feed。

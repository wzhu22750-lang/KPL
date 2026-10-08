// 站点身份和读者看得到的文案。换成你的行业时，先改这个文件。
// 网页和后端都读它；改完重新构建（docker compose up --build）即可生效。
// 域名不在这里：部署时用环境变量 SITE_URL 设置。

export const SITE = {
  /** 站名：导航、页面标题、分享图、RSS、MCP、后台都用它。 */
  name: "康平路情报站",
  /**
   * 行业词：拼进默认说法里，比如“KPL 日报”“KPL 动态”。
   * 改成“法律”“HR”“黄金”之类，页面上就会变成“法律日报”“法律动态”。
   */
  subject: "KPL",
  /** 首页的完整标题（浏览器标签、搜索结果）。 */
  homeTitle: "康平路情报站 — 王者荣耀职业联赛 · 智能信息检索与赛事分析",
  /** 一句话介绍：搜索引擎、分享卡片、RSS、llms.txt 会用。 */
  description:
    "盯住 KPL 的官方信源与赛事数据，用模型摘要、打分、精选，把同一场比赛、同一笔转会的报道归到一起；自然语言提问，AI 检索数据后给出有引用的回答。",
  /** 首页左上角和侧边栏下面的一行小字。 */
  tagline: "值得关注的 KPL 动态与战术情报",
  /** 界面语言（HTML lang、og:locale）。 */
  locale: "zh-CN",
  /** 默认域名，只在没设置 SITE_URL 时使用。 */
  defaultUrl: "http://localhost:3000",
  /**
   * MCP 工具名的前缀（小写字母、数字、下划线），工具会叫 kpl_get_latest、kpl_search……
   * 已经有人接入后就不要再改。
   */
  mcpPrefix: "kpl",
  /** 对外联系邮箱（选填）：使用规则、llms.txt、响应头里会写。 */
  contactEmail: null as string | null,
  /** 页脚的一行小字（选填）：填了会显示在页脚。 */
  footerNote: "数据与报道来自公开信源，AI 生成内容仅供参考",
  /** 中国大陆网站的 ICP 备案号（选填），填了就显示在页脚并链接到工信部备案系统。 */
  icp: null as string | null,
  /** 结构化数据里的网站运营者（搜索引擎用）。 */
  organization: {
    name: "康平路情报站",
    /** 创始人（选填）：{ name, url, description }。 */
    founder: null as null | { name: string; url?: string; description?: string },
  },
  /** 抓取信源时报上的名字（User-Agent 里用），不要冒用别的站。 */
  crawlerName: "KangPingLuBot",
} as const;

/** 关于页的文案。数字（信源数、收录数、精选数、日报期数）来自站内实时统计，不用写在这里。 */
export const ABOUT = {
  kicker: `关于 ${SITE.name}`,
  /** 大标题：第一行正常颜色，第二行强调色。 */
  headline: ["KPL 每天都有新动静，", "值得看的，只有几条。"] as [string, string],
  /** 标题下面的一段话。{sources} 会换成实时的信源数。 */
  lead: `${SITE.name} 替你盯着 {sources} 个信源：抓取、归并、打分、精选，每天早上 8 点出一份日报；还能直接用一句话提问，AI 检索赛程、战队与选手数据后给你有出处的回答。免费，不用注册。`,
  /** 信源河动画下面的四个环节。 */
  steps: {
    collect: "官方赛事数据、联盟公告、俱乐部官微、电竞媒体和公众号都在看；赛程密集时 15 分钟就看一次。",
    store: "报道存进文章库，赛果、阵容和比分进结构化数据库；同一件事的报道归到一起，热点榜就是从这里算出来的。",
    select: "模型先看是不是这个行业的事、有没有实际信息，再写中文标题、摘要和推荐理由；营销稿和重复转发进不来。",
    publish: "每天 08:00 出日报，赛后出赛果汇总与 AI 复盘；也可以随时提问，让 AI 从数据里替你查答案。",
  },
  /**
   * 作者块（选填），null 就不显示。
   * avatarSourceId：一个 X 账号信源的 id，头像取它的（选填）。
   * 二维码在后台“设置”里上传，或者放进 industry/brand/contact/；没有二维码就不显示那张卡片。
   */
  maker: null as null | {
    name: string;
    greeting: string[];
    avatarSourceId?: string | null;
    wechat?: { title: string; note: string };
    feishu?: { title: string; note: string };
  },
  /** 页面底部的版权与下架说明（结尾会接“反馈页”的链接）。 */
  copyright: `${SITE.name} 是聚合摘要和阅读索引，原文版权归各来源所有；比赛数据来自官方公开接口。如果你是来源方，希望更正、下架或调整展示方式，可以通过`,
} as const;

/** “KPL 日报”这类说法：行业词和名词之间，英文词加空格，中文词不加。 */
export function withSubject(noun: string): string {
  return /[A-Za-z0-9]$/.test(SITE.subject) ? `${SITE.subject} ${noun}` : `${SITE.subject}${noun}`;
}

/** “按主题看 KPL”“往期 KPL 日报”这类说法：行业词接在中文后面，英文词前加空格，中文词不加；noun 照 withSubject 接上。 */
export function subjectAfter(text: string, noun?: string): string {
  const gap = /^[A-Za-z0-9]/.test(SITE.subject) ? " " : "";
  return `${text}${gap}${noun ? withSubject(noun) : SITE.subject}`;
}

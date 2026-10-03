// 主题页“大事记”的行业规则。通用的几步在框架里（packages/backend/src/publication/topic-chronicle.ts）：
// 从近 12 个月已公开的精选里，按这里的规则定类型，比精选分门槛，把同一件事并成一个节点，按每月名额取舍，
// 再写成事件名；战队主题只收这家俱乐部自己的（看事实主体，没有主体时看标题在动作之前先点名谁）。
// 事件名与“同一件事合并”两项没有实现，走框架默认：同一件事靠事件归组，节点名取标题的第一句；
// 战队编年史还可以接上人工整理的历史：industry/chronicles/{主题 slug}.json，格式见 docs/customize.md。

/** 主题的分组（topics.json 的 group）：战队（后端身份沿用 company）、赛事领域、内容形态。 */
type Group = "company" | "field" | "genre";

/** 一类节点。 */
export interface ChronicleKind {
  /** 卡片和时间轴上的类型名。 */
  label: string;
  /** 战队编年史里排在时间轴上方一行（KPL：赛果），标记最醒目；其余类型在下方一行。 */
  above?: true;
  /** 主题自己的动作（战队：比赛、签约），用强调色标记；战队主题只收这家俱乐部自己做的。其余类型算新闻，战队主题只收以这家俱乐部为主体的。 */
  launch?: true;
  /** 战队主题收这类节点的精选分门槛和每月名额（各类型分开取，互不挤占）；不写就不收。 */
  company?: { min: number; perMonth: number };
  /** 领域和形态主题收这类节点的精选分门槛（这些主题每月按重要程度取前 5 件）；不写就不收。 */
  other?: { min: number };
}

/** 规则读到的一篇入选报道。 */
export interface ChronicleItem {
  title: string;
  /** 外文报道的原标题。 */
  originalTitle: string | null;
  category: string | null;
  tags: string[];
  /** 属于这个行业最受关注的那类事件（taxonomy.ts 的 RELEASE，即赛果战报）。 */
  release: boolean;
  /** 结构化抽取出的事实动作，比如 beat、sign、opinion。 */
  factAction: string | null;
}

/** 一个候选节点：代表报道、事件名和它的全部报道。 */
export interface ChronicleEvent {
  kind: string;
  label: string;
  head: { title: string };
  reports: ReadonlyArray<{ title: string }>;
}

export interface ChronicleRules {
  /** 节点类型。战队主题的搜索摘要按这里的先后列出。 */
  kinds: Record<string, ChronicleKind>;
  /** 内容形态主题的大事记收哪些类型，每月最多几件（默认 5）；没列出的形态主题不设大事记，直接读精选。 */
  forms: Record<string, { kinds: string[]; perMonth?: number }>;
  /** 动作词。战队主题遇到没有事实主体的报道，看标题在它之前先点名的是哪支战队。 */
  launchVerb: RegExp;
  /** 一篇报道在这一组主题里算哪类节点；不论分数高低都不算节点时返回 null（预告、前瞻、攻略……）。 */
  kindOf(item: ChronicleItem, group: Group): string | null;
  /** 可选：同一周、同一类型的两个节点是不是同一件事（归组漏掉的同一发布）。未实现，走框架默认。 */
  sameEvent?(a: ChronicleEvent, b: ChronicleEvent): boolean;
  /** 可选：节点在时间轴上的名字。未实现，走框架默认（标题第一句）。 */
  eventName?(title: string, kind: string, topic: { slug: string; orgNames: readonly string[] }): string;
}

// ── 哪些报道算节点 ──────────────────────────────────────────────────────────────────────

/** 还没发生、或不是一件“事”的报道，不进大事记。 */
const NOT_A_NODE = [
  /预告|即将|下周|将于|今晚|明日|明晚|次回合|还未|待定|coming soon/i, // 还没打/还没官宣
  /前瞻|预测|看好|胜率|赔率|大结局|谁能|花落谁家|状态预测/i, // 赛前分析
  /曝|传闻|爆料|正在接触|据称|据悉/i, // 未经确认的传闻
  /直播|回放|集锦|二路|解说席|节目|专访预告/i, // 观赛服务与节目单
  /^(?:每日|今日|本周)赛程$|赛程日历|观赛指南|观赛攻略/i, // 纯赛程日历与观赛指引
  /怎么玩|怎么进|如何|怎样|上分|出装|铭文|连招|攻略|教学/i, // 攻略教学
];
/** 评论类动作（复盘、观点）不是一件“发生”。 */
const COMMENTARY_ACTION = /^(?:opinion|analysis|commentary|prediction|tutorial|介绍|讲解|分享|评测|测评|回顾|复盘)(?:\b|功能|方法|$)/i;

/** 赛果、阵容与联盟事务是节点；战队主题里的联盟事务算这家俱乐部的大事。 */
function kindOf(item: ChronicleItem, group: Group): string | null {
  const kind = item.category === "match-result" ? "match"
    : item.category === "roster" ? "roster"
    : item.category === "league" ? (group === "company" ? "club" : "league")
    : item.category === "patch" ? (group === "company" ? null : "patch")
    : null;
  if (kind === null) return null;
  if (NOT_A_NODE.some((p) => p.test(item.title))) return null;
  if (kind !== "match" && COMMENTARY_ACTION.test(item.factAction ?? "")) return null;
  return kind;
}

/** 动作词：战队主题遇到没有事实主体的报道，用标题在动作词之前先点名的战队。 */
const ACTIONS = "夺冠|问鼎|加冕|捧杯|获得冠军|夺得|斩获|拿下|击败|战胜|横扫|险胜|惜败|不敌|负于|淘汰|晋级|止步|出局|无缘|落败|告负|胜利|失利|签约|引进|官宣|加盟|加入|离队|转会|租借|退役|复出|续约|注册|官宣名单|大名单|beat|defeat|sweep|win|sign|retire|transfer";

export const CHRONICLE: ChronicleRules = {
  kinds: {
    match: { label: "赛果", above: true, launch: true, company: { min: 65, perMonth: 5 }, other: { min: 72 } },
    roster: { label: "阵容", launch: true, company: { min: 70, perMonth: 2 }, other: { min: 72 } },
    club: { label: "俱乐部", company: { min: 75, perMonth: 1 } },
    league: { label: "联盟", other: { min: 80 } },
    patch: { label: "版本", other: { min: 72 } },
  },
  forms: {
    results: { kinds: ["match"], perMonth: 8 },
    transfers: { kinds: ["roster"] },
    patches: { kinds: ["patch"] },
    "world-champion-cup": { kinds: ["match"] },
    "challenger-cup": { kinds: ["match"] },
    playoffs: { kinds: ["match"] },
    youth: { kinds: ["roster"] },
    meta: { kinds: ["patch"] },
  },
  launchVerb: new RegExp(ACTIONS, "i"),
  kindOf,
};

// KPL 事实类型（claim type）识别与来源独立性标记。纯规则、无模型调用：
// 在内容分析产出（category/tags/title）之上细分出"这件事是哪一类事实"，权威矩阵（authority.ts）
// 与事件 rumor 状态机（events/rumor.ts）都以此为输入。
// 同一条官宣被转载时，origin 标记让佐证独立性按原始发布方归并：两个营销号转发同一个人的爆料
// 仍然是 1 个原始来源，不能算"2 个独立信源证实"。

export const CLAIM_TYPES = [
  "match_result", "schedule", "roster", "transfer", "rumor", "retirement", "injury", "starting_lineup",
  "rule_change", "discipline", "tournament", "standings", "milestone", "interview", "statement",
  "club_news", "player_news", "analysis", "community_discussion", "ticketing", "venue", "commercial",
  "entertainment",
] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** 由爆料/传闻驱动的声明类型：事实带上 rumor_state，进入爆料状态机。 */
export const RUMOR_CLAIMS: readonly ClaimType[] = ["transfer", "roster", "retirement", "injury", "starting_lineup", "player_news"];

/** 标题/摘要里出现即视为未经证实的爆料语言（营销号语态）。 */
export const RUMOR_MARKERS = [
  "爆料", "曝出", "曝：", "曝 ", "据传", "传闻", "传言", "风声", "疑似", "或将", "有望加盟",
  "据悉", "知情人士", "消息人士", "内部人士", "小道消息", "网传", "曝料", "rumor",
];

/** 具备确认资格的发布方（authority ≥ 阈值）使用的否定语态：官方辟谣把状态推到 official_denied。 */
export const DENIAL_MARKERS = ["辟谣", "否认", "不实", "失实", "并无此事", "严重失实", "从未", "没有进行过", "无此计划"];

/** 转载/转引识别：这条材料的发布方不是消息的原始出处。 */
export const REPOST_MARKERS = ["转载", "转发自", "来自微博", "源自", "来源：", "来源:", "via ", "转自"];
export const QUOTATION_MARKERS = ["据报道", "据媒体报道", "援引", "消息来源", "据爆料", "网传"];

interface ClaimInput {
  title: string;
  excerpt?: string | null;
  /** 分析产出的行业分类（industry/taxonomy CATEGORIES 的 key）。 */
  category?: string | null;
  tags?: readonly string[] | null;
  /** 发布方是社区平台（owner_type = community）：没有具体事实语态的内容归社区讨论（§29 舆情与事实分离）。 */
  community?: boolean;
}

export interface ClaimClassification {
  claimType: ClaimType;
  /** 命中的爆料/否定/转载标记，供 rumor 状态机与审计使用。 */
  rumorMarkers: string[];
  denialMarkers: string[];
  originType: "original" | "repost" | "syndication";
  /** 转载/转引指向的原始发布方（"@KPL王者荣耀职业联赛" / "来源：xxx"）。 */
  originEntity: string | null;
}

const hasAny = (hay: string, needles: readonly string[]) => needles.filter((n) => hay.includes(n));

/** 转载文本里的原始出处："来源：xxx"、"via @xxx"、"转自xxx"。 */
export function originEntityOf(hay: string): string | null {
  const patterns = [
    /(?:来源|转自|转载自|源自|转发自)[:：]?\s*([^\s，。、,\.]{2,20})/,
    /via\s+@?([A-Za-z0-9_\u4e00-\u9fff]{2,20})/i,
    /@([A-Za-z0-9_\u4e00-\u9fff]{2,20})的?(?:微博|声明|公告)/,
  ];
  for (const re of patterns) {
    const m = hay.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

/**
 * 一条材料的事实类型。词表按"最具体优先"排列：转会先于泛阵容，处罚先于泛联盟公告。
 * category（内容分析给的行业分类）只用于兜底与消歧：e.g. 同样出现"名单"，roster 类目下才是阵容。
 */
export function classifyClaim(input: ClaimInput): ClaimClassification {
  const title = input.title ?? "";
  const excerpt = input.excerpt ?? "";
  const hay = `${title}\n${excerpt}`;
  const category = input.category ?? "";
  const tags = input.tags ?? [];

  const rumorMarkers = hasAny(hay, RUMOR_MARKERS);
  const denialMarkers = hasAny(hay, DENIAL_MARKERS);

  const type: ClaimType = (() => {
    // 转会：选手流动的具体语态。
    if (/转会|租借|引援|加盟|签约|注册新|挂牌|买断|交换|下家|新东家/.test(hay)) return "transfer";
    if (/退役|挂靴|告别赛场|退役仪式|结束职业生涯/.test(hay)) return "retirement";
    if (/伤病|受伤|伤停|伤退|手术|因伤|伤愈复出|病退/.test(hay)) return "injury";
    if (/首发名单|首发阵容|出战名单|今日首发|比赛首发/.test(hay)) return "starting_lineup";
    // 阵容：大名单、教练组、人员注册。
    if (/大名单|名单公布|注册名单|人员变动|教练组|主教练|助教|监督|离队|回归|复出名单|选手名单/.test(hay)) return "roster";
    if (/处罚|罚款|禁赛|警告|违纪|通报批评|纪律委员会/.test(hay)) return "discipline";
    if (/赛程|延期|改期|时间调整|开赛时间|赛程调整|比赛时间/.test(hay)) return "schedule";
    if (/规则|赛制修改|赛制调整|竞赛规程/.test(hay) && !/版本|英雄|装备/.test(hay)) return "rule_change";
    if (/积分榜|排名|晋级形势|季后赛席位|胜场差|战绩榜/.test(hay)) return "standings";
    if (/门票|售票|开票|购票|观赛预约/.test(hay)) return "ticketing";
    if (/场馆|主场|举办地|落地城市|赛场地址/.test(hay)) return "venue";
    if (/赞助|冠名|合作伙伴|商务合作|品牌合作/.test(hay) || tags.includes("商务合作")) return "commercial";
    if (/专访|面对面|对话|独家对话/.test(hay) || tags.includes("采访人物")) return "interview";
    if (/里程碑|百场|千杀|第?\d+胜|队史|纪录|历史第[一二三]|达成成就/.test(hay)) return "milestone";
    if (/声明|公告|回应|澄清|致歉|官宣|正式宣布|正式公布/.test(hay)) return "statement";
    if (/抽奖|生日会|周年庆|粉丝福利|线下活动|综艺|直播预告/.test(hay)) return "entertainment";
    // 比赛结果：官方 API 是事实库，这里只收"报道赛果"的内容。
    if (/战胜|击败|取胜|惜败|横扫|零封|扳回|晋级|淘汰|夺冠|捧杯|摘得|斩获冠军|大比分|不敌|告负|险胜|先下一城|锁定胜局/.test(hay)) return "match_result";
    if (/复盘|分析|BP解读|战术|打法|教学|攻略|数据解读/.test(hay) || tags.includes("战术复盘") || tags.includes("攻略教学")) return "analysis";
    if (category === "match-result") return "match_result";
    if (category === "roster") return "roster";
    if (category === "league") return "rule_change";
    if (category === "patch") return "rule_change";
    if (category === "tactics" || category === "opinion") return "analysis";
    // 俱乐部/选手日常与新闻的兜底。
    if (/选手|队员/.test(hay)) return "player_news";
    if (/俱乐部|战队/.test(hay)) return "club_news";
    if (tags.includes("阵容转会")) return "roster";
    return "club_news";
  })();

  // 社区源：上面套出来的"俱乐部动态/选手动态/分析"若没有具体事实语态，就是讨论而不是新闻。
  // 事实类（赛果/转会/公告/处罚…）保持原判——社区曝光的官方内容仍按事实类型走权威矩阵。
  const discussionTypes: ClaimType[] = ["club_news", "player_news", "analysis", "entertainment"];
  const claimType: ClaimType = input.community === true && discussionTypes.includes(type) ? "community_discussion" : type;

  const originEntity = originEntityOf(hay);
  const repost = hasAny(hay, REPOST_MARKERS);
  const quotation = hasAny(hay, QUOTATION_MARKERS);
  const originType: ClaimClassification["originType"] = repost.length ? "repost" : quotation.length ? "syndication" : "original";
  return { claimType, rumorMarkers, denialMarkers, originType, originEntity };
}

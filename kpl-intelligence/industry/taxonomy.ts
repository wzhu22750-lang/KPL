// 这个行业的分类体系：类别、标签词表、战队（主体）名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 换行业时：类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。
// 战队名录以官方赛事数据为准（prod.comp.smoba.qq.com 的 team_id/team_name），转会与改名随时在后台修订。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；guide 告诉结构抽取模型这一类收什么、
 * 和相邻类别的边界在哪（总的归类原则写在 prompts/structure.md 里）。
 * commentary 标出评论类（战术复盘、观点）：日报写过的事又有评论类的后续报道，只占一行快讯（报道它的信源够多时除外）。
 * 没归上类的资料在日报里放进第一个 key 为 match-result 的类别所在的节（没有就放最后一节）。
 */
export const CATEGORIES = [
  { key: "match-result", label: "赛果", section: "赛果战报", guide: "比赛结果与进程：比分、BO 系列赛的胜负、单局战报、当日赛程赛果汇总、赛后 MVP 与关键数据。赛后复盘若以战术与 BP 讲解为主归 tactics，只报道结果归这里。" },
  { key: "roster", label: "阵容", section: "阵容与转会", guide: "战队人员变化：选手转会、租借、大名单公布、教练组变动、选手退役、复出、停赛与注册信息。选手个人专访若以生涯故事为主归 opinion，宣布离队/加入才是阵容。" },
  { key: "patch", label: "版本", section: "版本与赛制", guide: "游戏版本本身的变化：英雄强度调整、新英雄上线、装备与召唤师技能改动、赛场用版本切换及其对赛场环境的影响。仅讨论当前版本怎么玩、不报道改动内容的归 tactics 或 tutorial。" },
  { key: "league", label: "联盟", section: "版本与赛制", guide: "赛事组织层面的事：赛制规则变化、赛程与阶段安排、季后赛席位与晋级形势、联盟公告、俱乐部经营、赞助商务与合作。一场具体比赛的安排不算，赛果本身归 match-result。" },
  { key: "tactics", label: "战术", section: "战术与观点", guide: "以具体比赛或对局为素材的分析：BP 解读、阵容搭配思路、战术体系拆解、英雄克制讲解、经济与资源运营复盘。重点是可复用的打法认知；只有态度与预测而无做法归 opinion。", commentary: true },
  { key: "opinion", label: "观点", section: "战术与观点", guide: "重点是作者的解释、判断、主张、预测、评论或访谈观点。讨论战队或选手不自动归阵容，作者是解说或前选手不自动归观点。", commentary: true },
] as const satisfies ReadonlyArray<{ key: string; label: string; section: string; guide: string; commentary?: true }>;

/**
 * 这个行业最受关注的一类事件（AIHOT 原版是新模型）：日报报头的“N 场比赛”、改分类后修订已出的报告、
 * 战队编年史的上面一行都按它数。category 是类别，tag 是标签，两者都对上才算；unit 接在数字后面。
 */
export const RELEASE: { category: string; tag: string; unit: string } | null = { category: "match-result", tag: "赛果战报", unit: "场比赛" };

/** 周报月报的总述可以直接写、不必在报道里找到出处的行业通用词（小写）。站名会自动算进去。 */
export const PLAIN_TERMS: readonly string[] = ["kpl", "bp", "mvp", "fmvp", "bo5", "bo7", "moba", "elo", "kda"];

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 */
export const ITEM_TYPES = ["match_report", "roster_move", "patch_update", "league_business", "tactical_analysis", "tutorial_explainer", "opinion_analysis"] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/** 每篇资料的第一个标签必须是这些“分类标签”之一。 */
export const CATEGORY_TAGS = [
  "赛果战报", "阵容转会", "版本更新", "赛制公告", "战术复盘", "攻略教学", "观点评论", "数据统计", "采访人物", "商务合作",
  "其他",
] as const;

/** 可选的主题标签。 */
export const TOPIC_TAGS = [
  "世界冠军杯", "挑战者杯", "春季赛", "夏季赛", "年度总决赛", "常规赛", "季后赛", "版本环境", "青训", "电竞文化",
] as const;

/** 可选的实体标签（战队与联盟）。与 ENTITIES 的 name 一致。 */
export const ENTITY_TAGS = [
  "成都AG超玩会", "重庆狼队", "武汉eStarPro", "北京WB", "深圳DYG", "北京JDG", "长沙TES.A", "广州TTG",
  "佛山DRG", "南通Hero久竞", "济南RW侠", "西安WE", "上海EDG.M", "上海RNG.M", "杭州LGD.NBW", "苏州KSG",
  "桐乡情久", "无锡TCG", "KPL联盟",
] as const;

/** 模型常写的近义词，统一成词表里的写法。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  战报: "赛果战报", 赛果: "赛果战报", 比赛: "赛果战报", 战胜: "赛果战报", 击败: "赛果战报", 夺冠: "赛果战报", 冠军: "赛果战报",
  转会: "阵容转会", 引援: "阵容转会", 大名单: "阵容转会", 注册: "阵容转会", 退役: "阵容转会", 买卖: "阵容转会", 选手变动: "阵容转会",
  版本: "版本更新", 补丁: "版本更新", 英雄调整: "版本更新", 调整: "版本更新", 上线: "版本更新",
  赛制: "赛制公告", 公告: "赛制公告", 赛程: "赛制公告", 晋级: "赛制公告", 季后赛: "赛制公告", 规则: "赛制公告",
  复盘: "战术复盘", 分析: "战术复盘", "bp分析": "战术复盘", 战术: "战术复盘", 阵容搭配: "战术复盘",
  教程: "攻略教学", 攻略: "攻略教学", 教学: "攻略教学", 上分: "攻略教学", 玩法: "攻略教学",
  观点: "观点评论", 评论: "观点评论", 预测: "观点评论", 访谈: "采访人物", 采访: "采访人物", 人物: "采访人物",
  数据: "数据统计", 统计: "数据统计", 榜单: "数据统计",
  商务: "商务合作", 赞助: "商务合作", 合作: "商务合作", 经营: "商务合作",
  联盟: "赛制公告", 动态: "其他",
};

// ── 战队与联盟 ──────────────────────────────────────────────────────────────────────────

/**
 * 主体名录：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。
 * aliases 给结构抽取模型看；otherNames 是俱乐部自己的其他称呼（官方账号名、历史队名），
 * 把事实的主体对到发布方时也认它们。id 与 seeds 的 teams 表 slug 一致，上线后不要改。
 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[]; otherNames?: string[] }> = {
  kpl: { name: "KPL联盟", displayTag: "KPL", aliases: ["KPL", "王者荣耀职业联赛", "KPL联盟", "职业联赛"], otherNames: ["Hero Esports", "王者荣耀赛事", "腾讯电竞"] },
  ag: { name: "成都AG超玩会", displayTag: "AG", aliases: ["成都AG超玩会", "AG超玩会", "成都AG"], otherNames: ["AG", "超玩会"] },
  wolves: { name: "重庆狼队", displayTag: "狼队", aliases: ["重庆狼队", "狼队", "重庆QGhappy"], otherNames: ["QGhappy", "Wolves"] },
  estar: { name: "武汉eStarPro", displayTag: "eStar", aliases: ["武汉eStarPro", "eStarPro", "武汉eStar"], otherNames: ["eStar", "ES"] },
  wb: { name: "北京WB", displayTag: "WB", aliases: ["北京WB", "WB战队"], otherNames: ["WB", "TS战队"] },
  dyg: { name: "深圳DYG", displayTag: "DYG", aliases: ["深圳DYG", "DYG战队"], otherNames: ["DYG"] },
  jdg: { name: "北京JDG", displayTag: "JDG", aliases: ["北京JDG", "JDG王者荣耀"], otherNames: ["JDG"] },
  "tes-a": { name: "长沙TES.A", displayTag: "TES.A", aliases: ["长沙TES.A", "TES.A"], otherNames: ["TES", "滔搏"] },
  ttg: { name: "广州TTG", displayTag: "TTG", aliases: ["广州TTG", "TTG战队"], otherNames: ["TTG"] },
  drg: { name: "佛山DRG", displayTag: "DRG", aliases: ["佛山DRG", "DRG.GK"], otherNames: ["DRG", "GK"] },
  hero: { name: "南通Hero久竞", displayTag: "Hero", aliases: ["南通Hero久竞", "Hero久竞"], otherNames: ["Hero", "久竞"] },
  rw: { name: "济南RW侠", displayTag: "RW侠", aliases: ["济南RW侠", "RW侠"], otherNames: ["RW"] },
  we: { name: "西安WE", displayTag: "WE", aliases: ["西安WE", "WE战队"], otherNames: ["WE", "Team WE"] },
  edgm: { name: "上海EDG.M", displayTag: "EDG.M", aliases: ["上海EDG.M", "EDG.M"], otherNames: ["EDGM"] },
  rngm: { name: "上海RNG.M", displayTag: "RNG.M", aliases: ["上海RNG.M", "RNG.M"], otherNames: ["RNGM", "RNG"] },
  "lgd-nbw": { name: "杭州LGD.NBW", displayTag: "LGD", aliases: ["杭州LGD.NBW", "LGD.NBW"], otherNames: ["LGD", "NBW"] },
  ksg: { name: "苏州KSG", displayTag: "KSG", aliases: ["苏州KSG", "KSG战队"], otherNames: ["KSG"] },
  qingjiu: { name: "桐乡情久", displayTag: "情久", aliases: ["桐乡情久", "情久"], otherNames: ["QJ"] },
  tcg: { name: "无锡TCG", displayTag: "TCG", aliases: ["无锡TCG", "TCG"], otherNames: [] },
};

/**
 * 身份词典：摘要和标题里出现的战队/联盟，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴）。
 * 选手昵称同名冲突多（如“猫神”曾是多人昵称），词典只收战队与联盟，选手身份由 kb 的 entity_aliases 处理。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "kpl", name: "KPL联盟", patterns: [/KPL|王者荣耀职业联赛|\bKCC\b|世界冠军杯|挑战者杯/i] },
  { id: "ag", name: "成都AG超玩会", patterns: [/成都AG|AG超玩会|超玩会|\bAG\b(?!\w)/] },
  { id: "wolves", name: "重庆狼队", patterns: [/重庆狼队|(?<![a-zA-Z])狼队(?![a-zA-Z])|QGhappy|\bWolves\b/i] },
  { id: "estar", name: "武汉eStarPro", patterns: [/eStar|武汉eStar/i] },
  { id: "wb", name: "北京WB", patterns: [/(?<![a-zA-Z])WB(?![a-zA-Z])/] },
  { id: "dyg", name: "深圳DYG", patterns: [/\bDYG\b/i] },
  { id: "jdg", name: "北京JDG", patterns: [/\bJDG\b/i] },
  { id: "tes-a", name: "长沙TES.A", patterns: [/TES\.A|(?<![A-Z])TES(?!\.?[A-Z])/] },
  { id: "ttg", name: "广州TTG", patterns: [/\bTTG\b/i] },
  { id: "drg", name: "佛山DRG", patterns: [/佛山DRG|\bDRG\b|(?<![A-Z])GK(?![A-Z])/] },
  { id: "hero", name: "南通Hero久竞", patterns: [/Hero久竞|南通Hero|\bHero(?!\s?(Arena|Brink))/] },
  { id: "rw", name: "济南RW侠", patterns: [/RW侠|\bRW\b(?!\.?\w)/] },
  { id: "we", name: "西安WE", patterns: [/西安WE|(?<![a-zA-Z])WE(?![a-zA-Z])/] },
  { id: "edgm", name: "上海EDG.M", patterns: [/EDG\.M|EDGM/] },
  { id: "rngm", name: "上海RNG.M", patterns: [/RNG\.M|RNGM/] },
  { id: "lgd-nbw", name: "杭州LGD.NBW", patterns: [/LGD\.NBW|\bLGD\b(?!\.?\w)|NBW/] },
  { id: "ksg", name: "苏州KSG", patterns: [/苏州KSG|(?<![a-zA-Z])KSG(?![a-zA-Z])/] },
  { id: "qingjiu", name: "桐乡情久", patterns: [/桐乡情久|(?<![a-zA-Z])情久(?![a-zA-Z])/] },
  { id: "tcg", name: "无锡TCG", patterns: [/无锡TCG|(?<![a-zA-Z])TCG(?![a-zA-Z])/] },
];

/** 这些域名上的文章，发布方就是对应的主体（聚合站、媒体不算）。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "kpl", domains: ["kpl.qq.com", "pvp.qq.com", "spark.qq.com"] },
];

/** 原文里的这些写法也算提到了对应主体。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [
  { entityId: "wolves", pattern: /@狼队王者荣耀|@重庆狼队/ },
  { entityId: "ag", pattern: /@AG超玩会|@成都AG超玩会/ },
  { entityId: "kpl", pattern: /@KPL王者荣耀职业联赛|@王者荣耀职业联赛/ },
];

/** KPL 与王者荣耀核心战术与体系词汇 */
export const TACTICS_TERMS = [
  "张王组合", "张王体系", "乔夫体系", "乔离体系", "真香组合", "父子组合", "弹弓组合", "骨马体系", "露骨体系", "孙白杨体系", "关马体系", "朵核体系",
  "双狙流", "鬼火组合", "双飞组合", "野区", "反野", "换野", "守野区", "红区", "蓝区", "开龙", "控龙", "抢龙", "风暴龙王", "暴君", "主宰", "暗影先锋",
  "线权", "转线", "四一分带", "卡线", "断线", "拔塔", "破高地", "开团", "强开", "反打", "拉扯", "拆火", "掉点", "脱节", "视野压制", "以选代ban", "中辅摇摆",
  "连体", "挂边", "吃分体系"
] as const;

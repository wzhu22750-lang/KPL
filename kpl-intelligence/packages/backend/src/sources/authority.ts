// claim-type aware 的信源权威矩阵：不存在"KPL官方=100、虎扑=70"的统一分数。
// 同一个发布方对不同类型的事实有不同的发言资格——KPL联盟对处罚公告是最高权威，对"选手伤病"
// 就不如俱乐部本人；虎扑对社区舆情是第一手，对比赛结果几乎没有资格。
// 消费方：events/group.ts（事实主源选举与升级）、events/rumor.ts（转会等爆料的确认门槛）、
// admin 覆盖率看板（信源资格说明）。
import type { ClaimType } from "./claims.ts";

export type OwnerType = "league" | "club" | "player" | "coach" | "staff" | "media" | "community";

/** 确认门槛：authority ≥ CONFIRM_AUTHORITY 的事实类型，该发布方的话可以定案（rumor → confirmed）。 */
export const CONFIRM_AUTHORITY = 85;

/** 各主体在具体事实类型上的权威分（0-100）。未列出的类型用 DEFAULTS 兜底。 */
const MATRIX: Record<OwnerType, Partial<Record<ClaimType, number>>> = {
  // KPL 联盟官方：赛制、处罚、赛程、赛事组织的最高权威；比赛结果本身以 esports_api 为准（kind 分支）。
  league: {
    match_result: 90, schedule: 100, rule_change: 100, discipline: 100, tournament: 100,
    standings: 100, transfer: 90, roster: 90, retirement: 70, injury: 60, starting_lineup: 60,
    milestone: 90, statement: 100, interview: 80, ticketing: 100, venue: 100, commercial: 90,
  },
  // 俱乐部官方：自己队的事（阵容/转会/首发/伤病/声明）是最高权威；对联赛规则、别家的事没有资格。
  club: {
    transfer: 100, roster: 100, retirement: 100, injury: 100, starting_lineup: 100,
    statement: 100, club_news: 100, player_news: 90, schedule: 40, match_result: 10,
    rule_change: 20, discipline: 30, standings: 30, tournament: 30, commercial: 80,
  },
  // 选手本人：自己的声明最高权威；对转会（自己的去向）有高度但非最终资格，官宣仍以俱乐部/联盟为准。
  player: {
    statement: 100, retirement: 100, injury: 90, transfer: 80, player_news: 100,
    match_result: 10, rule_change: 10, discipline: 20,
  },
  coach: {
    starting_lineup: 90, statement: 90, transfer: 40, roster: 40, analysis: 85,
    match_result: 10, rule_change: 10,
  },
  staff: { statement: 80, roster: 40, analysis: 75, match_result: 10 },
  // 媒体：采访与报道的载体，不是事实的最终出处；转会的报道不能定案。
  media: {
    interview: 90, analysis: 70, match_result: 40, transfer: 30, roster: 30,
    schedule: 40, standings: 50, club_news: 40, player_news: 40,
  },
  // 社区：舆情与讨论的第一手，事实类声明几乎无资格。
  community: {
    community_discussion: 90, analysis: 60, match_result: 20, transfer: 10,
    roster: 10, schedule: 10, rumor: 60,
  },
};

const DEFAULTS: Record<OwnerType, number> = { league: 85, club: 70, player: 55, coach: 55, staff: 50, media: 45, community: 30 };

/** 一个信源的主体类型与声明范围（sources 表投影）。 */
export interface AuthoritySource {
  kind?: string;
  tier: string;
  first_party: boolean;
  owner_type?: string | null;
  /** 信源有资格发言的事实类型；非空时，范围外的声明一票无资格。 */
  claim_types?: string[] | null;
  /** 信源归属实体（owner_entity_id）：俱乐部信源的 slug，如 "ag" / "wolves"。 */
  owner_entity_id?: string | null;
}

/**
 * source 对某类事实的权威分。mentionedEntityIds 是这条材料提到的实体（kb entity_mentions 的
 * team/player id）：俱乐部的权威只覆盖自己的队——AG官博谈 AG 转会是定案，谈别家转会只是线索。
 */
export function authorityFor(source: AuthoritySource, claimType: ClaimType, mentionedEntityIds: Iterable<string> = []): number {
  const ownerType = (source.owner_type ?? (source.tier === "T1" ? "league" : source.tier === "T2" ? "community" : source.tier === "T3" ? "player" : "media")) as OwnerType;
  // 官方结构化赛事数据是比赛事实的事实库（esports.ts）：比分、赛程、BP、数据。
  if (source.kind === "esports_api") return ["match_result", "schedule", "standings", "tournament", "starting_lineup"].includes(claimType) ? 100 : DEFAULTS[ownerType];
  // 声明范围外的类型：这个信源根本没有发言资格（如俱乐部公众号声明只发赛事资讯）。
  if (source.claim_types?.length && !source.claim_types.includes(claimType)) return 0;
  const own = [...mentionedEntityIds];
  let score = MATRIX[ownerType]?.[claimType] ?? DEFAULTS[ownerType];
  // 俱乐部/选手的"自己的事"加成；谈别人家的事压到媒体水平。
  const isOwn = source.owner_entity_id != null && own.includes(source.owner_entity_id);
  if (ownerType === "club" || ownerType === "player") {
    score = isOwn ? Math.max(score, ownScore(ownerType, claimType)) : Math.min(score, 40);
  }
  if (ownerType === "coach" || ownerType === "staff") {
    score = isOwn ? Math.max(score, 80) : Math.min(score, 40);
  }
  return score;
}

function ownScore(ownerType: "club" | "player", claimType: ClaimType): number {
  if (ownerType === "club") {
    return ({ transfer: 100, roster: 100, retirement: 100, injury: 100, starting_lineup: 100, statement: 100, club_news: 100, player_news: 90 } as Partial<Record<ClaimType, number>>)[claimType] ?? 70;
  }
  return ({ statement: 100, retirement: 100, injury: 90, transfer: 80, player_news: 100 } as Partial<Record<ClaimType, number>>)[claimType] ?? 55;
}

/** 该发布方是否有资格就这类事实定案（俱乐部官宣转会、联盟宣布处罚……）。 */
export function canConfirm(source: AuthoritySource, claimType: ClaimType, mentionedEntityIds: Iterable<string> = []): boolean {
  return authorityFor(source, claimType, mentionedEntityIds) >= CONFIRM_AUTHORITY;
}

// KPL 知识库的网站 API 契约（/api/site/teams|schedule|matches|players）。类型只描述形状，行结构镜像查询输出。
// 与 site.ts 的其他契约一样：web 只 import 类型，路径字符串手写。

export interface KbTeam {
  slug: string;
  name: string;
  shortName: string | null;
  logo: string | null;
  city: string | null;
  isActive: boolean;
}

export interface ScheduleMatchSide {
  slug: string;
  name: string;
  shortName: string | null;
  logo: string | null;
  score: number;
}

export interface ScheduleMatch {
  id: string;
  seasonId: string;
  seasonName: string;
  stage: string | null;
  bo: number | null;
  status: "scheduled" | "live" | "finished" | "postponed" | "cancelled";
  scheduledAt: string | null;
  playedAt: string | null;
  gamesExpected: number | null;
  gamesCount: number;
  home: ScheduleMatchSide;
  away: ScheduleMatchSide;
  winner: string | null;
  ccKey: string | null;
}

export interface AvailableSeason {
  id: string;
  name: string;
  year: number;
  externalId: string;
  isCurrent?: boolean;
}

export interface ScheduleResponse {
  season: { id: string; name: string } | null;
  availableSeasons: AvailableSeason[];
  matches: ScheduleMatch[];
}

/**
 * P4 首页“今日比赛”（GET /api/site/kb/schedule?day=today）：
 * day 是北京时间日期；fallback=true 表示今日无比赛，已回退到最近场次。
 */
export interface DayScheduleResponse extends ScheduleResponse {
  day: string;
  fallback: boolean;
}

export interface TeamsResponse {
  teams: Array<KbTeam & { city: string | null; champions: number }>;
}

export interface TeamRosterPlayer {
  slug: string;
  nickname: string;
  position: string | null;
  portrait: string | null;
}

export interface TeamHonor {
  season: string | null;
  kind: string;
  note: string | null;
  year: number | null;
  title: string | null;
}

/** 实体详情页的“相关动态”：entity_mentions 桥联出来的新闻卡片。 */
export interface NewsCard {
  id: string;
  title: string;
  summary: string | null;
  publishedAt: string | null;
  selected: boolean;
  kind?: string | null;
}

export interface TeamDetailResponse {
  team: KbTeam & { foundedAt: string | null; historyNames: string[]; styleNotes: string | null };
  record: { wins: number; losses: number };
  roster: TeamRosterPlayer[];
  honors: TeamHonor[];
  recentMatches: ScheduleMatch[];
  news: NewsCard[];
}

export interface BpStep {
  step: number;
  type: "ban" | "pick";
  side: "blue" | "red";
  hero: { id: string; name: string };
  player: string | null;
  position: string | null;
}

export interface GamePlayerRow {
  nickname: string;
  team: string | null;
  side: "blue" | "red" | null;
  hero: string | null;
  heroIcon: string | null;
  position: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  gold: number | null;
  damage: number | null;
  mvp: boolean;
  mvpScore: number | null;
}

export interface GameDetail {
  id: string;
  gameNo: number;
  mode: "standard" | "pinnacle";
  winner: string | null;
  durationSecs: number | null;
  mvp: string | null;
  killsBlue: number | null;
  killsRed: number | null;
  goldBlue: number | null;
  goldRed: number | null;
  bp: BpStep[];
  players: GamePlayerRow[];
}

export interface MatchBattleVideoItem {
  battleSeq: number;
  url: string;
  channel?: string;
  title?: string;
}

export interface MatchDetailResponse {
  match: ScheduleMatch & { sourceUrl: string | null };
  blue: ScheduleMatchSide & { id: string };
  red: ScheduleMatchSide & { id: string };
  games: GameDetail[];
  videos?: MatchBattleVideoItem[];
}

/** P2 比赛主卡：match + games + 关联 stories + 按局次/时间组织的时间线。 */
export type MatchStoryLinkType = "series" | "game" | "node";

export interface MatchCardStory {
  story: {
    publicId: string;
    title: string;
    firstReportAt: string | null;
    latestAt: string | null;
  };
  gameNo: number | null;
  linkType: MatchStoryLinkType;
}

export interface MatchCardTimelineItem {
  kind: "game" | "story";
  /** 局次（game_no）；整场级 story 为 null，排在小局之后。 */
  gameNo: number | null;
  title: string;
  /** 小局胜者（game kind）；story kind 为 null。 */
  winner: string | null;
  /** story kind 的 public_id；game kind 为 null。 */
  storyPublicId: string | null;
  linkType: MatchStoryLinkType | null;
  /** 发布时间（game：null；story：最早报道的发布时间）。 */
  publishedAt: string | null;
  /** 发现时间（game：null；story：最早报道的发现时间）。 */
  discoveredAt: string | null;
}

export interface MatchCardResponse {
  match: ScheduleMatch & { sourceUrl: string | null };
  games: GameDetail[];
  stories: MatchCardStory[];
  timeline: MatchCardTimelineItem[];
}

export interface PlayerStint {
  team: string | null;
  teamSlug: string | null;
  joinedAt: string | null;
  leftAt: string | null;
}

export interface PlayerSeasonStat {
  seasonId: string;
  seasonName: string;
  games: number;
  wins: number;
  mvps: number;
  avgKills: number | null;
  avgDeaths: number | null;
  avgAssists: number | null;
}

export interface PlayerHeroStat {
  hero: string;
  heroIcon: string | null;
  games: number;
  wins: number;
}

export interface PlayerHonor {
  kind: string;
  season: string | null;
  title: string | null;
  year: number | null;
  note: string | null;
}

export interface PlayerDetailResponse {
  player: { slug: string; nickname: string; realName: string | null; bio: string | null; position: string | null; portrait: string | null; debutAt: string | null; team: string | null; teamSlug: string | null };
  stints: PlayerStint[];
  seasons: PlayerSeasonStat[];
  heroes: PlayerHeroStat[];
  honors: PlayerHonor[];
  news: NewsCard[];
}

// ==================== 1. 英雄相关契约 ====================
export interface HeroListItem {
  id: string;              // slug 或 hero_id（如 'sun-shangxiang'）
  heroId: number;          // 官方 hero_id
  name: string;            // '孙尚香'
  avatar: string;          // 头像 URL
  primaryPos: string;      // '发育路'
  positions: string[];     // ['发育路']
  functionTags: string[];  // ['爆发射手', '后期大核']
  versionStrength: string; // 'T0.5'
  picks: number;           // 职业出场次数
  bans: number;            // 职业禁用次数
  bpRate: number;          // BP 参与率 (0~1)
  winRate: number;         // 胜率 (0~1)
  topPlayer?: {
    slug: string;
    nickname: string;
    games: number;
    winRate: number;
    score?: number;
    mvpCount?: number;
    isFmvpHero?: boolean;
    fmvpSkinTitle?: string;
  };
}

export interface HeroListResponse {
  heroes: HeroListItem[];
  totalGames: number;      // 统计样本总局数
  season?: string;         // 当前选定赛季
}

export interface TeamSummary {
  id?: string;
  slug: string;
  name: string;
  shortName?: string | null;
  logo?: string | null;
  city?: string | null;
}

export interface SeasonSummary {
  id: string;
  name: string;
  year?: number;
}

export interface MatchSummary {
  id: string;
  seasonId?: string;
  seasonName?: string;
  stage?: string | null;
  bo?: number | null;
  status?: string;
  scheduledAt?: string | null;
  playedAt?: string | null;
  home: {
    slug: string;
    name: string;
    shortName?: string | null;
    logo?: string | null;
    score: number;
  };
  away: {
    slug: string;
    name: string;
    shortName?: string | null;
    logo?: string | null;
    score: number;
  };
  winner?: string | null;
}

export interface HeroDetailResponse {
  hero: {
    id: string;
    heroId: number;
    name: string;
    title?: string;
    avatar: string;
    primaryPos: string;
    positions: string[];
    functionTags: string[];
    versionStrength: string;
    powerPeriod?: string;
  };
  stats: {
    picks: number;
    bans: number;
    bpRate: number;
    wins: number;
    losses: number;
    winRate: number;
    blueWinRate: number;   // 蓝方胜率
    redWinRate: number;    // 红方胜率
    avgKda: number;
    avgDamageShare: number;// 场均伤害占比
    avgGoldShare: number;  // 场均经济占比
  };
  topPlayers: Array<{
    playerSlug: string;
    nickname: string;
    portrait?: string;
    teamName?: string;
    games: number;
    wins: number;
    winRate: number;
    kda: number;
    mvpCount: number;
    mvpRate?: number;
    playoffWins?: number;
    score: number;
    isFmvpHero?: boolean;
    fmvpSkinTitle?: string;
  }>;
  bestPartners: Array<{   // 同队胜率最高搭档 Top 5
    heroId: number;
    name: string;
    avatar: string;
    games: number;
    winRate: number;
  }>;
  counters: Array<{       // 对位胜率克制关系 Top 5
    heroId: number;
    name: string;
    avatar: string;
    games: number;
    winRate: number;
  }>;
  recentMatches: MatchSummary[];
}

// ==================== 2. H2H 历史对战契约 ====================
export interface H2HResponse {
  teamA: TeamSummary;
  teamB: TeamSummary;
  stats: {
    totalMatches: number;  // 大场总交手
    teamAWins: number;     // A 队大场胜场
    teamBWins: number;     // B 队大场胜场
    teamAGames: number;    // A 队小局胜局
    teamBGames: number;    // B 队小局胜局
    teamABo7Wins: number;  // BO7 关键胜场
    teamBBo7Wins: number;  // BO7 关键胜场
    last5WinnerSlugs: string[]; // 最近 5 场胜者走势
  };
  matches: MatchSummary[]; // 历次交锋对决清单（按时间倒序）
}

// ==================== 3. 积分榜契约 ====================
export interface StandingRow {
  rank: number;
  team: TeamSummary;
  group: 'S' | 'A' | 'B' | '季后赛' | '总榜';
  stageName?: string;      // '常规赛第一轮'
  matchesPlayed: number;
  wins: number;
  losses: number;
  winRate: number;
  gamesWon: number;
  gamesLost: number;
  gameDiff: number;        // 净胜局
  points: number;          // 积分
  streak: string;          // '3连胜' | '1连败'
}

export interface StandingsResponse {
  season: SeasonSummary;
  availableSeasons: AvailableSeason[];
  currentStage: string;
  stages: string[];        // ['常规赛第一轮', '常规赛第二轮', '常规赛第三轮', '季后赛']
  standingsByGroup: Record<string, StandingRow[]>; // { "S组": [...], "A组": [...], "B组": [...] }
}


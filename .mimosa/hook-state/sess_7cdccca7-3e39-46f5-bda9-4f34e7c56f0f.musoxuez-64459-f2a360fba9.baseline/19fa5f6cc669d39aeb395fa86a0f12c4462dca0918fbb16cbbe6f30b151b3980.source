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
  status: "scheduled" | "live" | "finished" | "cancelled";
  scheduledAt: string | null;
  playedAt: string | null;
  gamesExpected: number | null;
  gamesCount: number;
  home: ScheduleMatchSide;
  away: ScheduleMatchSide;
  winner: string | null;
  ccKey: string | null;
}

export interface ScheduleResponse {
  season: { id: string; name: string } | null;
  matches: ScheduleMatch[];
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
}

export interface TeamDetailResponse {
  team: KbTeam & { foundedAt: string | null; historyNames: string[]; styleNotes: string | null };
  record: { wins: number; losses: number };
  roster: TeamRosterPlayer[];
  honors: TeamHonor[];
  recentMatches: ScheduleMatch[];
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

export interface MatchDetailResponse {
  match: ScheduleMatch & { sourceUrl: string | null };
  blue: ScheduleMatchSide & { id: string };
  red: ScheduleMatchSide & { id: string };
  games: GameDetail[];
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

export interface PlayerDetailResponse {
  player: { slug: string; nickname: string; realName: string | null; position: string | null; portrait: string | null; debutAt: string | null; team: string | null; teamSlug: string | null };
  stints: PlayerStint[];
  seasons: PlayerSeasonStat[];
  heroes: PlayerHeroStat[];
}

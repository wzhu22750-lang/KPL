// KPL 领域化比赛事件识别、语义指纹提取与去重归组算法
import { collapseWhitespace } from "./text.ts";
import { beijingDate } from "@aihot/contracts/time";

export interface KplMatchFingerprint {
  teams: string[];
  stage?: string;
  outcome?: string;
  explicitDateKey?: string;
  dateKey?: string;
  game?: string;
  round?: string;
  matchKey: string;
}

// 战队别名映射字典（全部映射为标准 slug）
const TEAM_ALIAS_MAP: Array<{ slug: string; aliases: string[] }> = [
  { slug: "ksg", aliases: ["苏州ksg", "ksg", "快手ksg"] },
  { slug: "rw", aliases: ["济南rw侠", "rw侠", "济南rw", "rw"] },
  { slug: "ag", aliases: ["成都ag超玩会", "ag超玩会", "成都ag", "ag"] },
  { slug: "wolves", aliases: ["重庆狼队", "狼队", "qghappy", "qg"] },
  { slug: "estar", aliases: ["武汉estarpro", "estarpro", "武汉estar", "estar", "es"] },
  { slug: "ttg", aliases: ["广州ttg", "ttg"] },
  { slug: "wb", aliases: ["北京wb王者荣耀分部", "北京wb", "wb", "tsgaming", "ts"] },
  { slug: "hero", aliases: ["南京hero久竞俱乐部", "南京hero久竞", "南通hero久竞", "hero久竞", "南京hero", "hero"] },
  { slug: "drg", aliases: ["佛山drg电子竞技俱乐部", "佛山drg", "drg"] },
  { slug: "dyg", aliases: ["深圳dyg", "dyg"] },
  { slug: "tes", aliases: ["长沙tes.a", "长沙tes", "tes.a", "tes", "滔搏"] },
  { slug: "lgd", aliases: ["杭州lgd.nbw", "杭州lgd大鹅", "lgd.nbw", "lgd大鹅", "lgd"] },
  { slug: "edgm", aliases: ["上海edg.m", "上海edgm", "edg.m", "edgm"] },
  { slug: "rngm", aliases: ["上海rng.m", "上海rngm", "rng.m", "rngm"] },
  { slug: "we", aliases: ["西安we", "we"] },
  { slug: "jdg", aliases: ["北京jdg", "jdg"] },
  { slug: "tcg", aliases: ["无锡tcg", "tcg"] },
  { slug: "q9", aliases: ["桐乡情久", "情久", "q9"] },
];

/**
 * 清洗标题前缀噪点（方括号、栏目名、日期标签等）
 */
export function normalizeKplTitle(rawTitle: string): string {
  let title = rawTitle.toLowerCase();
  // 移除 【...】、[...] 等标签
  title = title.replace(/【[^】]*】/g, " ");
  title = title.replace(/\[[^\]]*\]/g, " ");
  title = title.replace(/（[^）]*）/g, " ");
  title = title.replace(/\([^)]*\)/g, " ");
  // 移除常见固定栏目字样与分隔符
  title = title.replace(/kpl战报\s*[\|丨:：\-_]/g, " ");
  title = title.replace(/赛事资讯\s*[\|丨:：\-_]/g, " ");
  title = title.replace(/互动有奖\s*[\|丨:：\-_]/g, " ");
  title = title.replace(/抽奖赠票\s*[\|丨:：\-_]/g, " ");
  title = title.replace(/送票\s*[!！]/g, " ");
  title = title.replace(/官宣\s*[!！]/g, " ");
  title = title.replace(/每日随机资讯/g, " ");
  // 移除开头日期，如 10月2日、2026-03-19- 等
  title = title.replace(/^\s*\d{1,4}[-/.年]\d{1,2}[-/.月]\d{1,2}[日号]?[-:：\s]*/, " ");
  title = title.replace(/\d{1,2}月\d{1,2}[日号]/g, " ");
  // 移除标点符号
  title = title.replace(/[,，!！?？:：;；、\|丨/\\_]/g, " ");
  return collapseWhitespace(title).trim();
}

/**
 * 从文本中识别提及的战队列表（已去重并排序）
 */
export function extractTeamsFromText(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();

  for (const team of TEAM_ALIAS_MAP) {
    for (const alias of team.aliases) {
      // Latin aliases need boundaries too: e.g. TES must not match "test".
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = `${/^[a-z0-9]/.test(alias) ? "(?<![a-z0-9])" : ""}${escaped}${/[a-z0-9]$/.test(alias) ? "(?![a-z0-9])" : ""}`;
      if (new RegExp(pattern, "i").test(lower)) {
        found.add(team.slug);
        break;
      }
    }
  }

  return Array.from(found).sort();
}

/**
 * 提取标题中的日期标签（格式 YYYYMMDD）。
 * 返回 { explicitDateKey, dateKey }：explicitDateKey 仅在标题明文出现日期时有值；dateKey 若无明文则回退到发帖日。
 */
export function extractDateKeysFromText(text: string, fallbackDate?: Date | null): { explicitDateKey?: string; dateKey?: string } {
  const fallback = fallbackDate && Number.isFinite(+fallbackDate) ? beijingDate(fallbackDate) : undefined;
  const full = text.match(/(?<!\d)((?:19|20)\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})(?:[日号]|(?!\d))/);
  const short = text.match(/(?<!\d)(\d{1,2})月(\d{1,2})[日号]/);
  const year = full?.[1] ?? text.match(/(?:19|20)\d{2}/)?.[0] ?? fallback?.slice(0, 4);
  let explicitDateKey: string | undefined;
  if (full || short) {
    if (year) {
      const month = (full?.[2] ?? short![1]!).padStart(2, "0");
      const day = (full?.[3] ?? short![2]!).padStart(2, "0");
      const iso = `${year}-${month}-${day}`;
      const parsed = new Date(`${iso}T00:00:00+08:00`);
      if (Number.isFinite(+parsed) && beijingDate(parsed) === iso) {
        explicitDateKey = iso.replaceAll("-", "");
      }
    }
  }
  const dateKey = explicitDateKey ?? fallback?.replaceAll("-", "");
  return { explicitDateKey, dateKey };
}

export function extractDateKeyFromText(text: string, fallbackDate?: Date | null): string | undefined {
  return extractDateKeysFromText(text, fallbackDate).dateKey;
}

/**
 * 提取比赛事件指纹
 */
export function extractMatchFingerprint(title: string, date?: Date | null): KplMatchFingerprint | null {
  const teams = extractTeamsFromText(title);
  // 一场对决通常包含两支队伍（例如 KSG vs RW侠，或包含 "迎战"、"零封"、"对阵"）
  if (teams.length !== 2) {
    return null;
  }

  const teamKey = `${teams[0]}-vs-${teams[1]}`;
  const { explicitDateKey, dateKey } = extractDateKeysFromText(title, date);

  let stage = "";
  if (/年度总决赛|年总/.test(title)) stage = "annual-finals";
  else if (/春季赛/.test(title)) stage = "spring";
  else if (/夏季赛/.test(title)) stage = "summer";
  else if (/挑战者杯|挑杯/.test(title)) stage = "kcc";
  else if (/世界冠军杯|世冠|kic/.test(title)) stage = "kic";

  let outcome = "";
  if (/零封|3-0|3:0|4-0|4:0/.test(title)) outcome = "sweep";
  else if (/开门红/.test(title)) outcome = "opener";

  const ordinal = title.match(/第([一二三四五六七八九十\d]+)局/);
  const chinese: Record<string, string> = { 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9", 十: "10" };
  const game = ordinal ? chinese[ordinal[1]!] ?? ordinal[1] : undefined;
  const round = title.match(/\bW\d+D\d+\b/i)?.[0].toUpperCase();
  const matchKey = `match:${teamKey}${stage ? `:${stage}` : ""}${dateKey ? `:${dateKey}` : ""}${round ? `:${round}` : ""}${game ? `:game-${game}` : ""}`;

  return { teams, stage, outcome, explicitDateKey, dateKey, game, round, matchKey };
}

/**
 * 2-gram 字符串字符级 Jaccard 相似度
 */
export function charBigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const setA = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) setA.add(a.slice(i, i + 2));
  const setB = new Set<string>();
  for (let i = 0; i < b.length - 1; i++) setB.add(b.slice(i, i + 2));

  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const bg of setA) {
    if (setB.has(bg)) intersection++;
  }

  return intersection / (setA.size + setB.size - intersection);
}

/**
 * 判定两篇报道是否描述完全相同的 KPL 赛事/事件 (Same Occurrence)
 */
export function areSameKplOccurrence(
  titleA: string,
  titleB: string,
  dateA?: Date | null,
  dateB?: Date | null
): boolean {
  const a = extractMatchFingerprint(titleA, dateA);
  const b = extractMatchFingerprint(titleB, dateB);
  // Similar wording, a shared team, a season, or "零封" is never identity evidence.
  // Restrict the shortcut to match reports; other news still uses the relation judge.
  const matchLanguage = /对阵|对战|迎战|战胜|击败|零封|拿下|\bvs\b|\d\s*[:：-]\s*\d/i;
  return !!(a && b && a.dateKey && a.dateKey === b.dateKey
    && matchLanguage.test(titleA) && matchLanguage.test(titleB)
    && !kplOccurrenceConflict(titleA, titleB, dateA, dateB));
}

/** Hard veto, also applied AFTER model recall: no positive shortcut may override a conflict.
 * Missing identity is not a match. A missing date remains uncertain; an explicit event date wins
 * over publication day (so next-day reports naming yesterday can still join it).
 */
export function kplOccurrenceConflict(titleA: string, titleB: string, dateA?: Date | null, dateB?: Date | null): string | null {
  const a = extractMatchFingerprint(titleA, dateA);
  const b = extractMatchFingerprint(titleB, dateB);
  if (!a || !b) return null;
  if (a.teams.join(",") !== b.teams.join(",")) return "different opponents";
  // 标题明确指明了不同比赛日期的，绝对互斥
  if (a.explicitDateKey && b.explicitDateKey && a.explicitDateKey !== b.explicitDateKey) return "different match dates";
  // 无论是否明文，若日期推导跨度超过 36 小时（即不是同场赛后连夜跨零点报道，而是隔日/隔周比赛），互斥
  if (a.dateKey && b.dateKey) {
    const dA = new Date(`${a.dateKey.slice(0, 4)}-${a.dateKey.slice(4, 6)}-${a.dateKey.slice(6, 8)}T00:00:00Z`).getTime();
    const dB = new Date(`${b.dateKey.slice(0, 4)}-${b.dateKey.slice(4, 6)}-${b.dateKey.slice(6, 8)}T00:00:00Z`).getTime();
    if (Math.abs(dA - dB) > 36 * 3600 * 1000) return "different match dates";
  }
  if (a.stage && b.stage && a.stage !== b.stage) return "different competitions";
  if (a.round && b.round && a.round !== b.round) return "different rounds";
  if (a.game !== b.game && (a.game || b.game)) return "different game scope";
  return null;
}

/**
 * P2 SAME_SERIES：同一系列赛的不同小局（同两队 + 同日期 + 同赛事/轮次，但局次不同）。
 * 软关系，仅用于“不触发 kplOccurrenceConflict 硬 veto”：调用方把这类两篇并入同一个 story、
 * 按局次分属不同 fact。至少一篇带局次信息且两篇局次不一致才算（两篇都没局次 → 不是“不同局”）。
 */
export function areSameSeriesDifferentGame(
  titleA: string,
  titleB: string,
  dateA?: Date | null,
  dateB?: Date | null
): boolean {
  const a = extractMatchFingerprint(titleA, dateA);
  const b = extractMatchFingerprint(titleB, dateB);
  if (!a || !b) return false;
  if (a.teams.join(",") !== b.teams.join(",")) return false;
  if (!a.dateKey || !b.dateKey || a.dateKey !== b.dateKey) return false;
  if ((a.stage || "") !== (b.stage || "")) return false;
  if ((a.round || "") !== (b.round || "")) return false;
  if (!a.game && !b.game) return false;
  return a.game !== b.game;
}

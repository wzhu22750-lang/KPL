// KPL 领域化比赛事件识别、语义指纹提取与去重归组算法
import { collapseWhitespace } from "./text.ts";

export interface KplMatchFingerprint {
  teams: string[];
  stage?: string;
  outcome?: string;
  dateKey?: string;
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
      // 避免短词误伤（如 'es'、'we'、'ts'、'qg' 等需配合边界或中文前后）
      if (alias.length <= 2) {
        const regex = new RegExp(`(?:[^a-z0-9]|^)${alias}(?:[^a-z0-9]|$)`, "i");
        if (regex.test(lower)) {
          found.add(team.slug);
          break;
        }
      } else if (lower.includes(alias)) {
        found.add(team.slug);
        break;
      }
    }
  }

  return Array.from(found).sort();
}

/**
 * 提取标题中的日期标签（格式 YYYYMMDD 或 MMDD）
 */
export function extractDateKeyFromText(text: string, fallbackDate?: Date | null): string | undefined {
  const dateMatch = text.match(/(?:202\d[年/-])?(\d{1,2})月(\d{1,2})[日号]/);
  if (dateMatch && dateMatch[1] && dateMatch[2]) {
    const m = dateMatch[1].padStart(2, "0");
    const d = dateMatch[2].padStart(2, "0");
    const y = text.match(/202\d/) ? text.match(/202\d/)![0] : (fallbackDate ? String(fallbackDate.getFullYear()) : "2026");
    return `${y}${m}${d}`;
  }
  if (fallbackDate && !isNaN(fallbackDate.getTime())) {
    const y = fallbackDate.getFullYear();
    const m = String(fallbackDate.getMonth() + 1).padStart(2, "0");
    const d = String(fallbackDate.getDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }
  return undefined;
}

/**
 * 提取比赛事件指纹
 */
export function extractMatchFingerprint(title: string, date?: Date | null): KplMatchFingerprint | null {
  const teams = extractTeamsFromText(title);
  // 一场对决通常包含两支队伍（例如 KSG vs RW侠，或包含 "迎战"、"零封"、"对阵"）
  if (teams.length < 2) {
    return null;
  }

  const teamKey = `${teams[0]}-vs-${teams[1]}`;
  const dateKey = extractDateKeyFromText(title, date);

  let stage = "";
  if (/年度总决赛|年总/.test(title)) stage = "annual-finals";
  else if (/春季赛/.test(title)) stage = "spring";
  else if (/夏季赛/.test(title)) stage = "summer";
  else if (/挑战者杯|挑杯/.test(title)) stage = "kcc";
  else if (/世界冠军杯|世冠|kic/.test(title)) stage = "kic";

  let outcome = "";
  if (/零封|3-0|3:0|4-0|4:0/.test(title)) outcome = "sweep";
  else if (/开门红/.test(title)) outcome = "opener";

  const matchKey = `match:${teamKey}${stage ? `:${stage}` : ""}${dateKey ? `:${dateKey}` : ""}`;

  return {
    teams,
    stage,
    outcome,
    dateKey,
    matchKey,
  };
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
  if (!titleA || !titleB) return false;

  // 1. 比赛事件指纹匹配（例如 KSG 迎战 RW侠，零封/年总开门红）
  const fpA = extractMatchFingerprint(titleA, dateA);
  const fpB = extractMatchFingerprint(titleB, dateB);

  if (fpA && fpB) {
    // 双方对阵队伍完全一致（如 ["ksg", "rw"]）
    const sameTeams = fpA.teams.length === 2 && fpB.teams.length === 2 &&
      fpA.teams[0] === fpB.teams[0] && fpA.teams[1] === fpB.teams[1];

    if (sameTeams) {
      // 场景 1: 日期键明确相同或都在同一赛事阶段
      if (fpA.dateKey && fpB.dateKey && fpA.dateKey === fpB.dateKey) {
        return true;
      }
      // 场景 2: 都有相同赛事阶段（如年总/春季赛），且若日期已知则时间差在 7 天内
      if (fpA.stage && fpB.stage && fpA.stage === fpB.stage) {
        if (!dateA || !dateB || Math.abs(dateA.getTime() - dateB.getTime()) <= 7 * 86400_000) {
          return true;
        }
      }
      // 场景 3: 双方都包含特定赛事结果关键词（如 "零封" 或 "开门红"）
      if (fpA.outcome && fpB.outcome && fpA.outcome === fpB.outcome) {
        return true;
      }
    }
  }

  // 2. 语义相似度门槛（经过规范化后相似度极高且均包含战队特征）
  const normA = normalizeKplTitle(titleA);
  const normB = normalizeKplTitle(titleB);
  if (normA && normB && normA.length >= 6 && normB.length >= 6) {
    const teamsA = extractTeamsFromText(titleA);
    const teamsB = extractTeamsFromText(titleB);
    if (teamsA.length > 0 && teamsB.length > 0 && teamsA.some(t => teamsB.includes(t))) {
      const sim = charBigramSimilarity(normA, normB);
      if (sim >= 0.72) {
        if (dateA && dateB && Math.abs(dateA.getTime() - dateB.getTime()) > 4 * 86400_000) {
          return false;
        }
        return true;
      }
    }
  }

  return false;
}

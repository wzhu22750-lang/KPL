#!/usr/bin/env npx tsx
/**
 * P0 解说字幕解析器
 *
 * 将 B站字幕提取/KPL解说 目录下 7839 个 .md 文件解析为结构化 JSONL，
 * 并尝试关联到 kpl-intelligence 现有的 match/season 数据。
 *
 * 产出：
 *   data/commentary_parsed.jsonl  — 每行一个 CommentaryRecord
 *   data/commentary_stats.json    — 汇总统计
 *
 * 用法：
 *   npx tsx scripts/import-commentary.ts [--source <dir>] [--out <dir>] [--dry-run]
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ─── 类型定义 ────────────────────────────────────────────────────────

/** 一个分P的解析结果 */
interface CommentaryRecord {
  /** 唯一ID: BVID + '_P' + partNo */
  id: string;
  /** B站视频 BVID */
  bvid: string;
  /** CID */
  cid: string | null;
  /** 分P序号 (1-based) */
  partNo: number;
  /** 总分P数 */
  totalParts: number | null;
  /** 发布日期 YYYY-MM-DD */
  publishDate: string;
  /** 视频链接 */
  videoUrl: string;

  /** 所属赛季目录名 (如 "2026夏季赛") */
  seasonDir: string;
  /** 解析出的赛季标识 (如 "kpl-2026-summer") */
  seasonId: string | null;
  /** 赛季年份 */
  year: number;
  /** 赛事类型: spring|summer|challenger|worlds|annual */
  split: string;

  /** 比赛目录名 (完整文件夹名) */
  matchDir: string;
  /** 主队名 (标题原文) */
  homeTeamRaw: string | null;
  /** 客队名 (标题原文) */
  awayTeamRaw: string | null;
  /** 主队 slug (映射到 taxonomy) */
  homeTeamSlug: string | null;
  /** 客队 slug (映射到 taxonomy) */
  awayTeamSlug: string | null;
  /** 是否为正式对战 (含 vs/VS) */
  isMatch: boolean;

  /** 内容类型: game|interview|pre-show|promo|other */
  contentType: "game" | "interview" | "pre-show" | "promo" | "other";
  /** 局号 (1-7, 仅 contentType=game 时有值) */
  gameNo: number | null;
  /** 分P标题 (文件名中 P0x_ 后面的部分) */
  partTitle: string;

  /** 原始标题 (Markdown # 行) */
  title: string;
  /** 视频简介 */
  description: string;

  /** 字幕总行数 */
  subtitleLineCount: number;
  /** 字幕时长 (最后一条时间戳，秒) */
  durationSecs: number | null;
  /** 字幕总字符数 (不含时间戳) */
  charCount: number;

  /** 字幕条目 */
  subtitles: SubtitleLine[];

  /** 赛事阶段 (从标题提取: 小组赛|淘汰赛|半决赛|决赛|常规赛|季后赛 等) */
  stage: string | null;

  /** BP 阶段分割 (仅 contentType=game 时有值) */
  bpSplit: BpSplit | null;
}

/** BP/正赛两阶段分割结果 */
interface BpSplit {
  /** BP 阶段终止的字幕行索引 (exclusive) */
  splitIndex: number;
  /** 正赛开始的时间戳 (秒) */
  gameStartSecs: number;
  /** 检测方法: caster_intro | battle_cry | side_announce | side_announce_unconfirmed | none */
  method: string;
  /** BP 阶段字幕行数 */
  bpLineCount: number;
  /** BP 阶段字符数 */
  bpCharCount: number;
  /** 正赛阶段字幕行数 */
  gameLineCount: number;
  /** 正赛阶段字符数 */
  gameCharCount: number;
}

interface SubtitleLine {
  /** 时间戳，秒 */
  timeSecs: number;
  /** 时间戳原文 HH:MM:SS 或 MM:SS */
  timeRaw: string;
  /** 字幕文本 */
  text: string;
}

// ─── 战队名映射表 ─────────────────────────────────────────────────────

/** 从 taxonomy.ts 提取的映射: 别名 → slug */
const TEAM_ALIAS_MAP: Record<string, string> = {};

/** 核心战队名录 (来自 taxonomy.ts ENTITIES) */
const ENTITIES: Record<string, { name: string; aliases: string[]; otherNames?: string[] }> = {
  ag: { name: "成都AG超玩会", aliases: ["成都AG超玩会", "AG超玩会", "成都AG"], otherNames: ["AG", "超玩会"] },
  wolves: { name: "重庆狼队", aliases: ["重庆狼队", "狼队", "重庆QGhappy"], otherNames: ["QGhappy", "Wolves"] },
  estar: { name: "武汉eStarPro", aliases: ["武汉eStarPro", "eStarPro", "武汉eStar", "武汉eStar"], otherNames: ["eStar", "ES"] },
  wb: { name: "北京WB", aliases: ["北京WB", "WB战队", "北京微博"], otherNames: ["WB", "TS战队"] },
  dyg: { name: "深圳DYG", aliases: ["深圳DYG", "DYG战队"], otherNames: ["DYG"] },
  jdg: { name: "北京JDG", aliases: ["北京JDG", "JDG王者荣耀"], otherNames: ["JDG"] },
  "tes-a": { name: "长沙TES.A", aliases: ["长沙TES.A", "TES.A"], otherNames: ["TES", "滔搏"] },
  ttg: { name: "广州TTG", aliases: ["广州TTG", "TTG战队"], otherNames: ["TTG"] },
  drg: { name: "佛山DRG", aliases: ["佛山DRG", "DRG.GK", "佛山DRG.GK", "佛山GK"], otherNames: ["DRG", "GK"] },
  hero: { name: "南通Hero久竞", aliases: ["南通Hero久竞", "Hero久竞", "南京Hero久竞", "南京Hero"], otherNames: ["Hero", "久竞"] },
  rw: { name: "济南RW侠", aliases: ["济南RW侠", "RW侠", "济南RW.侠", "济南RW"], otherNames: ["RW"] },
  we: { name: "西安WE", aliases: ["西安WE", "WE战队"], otherNames: ["WE", "Team WE"] },
  edgm: { name: "上海EDG.M", aliases: ["上海EDG.M", "EDG.M"], otherNames: ["EDGM"] },
  rngm: { name: "上海RNG.M", aliases: ["上海RNG.M", "RNG.M", "上海RNG,M"], otherNames: ["RNGM", "RNG"] },
  "lgd-nbw": { name: "杭州LGD.NBW", aliases: ["杭州LGD.NBW", "LGD.NBW", "杭州LGD大鹅"], otherNames: ["LGD", "NBW"] },
  ksg: { name: "苏州KSG", aliases: ["苏州KSG", "KSG战队", "KSG"], otherNames: ["KSG", "快手"] },
  qingjiu: { name: "桐乡情久", aliases: ["桐乡情久", "情久"], otherNames: ["QJ"] },
  tcg: { name: "无锡TCG", aliases: ["无锡TCG", "TCG"], otherNames: [] },
  // ── 历史/次级/海外战队 ──
  xyg: { name: "XYG", aliases: ["XYG"], otherNames: [] },
  mtg: { name: "郑州MTG", aliases: ["郑州MTG", "MTG"], otherNames: [] },
  vg: { name: "厦门VG", aliases: ["厦门VG", "VG"], otherNames: [] },
  klg: { name: "深圳KLG", aliases: ["深圳KLG", "KLG"], otherNames: [] },
  syg: { name: "SYG", aliases: ["SYG"], otherNames: [] },
  wst: { name: "WST", aliases: ["WST"], otherNames: [] },
  gke: { name: "GKE", aliases: ["GKE"], otherNames: [] },
  jxg: { name: "无锡JXG", aliases: ["无锡JXG", "JXG"], otherNames: [] },
  tkl: { name: "九江TKL", aliases: ["九江TKL", "TKL"], otherNames: [] },
  vtg: { name: "镇江VTG", aliases: ["镇江VTG", "VTG"], otherNames: [] },
  uug: { name: "常山UUG", aliases: ["常山UUG", "UUG"], otherNames: [] },
  yyg: { name: "YYG", aliases: ["YYG"], otherNames: [] },
  zdc: { name: "ZDC", aliases: ["ZDC"], otherNames: [] },
  zjq: { name: "ZJQ", aliases: ["ZJQ"], otherNames: [] },
  ltg: { name: "LTG", aliases: ["LTG"], otherNames: [] },
  hjg: { name: "HJG", aliases: ["HJG", "小当家"], otherNames: [] },
  emc: { name: "EMC", aliases: ["EMC"], otherNames: [] },
  boa: { name: "BOA", aliases: ["BOA"], otherNames: [] },
  md: { name: "MD", aliases: ["MD"], otherNames: [] },
  xhw: { name: "XHW", aliases: ["XHW"], otherNames: [] },
  wkk: { name: "Wkk", aliases: ["Wkk"], otherNames: [] },
  jiamein: { name: "佳美娜", aliases: ["佳美娜"], otherNames: [] },
  shiju: { name: "世巨A", aliases: ["世巨A"], otherNames: [] },
  dongguanwz: { name: "东莞Wz", aliases: ["东莞Wz", "东莞WZ"], otherNames: [] },
  boom: { name: "BOOM", aliases: ["BOOM"], otherNames: [] },
  menzhidui: { name: "梦之队Pro", aliases: ["梦之队Pro"], otherNames: [] },
  // ── 次级/青训/外卡选拔赛战队 ──
  huobao: { name: "火豹", aliases: ["火豹"], otherNames: [] },
  hh: { name: "HH", aliases: ["HH"], otherNames: [] },
  hi: { name: "HI", aliases: ["HI"], otherNames: [] },
  gog: { name: "GOG", aliases: ["GOG"], otherNames: [] },
  tlg: { name: "TLG", aliases: ["TLG"], otherNames: [] },
  ty: { name: "TY", aliases: ["TY"], otherNames: [] },
  wg: { name: "WG", aliases: ["WG"], otherNames: [] },
  tianlu: { name: "天鹿", aliases: ["天鹿"], otherNames: [] },
  miaoy: { name: "喵鱼", aliases: ["喵鱼"], otherNames: [] },
  hahoumi: { name: "好厚米", aliases: ["好厚米"], otherNames: [] },
  lafan: { name: "辣翻你是绝队", aliases: ["辣翻你是绝队"], otherNames: [] },
  alibabapkq: { name: "阿里巴巴PKQ", aliases: ["阿里巴巴PKQ"], otherNames: [] },
  qxlingyun: { name: "青训凌云", aliases: ["青训凌云"], otherNames: [] },
  qxqianyuan: { name: "青训潜渊", aliases: ["青训潜渊"], otherNames: [] },
  impunity: { name: "Impunity", aliases: ["Impunity"], otherNames: [] },
  ste: { name: "STE", aliases: ["中东及北非STE", "STE"], otherNames: [] },
  fut: { name: "FUT", aliases: ["土耳其FUT", "FUT", "FUTNOVA"], otherNames: [] },
  fx: { name: "FX", aliases: ["巴西FX", "FX"], otherNames: [] },
  tdt: { name: "TDT", aliases: ["越南TDT", "TDT"], otherNames: [] },
  a7: { name: "A7", aliases: ["巴西A7", "A7"], otherNames: [] },
  cqkeji: { name: "重庆科技大学", aliases: ["重庆科技大学"], otherNames: [] },
  chaoyichao: { name: "吵一吵", aliases: ["吵一吵"], otherNames: [] },
  // 海外战队
  "gen-g": { name: "Gen.G", aliases: ["韩国GEN", "Gen.G", "Gen.G Esports", "GEN"], otherNames: [] },
  bac: { name: "BAC", aliases: ["泰国BAC", "BAC", "Bacon Time"], otherNames: [] },
  trb: { name: "TRB", aliases: ["北美TRB", "TRB"], otherNames: [] },
  tfb: { name: "TFB", aliases: ["中国台湾TFB", "TFB"], otherNames: [] },
  tq: { name: "TQ", aliases: ["西欧TQ", "TQ"], otherNames: [] },
  isg: { name: "ISG", aliases: ["拉美ISG", "ISG", "Isurus"], otherNames: [] },
  imp: { name: "IMP", aliases: ["缅甸IMP", "南亚IMP", "IMP"], otherNames: [] },
  red: { name: "RED", aliases: ["巴西RED", "RED", "Red Canids"], otherNames: [] },
  sz: { name: "SCARZ", aliases: ["日本SZ", "日本SCARZ", "SCARZ", "SZ"], otherNames: [] },
  box: { name: "BOX", aliases: ["越南BOX", "BOX"], otherNames: [] },
  ftn: { name: "FTN", aliases: ["土耳其FTN", "FTN", "FUTNOVA"], otherNames: [] },
  yla: { name: "YaLLa", aliases: ["中东及北非YLA", "YaLLa", "YLA"], otherNames: [] },
  hd: { name: "HD", aliases: ["泰国HD", "HD"], otherNames: [] },
  tln: { name: "TLN", aliases: ["泰国TLN", "TLN"], otherNames: [] },
  sgp: { name: "SGP", aliases: ["越南SGP", "SGP"], otherNames: [] },
  btr: { name: "BTR", aliases: ["BTR"], otherNames: [] },
  hka: { name: "HKA", aliases: ["中国港澳台HKA", "HKA"], otherNames: [] },
  one: { name: "ONE", aliases: ["中国港澳台ONE", "ONE"], otherNames: [] },
  vks: { name: "VKS", aliases: ["巴西VKS", "VKS"], otherNames: [] },
  mast: { name: "MasT", aliases: ["马来西亚MasT", "MasT"], otherNames: [] },
};

// Build flat alias → slug map (longest alias first for greedy match)
for (const [slug, ent] of Object.entries(ENTITIES)) {
  for (const alias of [...ent.aliases, ...(ent.otherNames ?? [])]) {
    const key = alias.trim();
    if (key.length >= 2) { // skip single-char to avoid false matches
      TEAM_ALIAS_MAP[key] = slug;
    }
  }
}

// Sorted by length descending for greedy matching
const TEAM_ALIASES_SORTED = Object.keys(TEAM_ALIAS_MAP).sort((a, b) => b.length - a.length);

function resolveTeamSlug(raw: string): string | null {
  const cleaned = raw
    .replace(/^中国/, "")
    .replace(/\s+\d+月\d+日.*$/, "") // strip "12月5日小组赛" suffixes
    .replace(/赛前采访$/, "")
    .trim();
  // Exact match first
  if (TEAM_ALIAS_MAP[cleaned]) return TEAM_ALIAS_MAP[cleaned];
  if (TEAM_ALIAS_MAP[raw.trim()]) return TEAM_ALIAS_MAP[raw.trim()];
  // Substring match (longest first)
  for (const alias of TEAM_ALIASES_SORTED) {
    if (cleaned.includes(alias) || raw.includes(alias)) {
      return TEAM_ALIAS_MAP[alias];
    }
  }
  return null;
}

// ─── 赛季解析 ─────────────────────────────────────────────────────────

interface SeasonInfo {
  year: number;
  split: string; // spring|summer|challenger|worlds|annual
  seasonId: string; // kpl-2026-summer
}

function parseSeasonDir(dirName: string): SeasonInfo {
  const yearMatch = dirName.match(/(\d{4})/);
  const year = yearMatch ? parseInt(yearMatch[1]) : 0;

  let split = "other";
  if (/春季赛/.test(dirName)) split = "spring";
  else if (/夏季赛/.test(dirName)) split = "summer";
  else if (/挑战者杯/.test(dirName)) split = "challenger";
  else if (/世界冠军杯|世冠|KIC/.test(dirName)) split = "worlds";
  else if (/年度总决赛|年总/.test(dirName)) split = "annual";

  return { year, split, seasonId: `kpl-${year}-${split}` };
}

// ─── 内容类型与局号解析 ──────────────────────────────────────────────

const GAME_NO_MAP: Record<string, number> = {
  "第一局": 1, "第二局": 2, "第三局": 3, "第四局": 4,
  "第五局": 5, "第六局": 6, "第七局": 7, "第八局": 8, "第九局": 9,
};

interface ContentInfo {
  contentType: "game" | "interview" | "pre-show" | "promo" | "other";
  gameNo: number | null;
  partTitle: string;
}

function parseContentType(fileName: string, title: string): ContentInfo {
  // Extract part title: "P01_第一局.md" → "第一局"
  const partTitleMatch = fileName.match(/^P\d+_(.+)\.md$/);
  let partTitle = partTitleMatch ? partTitleMatch[1].replace(/[-_ ]*4[kK]$/, "").trim() : fileName.replace(/\.md$/, "");

  // Game detection
  for (const [label, no] of Object.entries(GAME_NO_MAP)) {
    if (partTitle.includes(label) || title.includes(label)) {
      return { contentType: "game", gameNo: no, partTitle };
    }
  }
  // Numeric game: "P03_3" or title ending with number after 局
  const numericGame = partTitle.match(/^(\d+)$/);
  if (numericGame) {
    const n = parseInt(numericGame[1]);
    if (n >= 1 && n <= 9) {
      return { contentType: "game", gameNo: n, partTitle };
    }
  }

  // Interview
  if (/赛后采访|赛后/.test(partTitle) || /采访/.test(partTitle)) {
    return { contentType: "interview", gameNo: null, partTitle };
  }

  // Pre-show
  if (/赛前评论|赛前节目|赛前预测|评论席|赛前采访/.test(partTitle)) {
    return { contentType: "pre-show", gameNo: null, partTitle };
  }

  // Promo
  if (/宣传|巡礼|开幕|预告|晋级之路|CG|本命英雄|缘起|城市专题|主宣/.test(partTitle) ||
      /宣传|巡礼|开幕|预告|晋级之路/.test(title)) {
    return { contentType: "promo", gameNo: null, partTitle };
  }

  return { contentType: "other", gameNo: null, partTitle };
}

// ─── 赛事阶段解析 ──────────────────────────────────────────────────────

function parseStage(title: string, matchDir: string): string | null {
  const text = title + " " + matchDir;
  if (/总决赛/.test(text)) return "总决赛";
  if (/半决赛/.test(text)) return "半决赛";
  if (/淘汰赛/.test(text)) return "淘汰赛";
  if (/季后赛/.test(text)) return "季后赛";
  if (/小组赛/.test(text)) return "小组赛";
  if (/瑞士轮/.test(text)) return "瑞士轮";
  if (/选拔赛/.test(text)) return "选拔赛";
  if (/外卡/.test(text)) return "外卡赛";
  if (/常规赛/.test(text)) return "常规赛";
  if (/决赛/.test(text)) return "决赛"; // generic "决赛"
  return null;
}

// ─── BP/正赛分割检测 ─────────────────────────────────────────────

/**
 * 在字幕中定位 BP 阶段→正赛开始的分界点。
 *
 * KPL 解说规律：
 *  - 第 2 局起，每局前 5-10 分钟是 BP 讨论、阵容分析
 *  - 正赛开始时解说会重新自我介绍（“我是解说XXX”）
 *  - 或喜报“全军出击”
 *  - 或先报“蓝色方/红色方”战队名称
 *
 * 优先级：
 *  1. “我是解说” — 最可靠，解说重新介绍即标志正赛开始
 *  2. “全军出击” — 游戏内开局口号
 *  3. “蓝色方”/“红色方” — 加载画面报队伍
 */
function findGameStart(
  subtitles: SubtitleLine[],
  gameNo: number | null,
): { splitIndex: number; gameStartSecs: number; method: string } | null {
  // 第 1 局：BP 可能在上一个分P或合并在视频开头，最低搜索门槛低一些
  const minTimeSecs = gameNo === 1 ? 30 : 120;

  // Pass 1: “我是解说”
  for (let i = 0; i < subtitles.length; i++) {
    if (subtitles[i].timeSecs < minTimeSecs) continue;
    if (subtitles[i].text.includes("我是解说")) {
      return { splitIndex: i, gameStartSecs: subtitles[i].timeSecs, method: "caster_intro" };
    }
  }

  // Pass 2: “全军出击”
  for (let i = 0; i < subtitles.length; i++) {
    if (subtitles[i].timeSecs < minTimeSecs) continue;
    if (subtitles[i].text.includes("全军出击")) {
      return { splitIndex: i, gameStartSecs: subtitles[i].timeSecs, method: "battle_cry" };
    }
  }

  // Pass 3: “蓝色方” or “红色方”
  for (let i = 0; i < subtitles.length; i++) {
    if (subtitles[i].timeSecs < minTimeSecs) continue;
    const t = subtitles[i].text;
    if (t.includes("蓝色方") || t.includes("红色方")) {
      // Check for confirmation within 90s
      let confirmed = false;
      for (let j = i + 1; j < Math.min(subtitles.length, i + 20); j++) {
        if (subtitles[j].timeSecs - subtitles[i].timeSecs > 90) break;
        if (/出击|开局|勇往直前|出发|解说|加油/.test(subtitles[j].text)) {
          confirmed = true;
          break;
        }
      }
      return {
        splitIndex: i,
        gameStartSecs: subtitles[i].timeSecs,
        method: confirmed ? "side_announce" : "side_announce_unconfirmed",
      };
    }
  }

  return null;
}

// ─── 对战双方解析 ──────────────────────────────────────────────────────

function parseTeams(matchDir: string, title: string): { home: string | null; away: string | null } {
  // Try match dir first, then title
  for (const text of [matchDir, title]) {
    // Pattern: "TeamA vs TeamB" or "TeamA VS TeamB"
    const vsMatch = text.match(/(.+?)\s+[vV][sS]\.?\s+(.+?)(?:\s+\d+月|\s*[-_]|$)/);
    if (vsMatch) {
      let home = vsMatch[1]
        .replace(/^.*?】\s*/, "") // remove 【...】 prefix
        .replace(/^\d+月\d+日\s*/, "") // remove date prefix
        .replace(/^(?:决赛|半决赛|淘汰赛|小组赛|季后赛|常规赛|瑞士轮|外卡赛|选拔赛)\s*/, "")
        .trim();
      let away = vsMatch[2].trim();

      // Remove BV suffix from dir name: "_BV1xxxxx" at end
      away = away.replace(/_BV[A-Za-z0-9]+$/, "").trim();
      // Remove trailing date/stage info
      away = away.replace(/\s+\d+月\d+日.*$/, "").trim();
      away = away.replace(/赛前采访$/, "").trim();
      // Remove leaked part info: " - P01 火豹" or "第1局" etc.
      away = away.replace(/\s+-\s+P\d+.*$/, "").trim();
      away = away.replace(/\s+第\d+局.*$/, "").trim();
      // Remove stage suffixes leaked into away name
      home = home.replace(/\s+-\s+P\d+.*$/, "").trim();
      home = home.replace(/\s+第\d+局.*$/, "").trim();

      if (home && away) return { home, away };
    }
  }
  return { home: null, away: null };
}

// ─── 字幕解析 ──────────────────────────────────────────────────────────

function parseTimestamp(raw: string): number {
  const parts = raw.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function parseSubtitles(content: string): SubtitleLine[] {
  const lines: SubtitleLine[] = [];
  const re = /^- \[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    lines.push({
      timeSecs: parseTimestamp(m[1]),
      timeRaw: m[1],
      text: m[2].trim(),
    });
  }
  return lines;
}

// ─── Markdown 元数据解析 ───────────────────────────────────────────────

function parseMetadata(content: string) {
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  const publishDate = content.match(/\*\*发布时间\*\*[：:]\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";
  const videoUrl = content.match(/\*\*视频链接\*\*[：:]\s*(https?:\/\/[^\s)]+)/)?.[1] ?? "";
  const bvid = content.match(/\*\*BVID\*\*[：:]\s*`([^`]+)`/)?.[1] ?? "";
  const cid = content.match(/\*\*CID\*\*[：:]\s*`([^`]+)`/)?.[1] ?? null;
  const subtitleLineCount = parseInt(content.match(/\*\*字幕总行数\*\*[：:]\s*(\d+)/)?.[1] ?? "0");
  const partInfo = content.match(/\*\*分P\*\*[：:]\s*第\s*(\d+)\s*集\s*\/\s*共\s*(\d+)\s*集/);
  const partNo = partInfo ? parseInt(partInfo[1]) : 1;
  const totalParts = partInfo ? parseInt(partInfo[2]) : null;
  const descMatch = content.match(/## 视频简介\s*\n\n([\s\S]*?)(?=\n---|\n## )/);
  const description = descMatch ? descMatch[1].trim() : "";

  return { title, publishDate, videoUrl, bvid, cid, subtitleLineCount, partNo, totalParts, description };
}

// ─── 主流程 ────────────────────────────────────────────────────────────

function processFile(filePath: string, seasonDir: string, matchDir: string): CommentaryRecord | null {
  const content = fs.readFileSync(filePath, "utf-8");
  const fileName = path.basename(filePath);

  const meta = parseMetadata(content);
  if (!meta.bvid) return null; // skip files without BVID

  const season = parseSeasonDir(seasonDir);
  const { home, away } = parseTeams(matchDir, meta.title);
  const ci = parseContentType(fileName, meta.title);
  const subtitles = parseSubtitles(content);
  const charCount = subtitles.reduce((sum, s) => sum + s.text.length, 0);
  const durationSecs = subtitles.length > 0 ? subtitles[subtitles.length - 1].timeSecs : null;
  const isMatch = /[vV][sS]/.test(matchDir) || /[vV][sS]/.test(meta.title);
  const stage = parseStage(meta.title, matchDir);

  // BP/正赛分割
  let bpSplit: BpSplit | null = null;
  if (ci.contentType === "game") {
    const gs = findGameStart(subtitles, ci.gameNo);
    if (gs) {
      const bpLines = subtitles.slice(0, gs.splitIndex);
      const gameLines = subtitles.slice(gs.splitIndex);
      bpSplit = {
        splitIndex: gs.splitIndex,
        gameStartSecs: gs.gameStartSecs,
        method: gs.method,
        bpLineCount: bpLines.length,
        bpCharCount: bpLines.reduce((s, l) => s + l.text.length, 0),
        gameLineCount: gameLines.length,
        gameCharCount: gameLines.reduce((s, l) => s + l.text.length, 0),
      };
    }
  }

  return {
    id: `${meta.bvid}_P${String(meta.partNo).padStart(2, "0")}`,
    bvid: meta.bvid,
    cid: meta.cid,
    partNo: meta.partNo,
    totalParts: meta.totalParts,
    publishDate: meta.publishDate,
    videoUrl: meta.videoUrl,
    seasonDir,
    seasonId: season.seasonId,
    year: season.year,
    split: season.split,
    matchDir,
    homeTeamRaw: home,
    awayTeamRaw: away,
    homeTeamSlug: home ? resolveTeamSlug(home) : null,
    awayTeamSlug: away ? resolveTeamSlug(away) : null,
    isMatch,
    contentType: ci.contentType,
    gameNo: ci.gameNo,
    partTitle: ci.partTitle,
    title: meta.title,
    description: meta.description,
    subtitleLineCount: meta.subtitleLineCount,
    durationSecs,
    charCount,
    subtitles,
    stage,
    bpSplit,
  };
}

// ─── CLI ────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const sourceDir = getArg(args, "--source") ?? path.resolve(__dirname, "../../B站字幕提取/KPL解说");
  const outDir = getArg(args, "--out") ?? path.resolve(__dirname, "../data");
  const dryRun = args.includes("--dry-run");

  if (!fs.existsSync(sourceDir)) {
    console.error(`❌ 源目录不存在: ${sourceDir}`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  console.log(`📂 源目录: ${sourceDir}`);
  console.log(`📁 输出目录: ${outDir}`);
  console.log();

  // Gather all season dirs
  const seasonDirs = fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith("."))
    .map(d => d.name)
    .sort();

  const records: CommentaryRecord[] = [];
  const stats = {
    totalFiles: 0,
    parsedRecords: 0,
    skippedFiles: 0,
    matchRecords: 0,
    nonMatchRecords: 0,
    byContentType: {} as Record<string, number>,
    bySeason: {} as Record<string, number>,
    bySplit: {} as Record<string, number>,
    totalSubtitleLines: 0,
    totalCharCount: 0,
    totalMatches: 0,
    teamSlugResolved: 0,
    teamSlugUnresolved: 0,
    unresolvedTeams: new Set<string>(),
    uniqueBvids: new Set<string>(),
    uniqueMatchDirs: new Set<string>(),
    gameParts: 0,
    interviewParts: 0,
    bpSplitFound: 0,
    bpSplitByMethod: {} as Record<string, number>,
    bpTotalLines: 0,
    bpTotalChars: 0,
  };

  for (const seasonDir of seasonDirs) {
    const seasonPath = path.join(sourceDir, seasonDir);
    const matchDirs = fs.readdirSync(seasonPath, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith("."));

    for (const matchDirEntry of matchDirs) {
      const matchPath = path.join(seasonPath, matchDirEntry.name);
      const mdFiles = fs.readdirSync(matchPath)
        .filter(f => f.endsWith(".md"))
        .sort();

      stats.uniqueMatchDirs.add(`${seasonDir}/${matchDirEntry.name}`);

      for (const mdFile of mdFiles) {
        stats.totalFiles++;
        const filePath = path.join(matchPath, mdFile);

        try {
          const record = processFile(filePath, seasonDir, matchDirEntry.name);
          if (!record) {
            stats.skippedFiles++;
            continue;
          }

          stats.parsedRecords++;
          stats.uniqueBvids.add(record.bvid);
          stats.byContentType[record.contentType] = (stats.byContentType[record.contentType] ?? 0) + 1;
          stats.bySeason[record.seasonDir] = (stats.bySeason[record.seasonDir] ?? 0) + 1;
          stats.bySplit[record.split] = (stats.bySplit[record.split] ?? 0) + 1;
          stats.totalSubtitleLines += record.subtitleLineCount;
          stats.totalCharCount += record.charCount;

          if (record.isMatch) {
            stats.matchRecords++;
          } else {
            stats.nonMatchRecords++;
          }

          if (record.contentType === "game") stats.gameParts++;
          if (record.contentType === "interview") stats.interviewParts++;

          // BP split stats
          if (record.bpSplit) {
            stats.bpSplitFound++;
            stats.bpSplitByMethod[record.bpSplit.method] = (stats.bpSplitByMethod[record.bpSplit.method] ?? 0) + 1;
            stats.bpTotalLines += record.bpSplit.bpLineCount;
            stats.bpTotalChars += record.bpSplit.bpCharCount;
          }

          // Track team resolution
          for (const raw of [record.homeTeamRaw, record.awayTeamRaw]) {
            if (!raw) continue;
            const slug = resolveTeamSlug(raw);
            if (slug) {
              stats.teamSlugResolved++;
            } else {
              stats.teamSlugUnresolved++;
              stats.unresolvedTeams.add(raw);
            }
          }

          records.push(record);
        } catch (err) {
          console.error(`  ⚠️  解析失败: ${filePath}: ${(err as Error).message}`);
          stats.skippedFiles++;
        }
      }
    }
  }

  stats.totalMatches = stats.uniqueMatchDirs.size;

  // ── 输出 ──
  if (!dryRun) {
    // JSONL output (subtitles included)
    const jsonlPath = path.join(outDir, "commentary_parsed.jsonl");
    const ws = fs.createWriteStream(jsonlPath);
    for (const r of records) {
      ws.write(JSON.stringify(r) + "\n");
    }
    ws.end();
    console.log(`✅ JSONL 已写入: ${jsonlPath}`);

    // Lightweight index (without subtitles, for quick browsing)
    const indexPath = path.join(outDir, "commentary_index.jsonl");
    const wsIdx = fs.createWriteStream(indexPath);
    for (const r of records) {
      const { subtitles: _s, ...rest } = r;
      wsIdx.write(JSON.stringify({ ...rest, subtitleLineCount: r.subtitles.length }) + "\n");
    }
    wsIdx.end();
    console.log(`✅ 索引 已写入: ${indexPath}`);

    // Stats
    const statsOut = {
      ...stats,
      unresolvedTeams: [...stats.unresolvedTeams].sort(),
      uniqueBvids: stats.uniqueBvids.size,
      uniqueMatchDirs: stats.uniqueMatchDirs.size,
    };
    const statsPath = path.join(outDir, "commentary_stats.json");
    fs.writeFileSync(statsPath, JSON.stringify(statsOut, null, 2));
    console.log(`✅ 统计 已写入: ${statsPath}`);
  }

  // ── 控制台统计 ──
  console.log();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("                    📊 解说字幕解析统计");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  总文件数:        ${stats.totalFiles}`);
  console.log(`  成功解析:        ${stats.parsedRecords}`);
  console.log(`  跳过:            ${stats.skippedFiles}`);
  console.log(`  唯一视频 (BVID): ${stats.uniqueBvids.size}`);
  console.log(`  比赛场次:        ${stats.totalMatches}`);
  console.log();
  console.log("─── 内容类型 ───────────────────────────────────────────────");
  for (const [type, count] of Object.entries(stats.byContentType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(12)} ${count}`);
  }
  console.log();
  console.log("─── 赛季分布 ───────────────────────────────────────────────");
  for (const [season, count] of Object.entries(stats.bySeason).sort()) {
    console.log(`  ${season.padEnd(20)} ${count}`);
  }
  console.log();
  console.log("─── 赛事类型 ───────────────────────────────────────────────");
  for (const [split, count] of Object.entries(stats.bySplit).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${split.padEnd(12)} ${count}`);
  }
  console.log();
  console.log("─── 战队映射 ───────────────────────────────────────────────");
  console.log(`  已解析:          ${stats.teamSlugResolved}`);
  console.log(`  未解析:          ${stats.teamSlugUnresolved}`);
  if (stats.unresolvedTeams.size > 0) {
    console.log(`  未识别战队名 (${stats.unresolvedTeams.size}):`);
    for (const t of [...stats.unresolvedTeams].sort()) {
      console.log(`    - ${t}`);
    }
  }
  console.log();
  console.log("─── 数据量 ─────────────────────────────────────────────────");
  console.log(`  字幕总行数:      ${stats.totalSubtitleLines.toLocaleString()}`);
  console.log(`  字幕总字符:      ${stats.totalCharCount.toLocaleString()}`);
  console.log(`  比赛局数 (game): ${stats.gameParts}`);
  console.log(`  赛后采访:        ${stats.interviewParts}`);
  console.log(`  正式对战记录:    ${stats.matchRecords}`);
  console.log(`  非对战内容:      ${stats.nonMatchRecords}`);
  console.log();
  console.log("─── BP/正赛分割 ───────────────────────────────────────────");
  console.log(`  成功分割:        ${stats.bpSplitFound} / ${stats.gameParts} (${(stats.bpSplitFound / stats.gameParts * 100).toFixed(1)}%)`);
  console.log(`  BP 总字幕行:    ${stats.bpTotalLines.toLocaleString()}`);
  console.log(`  BP 总字符:      ${stats.bpTotalChars.toLocaleString()}`);
  console.log(`  检测方法分布:`);
  for (const [method, count] of Object.entries(stats.bpSplitByMethod).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${method.padEnd(30)} ${count}`);
  }
  console.log("═══════════════════════════════════════════════════════════");
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

main();

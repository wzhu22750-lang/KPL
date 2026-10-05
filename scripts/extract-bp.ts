#!/usr/bin/env npx tsx
/**
 * P1 — BP 阶段解说稿结构化提取脚本
 *
 * 依据 prompts/bp-extraction.md 规范：
 * 从 data/commentary_parsed.jsonl 中读取具有 bpSplit 的比赛记录，
 * 调用大语言模型（如 Qwen-Plus, DeepSeek, GPT-4o-mini 等）提取结构化 BP 战术与洞察数据，
 * 经过强类型规则与王者荣耀官方实体库校验后，
 * 流式追加写入 data/bp_extractions.jsonl 并保存批处理统计。
 *
 * 支持特性：
 *   - 断点续跑 (--resume，默认启用)
 *   - 并发控制 (--concurrency，默认 3)
 *   - 采样/单条/全量测试 (--limit, --id, --sample, --season)
 *   - 自动检测并适配 DashScope / OpenAI 兼容接口
 *   - 官方英雄字典与别名库校准
 *   - 强类型规则校验与置信度审计
 *
 * 用法示例：
 *   # 单条测试金标样本 (BV1CTL96wEtV_P02, 佛山DRG vs 广州TTG 第2局)
 *   npx tsx scripts/extract-bp.ts --id BV1CTL96wEtV_P02 --verbose
 *
 *   # 试跑前 3 局（默认使用 DashScope qwen-plus）
 *   npx tsx scripts/extract-bp.ts --limit 3
 *
 *   # 使用指定模型与并发提取 2024 夏季赛
 *   npx tsx scripts/extract-bp.ts --season 2024夏季赛 --concurrency 5 --model qwen-plus
 *
 *   # Dry-run 检查 prompt 拼接与样本
 *   npx tsx scripts/extract-bp.ts --limit 1 --dry-run
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// ─── 类型定义 ────────────────────────────────────────────────────────

/** 原始解说记录中的字幕行 */
interface SubtitleLine {
  timeSecs: number;
  timeRaw: string;
  text: string;
}

/** BP 分割元数据 */
interface BpSplit {
  splitIndex: number;
  gameStartSecs: number;
  method: string;
  bpLineCount: number;
  bpCharCount: number;
  gameLineCount: number;
  gameCharCount: number;
}

/** 输入记录定义 (对应 commentary_parsed.jsonl) */
interface CommentaryRecord {
  id: string;
  bvid: string;
  cid: string | null;
  partNo: number;
  totalParts: number | null;
  publishDate: string;
  videoUrl: string;
  seasonDir: string;
  seasonId: string | null;
  year: number;
  split: string;
  matchDir: string;
  homeTeamRaw: string | null;
  awayTeamRaw: string | null;
  homeTeamSlug: string | null;
  awayTeamSlug: string | null;
  isMatch: boolean;
  contentType: "game" | "interview" | "pre-show" | "promo" | "other";
  gameNo: number | null;
  partTitle: string;
  title: string;
  description: string;
  subtitleLineCount: number;
  durationSecs: number | null;
  charCount: number;
  subtitles: SubtitleLine[];
  stage: string | null;
  bpSplit: BpSplit | null;
}

/** LLM 结构化提取结果 schema (与 bp-extraction.md 严格一致) */
export interface BpLlmExtraction {
  context: {
    series_score_before: string | null;
    previous_game_summary: string | null;
    blue_side: string | null;
    red_side: string | null;
  };
  bans: Array<{
    phase: number;
    order: number;
    side: "blue" | "red" | "unknown";
    hero: string;
    hero_raw: string;
    target_player: string | null;
    reason: string | null;
    timestamp: string | null;
  }>;
  picks: Array<{
    phase: number;
    order: number;
    side: "blue" | "red" | "unknown";
    hero: string;
    hero_raw: string;
    player: string | null;
    position: "对抗路" | "打野" | "中路" | "发育路" | "游走" | null;
    is_first_pick: boolean;
    reason: string | null;
    counter_to: string | null;
    synergy_with: string | null;
  }>;
  composition_analysis: {
    blue_comp: {
      heroes: string[];
      style_tags: string[];
      win_condition: string | null;
      weakness: string | null;
      key_timing: string | null;
    };
    red_comp: {
      heroes: string[];
      style_tags: string[];
      win_condition: string | null;
      weakness: string | null;
      key_timing: string | null;
    };
    matchup_comment: string | null;
  };
  player_insights: Array<{
    player: string;
    team: string;
    insight_type: "signature_hero" | "recent_form" | "role_change" | "career_milestone" | "head_to_head" | "stat";
    content: string;
    hero: string | null;
    timestamp: string | null;
  }>;
  meta_signals: Array<{
    type: "hero_strength" | "hero_trend" | "counter_logic" | "system_meta" | "version_change";
    content: string;
    heroes: string[];
    timestamp: string | null;
  }>;
  tactical_quotes: Array<{
    quote: string;
    topic: "ban_intent" | "pick_intent" | "comp_analysis" | "counter_strategy" | "player_evaluation" | "win_condition";
    timestamp: string | null;
  }>;
  extraction_confidence: {
    ban_completeness: "high" | "medium" | "low";
    pick_completeness: "high" | "medium" | "low";
    side_identification: "high" | "medium" | "low";
    notes: string;
  };
}

/** 最终输出落盘格式 */
export interface BpExtractionRecord {
  recordId: string;
  matchInfo: {
    season: string;
    seasonId: string | null;
    date: string;
    homeTeam: string;
    awayTeam: string;
    homeTeamSlug: string | null;
    awayTeamSlug: string | null;
    gameNo: number;
    totalParts: number | null;
    bvid: string;
    cid: string | null;
    title: string;
    videoUrl: string;
    year: number;
    split: string;
  };
  extraction: BpLlmExtraction;
  validation: {
    valid: boolean;
    errors: string[];
    warnings: string[];
  };
  meta: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    model: string;
    latencyMs: number;
    costUsd: number;
    timestamp: string;
  };
}

// ─── 英雄别名映射与实体库 ─────────────────────────────────────────────

const HERO_ALIAS_MAP: Record<string, string> = {
  "all in": "敖隐",
  "奥林": "敖隐",
  "澳林": "敖隐",
  "安林": "敖隐",
  "安琳": "敖隐",
  "奥运": "敖隐",
  "敖影": "敖隐",
  "火舞": "不知火舞",
  "fire dance": "不知火舞",
  "仓": "苍",
  "多利亚": "朵莉亚",
  "朵利亚": "朵莉亚",
  "桑七": "桑启",
  "太乙": "太乙真人",
  "大司令": "大司命",
  "翼德": "张飞",
  "鲁大师": "鲁班大师",
  "大师": "鲁班大师",
  "婉儿": "上官婉儿",
  "上官": "上官婉儿",
  "凯皇": "铠",
  "铠皇": "铠",
  "小鲁班": "鲁班七号",
  "卤蛋": "鲁班七号",
  "大小姐": "孙尚香",
  "阿离": "公孙离",
  "守约": "百里守约",
  "玄策": "百里玄策",
  "牛魔王": "牛魔",
  "八戒": "猪八戒",
  "猴子": "孙悟空",
  "宫本": "宫本武藏",
  "廉颇叔叔": "廉颇",
  "鸟人": "云中君",
  "鱼": "庄周",
  "草灵": "阿古朵",
  "少司缘": "少司缘",
  "元辅": "元流之子",
  "原辅": "元流之子",
  "元射": "元流之子",
  "元坦": "元流之子",
  "元刺": "元流之子",
  "元法": "元流之子",
  "次元": "元流之子",
};

function loadStandardHeroes(): Set<string> {
  const set = new Set<string>();
  const heroesJsonPath = path.resolve("kpl-intelligence/industry/kpl-entities/heroes.json");
  if (fs.existsSync(heroesJsonPath)) {
    try {
      const heroes = JSON.parse(fs.readFileSync(heroesJsonPath, "utf-8")) as Array<{ name: string }>;
      for (const h of heroes) {
        if (h.name) set.add(h.name);
      }
    } catch {
      // ignore
    }
  }
  // 确保新英雄与多形态英雄在库中
  set.add("元流之子");
  set.add("敖隐");
  set.add("苍");
  set.add("影");
  set.add("少司缘");
  return set;
}

function normalizeHeroName(rawName: string, standardHeroes: Set<string>): string {
  const trimmed = rawName.trim();
  if (standardHeroes.has(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  if (HERO_ALIAS_MAP[lower]) return HERO_ALIAS_MAP[lower];
  if (HERO_ALIAS_MAP[trimmed]) return HERO_ALIAS_MAP[trimmed];

  // 部分包含词处理
  for (const [alias, standard] of Object.entries(HERO_ALIAS_MAP)) {
    if (trimmed === alias || trimmed.includes(alias)) {
      return standard;
    }
  }

  return trimmed;
}

// ─── 提示词模板 ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是一位王者荣耀职业联赛（KPL）的数据分析专家，精通 Ban/Pick 策略与赛事分析。

你的任务是从 KPL 解说员的 BP 阶段字幕中提取结构化数据。解说字幕来自 B 站 AI 自动识别，因此：
- 英雄名可能有**谐音错误**（如"all in" / "奥林" / "奥运"→"敖隐"；"仓"→"苍"；"多利亚"→"朵莉亚"；"fire dance"/"火舞"→"不知火舞"；"桑启/桑七"辅助；"大司命/大司令"）
- 战术组合可能被语音识别错（如解说提到的**"穿狼体系/穿狼"**实际指张良+王昭君的**"张王体系/张王组合"**；"乔夫"指大乔+老夫子；"真香"指太乙真人+孙尚香；"父子"指鲁班大师+鲁班七号；"弹弓"指鲁班大师+姜子牙；"骨马/马核"指阿古朵+马超；"露骨"指阿古朵+露娜）
- 需准确理解经典赛事术语：野区博弈（反野/换野/保野）、中立生物争夺（开龙/控龙/拼惩戒/风暴龙王团）、兵线运营（线权/转线/四一分带/断线/拔高地）、团战执行（先手开团/反打/拉扯/拆火/掉点/视野压制/中辅摇摆/以选代ban）
- 选手名可能被语音识别成别的字（如"柚子"→"又子"；"一诺"→"一诺"）
- 战队名偶尔有错（如"BLG"应该是"DRG"；"微博"→"WB/北京WB"）
- 句间可能有断句不准确的问题，需要结合上下文理解完整含义

你需要：
1. 修正明显的语音识别错误，还原正确的英雄名、选手名、战队名与经典体系名（如将"穿狼"校准为"张王组合/张王体系"）
2. 理解解说员的分析逻辑，提取有价值的战术洞察
3. 区分事实性描述（"他选了XX"）和分析性评论（"这个以选代ban"）
4. 同一英雄单局内不可红蓝双选；如果信息不足或不确定，对应字段填 null，不要编造`;

const USER_PROMPT_TEMPLATE = `请分析以下 KPL 比赛的 BP 阶段解说字幕，提取结构化数据。

## 比赛信息
- 赛季：{season_name}（如"2026KPL夏季赛"）
- 日期：{publish_date}
- 对阵：{home_team} vs {away_team}
- 局数：第 {game_no} 局（本场共 {total_games} 局）
- 蓝色方：{blue_team}（如果字幕中提到）
- 红色方：{red_team}（如果字幕中提到）

## BP 阶段字幕
\`\`\`
{bp_subtitles}
\`\`\`

请输出以下 JSON 结构（严格遵循格式，不要添加 markdown 代码块以外的内容）：

\`\`\`json
{
  "context": {
    "series_score_before": "本局开始前的大比分（如 '1:0'，DRG领先时写 'DRG 1:0 TTG'），未提及填 null",
    "previous_game_summary": "解说提到的上一局比赛情况摘要（如'子阳钟馗拿到MVP'，'TTG被翻盘'），未提及填 null",
    "blue_side": "蓝色方战队名（修正后），未提及填 null",
    "red_side": "红色方战队名（修正后），未提及填 null"
  },

  "bans": [
    {
      "phase": 1,
      "order": 1,
      "side": "blue|red|unknown",
      "hero": "英雄名（修正后的标准名）",
      "hero_raw": "字幕中的原始称呼",
      "target_player": "如果解说提到此 ban 针对某选手，填选手名，否则 null",
      "reason": "解说给出的 ban 位理由（原话摘要），未提及填 null",
      "timestamp": "字幕中提到此 ban 的大致时间戳（如 '02:41'），未明确填 null"
    }
  ],

  "picks": [
    {
      "phase": 1,
      "order": 1,
      "side": "blue|red|unknown",
      "hero": "英雄名（修正后的标准名）",
      "hero_raw": "字幕中的原始称呼",
      "player": "使用该英雄的选手名，解说未提及填 null",
      "position": "对抗路|打野|中路|发育路|游走|null",
      "is_first_pick": true,
      "reason": "解说分析的选择理由（原话摘要），未提及填 null",
      "counter_to": "该选择克制的对方英雄或体系，解说未提及填 null",
      "synergy_with": "该选择配合的己方英雄，解说未提及填 null"
    }
  ],

  "composition_analysis": {
    "blue_comp": {
      "heroes": ["英雄1", "英雄2", "英雄3", "英雄4", "英雄5"],
      "style_tags": ["解说提到的阵容风格标签，如'全进攻','团战阵容','节奏快攻','大后期','保射手体系'等"],
      "win_condition": "解说分析的蓝色方赢的条件（如'前期抢节奏'，'控住婉儿的四级节奏'），未提及填 null",
      "weakness": "解说提到的阵容弱点（如'打前排太费劲'，'后期乏力'），未提及填 null",
      "key_timing": "解说提到的关键时间节点（如'婉儿四级后起节奏'，'中期团战是关键'），未提及填 null"
    },
    "red_comp": {
      "heroes": ["英雄1", "英雄2", "英雄3", "英雄4", "英雄5"],
      "style_tags": [],
      "win_condition": null,
      "weakness": null,
      "key_timing": null
    },
    "matchup_comment": "解说对两套阵容对抗的总评（如'两边都是主动进攻的阵容'），未提及填 null"
  },

  "player_insights": [
    {
      "player": "选手名",
      "team": "所属战队",
      "insight_type": "signature_hero|recent_form|role_change|career_milestone|head_to_head|stat",
      "content": "解说原话的关键信息摘要",
      "hero": "关联英雄名，无关填 null",
      "timestamp": "字幕时间戳"
    }
  ],

  "meta_signals": [
    {
      "type": "hero_strength|hero_trend|counter_logic|system_meta|version_change",
      "content": "解说提到的版本/环境信号",
      "heroes": ["关联英雄列表"],
      "timestamp": "字幕时间戳"
    }
  ],

  "tactical_quotes": [
    {
      "quote": "解说的原始分析金句（精确引用）",
      "topic": "ban_intent|pick_intent|comp_analysis|counter_strategy|player_evaluation|win_condition",
      "timestamp": "字幕时间戳"
    }
  ],

  "extraction_confidence": {
    "ban_completeness": "high|medium|low",
    "pick_completeness": "high|medium|low",
    "side_identification": "high|medium|low",
    "notes": "提取过程中的不确定之处说明"
  }
}
\`\`\``;

// ─── 预处理与输入拼接 ─────────────────────────────────────────────────

/**
 * BP 字幕预处理：过滤纯噪声，格式化为紧凑时间戳格式
 */
function prepareBpInput(subtitles: SubtitleLine[]): string {
  const noiseRegex = /^(嗯|哦|啊|好的?|是的?|对的?|没错|确实|OK|ok|哈哈|呵呵)$/;
  return subtitles
    .filter(s => s && s.text && s.text.trim().length >= 2)
    .filter(s => !noiseRegex.test(s.text.trim()))
    .map(s => `[${s.timeRaw}] ${s.text.trim()}`)
    .join("\n");
}

function buildPrompt(record: CommentaryRecord): { system: string; user: string } {
  const bpSubtitles = record.bpSplit ? record.subtitles.slice(0, record.bpSplit.splitIndex) : record.subtitles;
  const formattedSubtitles = prepareBpInput(bpSubtitles);

  const user = USER_PROMPT_TEMPLATE
    .replace("{season_name}", record.seasonDir || "KPL赛事")
    .replace("{publish_date}", record.publishDate || "未知日期")
    .replace("{home_team}", record.homeTeamRaw || "主队")
    .replace("{away_team}", record.awayTeamRaw || "客队")
    .replace("{game_no}", String(record.gameNo ?? 1))
    .replace("{total_games}", String(record.totalParts ?? "未知"))
    .replace("{blue_team}", "见解说分析确定")
    .replace("{red_team}", "见解说分析确定")
    .replace("{bp_subtitles}", formattedSubtitles);

  return { system: SYSTEM_PROMPT, user };
}

// ─── 质量校验规则 ─────────────────────────────────────────────────────

function validateExtraction(
  extraction: BpLlmExtraction,
  standardHeroes: Set<string>
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!extraction) {
    return { valid: false, errors: ["提取结果为空"], warnings: [] };
  }

  // 1. ban 数量合理性
  if (!Array.isArray(extraction.bans)) {
    errors.push("bans 字段不是数组");
  } else if (extraction.bans.length > 10) {
    errors.push(`ban 数量异常: ${extraction.bans.length} (KPL 单局最多 10 个)`);
  }

  // 2. pick 数量合理性
  if (!Array.isArray(extraction.picks)) {
    errors.push("picks 字段不是数组");
  } else if (extraction.picks.length > 10) {
    errors.push(`pick 数量异常: ${extraction.picks.length} (KPL 单局最多 10 个)`);
  }

  // 3. 英雄去重检查
  const pickHeroes = (extraction.picks || []).map(p => p.hero).filter(Boolean);
  const banHeroes = (extraction.bans || []).map(b => b.hero).filter(Boolean);

  const dupPicks = pickHeroes.filter((h, i) => pickHeroes.indexOf(h) !== i);
  if (dupPicks.length > 0) {
    errors.push(`选人英雄重复: ${dupPicks.join(", ")}`);
  }

  const bannedAndPicked = pickHeroes.filter(h => banHeroes.includes(h));
  if (bannedAndPicked.length > 0) {
    warnings.push(`英雄被 ban 后又被 pick: ${bannedAndPicked.join(", ")}`);
  }

  // 4. 阵容数量检查
  const blueComp = extraction.composition_analysis?.blue_comp?.heroes || [];
  const redComp = extraction.composition_analysis?.red_comp?.heroes || [];
  const blueHeroes = blueComp.filter(Boolean);
  const redHeroes = redComp.filter(Boolean);

  if (blueHeroes.length > 5) errors.push(`蓝方阵容英雄超过 5 个 (${blueHeroes.length})`);
  if (redHeroes.length > 5) errors.push(`红方阵容英雄超过 5 个 (${redHeroes.length})`);

  // 5. picks 中的英雄与 composition 闭环对应
  for (const p of extraction.picks || []) {
    if (p.side === "blue" && blueHeroes.length > 0 && !blueHeroes.includes(p.hero)) {
      warnings.push(`蓝方 pick ${p.hero} 未出现在蓝方阵容中`);
    } else if (p.side === "red" && redHeroes.length > 0 && !redHeroes.includes(p.hero)) {
      warnings.push(`红方 pick ${p.hero} 未出现在红方阵容中`);
    }
  }

  // 6. 标准英雄名检查
  if (standardHeroes.size > 0) {
    for (const p of extraction.picks || []) {
      if (p.hero && !standardHeroes.has(p.hero)) {
        warnings.push(`Pick 英雄 "${p.hero}" 非王者荣耀标准名`);
      }
    }
    for (const b of extraction.bans || []) {
      if (b.hero && !standardHeroes.has(b.hero)) {
        warnings.push(`Ban 英雄 "${b.hero}" 非王者荣耀标准名`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/** 规范化 LLM 输出中的英雄名 */
function sanitizeExtractionHeroes(extraction: BpLlmExtraction, standardHeroes: Set<string>): void {
  if (extraction.bans) {
    for (const b of extraction.bans) {
      if (b.hero) b.hero = normalizeHeroName(b.hero, standardHeroes);
    }
  }
  if (extraction.picks) {
    for (const p of extraction.picks) {
      if (p.hero) p.hero = normalizeHeroName(p.hero, standardHeroes);
    }
  }
  if (extraction.composition_analysis?.blue_comp?.heroes) {
    extraction.composition_analysis.blue_comp.heroes = extraction.composition_analysis.blue_comp.heroes.map(h =>
      h ? normalizeHeroName(h, standardHeroes) : h
    );
  }
  if (extraction.composition_analysis?.red_comp?.heroes) {
    extraction.composition_analysis.red_comp.heroes = extraction.composition_analysis.red_comp.heroes.map(h =>
      h ? normalizeHeroName(h, standardHeroes) : h
    );
  }
}

// ─── 模型调用与费用计算 ───────────────────────────────────────────────

function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const m = model.toLowerCase();
  if (m.includes("deepseek")) {
    return (inputTokens * 0.14 + outputTokens * 0.28) / 1_000_000;
  }
  if (m.includes("qwen-plus")) {
    return (inputTokens * 0.11 + outputTokens * 0.28) / 1_000_000;
  }
  if (m.includes("qwen-turbo") || m.includes("qwen3.8-flash") || m.includes("qwen3.7-flash")) {
    return (inputTokens * 0.04 + outputTokens * 0.08) / 1_000_000;
  }
  if (m.includes("gpt-4o-mini")) {
    return (inputTokens * 0.15 + outputTokens * 0.60) / 1_000_000;
  }
  if (m.includes("gpt-4o") || m.includes("gpt-6")) {
    return (inputTokens * 2.5 + outputTokens * 10.0) / 1_000_000;
  }
  if (m.includes("claude")) {
    return (inputTokens * 3.0 + outputTokens * 15.0) / 1_000_000;
  }
  return (inputTokens * 0.5 + outputTokens * 1.5) / 1_000_000;
}

interface LlmClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

async function callLlm(
  prompt: { system: string; user: string },
  config: LlmClientConfig,
  retries = 3
): Promise<{ rawJson: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const t0 = Date.now();
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      const latencyMs = Date.now() - t0;

      if (!resp.ok) {
        const errText = await resp.text();
        // 如果是 response_format 400，降级去除 response_format 重试
        if (resp.status === 400 && errText.includes("response_format")) {
          const fallbackResp = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: config.model,
              messages: [
                { role: "system", content: prompt.system },
                { role: "user", content: prompt.user },
              ],
              temperature: 0.1,
            }),
            signal: AbortSignal.timeout(config.timeoutMs),
          });
          if (fallbackResp.ok) {
            const data = (await fallbackResp.json()) as any;
            const content = data.choices?.[0]?.message?.content ?? "";
            return {
              rawJson: content,
              inputTokens: data.usage?.prompt_tokens ?? 0,
              outputTokens: data.usage?.completion_tokens ?? 0,
              latencyMs: Date.now() - t0,
            };
          }
        }
        throw new Error(`LLM HTTP ${resp.status}: ${errText.slice(0, 300)}`);
      }

      const data = (await resp.json()) as any;
      const content = data.choices?.[0]?.message?.content ?? "";
      return {
        rawJson: content,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        latencyMs,
      };
    } catch (err: any) {
      lastError = err;
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error("LLM call failed after retries");
}

function parseJsonFromLlmOutput(raw: string): BpLlmExtraction {
  let cleaned = raw.trim();
  // 移除 markdown 代码块包裹
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  // 截取首个 { 到末尾 }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }

  return JSON.parse(cleaned) as BpLlmExtraction;
}

// ─── 环境变量加载 ─────────────────────────────────────────────────────

function loadEnv(): void {
  const envCandidates = [
    path.resolve(".env"),
    path.resolve("kpl-intelligence/.env"),
  ];

  for (const file of envCandidates) {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const idx = trimmed.indexOf("=");
          if (idx > 0) {
            const k = trimmed.slice(0, idx).trim();
            const v = trimmed.slice(idx + 1).trim();
            if (!process.env[k]) {
              process.env[k] = v;
            }
          }
        }
      }
    }
  }
}

// ─── CLI 参数解析 ─────────────────────────────────────────────────────

interface CliOptions {
  input: string;
  out: string;
  stats: string;
  limit: number | null;
  offset: number;
  id: string | null;
  season: string | null;
  model: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  provider: "dashscope" | "openai" | "deepseek" | null;
  concurrency: number;
  timeoutMs: number;
  dryRun: boolean;
  resume: boolean;
  verbose: boolean;
}

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    input: "data/commentary_parsed.jsonl",
    out: "data/bp_extractions.jsonl",
    stats: "data/bp_extractions_stats.json",
    limit: null,
    offset: 0,
    id: null,
    season: null,
    model: null,
    baseUrl: null,
    apiKey: null,
    provider: null,
    concurrency: 3,
    timeoutMs: 90000,
    dryRun: false,
    resume: true,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--input" && args[i + 1]) opts.input = args[++i];
    else if (arg === "--out" && args[i + 1]) opts.out = args[++i];
    else if (arg === "--stats" && args[i + 1]) opts.stats = args[++i];
    else if (arg === "--limit" && args[i + 1]) opts.limit = parseInt(args[++i], 10);
    else if (arg === "--offset" && args[i + 1]) opts.offset = parseInt(args[++i], 10);
    else if (arg === "--id" && args[i + 1]) opts.id = args[++i];
    else if (arg === "--season" && args[i + 1]) opts.season = args[++i];
    else if (arg === "--model" && args[i + 1]) opts.model = args[++i];
    else if (arg === "--base-url" && args[i + 1]) opts.baseUrl = args[++i];
    else if (arg === "--api-key" && args[i + 1]) opts.apiKey = args[++i];
    else if (arg === "--provider" && args[i + 1]) opts.provider = args[++i] as any;
    else if (arg === "--concurrency" && args[i + 1]) opts.concurrency = parseInt(args[++i], 10);
    else if (arg === "--timeout" && args[i + 1]) opts.timeoutMs = parseInt(args[++i], 10);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--no-resume" || arg === "--force") opts.resume = false;
    else if (arg === "--verbose") opts.verbose = true;
    else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }

  return opts;
}

function printHelp(): void {
  console.log(`
P1 — KPL BP 解说字幕结构化提取

用法：
  npx tsx scripts/extract-bp.ts [选项]

选项：
  --limit <n>          提取条数上限
  --offset <n>         跳过前 N 条匹配记录
  --id <recordId>      提取单条特定记录 (如 BV1CTL96wEtV_P02)
  --season <name>      过滤特定赛季 (如 2026夏季赛 或 kpl-2026-summer)
  --model <name>       LLM 模型名称 (默认优先选择 qwen-plus 或 LLM_MODEL)
  --provider <name>    模型供应商预设 (dashscope | openai | deepseek)
  --base-url <url>     自定义 OpenAI 兼容接口 Base URL
  --api-key <key>      自定义 API Key
  --concurrency <n>    并发数 (默认 3)
  --timeout <ms>       单次请求超时时间 (默认 90000ms)
  --dry-run            仅打印 Prompt 样例和输入统计，不真正调用 LLM
  --no-resume / --force  不跳过已在输出文件中存在的 recordId
  --verbose            输出详细调试信息
  --input <path>       输入文件 (默认 data/commentary_parsed.jsonl)
  --out <path>         输出文件 (默认 data/bp_extractions.jsonl)
  --stats <path>       统计落盘路径 (默认 data/bp_extractions_stats.json)
`);
}

// ─── 主执行流程 ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  const opts = parseCliArgs();

  console.log("=================================================");
  console.log("🎮 KPL BP 阶段解说稿结构化提取管道 (P1)");
  console.log("=================================================");

  // 1. 加载英雄字典
  const standardHeroes = loadStandardHeroes();
  console.log(`📚 已载入王者荣耀标准英雄字典: ${standardHeroes.size} 位英雄`);

  // 2. 确定 LLM 客户端配置
  let baseUrl = opts.baseUrl;
  let apiKey = opts.apiKey;
  let model = opts.model;

  if (opts.provider === "dashscope" || (!baseUrl && process.env.DASHSCOPE_API_KEY)) {
    baseUrl = baseUrl ?? process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
    apiKey = apiKey ?? process.env.DASHSCOPE_API_KEY ?? "";
    model = model ?? "qwen-plus";
  } else {
    baseUrl = baseUrl ?? process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
    apiKey = apiKey ?? process.env.LLM_API_KEY ?? "";
    model = model ?? process.env.LLM_MODEL ?? "gpt-4o-mini";
  }

  if (!opts.dryRun && (!baseUrl || !apiKey)) {
    console.error("❌ 缺少 LLM 配置：未检测到有效 API Key (DASHSCOPE_API_KEY 或 LLM_API_KEY)。");
    console.error("   请在 .env 或 kpl-intelligence/.env 中配置，或通过 --api-key / --base-url 传入。");
    process.exit(1);
  }

  console.log(`🤖 LLM 目标: [${model}] @ ${baseUrl}`);
  console.log(`⚙️  并发: ${opts.concurrency} | 断点续跑: ${opts.resume ? "是" : "否"}`);
  console.log(`📂 输入: ${opts.input}`);
  console.log(`💾 输出: ${opts.out}`);

  // 3. 统计已完成的记录 ID（用于断点续跑）
  const completedIds = new Set<string>();
  if (opts.resume && fs.existsSync(opts.out)) {
    const existingRl = readline.createInterface({
      input: fs.createReadStream(opts.out),
      crlfDelay: Infinity,
    });
    for await (const line of existingRl) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.recordId) completedIds.add(item.recordId);
      } catch {
        // ignore malformed lines
      }
    }
    console.log(`🔄 断点续跑已载入历史已完成记录: ${completedIds.size} 条`);
  }

  // 4. 扫描输入记录
  if (!fs.existsSync(opts.input)) {
    console.error(`❌ 输入文件不存在: ${opts.input}`);
    process.exit(1);
  }

  console.log("\n🔍 正在检索符合条件的比赛记录 (contentType=game && bpSplit!=null)...");
  const candidates: CommentaryRecord[] = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(opts.input),
    crlfDelay: Infinity,
  });

  let scanned = 0;
  for await (const line of rl) {
    scanned++;
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as CommentaryRecord;
      if (record.contentType !== "game" || !record.bpSplit) continue;

      if (opts.id && record.id !== opts.id) continue;
      if (opts.season && !record.seasonDir.includes(opts.season) && record.seasonId !== opts.season) continue;
      if (opts.resume && completedIds.has(record.id)) continue;

      candidates.push(record);
      if (opts.limit && candidates.length >= opts.offset + opts.limit) {
        break;
      }
    } catch (e: any) {
      // ignore
    }
  }

  const targets = opts.offset > 0 ? candidates.slice(opts.offset) : candidates;
  console.log(`🎯 匹配待提取候选记录: ${targets.length} 条 (总扫描行数: ${scanned})`);

  if (targets.length === 0) {
    console.log("✨ 没有待处理的记录！所有候选已完成提取或无匹配。");
    return;
  }

  // Dry run 模式
  if (opts.dryRun) {
    console.log("\n🧪 --- Dry-Run 模式样例 ---");
    const sample = targets[0];
    const prompt = buildPrompt(sample);
    console.log(`记录 ID: ${sample.id}`);
    console.log(`对阵: ${sample.homeTeamRaw} vs ${sample.awayTeamRaw} (第 ${sample.gameNo} 局)`);
    console.log(`BP 行数: ${sample.bpSplit?.bpLineCount} | 字符数: ${sample.bpSplit?.bpCharCount}`);
    console.log(`\n[System Prompt Preview]\n${prompt.system.slice(0, 200)}...`);
    console.log(`\n[User Prompt Preview (前 600 字)]\n${prompt.user.slice(0, 600)}...\n`);
    console.log("Dry-run 检查完毕，未发起实际 LLM 调用。");
    return;
  }

  // 5. 确保输出目录存在
  const outDir = path.dirname(opts.out);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // 6. 批处理统计
  const batchStats = {
    totalTarget: targets.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    validationValidCount: 0,
    validationWarningCount: 0,
    validationErrorCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    startTime: new Date().toISOString(),
    endTime: "",
    errors: [] as Array<{ id: string; error: string }>,
  };

  const llmConfig: LlmClientConfig = {
    baseUrl: baseUrl!,
    apiKey: apiKey!,
    model: model!,
    timeoutMs: opts.timeoutMs,
  };

  // 互斥写入输出文件
  const appendResult = (resultRecord: BpExtractionRecord) => {
    fs.appendFileSync(opts.out, JSON.stringify(resultRecord) + "\n", "utf-8");
  };

  // 处理单条记录
  async function processOne(record: CommentaryRecord, index: number): Promise<void> {
    const t0 = Date.now();
    const prompt = buildPrompt(record);

    try {
      const llmResult = await callLlm(prompt, llmConfig);
      const parsedExtraction = parseJsonFromLlmOutput(llmResult.rawJson);

      // 规范化英雄名
      sanitizeExtractionHeroes(parsedExtraction, standardHeroes);

      // 校验规则
      const validation = validateExtraction(parsedExtraction, standardHeroes);

      const costUsd = estimateCostUsd(llmConfig.model, llmResult.inputTokens, llmResult.outputTokens);

      const outRecord: BpExtractionRecord = {
        recordId: record.id,
        matchInfo: {
          season: record.seasonDir,
          seasonId: record.seasonId,
          date: record.publishDate,
          homeTeam: record.homeTeamRaw ?? "主队",
          awayTeam: record.awayTeamRaw ?? "客队",
          homeTeamSlug: record.homeTeamSlug,
          awayTeamSlug: record.awayTeamSlug,
          gameNo: record.gameNo ?? 1,
          totalParts: record.totalParts,
          bvid: record.bvid,
          cid: record.cid,
          title: record.title,
          videoUrl: record.videoUrl,
          year: record.year,
          split: record.split,
        },
        extraction: parsedExtraction,
        validation,
        meta: {
          inputTokens: llmResult.inputTokens,
          outputTokens: llmResult.outputTokens,
          totalTokens: llmResult.inputTokens + llmResult.outputTokens,
          model: llmConfig.model,
          latencyMs: llmResult.latencyMs,
          costUsd,
          timestamp: new Date().toISOString(),
        },
      };

      appendResult(outRecord);

      // 更新统计
      batchStats.processed++;
      batchStats.succeeded++;
      batchStats.totalInputTokens += llmResult.inputTokens;
      batchStats.totalOutputTokens += llmResult.outputTokens;
      batchStats.totalCostUsd += costUsd;
      batchStats.totalLatencyMs += llmResult.latencyMs;

      if (validation.valid) {
        batchStats.validationValidCount++;
      } else {
        batchStats.validationErrorCount++;
      }
      if (validation.warnings.length > 0) {
        batchStats.validationWarningCount++;
      }

      const bansCount = parsedExtraction.bans?.length ?? 0;
      const picksCount = parsedExtraction.picks?.length ?? 0;
      const blueHeroes = (parsedExtraction.composition_analysis?.blue_comp?.heroes ?? []).join(",");
      const redHeroes = (parsedExtraction.composition_analysis?.red_comp?.heroes ?? []).join(",");

      const percent = ((batchStats.processed / batchStats.totalTarget) * 100).toFixed(1);
      console.log(
        `✅ [${batchStats.processed}/${batchStats.totalTarget}] (${percent}%) ${record.id}: ` +
          `${record.homeTeamRaw} vs ${record.awayTeamRaw} G${record.gameNo} -> ` +
          `Bans:${bansCount} Picks:${picksCount} [${blueHeroes} vs ${redHeroes}] ` +
          `(${llmResult.inputTokens}+${llmResult.outputTokens} tok, ${(llmResult.latencyMs / 1000).toFixed(1)}s, ~$${costUsd.toFixed(4)})`
      );

      if (opts.verbose && validation.warnings.length > 0) {
        console.log(`   ⚠️  校验警告: ${validation.warnings.join("; ")}`);
      }
    } catch (err: any) {
      batchStats.processed++;
      batchStats.failed++;
      batchStats.errors.push({ id: record.id, error: err.message });
      console.error(`❌ [${batchStats.processed}/${batchStats.totalTarget}] ${record.id} 提取失败: ${err.message}`);
    }
  }

  // 7. 并发调度执行 (Worker Pool)
  console.log(`\n🚀 开始批处理提取 (并发: ${opts.concurrency})...\n`);

  let currentIndex = 0;
  async function worker(): Promise<void> {
    while (currentIndex < targets.length) {
      const idx = currentIndex++;
      const item = targets[idx];
      await processOne(item, idx);
    }
  }

  const workerPromises = Array.from({ length: opts.concurrency }, () => worker());
  await Promise.all(workerPromises);

  batchStats.endTime = new Date().toISOString();

  // 8. 输出并保存汇总统计
  console.log("\n=================================================");
  console.log("🏁 BP 结构化提取任务完成");
  console.log("=================================================");
  console.log(`总处理数: ${batchStats.processed} / ${batchStats.totalTarget}`);
  console.log(`成功数: ${batchStats.succeeded} | 失败数: ${batchStats.failed}`);
  console.log(`校验通过: ${batchStats.validationValidCount} | 存在告警: ${batchStats.validationWarningCount}`);
  console.log(`累计 Tokens: In ${batchStats.totalInputTokens} + Out ${batchStats.totalOutputTokens}`);
  console.log(`估算总花费: ~$${batchStats.totalCostUsd.toFixed(4)} USD`);
  if (batchStats.succeeded > 0) {
    console.log(`平均耗时: ${(batchStats.totalLatencyMs / batchStats.succeeded / 1000).toFixed(2)}s`);
  }
  console.log(`产出写入: ${opts.out}`);

  // 落盘 stats
  if (opts.stats) {
    fs.writeFileSync(opts.stats, JSON.stringify(batchStats, null, 2), "utf-8");
    console.log(`统计写入: ${opts.stats}`);
  }
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});

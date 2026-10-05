#!/usr/bin/env npx tsx
/**
 * P2 — 赛后采访语料结构化提取脚本
 *
 * 依据 prompts/interview-extraction.md 规范：
 * 从 data/commentary_parsed.jsonl 中读取 contentType === 'interview' 的比赛记录（共 1,290 场），
 * 调用大语言模型提取受访选手/教练、问答轮次（Q&A）、职业生涯感悟、转会经历、
 * 标志性金句（Golden Quotes）与队内梗文化，
 * 经过实体校准与规则校验后，流式追加写入 data/interview_extractions.jsonl。
 *
 * 支持特性：
 *   - 断点续跑 (--resume，默认启用)
 *   - 并发控制 (--concurrency，默认 3)
 *   - 单条测试 (--id, 例如 BV1CTL96wEtV_P06)
 *   - 自动适配 DashScope / OpenAI 兼容接口
 *   - 实时 Token 消耗、耗时与 USD 费用统计
 *
 * 用法示例：
 *   # 单条测试金标样本（小胖赛后采访）
 *   npx tsx scripts/extract-interview.ts --id BV1CTL96wEtV_P06 --verbose
 *
 *   # 跑前 3 场采访
 *   npx tsx scripts/extract-interview.ts --limit 3
 *
 *   # 按赛季运行
 *   npx tsx scripts/extract-interview.ts --season 2026夏季赛 --concurrency 5
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// ─── 类型定义 ────────────────────────────────────────────────────────

interface SubtitleLine {
  timeSecs: number;
  timeRaw: string;
  text: string;
}

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
}

interface InterviewMeta {
  host: string | null;
  interviewees: Array<{
    name: string;
    team: string;
    role: "player" | "coach";
  }>;
  segment_type: "post_match_winner" | "post_match_loser" | "desk_commentary" | "mixed";
  match_result_mentioned: string | null;
}

interface QaDialogue {
  round: number;
  topic: string;
  question_summary: string;
  speaker: string;
  answer_summary: string;
  key_quote: string;
  timestamp: string;
}

interface PlayerProfile {
  player: string;
  team: string;
  dimensions: {
    personality_traits: string[];
    transfer_story: string | null;
    leadership_and_voice: string | null;
    hero_self_assessment: Array<{
      hero: string;
      comment: string;
    }>;
    career_milestones_noted: string[];
    memes_and_culture: string[];
  };
}

interface TeamChemistryInsight {
  team: string;
  insight: string;
  timestamp: string;
}

interface GoldenQuote {
  speaker: string;
  quote: string;
  context: string;
  timestamp: string;
}

interface ExtractionConfidence {
  interviewee_identified: "high" | "medium" | "low";
  dialogue_completeness: "high" | "medium" | "low";
  notes?: string;
}

export interface InterviewLlmExtraction {
  interview_meta: InterviewMeta;
  qa_dialogues: QaDialogue[];
  player_profiles: PlayerProfile[];
  team_chemistry_insights: TeamChemistryInsight[];
  golden_quotes: GoldenQuote[];
  extraction_confidence: ExtractionConfidence;
}

export interface InterviewExtractionRecord {
  recordId: string;
  matchInfo: {
    season: string;
    seasonId: string | null;
    date: string;
    homeTeam: string | null;
    awayTeam: string | null;
    homeTeamSlug: string | null;
    awayTeamSlug: string | null;
    bvid: string;
    cid: string | null;
    title: string;
    videoUrl: string;
    year: number;
    split: string;
  };
  extraction: InterviewLlmExtraction;
  meta: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    latencyMs: number;
    costUsd: number;
    extractedAt: string;
  };
}

// ─── 预处理与 Prompt 构建 ─────────────────────────────────────────────

export function prepareInterviewInput(subtitles: SubtitleLine[]): string {
  const noiseRegex = /^(嗯|哦|啊|好的?|是的?|对的?|没错|确实|OK|ok|哈哈|呵呵)$/;
  return subtitles
    .filter(s => s && s.text && s.text.trim().length >= 2)
    .filter(s => !noiseRegex.test(s.text.trim()))
    .map(s => `[${s.timeRaw}] ${s.text.trim()}`)
    .join("\n");
}

const SYSTEM_PROMPT = `你是一位资深王者荣耀职业电竞（KPL）人物与战队文化采编专家，擅长从选手、教练和主持人的第一人称采访对话中提炼选手画像、职业心路与赛事背景。

你的任务是从 KPL 赛后采访字幕中提取结构化的人物语料。字幕来自 B 站 AI 自动语音识别，因此：
- 选手昵称/真名可能有音近字错（如"小胖"、"一诺"、"无畏"、"清融"、"花海"、"信"、"易安"、"句号"、"菠萝"等）
- 主持人名可能音近字错（如"天云"、"英凯"、"灵儿"、"广宇"、"琪琪"、"悦悦"、"小鹿"等）
- 战队简称/外号常在对话中出现（如"甜甜糕"指广州TTG，"超玩会"指AG，"狼队"指重庆狼队等）
- 口语化黑话频出（如"吃晕碳"、"一扎五"、"热手"、"拿捏"、"互喂"等）

你需要：
1. 准确识别采访的主持人、受访选手（及所属战队）、受访教练；
2. 提取问答轮次（Q&A Rounds），精准对齐核心议题与原话回答；
3. 提取选手的标志性金句（Quote）、职业生涯转折感悟、队伍磨合经历、招牌英雄自评；
4. 提取解说/评论席在采访前后对受访选手的背景补充（如回归天数、胜负间隔、生涯里程碑）；
5. 忠实于原文，绝不凭空编造事实或添枝加叶。
严格仅输出合法的 JSON 格式，不输出任何 markdown 代码块外部的解释。`;

function buildUserPrompt(record: CommentaryRecord): string {
  const inputSubtitles = prepareInterviewInput(record.subtitles);
  return `请分析以下 KPL 赛后采访的字幕文本，提取结构化的人物画像与采访数据。

## 比赛信息
- 赛季：${record.seasonDir}
- 日期：${record.publishDate}
- 比赛：${record.homeTeamRaw ?? "未知"} vs ${record.awayTeamRaw ?? "未知"}
- 视频：${record.title}

## 采访字幕
\`\`\`
${inputSubtitles}
\`\`\`

请输出以下 JSON 结构：
\`\`\`json
{
  "interview_meta": {
    "host": "主持人姓名（如'天云'、'英凯'、'灵儿'等），未提及填 null",
    "interviewees": [
      {
        "name": "选手或教练昵称（如'小胖'、'无畏'）",
        "team": "所属战队（如'广州TTG'、'北京JDG'）",
        "role": "player|coach"
      }
    ],
    "segment_type": "post_match_winner|post_match_loser|desk_commentary|mixed",
    "match_result_mentioned": "采访中提及的本场赛果（如'广州TTG 3:1 佛山DRG'），未提及填 null"
  },
  "qa_dialogues": [
    {
      "round": 1,
      "topic": "transfer_feeling|match_review|team_chemistry|hero_play|funny_meme|career_milestone|future_goal",
      "question_summary": "主持人提问核心概要",
      "speaker": "回答人昵称",
      "answer_summary": "受访人回答核心观点",
      "key_quote": "受访人原话金句（逐字保留口语精华）",
      "timestamp": "时间戳"
    }
  ],
  "player_profiles": [
    {
      "player": "选手昵称",
      "team": "战队名称",
      "dimensions": {
        "personality_traits": ["性格特征标签，如'幽默搞怪'、'自信霸气'"],
        "transfer_story": "关于转会、离队、复出、加入新队伍的心路历程（无则填 null）",
        "leadership_and_voice": "在队伍中的指挥权、沟通方式或领导地位（无则填 null）",
        "hero_self_assessment": [
          { "hero": "英雄名", "comment": "自评内容" }
        ],
        "career_milestones_noted": ["里程碑记录"],
        "memes_and_culture": ["梗文化或经典发言"]
      }
    }
  ],
  "team_chemistry_insights": [
    {
      "team": "战队名称",
      "insight": "战队内部磨合、打法风格或氛围",
      "timestamp": "时间戳"
    }
  ],
  "golden_quotes": [
    {
      "speaker": "发言人昵称",
      "quote": "最具有传播价值的原汁原味金句（逐字真实）",
      "context": "金句语境说明",
      "timestamp": "时间戳"
    }
  ],
  "extraction_confidence": {
    "interviewee_identified": "high|medium|low",
    "dialogue_completeness": "high|medium|low",
    "notes": "提取过程说明"
  }
}
\`\`\``;
}

// ─── LLM 调用与反序列化 ───────────────────────────────────────────────

function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const m = model.toLowerCase();
  if (m.includes("qwen-plus")) {
    return (inputTokens * 0.0008 + outputTokens * 0.002) / 1000;
  }
  if (m.includes("qwen") || m.includes("deepseek")) {
    return (inputTokens * 0.00014 + outputTokens * 0.00028) / 1000;
  }
  if (m.includes("gpt-4o-mini")) {
    return (inputTokens * 0.00015 + outputTokens * 0.0006) / 1000;
  }
  return (inputTokens * 0.0002 + outputTokens * 0.0008) / 1000;
}

function parseJsonFromLlmOutput(raw: string): InterviewLlmExtraction {
  let cleaned = raw.trim();
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }
    throw new Error(`无法解析模型输出为合法 JSON: ${raw.slice(0, 150)}...`);
  }
}

async function callLlm(
  systemPrompt: string,
  userPrompt: string,
  opts: {
    model: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  }
): Promise<{ extraction: InterviewLlmExtraction; inputTokens: number; outputTokens: number; latencyMs: number }> {
  const startTime = Date.now();
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const payload = {
    model: opts.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
    max_tokens: 3500,
    response_format: { type: "json_object" },
  };

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${errorText.slice(0, 200)}`);
      }

      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("模型未返回有效文本内容");

      const extraction = parseJsonFromLlmOutput(content);
      const latencyMs = Date.now() - startTime;
      const inputTokens = data.usage?.prompt_tokens ?? Math.ceil(userPrompt.length / 2);
      const outputTokens = data.usage?.completion_tokens ?? Math.ceil(content.length / 2);

      return { extraction, inputTokens, outputTokens, latencyMs };
    } catch (err) {
      clearTimeout(timer);
      lastError = err as Error;
      if (attempt < 3) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error("LLM 调用重试失败");
}

// ─── 环境变量载入 ─────────────────────────────────────────────────────

function loadEnv(): void {
  const envPaths = [
    path.resolve(__dirname, "../kpl-intelligence/.env"),
    path.resolve(__dirname, "../.env"),
  ];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const k = trimmed.slice(0, eqIdx).trim();
          const v = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[k]) process.env[k] = v;
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
  id: string | null;
  season: string | null;
  model: string;
  baseUrl: string;
  apiKey: string;
  concurrency: number;
  timeoutMs: number;
  dryRun: boolean;
  resume: boolean;
  verbose: boolean;
}

function parseCliArgs(): CliOptions {
  loadEnv();
  const args = process.argv.slice(2);

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const model = getArg("--model") ?? process.env.LLM_MODEL ?? "gpt-6-luna";
  const baseUrl = getArg("--base-url") ?? process.env.LLM_BASE_URL ?? "https://api.mytokens.vip/v1";
  const apiKey = getArg("--api-key") ?? process.env.LLM_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? "";

  return {
    input: getArg("--input") ?? "data/commentary_parsed.jsonl",
    out: getArg("--out") ?? "data/interview_extractions.jsonl",
    stats: getArg("--stats") ?? "data/interview_extractions_stats.json",
    limit: getArg("--limit") ? parseInt(getArg("--limit")!) : null,
    id: getArg("--id") ?? null,
    season: getArg("--season") ?? null,
    model,
    baseUrl,
    apiKey,
    concurrency: getArg("--concurrency") ? parseInt(getArg("--concurrency")!) : 3,
    timeoutMs: getArg("--timeout") ? parseInt(getArg("--timeout")!) * 1000 : 90000,
    dryRun: args.includes("--dry-run"),
    resume: !args.includes("--no-resume") && !args.includes("--force"),
    verbose: args.includes("--verbose") || args.includes("-v"),
  };
}

// ─── 主执行流程 ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseCliArgs();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("       🎤 KPL 赛后采访语料结构化提取流水线 (P2)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`📂 输入: ${opts.input}`);
  console.log(`📁 输出: ${opts.out}`);
  console.log(`🤖 模型: ${opts.model} (${opts.baseUrl})`);
  console.log(`⚙️  并发: ${opts.concurrency} | 断点续跑: ${opts.resume ? "是" : "否"}`);

  if (!opts.apiKey && !opts.dryRun) {
    console.error("❌ 未检测到 API Key，请设置 LLM_API_KEY 环境变量或传入 --api-key");
    process.exit(1);
  }

  // 1. 载入已完成 ID 用于断点续跑
  const completedIds = new Set<string>();
  if (opts.resume && fs.existsSync(opts.out)) {
    const rl = readline.createInterface({
      input: fs.createReadStream(opts.out, "utf-8"),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.recordId) completedIds.add(item.recordId);
      } catch {}
    }
    console.log(`🔄 断点续跑已载入已完成记录: ${completedIds.size} 条`);
  }

  // 2. 流式过滤候选记录
  const candidates: CommentaryRecord[] = [];
  const inputRl = readline.createInterface({
    input: fs.createReadStream(opts.input, "utf-8"),
    crlfDelay: Infinity,
  });

  for await (const line of inputRl) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as CommentaryRecord;
      if (r.contentType !== "interview") continue;
      if (opts.id && r.id !== opts.id) continue;
      if (opts.season && r.seasonDir !== opts.season) continue;
      if (opts.resume && completedIds.has(r.id)) continue;
      candidates.push(r);
      if (opts.limit && candidates.length >= opts.limit) break;
    } catch {}
  }

  console.log(`📋 待处理采访候选: ${candidates.length} 条`);
  if (!candidates.length) {
    console.log("✨ 没有待处理的记录！全部已完成或无匹配。");
    return;
  }

  if (opts.dryRun) {
    console.log("\n[Dry-run] 第一条待提取样本预览:");
    const sample = candidates[0];
    console.log(`ID: ${sample.id} | 标题: ${sample.title}`);
    console.log(`对战: ${sample.homeTeamRaw} vs ${sample.awayTeamRaw} (${sample.publishDate})`);
    console.log("\nPrompt 预览:\n" + buildUserPrompt(sample).slice(0, 800) + "...\n");
    return;
  }

  // 3. 并发执行
  const outWs = fs.createWriteStream(opts.out, { flags: "a" });
  let succeeded = 0;
  let failed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let totalLatencyMs = 0;
  const errors: Array<{ id: string; error: string }> = [];

  let index = 0;
  async function worker(): Promise<void> {
    while (index < candidates.length) {
      const curIdx = index++;
      const record = candidates[curIdx];
      const startMs = Date.now();

      try {
        const userPrompt = buildUserPrompt(record);
        const { extraction, inputTokens, outputTokens, latencyMs } = await callLlm(
          SYSTEM_PROMPT,
          userPrompt,
          {
            model: opts.model,
            baseUrl: opts.baseUrl,
            apiKey: opts.apiKey,
            timeoutMs: opts.timeoutMs,
          }
        );

        const cost = estimateCostUsd(opts.model, inputTokens, outputTokens);
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        totalCostUsd += cost;
        totalLatencyMs += latencyMs;
        succeeded++;

        const outRecord: InterviewExtractionRecord = {
          recordId: record.id,
          matchInfo: {
            season: record.seasonDir,
            seasonId: record.seasonId,
            date: record.publishDate,
            homeTeam: record.homeTeamRaw,
            awayTeam: record.awayTeamRaw,
            homeTeamSlug: record.homeTeamSlug,
            awayTeamSlug: record.awayTeamSlug,
            bvid: record.bvid,
            cid: record.cid,
            title: record.title,
            videoUrl: record.videoUrl,
            year: record.year,
            split: record.split,
          },
          extraction,
          meta: {
            inputTokens,
            outputTokens,
            model: opts.model,
            latencyMs,
            costUsd: cost,
            extractedAt: new Date().toISOString(),
          },
        };

        outWs.write(JSON.stringify(outRecord) + "\n");

        const interviewees = extraction.interview_meta.interviewees.map(i => `${i.name}(${i.team})`).join("、") || "未知受访人";
        const quoteCount = extraction.golden_quotes.length;
        const dialogueCount = extraction.qa_dialogues.length;

        console.log(`[${curIdx + 1}/${candidates.length}] ✅ ${record.id} | ${interviewees} | 问答:${dialogueCount}轮 | 金句:${quoteCount}条 | 耗时:${(latencyMs / 1000).toFixed(1)}s`);

        if (opts.verbose) {
          console.log(`   主持人: ${extraction.interview_meta.host ?? "未知"}`);
          if (extraction.golden_quotes[0]) {
            console.log(`   金句: "${extraction.golden_quotes[0].quote}"`);
          }
        }
      } catch (err) {
        failed++;
        const msg = (err as Error).message;
        errors.push({ id: record.id, error: msg });
        console.error(`[${curIdx + 1}/${candidates.length}] ❌ ${record.id} 提取失败: ${msg}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(opts.concurrency, candidates.length) }, () => worker());
  await Promise.all(workers);

  outWs.end();

  // 4. 保存统计
  const stats = {
    totalCandidates: candidates.length,
    succeeded,
    failed,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    totalLatencyMs,
    avgLatencyMs: succeeded > 0 ? Math.round(totalLatencyMs / succeeded) : 0,
    model: opts.model,
    errors,
  };
  fs.writeFileSync(opts.stats, JSON.stringify(stats, null, 2));

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("                  📊 采访提取任务完成");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  成功: ${succeeded} | 失败: ${failed}`);
  console.log(`  输入 Token: ${totalInputTokens.toLocaleString()} | 输出 Token: ${totalOutputTokens.toLocaleString()}`);
  console.log(`  总估算成本: $${totalCostUsd.toFixed(4)} USD`);
  console.log(`  统计产物: ${opts.stats}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv[1] && process.argv[1].endsWith("extract-interview.ts")) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

#!/usr/bin/env npx tsx
/**
 * 模块 3：BP 战术知识块入库与语义增强合成脚本 (scripts/ingest-bp-to-kb.ts)
 *
 * 依据「路线 A：BP 战术知识入库与 QA 问答强化完整提示词」规范：
 * 1. 从 data/bp_extractions.jsonl 读取结构化 BP 提取数据；
 * 2. 调度模块 1 (KB Chunk Synthesizer) 大模型合成高密度战术知识文本块；
 * 3. 关联官方数据库 matches / games / players / heroes 实体 ID；
 * 4. 封装 BpChunkPayload 契约；
 * 5. 覆盖式写入 PostgreSQL chunks 表 (source_type = 'match' | 'player' | 'hero')；
 * 6. 可选补齐 pgvector 1024 维语义向量；
 * 7. 写入 data/bp_chunks.jsonl 离线审计镜像与汇总统计。
 *
 * 用法：
 *   # 测试单局合成与入库 (金标样本 BV1CTL96wEtV_P02)
 *   npx tsx scripts/ingest-bp-to-kb.ts --id BV1CTL96wEtV_P02 --verbose
 *
 *   # 仅合成 JSONL，不写入远程数据库
 *   npx tsx scripts/ingest-bp-to-kb.ts --limit 3 --no-db
 *
 *   # Dry-run 预览 Prompt
 *   npx tsx scripts/ingest-bp-to-kb.ts --limit 1 --dry-run
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { createHash } from "node:crypto";

// ─── 契约定义 (模块 3 写入契约) ─────────────────────────────────────────

export interface BpChunkPayload {
  matchId: string;
  gameId: string;
  gameNo: number;
  seasonId: string;
  seasonName: string;
  title: string;
  content: string;
  tacticalQuotes: string[];
  blueComp: string[];
  redComp: string[];
  bvid: string;
  videoUrl: string;
}

/** 模块 1 LLM 输出结构 */
export interface SynthesizedChunks {
  match_bp_chunk: {
    title: string;
    content: string;
    keywords: string[];
  };
  entity_sub_chunks: Array<{
    entity_type: "player" | "hero";
    entity_name: string;
    title: string;
    content: string;
  }>;
}

/** P1 输入数据结构 (来自 data/bp_extractions.jsonl) */
interface BpExtractionRecord {
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
  extraction: {
    context: {
      series_score_before: string | null;
      previous_game_summary: string | null;
      blue_side: string | null;
      red_side: string | null;
    };
    bans: any[];
    picks: any[];
    composition_analysis: any;
    tactical_quotes: Array<{ quote: string; topic: string; timestamp: string | null }>;
    player_insights: any[];
    meta_signals: any[];
    extraction_confidence: any;
  };
  validation: any;
  meta: any;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ─── 模块 1 提示词定义 ─────────────────────────────────────────────────

const SYNTHESIZER_SYSTEM = `你是一位资深王者荣耀职业电竞（KPL）战术知识库架构师。
你的任务是将单场比赛的结构化 BP 提取数据，合成为供专业赛事数据库与 RAG 检索系统消费的“高密度知识库文本块（Knowledge Chunks）”。

原则：
1. 语言高度客观、凝练，保留解说原汁原味的战术术语与分析逻辑。
2. 每一个陈述必须包含明确的实体主体（战队名、选手名、英雄名、位置）。
3. 准确识别并使用 KPL 经典战术体系术语（如：张王组合/张王体系[张良+王昭君]、乔夫体系[大乔+老夫子]、乔离体系[大乔+公孙离]、真香组合[太乙真人+孙尚香]、父子组合[鲁班大师+鲁班七号]、弹弓组合[鲁班大师+姜子牙]、骨马体系[阿古朵+马超]、孙白杨体系[孙膑+白起+杨玉环]等）。
4. 熟练运用游戏核心机制术语（如：野区博弈[反野/换野/保野]、远古生物争夺[开龙/控龙/拼惩戒/风暴龙王团]、兵线运营[线权/转线/四一分带/断线]、团战执行[开团/反打/拆火/掉点/视野压制/中辅摇摆/以选代ban]）。
5. 必须包含解说的原始战术金句与核心因果逻辑（“因为对方...所以选择...目的是...”）。
6. 杜绝模糊代词（严禁使用“他们”、“该选手”、“这套阵容”，必须写明具体名字）。`;

const SYNTHESIZER_USER_TEMPLATE = `请根据以下 KPL 单局比赛的 BP 结构化提取数据，合成该对局的战术知识文本块。

## 对局基本信息
- 赛季：{season}
- 日期：{date}
- 比赛：{homeTeam} vs {awayTeam}（第 {gameNo} 局）
- 蓝色方：{blueSide} | 红色方：{redSide}
- 赛前大比分：{scoreBefore}
- 上局背景：{previousSummary}

## 结构化 BP 数据
\`\`\`json
{structuredJson}
\`\`\`

## 输出格式要求
请输出以下 JSON 结构：

\`\`\`json
{
  "match_bp_chunk": {
    "title": "【BP战术解读】{season} {date} {homeTeam} vs {awayTeam} 第{gameNo}局",
    "content": "400-800字符的综述段落，包含：双方BP博弈核心、关键Ban位针对点、一抢英雄及克制链条、双方阵容体系风格标签（如进攻/多核/节奏）、胜利条件与后期隐患、最关键的解说金句引用",
    "keywords": ["关键词1", "关键词2", "关键词3"]
  },
  "entity_sub_chunks": [
    {
      "entity_type": "player|hero",
      "entity_name": "选手名或英雄名",
      "title": "【选手战术记录】选手名 / 【英雄赛事打法】英雄名",
      "content": "200-400字符，提取该对局中关于该选手或英雄的核心评价、绝活表现、出装分线或克制关系"
    }
  ]
}
\`\`\``;

function buildSynthesizerPrompt(rec: BpExtractionRecord): { system: string; user: string } {
  const structuredData = {
    bans: rec.extraction.bans,
    picks: rec.extraction.picks,
    composition: rec.extraction.composition_analysis,
    tactical_quotes: rec.extraction.tactical_quotes,
    player_insights: rec.extraction.player_insights,
    meta_signals: rec.extraction.meta_signals,
  };

  const user = SYNTHESIZER_USER_TEMPLATE
    .replace(/{season}/g, rec.matchInfo.season)
    .replace(/{date}/g, rec.matchInfo.date)
    .replace(/{homeTeam}/g, rec.matchInfo.homeTeam)
    .replace(/{awayTeam}/g, rec.matchInfo.awayTeam)
    .replace(/{gameNo}/g, String(rec.matchInfo.gameNo))
    .replace(/{blueSide}/g, rec.extraction.context?.blue_side ?? rec.matchInfo.homeTeam)
    .replace(/{redSide}/g, rec.extraction.context?.red_side ?? rec.matchInfo.awayTeam)
    .replace(/{scoreBefore}/g, rec.extraction.context?.series_score_before ?? "无")
    .replace(/{previousSummary}/g, rec.extraction.context?.previous_game_summary ?? "无")
    .replace("{structuredJson}", JSON.stringify(structuredData, null, 2));

  return { system: SYNTHESIZER_SYSTEM, user };
}

// ─── LLM 调用客户端 ───────────────────────────────────────────────────

async function callLlmJson(
  prompt: { system: string; user: string },
  cfg: { baseUrl: string; apiKey: string; model: string; timeoutMs: number }
): Promise<{ data: SynthesizedChunks; inputTokens: number; outputTokens: number; latencyMs: number }> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const t0 = Date.now();

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`LLM HTTP ${resp.status}: ${errText.slice(0, 300)}`);
  }

  const json = (await resp.json()) as any;
  let text = json.choices?.[0]?.message?.content ?? "";
  text = text.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s !== -1 && e !== -1) {
    text = text.slice(s, e + 1);
  }

  const parsed = JSON.parse(text) as SynthesizedChunks;
  return {
    data: parsed,
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
  };
}

// ─── 环境变量与配置 ───────────────────────────────────────────────────

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
            if (!process.env[k]) process.env[k] = v;
          }
        }
      }
    }
  }
}

// ─── 数据库适配器 ─────────────────────────────────────────────────────

let postgresClient: any = null;

async function getSql() {
  if (postgresClient) return postgresClient;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  try {
    let postgres: any;
    try {
      postgres = (await import("postgres")).default;
    } catch {
      postgres = (await import(path.resolve("kpl-intelligence/node_modules/postgres/src/index.js"))).default;
    }
    postgresClient = postgres(dbUrl, { connect_timeout: 10, max: 5 });
    // 测试连接
    await postgresClient`SELECT 1`;
    return postgresClient;
  } catch (err: any) {
    console.warn(`⚠️  数据库连接失败 (${err.message})`);
    return null;
  }
}

/** 根据提取信息在数据库中检索 matchId 与 gameId */
async function resolveMatchAndGameIds(
  rec: BpExtractionRecord,
  sql: any
): Promise<{ matchId: string; gameId: string } | null> {
  if (!sql) return null;
  try {
    const slugA = rec.matchInfo.homeTeamSlug;
    const slugB = rec.matchInfo.awayTeamSlug;
    const dateStr = rec.matchInfo.date;

    if (!slugA || !slugB) return null;

    // 匹配 match
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM matches
      WHERE (
        (team_a_id = ${slugA} AND team_b_id = ${slugB})
        OR
        (team_a_id = ${slugB} AND team_b_id = ${slugA})
      )
      AND (
        (played_at IS NOT NULL AND played_at::date = ${dateStr}::date)
        OR
        (scheduled_at IS NOT NULL AND scheduled_at::date = ${dateStr}::date)
        OR
        (${rec.matchInfo.seasonId ? true : false} AND season_id = ${rec.matchInfo.seasonId ?? ""})
      )
      ORDER BY coalesce(played_at, scheduled_at) DESC
      LIMIT 1
    `;

    if (!rows.length) return null;
    const matchId = rows[0].id;

    // 匹配 game
    const gameRows = await sql<{ id: string }[]>`
      SELECT id FROM games
      WHERE match_id = ${matchId} AND game_no = ${rec.matchInfo.gameNo}
      LIMIT 1
    `;

    const gameId = gameRows.length ? gameRows[0].id : `${matchId}-g${rec.matchInfo.gameNo}`;
    return { matchId, gameId };
  } catch (e: any) {
    return null;
  }
}

/** 在数据库中检索选手或英雄的官方 ID */
async function resolveEntityRefId(
  type: "player" | "hero",
  name: string,
  sql: any
): Promise<string> {
  if (!sql) return `${type}:${name}`;
  try {
    if (type === "player") {
      const pRows = await sql<{ id: string }[]>`
        SELECT id FROM players
        WHERE nickname = ${name} OR slug = ${name.toLowerCase()}
        LIMIT 1
      `;
      if (pRows.length) return pRows[0].id;
    } else if (type === "hero") {
      const hRows = await sql<{ id: string }[]>`
        SELECT id FROM heroes
        WHERE name = ${name} OR slug = ${name.toLowerCase()}
        LIMIT 1
      `;
      if (hRows.length) return hRows[0].id;
    }
  } catch {
    // ignore
  }
  return `${type}:${name}`;
}

/** 生成 1024 维 embedding 向量 (DashScope / OpenAI) */
async function computeEmbedding(text: string): Promise<number[] | null> {
  const dashKey = process.env.DASHSCOPE_API_KEY;
  const dashBase = process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";

  if (dashKey) {
    try {
      const resp = await fetch(`${dashBase.replace(/\/+$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${dashKey}`,
        },
        body: JSON.stringify({
          model: "text-embedding-v3", // 1024 维
          input: text.slice(0, 1500),
          dimensions: 1024,
        }),
      });
      if (resp.ok) {
        const j = (await resp.json()) as any;
        return j.data?.[0]?.embedding ?? null;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/** 将 chunk 写入 chunks 表 (幂等先删后插) */
async function upsertDbChunk(
  sql: any,
  item: {
    sourceType: "match" | "player" | "hero";
    refId: string;
    ord: number;
    title: string;
    content: string;
  },
  generateVector: boolean
): Promise<void> {
  const tokenCount = Math.ceil(item.content.length / 2);
  const textHash = sha256(item.content);

  let vectorLiteral: string | null = null;
  if (generateVector) {
    const vec = await computeEmbedding(item.content);
    if (vec && vec.length) {
      vectorLiteral = `[${vec.join(",")}]`;
    }
  }

  await sql.begin(async (tx: any) => {
    // 覆盖式删除该 ref 下的同标题或同序号 chunk
    await tx`
      DELETE FROM chunks
      WHERE source_type = ${item.sourceType}
        AND ref_id = ${item.refId}
        AND (ord = ${item.ord} OR title = ${item.title})
    `;

    if (vectorLiteral) {
      await tx`
        INSERT INTO chunks (source_type, ref_id, ord, title, content, token_count, text_hash, embedding, created_at, updated_at)
        VALUES (
          ${item.sourceType},
          ${item.refId},
          ${item.ord},
          ${item.title},
          ${item.content},
          ${tokenCount},
          ${textHash},
          ${vectorLiteral}::vector,
          NOW(),
          NOW()
        )
      `;
    } else {
      await tx`
        INSERT INTO chunks (source_type, ref_id, ord, title, content, token_count, text_hash, created_at, updated_at)
        VALUES (
          ${item.sourceType},
          ${item.refId},
          ${item.ord},
          ${item.title},
          ${item.content},
          ${tokenCount},
          ${textHash},
          NOW(),
          NOW()
        )
      `;
    }
  });
}

// ─── 主执行程序 ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();

  const args = process.argv.slice(2);
  let inputFile = "data/bp_extractions.jsonl";
  let outputFile = "data/bp_chunks.jsonl";
  let statsFile = "data/bp_chunks_stats.json";
  let limit: number | null = null;
  let filterId: string | null = null;
  let filterSeason: string | null = null;
  let concurrency = 3;
  let dryRun = false;
  let useDb = true;
  let useEmbed = true;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--input" && args[i + 1]) inputFile = args[++i];
    else if (a === "--out" && args[i + 1]) outputFile = args[++i];
    else if (a === "--stats" && args[i + 1]) statsFile = args[++i];
    else if (a === "--limit" && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (a === "--id" && args[i + 1]) filterId = args[++i];
    else if (a === "--season" && args[i + 1]) filterSeason = args[++i];
    else if (a === "--concurrency" && args[i + 1]) concurrency = parseInt(args[++i], 10);
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--no-db") useDb = false;
    else if (a === "--no-embed") useEmbed = false;
    else if (a === "--verbose") verbose = true;
  }

  console.log("=================================================");
  console.log("🧩 KPL BP 战术知识块入库与语义增强合成 (模块 1 & 3)");
  console.log("=================================================");

  if (!fs.existsSync(inputFile)) {
    console.error(`❌ 输入提取文件不存在: ${inputFile}`);
    process.exit(1);
  }

  const sql = useDb ? await getSql() : null;
  if (useDb && !sql) {
    console.warn("⚠️  未连接到数据库 (DATABASE_URL 为空或无法连接)，将自动降级为仅落盘 JSONL。");
  } else if (sql) {
    console.log("🔌 数据库已连接: chunks 表 pgvector / pg_trgm 写入已就绪");
  }

  const baseUrl = process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
  const apiKey = process.env.DASHSCOPE_API_KEY ?? process.env.LLM_API_KEY ?? "";
  const model = "qwen-plus";

  console.log(`🤖 合成模型: [${model}] @ ${baseUrl}`);
  console.log(`📂 输入来源: ${inputFile}`);
  console.log(`💾 镜像输出: ${outputFile}`);

  // 读取已完成的记录 ID 用于断点续跑
  const completedIds = new Set<string>();
  if (fs.existsSync(outputFile)) {
    const oldRl = readline.createInterface({
      input: fs.createReadStream(outputFile),
      crlfDelay: Infinity,
    });
    for await (const line of oldRl) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.recordId) completedIds.add(item.recordId);
      } catch {}
    }
    console.log(`🔄 已载入历史已合成块记录: ${completedIds.size} 条`);
  }

  // 扫描输入记录
  const candidates: BpExtractionRecord[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(inputFile),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as BpExtractionRecord;
      if (filterId && rec.recordId !== filterId) continue;
      if (filterSeason && !rec.matchInfo.season.includes(filterSeason)) continue;
      if (completedIds.has(rec.recordId)) continue;
      candidates.push(rec);
      if (limit && candidates.length >= limit) break;
    } catch {}
  }

  console.log(`🎯 匹配待合成候选记录: ${candidates.length} 条\n`);
  if (!candidates.length) {
    console.log("✨ 没有待处理的记录！");
    if (sql) await sql.end();
    return;
  }

  // Dry-run
  if (dryRun) {
    const sample = candidates[0];
    const prompt = buildSynthesizerPrompt(sample);
    console.log("🧪 --- Dry-Run Prompt 样例 ---");
    console.log(`记录 ID: ${sample.recordId}`);
    console.log(`标题: ${sample.matchInfo.title}`);
    console.log("\n[User Prompt 预览 (前 800 字符)]\n" + prompt.user.slice(0, 800) + "...\n");
    if (sql) await sql.end();
    return;
  }

  const stats = {
    totalTarget: candidates.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    matchChunksWritten: 0,
    subChunksWritten: 0,
    totalTokens: 0,
    startTime: new Date().toISOString(),
    endTime: "",
  };

  const appendOut = (data: any) => {
    fs.appendFileSync(outputFile, JSON.stringify(data) + "\n", "utf-8");
  };

  async function processOne(rec: BpExtractionRecord): Promise<void> {
    const prompt = buildSynthesizerPrompt(rec);
    try {
      const { data, inputTokens, outputTokens, latencyMs } = await callLlmJson(prompt, {
        baseUrl,
        apiKey,
        model,
        timeoutMs: 60000,
      });

      stats.totalTokens += inputTokens + outputTokens;

      // 关联 matchId 与 gameId
      const ids = (await resolveMatchAndGameIds(rec, sql)) ?? {
        matchId: rec.matchInfo.bvid,
        gameId: rec.recordId,
      };

      // 封装 BpChunkPayload
      const payload: BpChunkPayload = {
        matchId: ids.matchId,
        gameId: ids.gameId,
        gameNo: rec.matchInfo.gameNo,
        seasonId: rec.matchInfo.seasonId ?? rec.matchInfo.season,
        seasonName: rec.matchInfo.season,
        title: data.match_bp_chunk.title,
        content: data.match_bp_chunk.content,
        tacticalQuotes: (rec.extraction.tactical_quotes || []).map(q => q.quote),
        blueComp: rec.extraction.composition_analysis?.blue_comp?.heroes || [],
        redComp: rec.extraction.composition_analysis?.red_comp?.heroes || [],
        bvid: rec.matchInfo.bvid,
        videoUrl: rec.matchInfo.videoUrl,
      };

      // 写入数据库 chunks
      if (sql) {
        // 1. 主 match chunk
        await upsertDbChunk(
          sql,
          {
            sourceType: "match",
            refId: payload.matchId,
            ord: payload.gameNo,
            title: payload.title,
            content: payload.content,
          },
          useEmbed
        );
        stats.matchChunksWritten++;

        // 2. entity sub chunks
        for (const sub of data.entity_sub_chunks || []) {
          const entityRefId = await resolveEntityRefId(sub.entity_type, sub.entity_name, sql);
          await upsertDbChunk(
            sql,
            {
              sourceType: sub.entity_type,
              refId: entityRefId,
              ord: payload.gameNo,
              title: sub.title,
              content: sub.content,
            },
            useEmbed
          );
          stats.subChunksWritten++;
        }
      }

      // 写入 JSONL 离线镜像
      appendOut({
        recordId: rec.recordId,
        payload,
        synthesized: data,
        meta: {
          inputTokens,
          outputTokens,
          latencyMs,
          timestamp: new Date().toISOString(),
        },
      });

      stats.processed++;
      stats.succeeded++;

      console.log(
        `✅ [${stats.processed}/${stats.totalTarget}] ${rec.recordId} -> ` +
          `[MatchChunk: ${data.match_bp_chunk.title}] + ${data.entity_sub_chunks?.length ?? 0} 个实体块 ` +
          `(${inputTokens}+${outputTokens} tok, ${(latencyMs / 1000).toFixed(1)}s)`
      );

      if (verbose) {
        console.log(`   📝 综述摘录: ${data.match_bp_chunk.content.slice(0, 100)}...`);
      }
    } catch (err: any) {
      stats.processed++;
      stats.failed++;
      console.error(`❌ [${stats.processed}/${stats.totalTarget}] ${rec.recordId} 合成失败: ${err.message}`);
    }
  }

  // 并发调度
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < candidates.length) {
      const idx = cursor++;
      await processOne(candidates[idx]);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  stats.endTime = new Date().toISOString();

  console.log("\n=================================================");
  console.log("🏁 BP 战术知识块入库完成");
  console.log("=================================================");
  console.log(`处理记录: ${stats.processed} / ${stats.totalTarget}`);
  console.log(`成功: ${stats.succeeded} | 失败: ${stats.failed}`);
  if (sql) {
    console.log(`写入 Match Chunks: ${stats.matchChunksWritten} 条`);
    console.log(`写入 Entity Sub Chunks: ${stats.subChunksWritten} 条`);
  }
  console.log(`离线镜像: ${outputFile}`);

  if (statsFile) {
    fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2), "utf-8");
    console.log(`统计文件: ${statsFile}`);
  }

  if (sql) {
    await sql.end();
  }
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});

// QA 三通道检索 + RRF 融合（阶段 4.3）：
//   结构化通道——按意图路由到 kb 查询（赛果/对比 → loadSchedule，H2H → loadH2H，阵容 → players），产出逐字可引用的数据卡片；
//   语义通道——pgvector 余弦检索 chunks（问题向量化复用 ensureEmbeddings 的缓存与计费回执）；
//   关键词通道——pg_trgm 相似度（% 操作符 + similarity 排序）。
// 语义与关键词两路按 RRF（score = Σ 1/(60+rank)）融合去重；任何单通道失败或为空都不影响整体。
import { createHash } from "node:crypto";
import { beijingDate } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { loadH2H, loadSchedule } from "../kb/read.ts";
import { ensureEmbeddings, embeddingsAvailable } from "../providers/embeddings.ts";
import type { UnderstandResult } from "./understand.ts";

function vectorLiteral(vec: number[]): string {
  return "[" + vec.join(",") + "]";
}

const RRF_K = 60;

export interface QaDataCard {
  kind: "match-result" | "h2h" | "roster" | "compare";
  title: string;
  lines: string[];
}

export interface QaPassage {
  sourceType: string;
  refId: string;
  ord: number;
  title: string;
  content: string;
  score: number;
}

export interface QaMaterial {
  dataCards: QaDataCard[];
  passages: QaPassage[];
}

interface ChunkRow {
  source_type: string;
  ref_id: string;
  ord: number;
  title: string;
  content: string;
}

async function semanticPassages(question: string, limit = 6): Promise<QaPassage[]> {
  if (!embeddingsAvailable()) return [];
  const id = "qa-query:" + createHash("sha256").update(question).digest("hex").slice(0, 24);
  const vectors = await ensureEmbeddings([{ id, text: question.slice(0, 500) }]);
  const vec = vectors.get(id);
  if (!vec) return [];
  const literal = vectorLiteral(vec);
  const rows = await sql<ChunkRow[]>`
    SELECT source_type, ref_id, ord, title, content FROM chunks
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${limit}`;
  return rows.map((r, i) => ({ sourceType: r.source_type, refId: r.ref_id, ord: r.ord, title: r.title, content: r.content, score: 1 / (RRF_K + i + 1) }));
}

async function keywordPassages(keywords: string[], limit = 6): Promise<QaPassage[]> {
  const terms = [...new Set(keywords.map((k) => k.trim()).filter((k) => k.length >= 2))].slice(0, 6);
  if (!terms.length) return [];
  // 逐词 trigram 相似度检索（中文长文本下 % 操作符的 0.3 默认阈值会漏召回），按词序合并去重
  const seen = new Set<string>();
  const out: ChunkRow[] = [];
  for (const term of terms) {
    const rows = await sql<ChunkRow[]>`
      SELECT source_type, ref_id, ord, title, content FROM chunks
      WHERE similarity(content, ${term}) > 0.03
      ORDER BY similarity(content, ${term}) DESC
      LIMIT ${limit}`;
    for (const r of rows) {
      const key = r.source_type + ":" + r.ref_id + ":" + r.ord;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(r);
      }
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit).map((r, i) => ({ sourceType: r.source_type, refId: r.ref_id, ord: r.ord, title: r.title, content: r.content, score: 1 / (RRF_K + i + 1) }));
}

interface ResolvedEntity {
  kind: "team" | "player" | "hero";
  id: string;
  slug: string;
  name: string;
}

/** 实体名 → kb 主键。实体规模小（几十~几百行），与 kb/entity-mentions 同款做法：
 *  整表载入后 JS 侧小写匹配（含别名字典），先精确后包含。 */
async function resolveOne(kind: "team" | "player" | "hero", name: string): Promise<ResolvedEntity | null> {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  if (kind === "team") {
    const rows = await sql<{ id: string; slug: string; name: string; alias: string | null }[]>`
      SELECT t.id, t.slug, t.name, a.alias FROM teams t
      LEFT JOIN team_aliases a ON a.team_id = t.id
      ORDER BY t.is_active DESC, t.sort_weight DESC`;
    for (const r of rows) {
      if (r.name.toLowerCase() === needle || r.slug.toLowerCase() === needle || r.alias?.toLowerCase() === needle) {
        return { kind, id: r.id, slug: r.slug, name: r.name };
      }
    }
    for (const r of rows) {
      if (r.name.toLowerCase().includes(needle) || r.alias?.toLowerCase().includes(needle)) {
        return { kind, id: r.id, slug: r.slug, name: r.name };
      }
    }
    return null;
  }
  if (kind === "player") {
    const rows = await sql<{ id: string; slug: string; nickname: string; real_name: string | null }[]>`
      SELECT id, slug, nickname, real_name FROM players WHERE is_active ORDER BY id`;
    for (const r of rows) {
      if (r.nickname.toLowerCase() === needle || r.real_name?.toLowerCase() === needle) {
        return { kind, id: r.id, slug: r.slug, name: r.nickname };
      }
    }
    for (const r of rows) {
      if (r.nickname.toLowerCase().includes(needle)) {
        return { kind, id: r.id, slug: r.slug, name: r.nickname };
      }
    }
    return null;
  }
  const heroes = await sql<{ id: string; slug: string; name: string }[]>`
    SELECT id, slug, name FROM heroes ORDER BY id`;
  for (const h of heroes) {
    if (h.name === name.trim() || h.slug.toLowerCase() === needle) {
      return { kind, id: h.id, slug: h.slug, name: h.name };
    }
  }
  for (const h of heroes) {
    if (h.name.includes(name.trim())) return { kind, id: h.id, slug: h.slug, name: h.name };
  }
  return null;
}

export async function resolveEntities(entities: UnderstandResult["entities"]): Promise<ResolvedEntity[]> {
  const out: ResolvedEntity[] = [];
  for (const e of entities.slice(0, 8)) {
    try {
      const resolved = await resolveOne(e.kind, e.name);
      if (resolved) out.push(resolved);
    } catch {
      // 单个实体解析失败不影响其余
    }
  }
  return out;
}

/** "2026-summer" → seasons.id "kpl-2026-summer"；不认识的时间表述返回 null（宁可不加过滤）。 */
export function normalizeSeasonId(season: string | null | undefined): string | null {
  const parts = (season ?? "").trim().split("-");
  if (parts.length !== 2) return null;
  const year = parts[0] ?? "";
  const split = parts[1] ?? "";
  if (!/^\d{4}$/.test(year)) return null;
  if (!["spring", "summer", "annual", "challenger"].includes(split)) return null;
  return "kpl-" + year + "-" + split;
}

interface LineSource {
  playedAt?: string | null;
  scheduledAt?: string | null;
  home: { name: string; score: number };
  away: { name: string; score: number };
  stage?: string | null;
}

function matchLine(m: LineSource): string {
  const day = beijingDate(m.playedAt ?? m.scheduledAt ?? "");
  const stage = m.stage ? "（" + m.stage + "）" : "";
  return day + " " + m.home.name + " " + m.home.score + " : " + m.away.score + " " + m.away.name + stage;
}

async function structuredCards(intent: UnderstandResult, resolved: ResolvedEntity[]): Promise<QaDataCard[]> {
  const cards: QaDataCard[] = [];
  const teams = resolved.filter((r) => r.kind === "team");
  const seasonId = normalizeSeasonId(intent.season);

  if (intent.intent === "h2h" && teams.length >= 2) {
    const teamA = teams[0];
    const teamB = teams[1];
    const h2h = teamA && teamB ? await loadH2H(teamA.slug, teamB.slug, seasonId ?? undefined) : null;
    if (h2h) {
      cards.push({
        kind: "h2h",
        title: h2h.teamA.name + " vs " + h2h.teamB.name + " 历史交手",
        lines: [
          "大场交手 " + h2h.stats.totalMatches + " 场：" + h2h.teamA.name + " " + h2h.stats.teamAWins + " 胜，" + h2h.teamB.name + " " + h2h.stats.teamBWins + " 胜",
          "小局比分 " + h2h.stats.teamAGames + " : " + h2h.stats.teamBGames,
          ...h2h.matches.slice(0, 5).map(matchLine),
        ],
      });
    }
  }

  if ((intent.intent === "match-result" || intent.intent === "compare") && teams.length >= 1) {
    for (const team of teams.slice(0, 2)) {
      const schedule = await loadSchedule({ season: seasonId, team: team.slug, limit: 10 });
      const finished = schedule.matches.filter((m) => m.status === "finished");
      if (!finished.length) continue;
      cards.push({
        kind: intent.intent === "match-result" ? "match-result" : "compare",
        title: team.name + " " + (schedule.season?.name ?? "") + " 赛果",
        lines: finished.slice(0, 6).map(matchLine),
      });
    }
  }

  if (intent.intent === "roster" && teams.length >= 1) {
    const first = teams[0];
    if (first) {
      const roster = await sql<{ nickname: string; position: string | null }[]>`
        SELECT nickname, position FROM players
        WHERE current_team_id = ${first.id} AND is_active
        ORDER BY position NULLS LAST, nickname`;
      if (roster.length) {
        cards.push({
          kind: "roster",
          title: first.name + " 现役阵容",
          lines: roster.map((p) => (p.position ? p.nickname + "（" + p.position + "）" : p.nickname)),
        });
      }
    }
  }
  return cards;
}

export async function retrieveMaterial(question: string, intent: UnderstandResult): Promise<QaMaterial> {
  const [cards, semantic, keyword] = await Promise.all([
    structuredCards(intent, await resolveEntities(intent.entities)).catch(() => [] as QaDataCard[]),
    semanticPassages(question).catch(() => [] as QaPassage[]),
    keywordPassages(intent.keywords).catch(() => [] as QaPassage[]),
  ]);
  const fused = new Map<string, QaPassage>();
  for (const p of [...semantic, ...keyword]) {
    const key = p.sourceType + ":" + p.refId + ":" + p.ord;
    const prev = fused.get(key);
    if (prev) prev.score += p.score;
    else fused.set(key, { ...p });
  }
  const passages = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, 10);
  return { dataCards: cards, passages };
}

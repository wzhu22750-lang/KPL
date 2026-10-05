// QA 流式编排（阶段 4.5）：SSE 事件序列 meta → delta → citation → done（异常时 error）。
// 限流用 qa_rate（0055 表结构按 day 分桶）→ 落地为每 IP 每日 20 次，超限返回 429；
// 缓存用 qa_queries：同一问题（规范化后 hash）24h 内直接回放缓存答案，不再调用模型。
// 说明：任务书写"每小时 20 次"，但 0055 的 qa_rate 表只有 day 粒度，按表结构如实实现为每日 20 次。
import { createHash } from "node:crypto";
import { beijingDate } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { assembleSources, generateAnswer } from "./answer.ts";
import { retrieveMaterial } from "./retrieval.ts";
import { understandQuestion } from "./understand.ts";

export const QA_DAILY_LIMIT = 20;

export type QaStreamEvent = {
  event: "meta" | "delta" | "citation" | "done" | "error";
  data: unknown;
  /** 有值时该事件以对应 HTTP 状态码开始整个响应（当前仅 error/429） */
  status?: number;
};

function ipHash(ip: string): string {
  return createHash("sha256").update(ip).digest("hex");
}

export function normalizedQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, " ");
}

/** 消费一次配额：返回是否仍被允许（第 21 次起拒绝）。 */
export async function consumeRateLimit(ip: string): Promise<boolean> {
  const day = beijingDate(new Date());
  const hash = ipHash(ip);
  const [row] = await sql<{ count: number }[]>`
    INSERT INTO qa_rate (day, ip_hash, count)
    VALUES (${day}, ${hash}, 1)
    ON CONFLICT (day, ip_hash) DO UPDATE SET count = qa_rate.count + 1
    RETURNING count`;
  return (row?.count ?? 0) <= QA_DAILY_LIMIT;
}

interface CachedQa {
  intent: unknown;
  dataCards: unknown;
  answerText: string;
  citations: number[];
}

/** 24h 内相同问题（规范化后 hash 命中）直接回放缓存答案。 */
export async function cachedQa(question: string): Promise<CachedQa | null> {
  const key = createHash("sha256").update(normalizedQuestion(question)).digest("hex");
  const [row] = await sql<{ intent: unknown; data_cards: unknown; answer_text: string; citations: number[] }[]>`
    SELECT intent, data_cards, answer_text, citations FROM qa_queries
    WHERE normalized_key = ${key} AND status = 'ok' AND created_at > now() - interval '24 hours'
    ORDER BY id DESC
    LIMIT 1`;
  if (!row) return null;
  return { intent: row.intent, dataCards: row.data_cards, answerText: row.answer_text, citations: row.citations };
}

/** 完整问答管线：意图理解 → 三通道检索 → 生成+护栏，产出 SSE 事件序列。 */
export async function qaStreamEvents(question: string, ip: string): Promise<QaStreamEvent[]> {
  const trimmed = question.trim().slice(0, 500);
  if (!trimmed) {
    return [{ event: "error", status: 400, data: { code: "empty_question", message: "请输入问题" } }];
  }

  const allowed = await consumeRateLimit(ip);
  if (!allowed) {
    return [{ event: "error", status: 429, data: { code: "rate_limited", message: "今日提问次数已达上限，请明天再来。" } }];
  }

  const cached = await cachedQa(trimmed);
  if (cached) {
    return [
      { event: "meta", data: { intent: cached.intent, dataCards: cached.dataCards, cached: true } },
      { event: "delta", data: { text: cached.answerText } },
      { event: "citation", data: { citations: cached.citations } },
      { event: "done", data: { status: "ok", cached: true } },
    ];
  }

  const started = Date.now();
  const intentResult = await understandQuestion(trimmed);
  const material = await retrieveMaterial(trimmed, intentResult);
  const answer = await generateAnswer(trimmed, material, intentResult.intent);

  const events: QaStreamEvent[] = [
    {
      event: "meta",
      data: {
        intent: intentResult.intent,
        entities: intentResult.entities,
        season: intentResult.season,
        degraded: intentResult.degraded,
        dataCards: material.dataCards,
      },
    },
    { event: "delta", data: { text: answer.answer } },
    {
      event: "citation",
      data: { citations: answer.citations, sources: assembleSources(material).blocks.map((b) => b.label) },
    },
    { event: "done", data: { status: answer.degraded ? "degraded" : "ok" } },
  ];

  // 只缓存通过护栏的完整回答；降级结果不进缓存（资料更新后应能重试出更好的答案）
  if (!answer.degraded) {
    await sql`
      INSERT INTO qa_queries (question, normalized_key, intent, entities, answer_text, citations, data_cards,
                              model, prompt_version, receipt_ids, status, duration_ms, client_ip_hash)
      VALUES (${trimmed}, ${createHash("sha256").update(normalizedQuestion(trimmed)).digest("hex")},
              ${sql.json({ intent: intentResult.intent, entities: intentResult.entities, season: intentResult.season } as never)},
              ${sql.json(intentResult.entities as never)},
              ${answer.answer}, ${sql.json(answer.citations as never)}, ${sql.json(material.dataCards as never)},
              ${answer.model ?? ""}, ${"kpl-answer-v1"}, ${answer.receiptId != null ? [answer.receiptId] : []},
              ${"ok"}, ${Date.now() - started}, ${ipHash(ip)})`;
  }
  return events;
}

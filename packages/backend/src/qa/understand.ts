// QA 意图理解（阶段 4.2）：把用户问题解析为结构化检索意图。
// 模型关闭、网络失败或输出不可解析时一律降级为「开放问答」，绝不向调用方抛异常——
// 检索与生成链路总能拿到一个可用的意图对象。
import { createHash } from "node:crypto";
import { z } from "zod";
import { modelFor } from "../editorial/models.ts";
import { promptText } from "../editorial/prompts.ts";
import { chatJson } from "../providers/llm.ts";

export const UnderstandSchema = z.object({
  intent: z.enum(["match-result", "compare", "h2h", "roster", "open"]),
  entities: z
    .array(z.object({ kind: z.enum(["team", "player", "hero"]), name: z.string().min(1).max(40) }))
    .max(8)
    .catch([]),
  season: z.string().max(40).nullable().catch(null),
  keywords: z.array(z.string().min(1).max(30)).max(8).catch([]),
});

export type UnderstandResult = z.infer<typeof UnderstandSchema> & {
  receiptId: number | null;
  /** true = 模型不可用或输出不可解析，走了降级路径 */
  degraded: boolean;
};

/** 兜底意图：开放问答 + 原问句截断作关键词，保证三通道仍有可检索的输入。 */
export function fallbackUnderstand(question: string): UnderstandResult {
  return {
    intent: "open",
    entities: [],
    season: null,
    keywords: [question.trim().replace(/\s+/g, " ").slice(0, 30)].filter(Boolean),
    receiptId: null,
    degraded: true,
  };
}

export async function understandQuestion(question: string): Promise<UnderstandResult> {
  const trimmed = question.trim();
  if (!trimmed) return fallbackUnderstand(trimmed);
  try {
    const model = await modelFor("qaUnderstand");
    const res = await chatJson({
      model,
      purpose: "qa_understand",
      subject: `qa:${createHash("sha256").update(trimmed).digest("hex").slice(0, 16)}`,
      promptVersion: "kpl-understand-v1",
      system: promptText("kpl-understand"),
      user: trimmed.slice(0, 500),
      schema: UnderstandSchema,
      temperature: 0.1,
      maxTokens: 800,
    });
    return { ...res.data, receiptId: res.receiptId, degraded: false };
  } catch (error) {
    // 降级要留痕：QA 链路在运营侧需要知道为什么没走模型
    console.error("qa understand degraded:", error instanceof Error ? error.message : String(error).slice(0, 300));
    return fallbackUnderstand(trimmed);
  }
}

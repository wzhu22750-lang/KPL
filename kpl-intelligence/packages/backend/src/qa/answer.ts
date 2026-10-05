// QA 回答生成 + 护栏（阶段 4.4）：
// 组装材料（数据卡片逐字 + 资料摘录）→ 调模型 → grounded 校验：
//   1) 回答中的每个数字/比分必须能在材料中逐字找到；找不到重试一次，再失败降级为「只输出数据卡片 + 抱歉文案」；
//   2) 有材料时必须给出引用（citations 非空），缺失同样触发重试；
//   3) 张冠李戴校验：用 IDENTITY_LEXICON 检查回答里的战队名组合是否都出现在材料里。
// 模型关闭/输出不可解析时直接走降级路径，不向调用方抛异常。
import { z } from "zod";
import { IDENTITY_LEXICON } from "@aihot/industry/taxonomy";
import { modelFor } from "../editorial/models.ts";
import { promptText } from "../editorial/prompts.ts";
import { chatJson } from "../providers/llm.ts";
import type { QaDataCard, QaPassage } from "./retrieval.ts";

export const AnswerSchema = z.object({
  answer: z.string().min(1).max(2000).catch(""),
  citations: z.array(z.number().int().min(1)).max(12).catch([]),
});

export interface QaAnswer {
  answer: string;
  citations: number[];
  /** true = grounded 校验重试后仍失败（或无材料/模型不可用），输出的是降级内容 */
  degraded: boolean;
  /** 降级原因："检索无结果" | "模型输出未通过一致性校验" */
  reason?: string;
  model: string | null;
  receiptId: number | null;
}

export interface QaMaterialInput {
  dataCards: QaDataCard[];
  passages: QaPassage[];
}

interface SourceBlock {
  label: string;
  text: string;
}

/** 材料编号化：数据卡片在前（逐字引用区），摘录在后。 */
export function assembleSources(material: QaMaterialInput): { blocks: SourceBlock[]; corpus: string } {
  const blocks: SourceBlock[] = [];
  for (const card of material.dataCards) {
    blocks.push({ label: "数据卡片：" + card.title, text: card.lines.join("\n") });
  }
  for (const p of material.passages) {
    blocks.push({ label: "资料摘录：" + p.title, text: p.content.slice(0, 400) });
  }
  const corpus = blocks.map((b) => b.label + "\n" + b.text).join("\n");
  return { blocks, corpus };
}

function buildUser(question: string, blocks: SourceBlock[], retryHint: string): string {
  const sections = blocks.map((b, i) => "[来源" + (i + 1) + "] " + b.label + "\n" + b.text).join("\n\n");
  return [
    "【用户问题】\n" + question,
    "【材料（来源编号已给出）】\n" + sections,
    retryHint,
  ].filter(Boolean).join("\n\n");
}

/** 回答里出现、但材料 corpus 里没有的数字（比分/整数），即为编造信号。 */
export function fabricatedNumbers(answer: string, corpus: string): string[] {
  // 排除 [来源N] 引用角标，避免将来源编号误判为事实数字
  const stripped = answer.replace(/\[来源\d+\]/g, "");
  const mentioned = stripped.match(/\d+/g) ?? [];
  const unique = [...new Set(mentioned)];
  return unique.filter((n) => !corpus.includes(n));
}

/** 判断是否为战术类问题（为什么/选/ban/克制/体系/阵容/打法等，或意图为 tactics） */
export function isTacticalQuestion(question: string, intent?: string): boolean {
  if (intent === "tactics") return true;
  return /为什么|选|ban|禁|克制|体系|阵容|打法|首抢|以选代ban|摇摆/i.test(question);
}

/** 张冠李戴校验：回答里命中的战队身份（IDENTITY_LEXICON）必须是材料里也命中的子集。
 *  "kpl" 联盟词条不参与（问题提"KPL"而材料没提是常态，不属于张冠李戴）。 */
export function misattributedTeams(answer: string, corpus: string): string[] {
  const hit = (text: string) => {
    const ids = new Set<string>();
    for (const entry of IDENTITY_LEXICON) {
      if (entry.id === "kpl") continue;
      if (entry.patterns.some((re) => re.test(text))) ids.add(entry.id);
    }
    return ids;
  };
  const materialIds = hit(corpus);
  const answerIds = hit(answer);
  return [...answerIds].filter((id) => !materialIds.has(id));
}

function degradedAnswer(material: QaMaterialInput, reason: string): QaAnswer {
  const lines = material.dataCards.flatMap((c) => c.lines);
  const answer = lines.length
    ? lines.join("；") + "\n\n抱歉，暂时无法根据已有资料生成可靠的文字回答（" + reason + "）。"
    : "抱歉，现有资料不足，暂时无法回答这个问题。";
  return { answer, citations: [], degraded: true, reason, model: null, receiptId: null };
}

export async function generateAnswer(question: string, material: QaMaterialInput, intent?: string): Promise<QaAnswer> {
  const { blocks, corpus } = assembleSources(material);
  if (!blocks.length) return degradedAnswer(material, "检索无结果");

  const tactical = isTacticalQuestion(question, intent);
  const promptName = tactical ? "kpl-answer-tactics" : "kpl-answer";
  const promptVer = tactical ? "kpl-answer-tactics-v1" : "kpl-answer-v1";

  let lastReceipt: number | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const model = await modelFor("qaAnswer");
      const hint = attempt === 0
        ? ""
        : "【重试提示】上一次回答包含材料中不存在的数字/事实或缺少来源引用。请严格只用材料中的信息重新回答，并给出 citations。";
      const res = await chatJson({
        model,
        purpose: "qa_answer",
        subject: "qa:" + attempt + ":" + question.slice(0, 40),
        promptVersion: promptVer,
        system: promptText(promptName),
        user: buildUser(question, blocks, hint),
        schema: AnswerSchema,
        temperature: 0.2,
        maxTokens: 1200,
      });
      lastReceipt = res.receiptId;
      const answerText = res.data.answer.trim();
      const citations = [...new Set(res.data.citations)].sort((a, b) => a - b);
      const badNumbers = fabricatedNumbers(answerText, corpus);
      const badTeams = misattributedTeams(answerText, corpus);
      const missingCitations = citations.length === 0;
      if (!answerText || badNumbers.length || badTeams.length || missingCitations) continue;
      return { answer: answerText, citations, degraded: false, model: res.model, receiptId: res.receiptId };
    } catch {
      // 模型关闭/网络失败/输出不可解析 → 落到降级
      break;
    }
  }
  const degraded = degradedAnswer(material, "模型输出未通过一致性校验");
  return { ...degraded, receiptId: lastReceipt };
}

// AI 问答页（阶段 4.5）：客户端 fetch POST /api/site/qa/stream，解析 SSE 事件流（meta→delta→citation→done）。
// 页面本身不查库（web 进程铁律：只许 HTTP 调 api），流式渲染回答、数据卡片与来源引用。
import { useState } from "react";
import type { Route } from "./+types/ask";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { name: "AI 问答" };

export function meta() {
  return pageMeta({
    title: "AI 问答：关于 KPL 的问题，用站内数据回答",
    description: "输入关于 KPL 战队、选手、赛果与历史交手的问题，AI 基于站内数据库与精选资料作答，并给出可查证的来源引用。",
    path: "/ask",
  });
}

interface QaDataCard {
  kind: string;
  title: string;
  lines: string[];
}

const EXAMPLES = ["成都AG超玩会和重庆狼队交手记录", "重庆狼队现在有哪些选手", "KPL 夏季赛总决赛比分"];

export default function AskPage() {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const [cards, setCards] = useState<QaDataCard[]>([]);
  const [citations, setCitations] = useState<number[]>([]);
  const [sources, setSources] = useState<string[]>([]);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    setAnswer("");
    setCards([]);
    setCitations([]);
    setSources([]);
    try {
      const res = await fetch("/api/site/qa/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      if (!res.body) throw new Error("empty body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawError = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const lines = block.split("\n");
          const eventLine = lines.find((l) => l.startsWith("event: "));
          const dataLine = lines.find((l) => l.startsWith("data: "));
          if (!eventLine) continue;
          const event = eventLine.slice(7).trim();
          let data: Record<string, unknown> = {};
          try {
            data = dataLine ? JSON.parse(dataLine.slice(6)) : {};
          } catch {
            continue;
          }
          if (event === "meta") {
            setCards(Array.isArray(data.dataCards) ? (data.dataCards as QaDataCard[]) : []);
          } else if (event === "delta") {
            setAnswer(String(data.text ?? ""));
          } else if (event === "citation") {
            setCitations(Array.isArray(data.citations) ? (data.citations as number[]) : []);
            setSources(Array.isArray(data.sources) ? (data.sources as string[]) : []);
          } else if (event === "error") {
            sawError = true;
            setBusy(false);
            setError(String(data.message ?? "请求失败，请稍后重试。"));
          } else if (event === "done") {
            setBusy(false);
          }
        }
      }
      if (!sawError) setBusy(false);
    } catch {
      setBusy(false);
      setError("网络异常，请稍后重试。");
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-6">
      <h1 className="text-[20px] font-semibold text-ink-1">AI 问答</h1>
      <p className="mt-1 text-[13px] text-ink-3">
        基于站内赛事数据库与精选资料回答，答案附来源引用；数字与比分逐字来自结构化查询。
      </p>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="例如：成都AG超玩会和重庆狼队交手记录怎么样？"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-[14px] text-ink-1 outline-none focus:border-accent"
          maxLength={200}
        />
        <button
          type="submit"
          disabled={busy || !question.trim()}
          className="shrink-0 rounded-lg bg-accent px-4 py-2 text-[14px] font-medium text-white disabled:opacity-50"
        >
          {busy ? "思考中…" : "提问"}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => {
              setQuestion(example);
              void ask(example);
            }}
            disabled={busy}
            className="rounded-full border border-line px-3 py-1 text-[12px] text-ink-3 hover:text-ink-1 disabled:opacity-50"
          >
            {example}
          </button>
        ))}
      </div>

      {error ? <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-700">{error}</div> : null}

      {cards.length > 0 ? (
        <div className="mt-5 space-y-2">
          {cards.map((card) => (
            <div key={card.title} className="rounded-xl border border-line bg-surface px-4 py-3">
              <div className="text-[12px] font-medium text-accent">{card.title}</div>
              <div className="mt-1 space-y-0.5">
                {card.lines.map((line, i) => (
                  <div key={i} className="text-[13.5px] text-ink-2">{line}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {answer ? (
        <div className="mt-5 rounded-xl border border-line bg-surface px-4 py-4">
          <div className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-ink-1">{answer}</div>
          {sources.length > 0 ? (
            <div className="mt-3 border-t border-line pt-2 text-[12px] text-ink-4">
              来源：
              {sources.map((source, i) => (
                <span key={i} className={citations.includes(i + 1) ? "mr-2 text-accent" : "mr-2"}>
                  [来源{i + 1}] {source}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <PhoneBar />
    </div>
  );
}

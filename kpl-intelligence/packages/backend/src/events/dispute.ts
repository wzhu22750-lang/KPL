// Dispute-topic classification (P3): after grouping, best-effort, one model call per story.
// Reads the story's facts and member reports, runs industry/prompts/dispute-extract.md, and
// writes stories.topic_kind / positions / dispute_status. A failure (or disabled model calls)
// leaves topic_kind at 'general' — grouping never depends on this.
//
// positions NULL = never classified; [] = classified as general; non-empty = dispute/fun
// positions. That distinction keeps a classified-general story from being re-run on every
// new article.
import { z} from "zod";
import { sql} from "../db.ts";
import { config} from "../config.ts";
import { chatJson} from "../providers/llm.ts";
import { completeReceipt} from "../providers/receipts.ts";
import { modelFor} from "../editorial/models.ts";
import { promptText, promptVersion} from "../editorial/prompts.ts";

export const DISPUTE_SYSTEM = promptText("dispute-extract");
export const DISPUTE_PROMPT_VERSION = promptVersion("dispute-extract");

export interface DisputePosition {
stance: string;
holders: string[];
evidence: string;
source: string;
}

export type DisputeStatus = "ongoing" | "responded" | "clarified" | "settled" | null;
export type TopicKind = "general" | "dispute" | "fun";

const DisputeSchema = z.object({
topic_kind: z.enum(["general", "dispute", "fun"]).catch("general"),
positions: z.array(z.object({
stance: z.string().max(80).catch(""),
holders: z.array(z.string()).max(5).catch([]),
evidence: z.string().max(300).catch(""),
source: z.string().max(80).catch(""),
})).max(4).catch([]),
dispute_status: z.enum(["ongoing", "responded", "clarified", "settled"]).nullable().catch(null),
summary: z.string().max(300).catch(""),
});

export interface DisputeRefreshResult {
status: "classified" | "skipped";
reason: string;
topicKind?: TopicKind;
}

/** Max member reports fed to the model; newest first. */
const MAX_REPORTS = 12;

function buildDisputeInput(
title: string,
facts: Array<{ title: string; claim_type: string | null; rumor_state: string | null}>,
reports: Array<{ title: string; summary: string | null; source_name: string; at: Date}>,
): string {
const lines = [`\n${title}`, ""];
lines.push("");
for (const f of facts.slice(0, 8)) {
lines.push(`- ${f.title}${f.claim_type? `（类型:${f.claim_type}）`: ""}${f.rumor_state? `（爆料状态:${f.rumor_state}）`: ""}`);
}
lines.push("", "");
for (const r of reports.slice(0, MAX_REPORTS)) {
lines.push(`- [${r.source_name} ${r.at.toISOString().slice(0, 10)}] ${r.title}${r.summary? `：${r.summary.slice(0, 160)}`: ""}`);
}
return lines.join("\n");
}

export async function refreshDisputeClassification(storyId: number): Promise<DisputeRefreshResult> {
if (!config.modelCallsEnabled) return { status: "skipped", reason: "model-calls-disabled"};
const [s] = await sql<{ id: number; title: string; topic_kind: string; positions: unknown; merged_into: number | null}[]>`
SELECT id, title, topic_kind, positions, merged_into FROM stories WHERE id = ${storyId}`;
if (!s || s.merged_into!== null) return { status: "skipped", reason: "not-found-or-merged"};
// Already classified (positions [] = general, non-empty = dispute/fun): don't re-run per article.
if (s.positions!== null) return { status: "skipped", reason: "already-classified"};
const facts = await sql<{ title: string; claim_type: string | null; rumor_state: string | null}[]>`
SELECT title, claim_type, rumor_state FROM facts WHERE story_id = ${storyId} ORDER BY id LIMIT 8`;
const reports = await sql<{ title: string; summary: string | null; source_name: string; at: Date}[]>`
SELECT DISTINCT ON (p.article_id) p.title, p.summary, s.name AS source_name, coalesce(p.published_at, p.discovered_at) AS at
FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
JOIN sources s ON s.id = p.source_id
WHERE f.story_id = ${storyId} AND fa.role IN ('primary', 'report') AND p.visibility = 'public'
ORDER BY p.article_id, coalesce(p.published_at, p.discovered_at) DESC`;
if (reports.length === 0) return { status: "skipped", reason: "no-reports"};
const model = await modelFor("dispute");
const res = await chatJson({
model,
purpose: "dispute_extract",
subject: `story:${storyId}`,
promptVersion: DISPUTE_PROMPT_VERSION,
system: DISPUTE_SYSTEM,
user: buildDisputeInput(s.title, facts, reports),
schema: DisputeSchema,
temperature: 0.2,
maxTokens: 2048,
timeoutMs: 120_000,
});
const d = res.data;
const topicKind = d.topic_kind as TopicKind;
const positions: DisputePosition[] = topicKind === "general"? []: d.positions
.filter((p) => p.stance.trim())
.map((p) => ({ stance: p.stance.trim(), holders: p.holders.map((h) => h.trim()).filter(Boolean).slice(0, 3), evidence: p.evidence.trim() || "暂无公开依据", source: p.source.trim()}));
const disputeStatus: DisputeStatus = topicKind === "dispute"? (d.dispute_status?? "ongoing"): null;
await sql.begin(async (tx) => {
await tx`UPDATE stories SET topic_kind = ${topicKind}, positions = ${tx.json(positions as never)},
dispute_status = ${disputeStatus} WHERE id = ${storyId} AND merged_into IS NULL`;
await completeReceipt(tx, res.receiptId);
});
return { status: "classified", reason: "ok", topicKind};
}

// 事实主源的 claim-aware 选举与 rumor 状态机在完整分组管道里的行为（§31 一手来源升级、§17 转会爆料）：
// 媒体先报转会 → unverified 且当不了主源；俱乐部官宣 → 主源升级 + official_confirmed + 时间线保留；
// 两个独立来源 → multiple_reports；官方辟谣 → official_denied。
// 归并用完全相同的标题+摘要（词法相似度 1.0 ≥ CONFIRM_BELOW_COSINE），不触发任何模型调用。
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { groupArticle } from "@aihot/backend/events/group";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const MEDIA = `test-media-${T}`;
const MEDIA2 = `test-media2-${T}`;
const CLUB_AG = `test-club-ag-${T}`;
const CLUB_ESTAR = `test-club-estar-${T}`;
const CLUB_TTG = `test-club-ttg-${T}`;

// 分组判定模型：只有候选与 query 携带同一隔离标记（扩展区汉字指纹）才答 SAME_OCCURRENCE，
// 否则 UNRELATED——不同测试用例之间互不归并，同一用例的成对报道稳定归并。
const MARKS = /([\u3400-\u4dbf]{8,})/gu;
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { messages: Array<{ content: string }> };
  const user = body.messages[1]!.content;
  if (user.includes("报道 A")) {
    const marks = [...user.matchAll(MARKS)].map((m) => m[1]!);
    const same = marks.length >= 2 && marks[0] === marks[1];
    const answer = { a: "转会", b: "转会", relation: same ? "SAME_OCCURRENCE" : "UNRELATED", difference: "", confidence: 0.95 };
    return { id: "stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
  }
  const queryMark = MARKS.test(user) ? ([...user.matchAll(MARKS)][0]?.[1] ?? "") : "";
  MARKS.lastIndex = 0;
  const ids = [...user.matchAll(/【候选 (C\d+)】/g)].map((m) => m[1]!);
  const answer = {
    query: "转会",
    decisions: ids.map((id) => {
      const c = user.indexOf(`【候选 ${id}】`);
      const next = user.indexOf("【候选", c + 1);
      const block = user.slice(c, next > 0 ? next : undefined);
      const cm = [...block.matchAll(MARKS)][0]?.[1];
      return { id, relation: cm && cm === queryMark ? "SAME_OCCURRENCE" : "UNRELATED", confidence: 0.95, note: "" };
    }),
    selection: { addsValue: true, reason: "fixture news" },
  };
  return { id: "stub", choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});
for (const name of ["DEEPSEEK", "XIAOMI_MIMO"]) {
  process.env[`${name}_BASE_URL`] = `${provider.url}/v1`;
  process.env[`${name}_API_KEY`] = "test-key";
}

// 隔离文本：扩展区汉字序列，每个字符只出现一次，不与任何其他报道共享字符对（counter 决定，确定性）。
let counter = 0;
const mark = () => {
  const chars: number[] = [];
  while (chars.length < 16) {
    const c = 0x3400 + ((counter++ * 17) % 0x19c0);
    if (chars.includes(c)) continue;
    chars.push(c);
  }
  return String.fromCharCode(...chars);
};

/** 一篇转会报道：title/summary 完全相同的两篇会被词法召回+配对判定并成同一事实（无需真实模型）。 */
async function report(source: string, suffix: string, title: string, opts: { mark?: string; team?: string } = {}) {
  const text = opts.mark ?? mark();
  const titled = `${title}${text}`;
  const { articleId } = await upsertMaterial({
    sourceId: source, url: `https://example.com/kpl-${T}-${source}-${suffix}`, title: `Roster news ${T} ${text}`,
    bodyText: `Transfer market note. ${text}`, bodyStatus: "ok", via: "fetch", publishedAt: new Date(),
  });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', 'pass', 'roster', ${titled}, ${titled}, 80, false,
                    ${sql.json({ scope: "single", fact: { title: titled, subject: "测试", action: "转会", object: "选手" } })})`;
  await sql`UPDATE articles SET claim_type = 'transfer' WHERE id = ${articleId}`;
  await sql`INSERT INTO entity_mentions (article_id, entity_type, entity_id) VALUES (${articleId}, 'team', ${opts.team ?? "ag"})`;
  await publishArticle(articleId);
  return articleId;
}

const factOf = async (articleId: string) => {
  const [row] = await sql<{ fact_id: number; role: string }[]>`SELECT fact_id, role FROM fact_articles WHERE article_id = ${articleId} ORDER BY (role = 'primary') DESC LIMIT 1`;
  return row;
};

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, owner_type, owner_entity_id, next_fetch_at)
            VALUES (${MEDIA}, '测试媒体', 'web_list', 'T2', 'editorial', 'media', NULL, '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, owner_type, owner_entity_id, next_fetch_at)
            VALUES (${MEDIA2}, '测试媒体二', 'web_list', 'T2', 'editorial', 'media', NULL, '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, owner_type, owner_entity_id, next_fetch_at)
            VALUES (${CLUB_AG}, 'AG官方公众号', 'mp_account', 'T1_5', 'editorial', 'club', 'ag', '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, owner_type, owner_entity_id, next_fetch_at)
            VALUES (${CLUB_ESTAR}, 'eStar官方公众号', 'mp_account', 'T1_5', 'editorial', 'club', 'estar', '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, owner_type, owner_entity_id, next_fetch_at)
            VALUES (${CLUB_TTG}, 'TTG官方公众号', 'mp_account', 'T1_5', 'editorial', 'club', 'ttg', '2100-01-01')`;
});
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("媒体报道转会：事实挂 transfer + unverified，媒体权威不足当不了主源", async () => {
  const id = await report(MEDIA, "rumor", `爆料：AG新援名单即将公布${T}`, { team: "ag" });
  const res = await groupArticle(id);
  assert.equal(res.verdict, "new-story");
  const [fact] = await sql<{ claim_type: string | null; rumor_state: string | null; primary_source_id: string | null }[]>`
    SELECT claim_type, rumor_state, primary_source_id FROM facts WHERE id = ${res.factId!}`;
  assert.equal(fact!.claim_type, "transfer");
  assert.equal(fact!.rumor_state, "unverified", "媒体爆料只能是未经证实");
  assert.equal(fact!.primary_source_id, null, "媒体在转会上权威不足，不当主源");
  assert.equal((await factOf(id))!.role, "report");
});

test("一天后俱乐部官宣：主源升级为俱乐部官方，rumor → official_confirmed，时间线保留", async () => {
  const shared = mark();
  const title = `曝estar阵容调整进入倒计时${T}`;
  const mediaId = await report(MEDIA2, "then-media", title, { mark: shared, team: "estar" });
  const res1 = await groupArticle(mediaId);
  assert.ok(res1.factId, "爆料先建/入一个事实");
  const clubId = await report(CLUB_ESTAR, "then-club", title, { mark: shared, team: "estar" });
  const res2 = await groupArticle(clubId);
  assert.equal(res2.verdict, "same-fact", "官宣并入爆料所在的事实");
  const [fact] = await sql<{ rumor_state: string | null; primary_source_id: string | null }[]>`
    SELECT rumor_state, primary_source_id FROM facts WHERE id = ${res2.factId!}`;
  assert.equal(fact!.rumor_state, "official_confirmed", "俱乐部官宣即确认");
  assert.equal(fact!.primary_source_id, CLUB_ESTAR, "主源升级为俱乐部官方");
  assert.equal((await factOf(clubId))!.role, "primary");
  assert.equal((await factOf(mediaId))!.role, "report", "原爆料保留为 report");
  const timeline = await sql<{ from_state: string | null; to_state: string }[]>`
    SELECT from_state, to_state FROM rumor_timeline WHERE fact_id = ${res2.factId!} ORDER BY id`;
  assert.ok(timeline.some((t) => t.to_state === "unverified"), "爆料状态先入时间线");
  assert.ok(timeline.some((t) => t.to_state === "official_confirmed"), "确认写入时间线：rumor → confirmed 的过程可追溯");
});

test("两个独立来源的转会爆料：multiple_reports，但绝不写成 confirmed", async () => {
  const shared = mark();
  const title = `网传wolves接触某自由选手${T}`;
  const first = await report(MEDIA, "multi-a", title, { mark: shared, team: "wolves" });
  const res1 = await groupArticle(first);
  const second = await report(MEDIA2, "multi-b", title, { mark: shared, team: "wolves" });
  const res2 = await groupArticle(second);
  const factId = res2.factId!;
  assert.equal(res2.verdict, "same-fact");
  const [fact] = await sql<{ rumor_state: string | null }[]>`SELECT rumor_state FROM facts WHERE id = ${factId}`;
  assert.equal(fact!.rumor_state, "multiple_reports", "两个独立原始来源 = multiple_reports");
  assert.notEqual(fact!.rumor_state, "official_confirmed");
  assert.notEqual(fact!.rumor_state, "official_denied");
  assert.ok(res1.factId);
});

test("官方辟谣把状态推到 official_denied 并落 confirmed_at", async () => {
  const shared = mark();
  const title = `TTG挂牌传闻四起${T}`;
  const rumorId = await report(MEDIA, "deny-rumor", title, { mark: shared, team: "ttg" });
  const res1 = await groupArticle(rumorId);
  const denyId = await report(CLUB_TTG, "deny", `TTG官方辟谣：${title}消息不实`, { mark: shared, team: "ttg" });
  const res2 = await groupArticle(denyId);
  assert.equal(res2.verdict, "same-fact");
  const [fact] = await sql<{ rumor_state: string | null; confirmed_at: Date | null }[]>`SELECT rumor_state, confirmed_at FROM facts WHERE id = ${res1.factId!}`;
  assert.equal(fact!.rumor_state, "official_denied");
  assert.ok(fact!.confirmed_at, "denied 也算定案，confirmed_at 落值");
});

// Topic pages: which articles a topic takes, its chronicle and counts.
// Written before the code, from the ways it can go wrong:
// - a company topic takes an article about another company that only mentions it (several subjects,
//   its name nowhere in the title), or drops one about it whose title names it in English, in another
//   case, next to Chinese text, or only by a product (it is the article's only subject);
// - a Latin name matches inside another word ("Metadata" is not Meta); a headline naming a company
//   that is not a subject of the article gets in;
// - a technical-direction topic stops taking its tags;
// - the chronicle keeps a month's latest events instead of its most important ones, lists one event
//   twice across months, files 00:30 Beijing time on the 1st under the previous month, links an event
//   with a public story page to the article, or counts a withdrawn report's source;
// - a company's chronicle (its milestones) shows a tutorial, somebody else's commentary or another
//   organisation's research (even from an official source), drops the company's model/product launches,
//   or keeps more than three models, two products and one piece of its own news a month;
// - withdrawn or not yet released articles appear in a list, a count or the chronicle;
// - an article or story page names a topic its reports do not belong to;
// - a topic without content has no page, or an unknown slug or a page past the end has one.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { beijingDate } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { loadTopicPage, listTopicSummaries, topicsOfStory } from "@aihot/backend/publication/topics";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const OFFICIAL = `test-topics-official-${T}`;
const MEDIA = `test-topics-media-${T}`;
const OTHER = `test-topics-other-${T}`;
const AG_BLOG = `test-topics-ag-blog-${T}`;
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, next_fetch_at) VALUES
    (${OFFICIAL}, 'Official', 'rss', 'T1', 'editorial', true, '2100-01-01'),
    (${MEDIA}, 'Media', 'rss', 'T2', 'editorial', false, '2100-01-01'),
    (${OTHER}, 'Other media', 'rss', 'T2', 'editorial', false, '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, first_party, owner_entity_id, next_fetch_at) VALUES
    (${AG_BLOG}, 'AG blog', 'rss', 'T1', 'editorial', true, 'ag', '2100-01-01')`;
});
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
interface Report {
  source?: string;
  at: Date;
  title: string;
  originalTitle?: string;
  subjects?: string[];
  tags?: string[];
  score?: number;
  selected?: boolean;
  fact?: number;
  category?: string;
}

/** A published report; `fact` links it to a fact before publishing, as grouping would. */
async function report(r: Report): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: r.source ?? MEDIA, url: `https://example.com/topics-${T}-${n}`, title: r.originalTitle ?? r.title, bodyText: "body", bodyHtml: "<p>body</p>", bodyStatus: "ok", via: "fetch", publishedAt: r.at,
  });
  await sql`UPDATE articles SET discovered_at = ${r.at}, timeline_at = ${r.at}, grouped_at = now() WHERE id = ${articleId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, subjects, tags)
            VALUES (${articleId}, 1, 'rule', 'pass', ${r.category ?? "match-result"}, ${r.title}, ${`摘要 ${n}`}, ${r.score ?? 80}, ${r.selected ?? true}, ${r.subjects ?? []}, ${[r.category === "roster" ? "阵容转会" : r.category === "tactics" ? "战术复盘" : r.category === "opinion" ? "观点评论" : r.category === "league" ? "赛制公告" : "赛果战报", ...(r.tags ?? [])]})`;
  if (r.fact) await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${r.fact}, ${articleId}, 'report')`;
  await publishArticle(articleId, { releasedAt: new Date(r.at.getTime() + 60_000) });
  return articleId;
}

async function story(title: string): Promise<{ id: number; publicId: string }> {
  const publicId = randomUUID();
  const [s] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${title}, now(), now()) RETURNING id`;
  return { id: s!.id, publicId };
}

async function fact(storyId: number | null, title: string): Promise<number> {
  const [f] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}-${randomUUID()}`}, ${storyId}, ${title}) RETURNING id`;
  return f!.id;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);
const page = async (slug: string, p = 1) => {
  const data = await loadTopicPage(slug, p, new Date());
  assert.ok(data, `${slug} page ${p}`);
  return data;
};
/** Every article of a topic, over all its pages. */
async function members(slug: string): Promise<string[]> {
  const first = await page(slug);
  const out = ids(first.items);
  for (let p = 2; p <= first.pageCount; p++) out.push(...ids((await page(slug, p)).items));
  return out;
}

test("a company topic takes the articles about it, not the ones that only mention it", async () => {
  const about = await report({ at: hoursAgo(30), title: `成都AG超玩会 3 比 1 战胜对手 ${T}`, subjects: ["ag"] });
  const product = await report({ at: hoursAgo(31), title: `成都AG超玩会 官宣新选手加盟 ${T}`, category: "roster", subjects: ["ag"] });
  const english = await report({ at: hoursAgo(32), title: `赛果战报 ${T}`, originalTitle: `AG wins the match ${T}`, subjects: ["ag", "wolves"] });
  const subpoena = await report({ at: hoursAgo(33), title: `联盟对重庆狼队选手违规进行通报 ${T}`, category: "league", subjects: ["wolves", "ag", "estar"] });
  const lowerCase = await report({ at: hoursAgo(34), title: `wolves 公布新的首发大名单 ${T}`, category: "roster", subjects: ["wolves", "ag"] });
  const pact = await report({ at: hoursAgo(35), title: `KPL各大俱乐部联合签署公约 ${T}`, category: "league", subjects: ["wolves", "ag", "estar"] });
  const metadata = await report({ at: hoursAgo(36), title: `estar 战队新赛季主场落地武汉 ${T}`, category: "league", subjects: ["estar", "wolves"] });
  const adjacent = await report({ at: hoursAgo(37), title: `武汉eStarPro 战队赛果公布 ${T}`, subjects: ["estar", "wolves"] });
  const headline = await report({ at: hoursAgo(38), title: `成都AG超玩会 被一篇盘点提到 ${T}`, subjects: ["estar"] });
  const tactics = await report({ at: hoursAgo(39), title: `野区控龙战术分析 ${T}`, category: "tactics", tags: ["战术复盘"] });

  const ag = await members("ag");
  for (const id of [about, product, english]) assert.ok(ag.includes(id), "about AG");
  for (const id of [subpoena, lowerCase, pact, headline]) assert.ok(!ag.includes(id), "only mentions AG");
  const wolves = await members("wolves");
  for (const id of [subpoena, lowerCase]) assert.ok(wolves.includes(id), "about Wolves");
  for (const id of [english, pact]) assert.ok(!wolves.includes(id), "only mentions Wolves");
  const estar = await members("estar");
  assert.ok(estar.includes(adjacent), "eStar next to text");
  assert.ok((await members("tactics")).includes(tactics), "a genre direction takes its tag");

  // The article page names the topics it belongs to.
  const topicsOf = async (id: string) => {
    const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
    return (JSON.parse(res.body) as { topics: Array<{ slug: string }> }).topics.map((t) => t.slug);
  };
  assert.deepEqual(await topicsOf(about), ["ag", "results"]);
  assert.deepEqual(await topicsOf(subpoena), ["wolves"]);
  assert.deepEqual(await topicsOf(pact), []);
  assert.deepEqual(await topicsOf(tactics), ["tactics"]);
});

test("the chronicle keeps each month's most important events, once each, in Beijing months", async () => {
  // The 1st of last month, 00:30 in Beijing (16:30 UTC the day before).
  const today = beijingDate(Date.now());
  const [y, m] = today.split("-").map(Number) as [number, number];
  const lastMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const firstOfLastMonth = new Date(`${lastMonth}-01T00:30:00+08:00`);
  const at = (minutes: number) => new Date(firstOfLastMonth.getTime() + minutes * 60_000);

  const launch = await story(`总决赛赛果速递 ${T}`);
  const launchFact = await fact(launch.id, "总决赛决胜");
  const official = await report({ source: OFFICIAL, at: at(0), title: `重庆狼队 4 比 2 战胜对手夺冠 ${T}`, tags: ["赛果战报"], score: 95, fact: launchFact });
  await report({ source: OTHER, at: at(5), title: `媒体：重庆狼队总决赛夺冠赛后复盘 ${T}`, tags: ["赛果战报"], score: 70, fact: launchFact });
  const gone = await report({ source: MEDIA, at: at(6), title: `撤回的报道：总决赛赛果 ${T}`, tags: ["赛果战报"], score: 70, fact: launchFact });
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${gone}`;
  // A second development of the same story the same month.
  const followFact = await fact(launch.id, "赛后颁奖");
  await report({ at: at(600), title: `重庆狼队捧起银龙杯 ${T}`, tags: ["赛果战报"], score: 60, fact: followFact });
  const minor: string[] = [];
  for (let i = 0; i < 8; i++) minor.push(await report({ at: at(1000 + i * 60), title: `常规赛赛果 ${i} ${T}`, tags: ["赛果战报"], score: 85 - i, category: "match-result" }));

  const data = await page("results");
  const month = data.chronicle.find((c) => c.month === lastMonth);
  assert.ok(month, "the 1st at 00:30 Beijing time belongs to its own month");
  const listed = month.events.map((e) => e.id);
  assert.equal(month.events.length, 8, "eight events a month");
  assert.equal(listed.filter((id) => id === official).length, 1, "the story once, by its most important report");
  assert.ok(!listed.includes(minor[7]!), "the least important event drops out, though it is the latest");
  const lead = month.events.find((e) => e.id === official)!;
  assert.equal(lead.href, `/story/${launch.publicId}`, "an event with a public story links to it");
  assert.ok(month.events.find((e) => e.id === minor[0])!.href.startsWith("/items/"), "an event without a story links to the article");
  assert.deepEqual(listed, [...month.events].sort((a, b) => b.at.localeCompare(a.at)).map((e) => e.id), "newest first within a month");
  assert.equal(month.events.find((e) => e.id === minor[0])?.kind, "match", "a results genre keeps match results");
  assert.deepEqual(await topicsOfStory(launch.id), [{ slug: "results", name: "赛果与战报" }], "the story page names the topic of its reports");
});

test("a company's band prioritizes model and product launches over commentary and research", async () => {
  const today = beijingDate(Date.now());
  const [y, m] = today.split("-").map(Number) as [number, number];
  const lastMonth = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  const at = (day: number) => new Date(`${lastMonth}-${String(day).padStart(2, "0")}T12:00:00+08:00`);
  const ag = { subjects: ["ag"] };
  const match = await report({ ...ag, at: at(3), title: `成都AG超玩会 3 比 1 战胜对手 ${T}`, category: "match-result", score: 90 });
  const roster = await report({ ...ag, at: at(5), title: `成都AG超玩会 官宣新选手加盟 ${T}`, category: "roster", score: 85 });
  const news = await report({ ...ag, at: at(7), title: `成都AG超玩会 俱乐部新赛季计划 ${T}`, category: "league", score: 80 });
  const tactics = await report({ ...ag, source: AG_BLOG, at: at(9), title: `成都AG超玩会 战术复盘解析 ${T}`, category: "tactics", score: 95 });
  const tutorial = await report({ ...ag, source: AG_BLOG, at: at(11), title: `成都AG超玩会 选手上分指南 ${T}`, category: "tactics", tags: ["攻略教学"], score: 99 });
  const commentary = await report({ ...ag, at: at(13), title: `评论：成都AG超玩会的夺冠前景 ${T}`, category: "opinion", score: 98 });
  const others = await report({ ...ag, source: OFFICIAL, at: at(15), title: `媒体关于成都AG超玩会的专栏 ${T}`, category: "opinion", score: 97 });

  const data = await page("ag");
  assert.deepEqual(data.chronicle, [], "a company has its band instead of the monthly rail");
  const month = data.milestones.filter((ms) => ms.date.startsWith(lastMonth));
  const listed = month.map((ms) => ms.href);
  for (const id of [tutorial, commentary, others, tactics]) assert.ok(!listed.includes(`/items/${id}`), "no tutorials, nor commentary or tactics");
  assert.deepEqual([...listed].sort(), [match, roster, news].map((id) => `/items/${id}`).sort(), "matches, rosters and club news");
  assert.deepEqual(month.map((ms) => ms.kind), ["match", "roster", "club"], "oldest first, each with its kind");
  assert.deepEqual(month.map((ms) => ms.major), [false, false, false], "nothing picked up automatically is set in bold");
  assert.equal((await page("results")).milestones.length, 0, "a genre has its rail, not a band");
});

test("a cross-month event keeps its first date while all selected progress stays readable", async () => {
  const current = beijingDate(Date.now()).slice(0, 7);
  const after = new Date(new Date(`${current}-01T00:00:00+08:00`).getTime() - 3600_000);
  const representativeMonth = beijingDate(after).slice(0, 7);
  const before = new Date(new Date(`${representativeMonth}-01T00:00:00+08:00`).getTime() - 3600_000);
  const launch = await story(`重庆狼队转会官宣 ${T}`);
  const originalFact = await fact(launch.id, "选手签约");
  const followFact = await fact(launch.id, "后续报道");
  const independent = await story(`重庆狼队独立进展 ${T}`);
  const independentFact = await fact(independent.id, "另一场比赛");
  const common = { subjects: ["wolves"], category: "roster", tags: ["阵容转会"] };
  const earlier = await report({ ...common, at: before, title: `重庆狼队签约新选手 ${T}`, score: 80, fact: originalFact });
  const representative = await report({ ...common, at: after, title: `重庆狼队新选手详细报道 ${T}`, score: 95, fact: followFact });
  const other = await report({ ...common, at: after, title: `重庆狼队另一位选手续约 ${T}`, score: 80, fact: independentFact });

  for (const slug of ["wolves", "transfers"]) {
    const data = await page(slug);
    const entries = data.topic.group === "company"
      ? data.milestones.map((m) => ({ href: m.href, title: m.headline, month: m.date.slice(0, 7) }))
      : data.chronicle.flatMap((m) => m.events.map((e) => ({ href: e.href, title: e.title, month: m.month })));
    const kept = entries.filter((e) => e.href === `/story/${launch.publicId}`);
    assert.deepEqual(kept, [{ href: `/story/${launch.publicId}`, title: `重庆狼队新选手详细报道 ${T}`, month: beijingDate(before).slice(0, 7) }], `${slug}: one event, the earliest qualifying publication`);
    assert.ok(entries.some((e) => e.href === `/story/${independent.publicId}`), "a different event remains independent");
    const selected = await members(slug);
    for (const id of [earlier, representative, other]) assert.ok(selected.includes(id), "selected progress is not removed by chronicle deduplication");
  }
});

test("withdrawn articles stay out of lists, counts and the chronicle band", async () => {
  const kept = await report({ at: hoursAgo(5), title: `南通Hero久竞 3 比 0 击败对手 ${T}`, subjects: ["hero"] });
  const withdrawn = await report({ at: hoursAgo(4), title: `南通Hero久竞 撤回的战报 ${T}`, subjects: ["hero"] });
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${withdrawn}`;

  const data = await page("hero");
  assert.deepEqual(ids(data.items), [kept]);
  assert.equal(data.topic.total, 1);
  assert.deepEqual(data.milestones.map((m) => m.href), [`/items/${kept}`], "the chronicle band");
  const summary = (await listTopicSummaries()).topics.find((t) => t.slug === "hero")!;
  assert.equal(summary.latest?.title, `南通Hero久竞 3 比 0 击败对手 ${T}`, "the index shows the newest public article");
});

test("every topic has a page; unknown topics and pages past the end have none", async () => {
  const empty = await page("tcg");
  assert.equal(empty.topic.indexable, false, "a topic without content is not indexed");
  assert.deepEqual(empty.items, []);
  assert.equal(await loadTopicPage("not-a-topic", 1, new Date()), null);
  assert.equal(await loadTopicPage("tcg", 2, new Date()), null);
  const index = await app.inject({ method: "GET", url: "/api/site/topics" });
  const body = JSON.parse(index.body) as { groups: Array<{ key: string }>; topics: Array<{ slug: string }> };
  assert.deepEqual(body.groups.map((g) => g.key), ["company", "field", "genre"]);
  assert.equal(body.topics.length, 29);
});

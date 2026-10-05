// Topic milestones: the rules in publication/topic-chronicle.ts with the KPL pack's industry/chronicle.ts,
// on reports as the topic index reads them. Written from the ways it can go wrong:
// - kinds: a team's month is filled by one kind, so its matches crowd out roster moves, and club news
//   displaces both; a report about several teams (a roundup or the other side's win) shows as one team's own;
// - not a node: an announcement of what is coming, a pre-match prediction, a tutorial, a schedule
//   calendar or a viewing guide stays out however high its score, while a real result still gets in;
// - ownership: a match or signing belongs to the team named before the action verb (the winner signs,
//   the losing side does not own the report); club news is owned by subject or by a single entity tag;
// - one event: reports of one match within a week stay one milestone (earliest date, strongest headline);
// - curated history: a curated month suppresses the automatic milestone only through that month;
// - limits: the results timeline keeps no more of a busy month than any other topic (8), field topics 5;
// - highlights: a team's highlights lead with matches, then roster moves, then club news.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { findTopic, TOPICS } from "@aihot/backend/publication/topics";
import { selectTopicChronicle, selectTopicHighlights, type ChronicleReport } from "@aihot/backend/publication/topic-chronicle";

const NOW = new Date("2026-09-30T20:00:00+08:00");
const window = { now: NOW };
const ALL = TOPICS.map((t) => t.slug);
const topic = (slug: string) => {
  const t = findTopic(slug);
  assert.ok(t, slug);
  return t;
};

let n = 0;
/** A selected report, on 10 September unless `day` says otherwise. */
function report(title: string, o: Partial<ChronicleReport> & { day?: number } = {}): ChronicleReport {
  n += 1;
  const at = new Date(`2026-09-${String(o.day ?? 10).padStart(2, "0")}T12:00:00+08:00`);
  return {
    id: `r${n}`, title, originalTitle: null, category: "match-result", tags: ["赛果战报"], score: 85, topicSlugs: ALL,
    timelineAt: at, publishedAt: at, factPublishedAt: null, firstParty: false, owner: null, factId: null, factSubject: null,
    factAction: null, factOccurredAt: null, storyPublicId: null, sourceCount: 1, scope: "single", ...o,
  };
}
const roster = (title: string, o: Partial<ChronicleReport> & { day?: number } = {}) => report(title, { category: "roster", tags: ["阵容转会"], ...o });
const club = (title: string, o: Partial<ChronicleReport> & { day?: number } = {}) => report(title, { category: "league", tags: ["赛制公告"], ...o });
const events = (slug: string, reports: ChronicleReport[]) => selectTopicChronicle(topic(slug), reports, window).flatMap((m) => m.events);
const titles = (slug: string, reports: ChronicleReport[]) => events(slug, reports).map((e) => e.title);

test("a team's month keeps five matches, two roster moves and one piece of club news, each by score", () => {
  const reports = [
    report("重庆狼队 3 比 1 战胜上海EDG.M", { score: 90 }), report("重庆狼队 3 比 2 险胜成都AG超玩会", { score: 85, day: 20 }),
    report("重庆狼队 2 比 0 击败苏州KSG", { score: 80 }), report("重庆狼队 1 比 3 不敌武汉eStarPro", { score: 75 }),
    report("重庆狼队 3 比 0 横扫西安WE", { score: 72 }), report("重庆狼队 3 比 1 战胜济南RW侠", { score: 70 }),
    roster("重庆狼队官宣新打野加入首发", { score: 85 }), roster("重庆狼队与中路选手完成续约", { score: 80 }), roster("重庆狼队青训营首批名单公布", { score: 76 }),
    club("KPL公布重庆狼队季后赛赛程安排", { score: 98, tags: ["赛制公告", "entity:wolves"] }),
    club("重庆狼队俱乐部公布新赛季主客场计划", { score: 84, tags: ["赛制公告", "entity:wolves"] }),
  ];
  const picked = events("wolves", reports);
  const of = (kind: string) => picked.filter((e) => e.kind === kind).map((e) => e.title).sort();
  assert.deepEqual(of("match"), ["重庆狼队 3 比 1 战胜上海EDG.M", "重庆狼队 3 比 2 险胜成都AG超玩会", "重庆狼队 2 比 0 击败苏州KSG", "重庆狼队 1 比 3 不敌武汉eStarPro", "重庆狼队 3 比 0 横扫西安WE"].sort());
  assert.deepEqual(of("roster"), ["重庆狼队官宣新打野加入首发", "重庆狼队与中路选手完成续约"].sort());
  assert.deepEqual(of("club"), ["KPL公布重庆狼队季后赛赛程安排"]);
  assert.deepEqual(picked.map((e) => e.at), [...picked].sort((a, b) => b.at.localeCompare(a.at)).map((e) => e.at), "newest first within the month");
});

test("what is not a node stays out, however high its score", () => {
  const out = [
    "重庆狼队将于下周迎战成都AG超玩会", "前瞻：重庆狼队对阵武汉eStarPro的胜率几何", "曝重庆狼队正在接触新打野",
    "重庆狼队今晚比赛观赛指南", "重庆狼队青训营怎么进", "重庆狼队上分出装教学", "KPL本季赛程日历一图看懂",
    "重庆狼队选手直播精彩集锦", "重庆狼队夺冠纪录片预告",
  ];
  const reports = out.map((title, i) => report(title, { score: 99, day: 1 + i }));
  assert.deepEqual(titles("wolves", reports), []);
  assert.deepEqual(titles("results", reports), [], "nor on the results timeline");
  const result = report("重庆狼队 3 比 1 战胜成都AG超玩会，登顶榜首", { score: 99, day: 25 });
  assert.deepEqual(titles("wolves", [...reports, result]), [result.title], "a real result may claim its rankings");
});

test("a match belongs to the winner named before the verb, or to the fact's subject", () => {
  const win = report("成都AG超玩会 3 比 1 战胜重庆狼队");
  assert.deepEqual(titles("ag", [win]), [win.title]);
  assert.deepEqual(titles("wolves", [win]), [], "the losing side does not own the report");
  const sweep = report("横扫！重庆狼队 3 比 0 击败西安WE", { day: 12 });
  assert.deepEqual(titles("wolves", [sweep]), [sweep.title], "the actor is the team named before the verb");
  const signing = roster("上海EDG.M 官宣新打野正式加入");
  assert.deepEqual(titles("edgm", [signing]), [signing.title]);
  assert.deepEqual(titles("ag", [signing]), []);
  const coaching = club("重庆狼队宣布教练组调整", { factSubject: "重庆狼队", tags: ["赛制公告", "entity:wolves"] });
  assert.deepEqual(events("wolves", [coaching]).map((e) => e.kind), ["club"]);
});

test("one match's reports within a week are one milestone: the earliest date, the strongest Chinese headline", () => {
  const reports = [
    report("赛后速报：狼队晋级", { day: 11, score: 77, sourceCount: 3, factId: 1 }),
    report("重庆狼队 3 比 1 战胜上海EDG.M", { day: 12, score: 99, factId: 1 }),
    report("重庆狼队晋级季后赛", { day: 13, score: 90, factId: 1 }),
    report("重庆狼队 3 比 1 战胜上海EDG.M 后发布夺冠海报", { day: 14, score: 80, factId: 1 }),
  ];
  const picked = events("wolves", reports);
  assert.equal(picked.length, 1);
  assert.equal(picked[0]!.title, "重庆狼队 3 比 1 战胜上海EDG.M", "the highest-scoring Chinese headline");
  assert.equal(picked[0]!.at.slice(0, 10), "2026-09-11");
  assert.equal(picked[0]!.kind, "match");
});

test("curated months cannot suppress an event's automatic milestone after the curated boundary", () => {
  const august = new Date("2026-08-20T12:00:00+08:00");
  const older = report("重庆狼队 3 比 0 战胜深圳DYG", { storyPublicId: "s-curated", score: 95, timelineAt: august, publishedAt: august });
  const newer = report("重庆狼队 3 比 2 战胜深圳DYG", { storyPublicId: "s-curated", score: 80 });
  const picked = selectTopicChronicle(topic("wolves"), [older, newer], { now: NOW, through: "2026-08" }).flatMap((m) => m.events);
  assert.deepEqual(picked.map((e) => [e.title, e.at.slice(0, 10)]), [[newer.title, "2026-09-10"]], "automatic selection starts after the curated month, before event deduplication");
});

test("a field topic's chronicle takes what names it: results and league affairs, not tutorials or other teams' matches", () => {
  const general = report("重庆狼队季后赛首轮 3 比 1 战胜上海EDG.M", { tags: ["赛果战报", "季后赛"] });
  const preview = report("季后赛前瞻：重庆狼队的晋级形势", { tags: ["赛果战报", "季后赛"] });
  const schedule = club("KPL 公布季后赛赛程与对阵", { tags: ["赛制公告", "季后赛"] });
  assert.deepEqual(new Set(titles("playoffs", [general, preview, schedule])), new Set([general.title, schedule.title]));
  assert.deepEqual(events("playoffs", [schedule]).map((e) => e.kind), ["league"]);
  const patches = [report("S40 版本射手英雄集体削弱，发育路生态重洗", { category: "patch", tags: ["版本更新", "版本环境"] })];
  assert.deepEqual(events("meta", patches).map((e) => e.kind), ["patch"]);
  assert.deepEqual(titles("meta", [general]), [], "a match is not a version node");
});

test("the results timeline keeps eight matches of a busy month, field topics five", () => {
  const matches = Array.from({ length: 9 }, (_, i) => report(`季后赛重庆狼队 3 比 ${i} 战胜对手T${i}`, { day: 1 + i, score: 90 - i, tags: ["赛果战报", "季后赛"] }));
  assert.equal(events("results", matches).length, 8);
  assert.equal(events("playoffs", matches).length, 5);
  assert.ok(!titles("results", matches).includes(matches[8]!.title), "the least important one drops out");
});

test("a team's highlights lead with its matches, then roster moves and club news", () => {
  const reports = [club("KPL公布重庆狼队季后赛赛程安排", { score: 99, tags: ["赛制公告", "entity:wolves"], day: 25 }), roster("重庆狼队官宣新打野加入首发", { score: 90, day: 26 }), report("重庆狼队 3 比 1 战胜上海EDG.M", { score: 80, day: 27 })];
  assert.deepEqual(selectTopicHighlights(topic("wolves"), reports, window).map((e) => e.kind), ["match", "roster", "club"]);
});

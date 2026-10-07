import assert from "node:assert/strict";
import test from "node:test";
import {
  areSameKplOccurrence,
  extractMatchFingerprint,
  extractTeamsFromText,
  normalizeKplTitle,
} from "@aihot/backend/lib/kpl-dedup";

test("KPL Dedup - 识别战队", () => {
  const teams1 = extractTeamsFromText("苏州KSG迎战济南RW侠");
  assert.deepEqual(teams1, ["ksg", "rw"]);

  const teams2 = extractTeamsFromText("成都AG超玩会 3:0 重庆狼队");
  assert.deepEqual(teams2, ["ag", "wolves"]);

  const teams3 = extractTeamsFromText("广州TTG vs 武汉eStarPro");
  assert.deepEqual(teams3, ["estar", "ttg"]);
});

test("KPL Dedup - 用户提出的关键用例：KSG 零封 RW侠 年总开门红", () => {
  const titleA = "苏州KSG在KPL年度总决赛零封济南RW侠，拿下年总开门红";
  const titleB = "10月2日苏州KSG零封济南RW侠，拿下年度总决赛开门红";
  const titleC = "【2026KPL年度总决赛】10月2日 KSG VS 济南RW侠";

  const at = new Date("2026-10-02T12:00:00+08:00");
  const isSameAB = areSameKplOccurrence(titleA, titleB, at, at);
  assert.equal(isSameAB, true, "titleA 与 titleB 必须被判定为相同事件 (SAME_OCCURRENCE)");

  const isSameAC = areSameKplOccurrence(titleA, titleC, at, at);
  assert.equal(isSameAC, true, "titleA 与 titleC 必须被判定为相同比赛对决");

  const isSameBC = areSameKplOccurrence(titleB, titleC, at, at);
  assert.equal(isSameBC, true, "titleB 与 titleC 必须被判定为相同比赛对决");
});

test("different opponents cannot merge through title similarity (October 7 regression)", () => {
  assert.equal(areSameKplOccurrence(
    "2026KPL年度总决赛：10月3日北京JDG对阵上海EDG.M",
    "2026KPL年度总决赛10月7日北京WB对阵上海EDG.M",
    new Date("2026-10-03T10:16:43Z"), new Date("2026-10-07T09:35:57Z"),
  ), false);
});

test("same teams and season do not identify a rematch, nor do matching outcomes", () => {
  for (const suffix of ["年度总决赛", "零封取得开门红", ""]) {
    assert.equal(areSameKplOccurrence(`10月3日KSG对阵RW侠${suffix}`, `10月7日KSG对阵RW侠${suffix}`, new Date("2026-10-03"), new Date("2026-10-07")), false);
  }
  assert.equal(areSameKplOccurrence("KSG对阵RW侠年度总决赛", "KSG对阵RW侠年度总决赛"), false, "unknown dates are not proof of identity");
});

test("conflicting seasons and individual games are separate occurrences", () => {
  const at = new Date("2026-10-07");
  assert.equal(areSameKplOccurrence("KSG对阵RW侠春季赛", "KSG对阵RW侠夏季赛", at, at), false);
  assert.equal(areSameKplOccurrence("KSG对阵RW侠第二局", "KSG对阵RW侠第三局", at, at), false);
  assert.equal(areSameKplOccurrence("KSG对阵RW侠第二局", "KSG 3:1战胜RW侠", at, at), false);
});

test("partial teams and multi-match roundups cannot force identity", () => {
  const at = new Date("2026-10-07");
  assert.equal(areSameKplOccurrence("KSG今日首发阵容公布", "KSG今日首发阵容公布", at, at), false);
  assert.equal(areSameKplOccurrence("KSG RW侠 AG三队战报", "KSG RW侠 AG三队战报", at, at), false);
  assert.deepEqual(extractTeamsFromText("West vs TES.A，news test"), ["tes"]);
});

test("match dates keep explicit dates, validate them and use Beijing rather than host timezone", () => {
  assert.equal(extractMatchFingerprint("KSG vs RW侠", new Date("2026-10-06T17:00:00Z"))?.dateKey, "20261007");
  assert.equal(extractMatchFingerprint("2026-10-03 KSG vs RW侠", new Date("2026-10-07"))?.dateKey, "20261003");
  assert.equal(extractMatchFingerprint("2026年2月30日 KSG vs RW侠")?.dateKey, undefined);
  assert.equal(areSameKplOccurrence("2026年10月3日 KSG vs RW侠", "2025年10月3日 KSG vs RW侠"), false);
});

test("KPL Dedup - 标题规范化与前缀噪点过滤", () => {
  const raw1 = "【2026KPL年度总决赛】10月2日 KSG VS 济南RW侠";
  const norm1 = normalizeKplTitle(raw1);
  assert.ok(!norm1.includes("2026kpl年度总决赛"));
  assert.ok(!norm1.includes("10月2日"));
  assert.ok(norm1.includes("ksg vs 济南rw侠") || norm1.includes("ksg") && norm1.includes("rw侠"));

  const raw2 = "KPL战报 | 苏州KSG晋级S组,时隔1357天再次闯入季后赛";
  const norm2 = normalizeKplTitle(raw2);
  assert.ok(!norm2.includes("kpl战报"));
  assert.ok(norm2.includes("苏州ksg晋级s组"));
});

test("KPL Dedup - 互斥/不同事件不应被误判为相同事件", () => {
  const titleA = "10月2日苏州KSG迎战济南RW侠，拿下年度总决赛开门红";
  const titleDifferentOpponent = "10月4日苏州KSG迎战深圳DYG";
  const titleDifferentMatch = "成都AG超玩会零封TES强势挺进S/A卡位赛!";

  assert.equal(areSameKplOccurrence(titleA, titleDifferentOpponent), false, "不同对手绝不能合并");
  assert.equal(areSameKplOccurrence(titleA, titleDifferentMatch), false, "完全不同战队赛果绝不能合并");
});

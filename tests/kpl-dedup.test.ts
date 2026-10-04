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

  const isSameAB = areSameKplOccurrence(titleA, titleB);
  assert.equal(isSameAB, true, "titleA 与 titleB 必须被判定为相同事件 (SAME_OCCURRENCE)");

  const isSameAC = areSameKplOccurrence(titleA, titleC);
  assert.equal(isSameAC, true, "titleA 与 titleC 必须被判定为相同比赛对决");

  const isSameBC = areSameKplOccurrence(titleB, titleC);
  assert.equal(isSameBC, true, "titleB 与 titleC 必须被判定为相同比赛对决");
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

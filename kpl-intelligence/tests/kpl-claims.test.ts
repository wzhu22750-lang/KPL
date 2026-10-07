// KPL claim 分类器与权威矩阵（sources/claims.ts + authority.ts）的纯单元测试：
// 不同事实类型上不同发布方的发言资格，以及转载/爆料的独立性标记。
import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyClaim, originEntityOf, RUMOR_CLAIMS } from "@aihot/backend/sources/claims";
import { authorityFor, canConfirm, CONFIRM_AUTHORITY } from "@aihot/backend/sources/authority";
import { nextRumorState } from "@aihot/backend/events/rumor";

const league = { kind: "rss", tier: "T1", first_party: true, owner_type: "league" as const };
const clubAg = { kind: "mp_account", tier: "T1_5", first_party: false, owner_type: "club" as const, owner_entity_id: "ag" };
const player = { kind: "x_search", tier: "T3", first_party: false, owner_type: "player" as const, owner_entity_id: "fly" };
const media = { kind: "web_list", tier: "T2", first_party: false, owner_type: "media" as const };
const community = { kind: "json_list", tier: "T2", first_party: false, owner_type: "community" as const };

test("classifyClaim 按最具体的语态识别事实类型", () => {
  assert.equal(classifyClaim({ title: "官方：李某某正式加盟成都AG超玩会" }).claimType, "transfer");
  assert.equal(classifyClaim({ title: "KPL联盟公布2026年度总决赛大名单" }).claimType, "roster");
  assert.equal(classifyClaim({ title: "重庆狼队3:1战胜成都AG超玩会" }).claimType, "match_result");
  assert.equal(classifyClaim({ title: "KPL官方宣布对某某俱乐部罚款通报批评" }).claimType, "discipline");
  assert.equal(classifyClaim({ title: "KPL公布季后赛赛程 时间调整公告" }).claimType, "schedule");
  assert.equal(classifyClaim({ title: "选手某某因伤病休赛三周" }).claimType, "injury");
  assert.equal(classifyClaim({ title: "某某宣布退役 告别赛场" }).claimType, "retirement");
  assert.equal(classifyClaim({ title: "今日首发名单公布" }).claimType, "starting_lineup");
  assert.equal(classifyClaim({ title: "KPL官方发布最新赛事规则调整" }).claimType, "rule_change");
  assert.equal(classifyClaim({ title: "A战队赛后BP复盘分析" }).claimType, "analysis");
  // category 兜底：正文没有触发词时行业分类说了算。
  assert.equal(classifyClaim({ title: "本周电竞圈观察", category: "match-result" }).claimType, "match_result");
  // 社区源的反应类内容归社区讨论；社区曝光的官方事实仍按事实类型走。
  assert.equal(classifyClaim({ title: "2026年度总决赛太精彩了", category: "opinion", community: true }).claimType, "community_discussion");
  assert.equal(classifyClaim({ title: "爆料：某选手或将加盟新东家", community: true }).claimType, "transfer");
  assert.equal(classifyClaim({ title: "2026年度总决赛太精彩了", category: "opinion" }).claimType, "analysis");
});

test("classifyClaim 标记爆料、辟谣与转载出处", () => {
  const rumor = classifyClaim({ title: "爆料：某选手或将加盟新东家" });
  assert.equal(rumor.claimType, "transfer");
  assert.ok(rumor.rumorMarkers.length >= 2, "爆料 + 或将 都要命中");

  const denied = classifyClaim({ title: "AG官方辟谣：转会传闻不实" });
  assert.ok(denied.denialMarkers.includes("辟谣"));

  const repost = classifyClaim({ title: "KPL公布大名单", excerpt: "来源：KPL王者荣耀职业联赛官方微博" });
  assert.equal(repost.originType, "repost");
  assert.equal(repost.originEntity, "KPL王者荣耀职业联赛官方微博");
  assert.equal(originEntityOf("据@狼队王者荣耀微博消息"), "狼队王者荣耀");
});

test("authorityFor：同一发布方在不同事实类型上的资格完全不同", () => {
  // 联盟：赛制/处罚/赛程最高，转会高但非唯一。
  assert.equal(authorityFor(league, "rule_change"), 100);
  assert.equal(authorityFor(league, "discipline"), 100);
  assert.equal(authorityFor(league, "schedule"), 100);
  assert.equal(authorityFor(league, "transfer"), 90);
  // 俱乐部：自己队的事是最高权威。
  assert.equal(authorityFor(clubAg, "transfer", ["ag"]), 100);
  assert.equal(authorityFor(clubAg, "roster", ["ag"]), 100);
  // 谈别人家的事压到媒体水平：AG官博谈狼队转会没有资格。
  assert.ok(authorityFor(clubAg, "transfer", ["wolves"]) <= 40);
  // 选手：自己的声明最高，对比赛结果几乎无资格。
  assert.equal(authorityFor(player, "statement", ["fly"]), 100);
  assert.ok(authorityFor(player, "match_result") <= 20);
  // 社区：舆情第一手，事实类声明几乎没有资格。
  assert.equal(authorityFor(community, "community_discussion"), 90);
  assert.equal(authorityFor(community, "match_result"), 20);
  assert.ok(authorityFor(community, "transfer") <= 10);
  // 官方结构化赛事数据是比赛事实的事实库。
  assert.equal(authorityFor({ ...league, kind: "esports_api" }, "match_result"), 100);
  assert.equal(authorityFor({ ...league, kind: "esports_api" }, "standings"), 100);
});

test("claim_types 声明范围外的类型一票无资格", () => {
  const narrowClub = { ...clubAg, claim_types: ["club_news", "roster"] };
  assert.ok(authorityFor(narrowClub, "roster", ["ag"]) > 0);
  assert.equal(authorityFor(narrowClub, "transfer", ["ag"]), 0);
});

test("canConfirm 的确认门槛把官宣与报道分开", () => {
  assert.ok(canConfirm(clubAg, "transfer", ["ag"]));
  assert.ok(!canConfirm(media, "transfer", ["ag"]), "媒体报道转会不能定案");
  assert.ok(!canConfirm(community, "transfer", ["ag"]));
});

test("nextRumorState：爆料只能到 multiple_reports，官宣才 confirmed，且绝不降级", () => {
  const base = { claimType: "transfer", mentionedEntityIds: ["ag"], title: "AG官宣新选手加盟", independentOriginOwners: 1 };
  // 媒体报道：unverified；两个独立原始来源：multiple_reports。
  assert.equal(nextRumorState({ ...base, source: media, current: null }), "unverified");
  assert.equal(nextRumorState({ ...base, source: media, current: null, independentOriginOwners: 2 }), "multiple_reports");
  // 官方确认。
  assert.equal(nextRumorState({ ...base, source: clubAg, current: "unverified" }), "official_confirmed");
  // 官方辟谣。
  assert.equal(nextRumorState({ ...base, source: clubAg, current: "unverified", title: "AG俱乐部辟谣：网传转会消息不实" }), "official_denied");
  // 确认后营销号继续炒作：不接受降级。
  assert.equal(nextRumorState({ ...base, source: media, current: "official_confirmed" }), null);
  // 非爆料类事实不进状态机。
  assert.equal(nextRumorState({ ...base, source: media, current: null, claimType: "match_result" }), null);
});

test("rumor 状态机覆盖全部用户定义的爆料类声明", () => {
  for (const c of ["transfer", "roster", "retirement", "injury", "starting_lineup", "player_news"]) {
    assert.ok(RUMOR_CLAIMS.includes(c as never), c);
  }
  assert.ok(CONFIRM_AUTHORITY >= 85);
});

// P3 scoring v2: the formula in editorial/scoring-v2.ts.
// Pure-function tests — no database, no model calls.
import assert from "node:assert/strict";
import test from "node:test";
import {
  HEAT_UNKNOWN_VALUE, REVIEW_SCORE_CAP, SCORE_FORMULA_VERSION,
  averageModelOutputs, clampScore, compareRanked, finalizeScore, heatScore, noiseResult, officialScore,
} from "@aihot/backend/editorial/scoring-v2";
import { pruneTextNoise } from "@aihot/backend/content/clean-noise";

test("scoring-v2 - formula version is v2", () => {
  assert.equal(SCORE_FORMULA_VERSION, "v2");
});

test("scoring-v2 - clamp boundaries: never below 0 or above 100", () => {
  // Maxed out: 70 + 10 + 20 − 0.
  const hi = finalizeScore({ base: 70, official: 10, heat: 20, noiseFlags: [], contentKind: "announcement" });
  assert.equal(hi.final, 100);
  assert.deepEqual([hi.components.base, hi.components.official, hi.components.heat, hi.components.noise], [70, 10, 20, 0]);
  // Over-claimed inputs still clamp.
  const over = finalizeScore({ base: 999, official: 99, heat: 99, noiseFlags: [], contentKind: "announcement" });
  assert.equal(over.final, 100);
  // Full noise deduction cannot go negative: 0 + 0 + 0 − 30.
  const lo = finalizeScore({ base: 0, official: 0, heat: 0, noiseFlags: ["betting", "promo_poster", "fan_war"], contentKind: "daily" });
  assert.equal(lo.final, 0);
  assert.ok(lo.components.noise <= 30);
  assert.equal(clampScore(-5), 0);
  assert.equal(clampScore(101), 100);
});

test("scoring-v2 - official: the source-authority rule table", () => {
  // T1 联盟/俱乐部一手公告 +8–10
  assert.equal(officialScore({ tier: "T1", ownerType: "league", role: "league_official" }), 10);
  assert.equal(officialScore({ tier: "T1", ownerType: "club", role: "club_official" }), 9);
  assert.equal(officialScore({ tier: "T1", ownerType: "player", role: "principal" }), 8);
  assert.equal(officialScore({ tier: "T1", ownerType: "league", role: "media" }), 8);
  // 官方采访/原创 +3–6
  assert.equal(officialScore({ tier: "T1_5", role: "principal" }), 6);
  assert.equal(officialScore({ tier: "T1_5", ownerType: "club", role: "club_official" }), 5);
  assert.equal(officialScore({ tier: "T1_5", role: "caster" }), 4);
  assert.equal(officialScore({ tier: "T1_5", role: "media" }), 4);
  assert.equal(officialScore({ tier: "T2", role: "media" }), 3);
  assert.equal(officialScore({ tier: "T2", role: "principal" }), 3);
  // 普通应援/重复海报/纯商务 +0–2
  assert.equal(officialScore({ tier: "T2", role: "community" }), 2);
  assert.equal(officialScore({ tier: "T2", ownerType: "community", role: "community" }), 2);
  assert.equal(officialScore({ tier: "T9", role: "community" }), 1);
  // 搬运不继承：转载的一手源稿也不加分
  assert.equal(officialScore({ tier: "T1", ownerType: "league", role: "league_official" }, true), 0);
  assert.equal(officialScore({ tier: "T2", role: "media" }, true), 0);
});

test("scoring-v2 - heat: unknown coverage degrades instead of scoring 0", () => {
  const r = finalizeScore({ base: 50, official: 5, heat: null, noiseFlags: [], contentKind: "announcement" });
  assert.equal(r.components.coverage, "unknown");
  assert.equal(r.components.heat, HEAT_UNKNOWN_VALUE);
  assert.ok(r.components.heat > 0, "缺失不当 0");
  assert.equal(r.final, 50 + 5 + HEAT_UNKNOWN_VALUE);
  const known = finalizeScore({ base: 50, official: 5, heat: 12, noiseFlags: [], contentKind: "announcement" });
  assert.equal(known.components.coverage, "ok");
});

test("scoring-v2 - heat: participant/growth/community bands are re-checkable", () => {
  assert.equal(heatScore({ participants: 0, newParticipants6h: 0, communities: 0 }), 0);
  assert.equal(heatScore({ participants: 1, newParticipants6h: 0, communities: 1 }), 1);
  assert.equal(heatScore({ participants: 3, newParticipants6h: 1, communities: 2 }), 4 + 3 + 2);
  assert.equal(heatScore({ participants: 8, newParticipants6h: 3, communities: 3 }), 20);
  assert.ok(heatScore({ participants: 99, newParticipants6h: 99, communities: 9 }) <= 20);
});

test("scoring-v2 - ranking: unknown heat sorts below equal scores with observed heat", () => {
  const a = { final: 70, coverage: "unknown" as const };
  const b = { final: 70, coverage: "ok" as const };
  const c = { final: 71, coverage: "unknown" as const };
  assert.ok(compareRanked(a, b) > 0, "同分时未知覆盖降级");
  assert.ok(compareRanked(b, a) < 0);
  assert.ok(compareRanked(c, b) < 0, "分数高仍在前");
  const ordered = [a, b, c].sort(compareRanked).map((x) => x.final + x.coverage);
  assert.deepEqual(ordered, ["71unknown", "70ok", "70unknown"]);
});

test("scoring-v2 - noise: flags map to deductions, capped at 30, with hard caps", () => {
  const r = noiseResult(["ad_tail", "lottery_hook"]);
  assert.equal(r.deduction, 11);
  assert.equal(r.hardCap, null);
  assert.equal(r.needsReview, false);
  assert.equal(r.blocked, false);
  const capped = noiseResult(["betting", "promo_poster", "fan_war", "title_bait"]);
  assert.equal(capped.deduction, 30, "扣分上限 30");
  assert.equal(capped.hardCap, 30, "title_bait/betting 硬上限 30");
  const f = finalizeScore({ base: 65, official: 10, heat: 20, noiseFlags: ["title_bait"], contentKind: "announcement" });
  assert.equal(f.final, 30);
  // Unknown flags are dropped, duplicates counted once.
  const u = noiseResult(["ad_tail", "ad_tail", "not_a_flag"]);
  assert.deepEqual(u.flags, ["ad_tail"]);
});

test("scoring-v2 - noise: no double penalty with clean-noise (scoring sees cleaned text)", () => {
  const noisy = [
    "成都AG超玩会 4:2 战胜重庆狼队，拿下总决赛冠军。",
    "",
    "**推荐阅读**",
    "",
    "评论区抽2位朋友赠送充值卡，来评论吧！",
    "",
    "觉得不错点个赞吧",
  ].join("\n\n");
  const cleaned = pruneTextNoise(noisy);
  assert.ok(cleaned.includes("拿下总决赛冠军"), "正文保留");
  assert.ok(!cleaned.includes("推荐阅读"), "尾部噪声已被净化");
  assert.ok(!cleaned.includes("抽2位朋友"), "抽奖引导已被净化");
  // The model scores the cleaned text, so tail-noise flags must not fire on it: the mapping
  // only deducts what is still visible after cleaning.
  const r = noiseResult([]);
  assert.equal(r.deduction, 0);
});

test("scoring-v2 - gates: review flags cap, block flags intercept", () => {
  const review = finalizeScore({ base: 65, official: 10, heat: 20, noiseFlags: ["severe_misinformation"], contentKind: "dispute" });
  assert.equal(review.components.needsReview, true);
  assert.ok(review.final <= REVIEW_SCORE_CAP, `待复核压分不发布（得 ${review.final}）`);
  const privacy = noiseResult(["privacy_violation"]);
  assert.equal(privacy.needsReview, true);
  const ooc = noiseResult(["out_of_context"]);
  assert.equal(ooc.needsReview, true);
  for (const flag of ["unrelated", "drainage", "abuse"]) {
    const blocked = finalizeScore({ base: 70, official: 10, heat: 20, noiseFlags: [flag], contentKind: "announcement" });
    assert.equal(blocked.components.blocked, true, flag);
    assert.equal(blocked.final, 0, `${flag} 直接拦截`);
  }
});

test("scoring-v2 - two calls: components are averaged/unioned before the formula", () => {
  const avg = averageModelOutputs([
    { contentKind: "announcement", base: 60, heatEvidence: "", noiseFlags: ["ad_tail"], reasons: "r1" },
    { contentKind: "announcement", base: 50, heatEvidence: "被引用 3 次", noiseFlags: ["lottery_hook"], reasons: "" },
  ]);
  assert.equal(avg.base, 55);
  assert.deepEqual([...avg.noiseFlags].sort(), ["ad_tail", "lottery_hook"]);
  assert.equal(avg.heatEvidence, "被引用 3 次");
  assert.equal(avg.reasons, "r1");
  assert.equal(avg.contentKind, "announcement");
});

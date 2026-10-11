import assert from "node:assert/strict";
import { test } from "node:test";
import { formatNumber, formatRate, rateWidth, matchDate } from "../app/lib/esports.ts";

test("esports number display preserves zero and rejects missing/nonfinite values", () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity]) assert.equal(formatNumber(value), "—");
  assert.equal(formatNumber(0), "0");
  assert.equal(formatNumber(-3), "-3");
  assert.equal(formatNumber(1605), "1,605");
  assert.equal(formatNumber(5.8, 2), "5.80");
});
test("independent rate scales preserve genuine zero and 100% without minimum bars", () => {
  assert.equal(formatRate(0, 20), "0.0%");
  assert.equal(formatRate(1, 20), "100.0%");
  assert.equal(rateWidth(0), 0);
  assert.equal(rateWidth(1), 100);
  assert.equal(rateWidth(0.521), 52.1);
  assert.equal(rateWidth(0.501), 50.1);
});
test("missing/zero samples and out-of-range rates do not fabricate percentages", () => {
  for (const value of [null, undefined, NaN, Infinity, -0.1, 1.1]) {
    assert.equal(formatRate(value), "—");
    assert.equal(rateWidth(value), 0);
  }
  for (const sample of [0, -1, NaN, Infinity]) assert.equal(formatRate(0.8, sample), "—");
  assert.equal(formatRate(0.8, 1), "80.0%"); // UI displays the sample next to this value.
});
test("match dates use the same Shanghai day across timezone boundaries", () => {
  assert.equal(matchDate("2026-01-01T18:00:00Z"), "2026/01/02");
  assert.equal(matchDate("2026-01-01T18:00:00Z", true), "2026/01/02 02:00");
  for (const value of [null, undefined, "", "invalid"]) assert.equal(matchDate(value), "时间待确认");
});

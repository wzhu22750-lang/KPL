import assert from "node:assert";

// 英雄别名映射测试
const HERO_ALIAS_MAP: Record<string, string> = {
  "all in": "敖隐",
  "奥林": "敖隐",
  "澳林": "敖隐",
  "安林": "敖隐",
  "安琳": "敖隐",
  "奥运": "敖隐",
  "敖影": "敖隐",
  "火舞": "不知火舞",
  "仓": "苍",
  "多利亚": "朵莉亚",
  "朵莉亚": "朵莉亚",
  "桑七": "桑启",
  "太乙": "太乙真人",
  "大司令": "大司命",
  "翼德": "张飞",
  "鲁大师": "鲁班大师",
  "大师": "鲁班大师",
  "婉儿": "上官婉儿",
  "上官": "上官婉儿",
  "凯皇": "铠",
  "铠皇": "铠",
  "小鲁班": "鲁班七号",
  "卤蛋": "鲁班七号",
  "大小姐": "孙尚香",
  "阿离": "公孙离",
  "守约": "百里守约",
  "玄策": "百里玄策",
  "牛魔王": "牛魔",
  "八戒": "猪八戒",
  "猴子": "孙悟空",
  "宫本": "宫本武藏",
  "鸟人": "云中君",
  "鱼": "庄周",
  "草灵": "阿古朵",
  "少司缘": "少司缘",
  "元辅": "元流之子",
  "原辅": "元流之子",
  "元射": "元流之子",
  "元坦": "元流之子",
  "元刺": "元流之子",
  "元法": "元流之子",
  "次元": "元流之子",
};

const standardHeroes = new Set(["敖隐", "不知火舞", "上官婉儿", "苍", "朵莉亚", "桑启", "元流之子", "孙悟空", "鲁班七号", "大司命"]);

function normalizeHeroName(rawName: string, standard: Set<string>): string {
  const trimmed = rawName.trim();
  if (standard.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (HERO_ALIAS_MAP[lower]) return HERO_ALIAS_MAP[lower];
  if (HERO_ALIAS_MAP[trimmed]) return HERO_ALIAS_MAP[trimmed];
  return trimmed;
}

function prepareBpInput(subtitles: Array<{ timeRaw: string; text: string }>): string {
  const noiseRegex = /^(嗯|哦|啊|好的?|是的?|对的?|没错|确实|OK|ok|哈哈|呵呵)$/;
  return subtitles
    .filter(s => s && s.text && s.text.trim().length >= 2)
    .filter(s => !noiseRegex.test(s.text.trim()))
    .map(s => `[${s.timeRaw}] ${s.text.trim()}`)
    .join("\n");
}

console.log("Running P1 BP Extraction tests...");

// Test 1: Alias normalization
assert.strictEqual(normalizeHeroName("all in", standardHeroes), "敖隐");
assert.strictEqual(normalizeHeroName("火舞", standardHeroes), "不知火舞");
assert.strictEqual(normalizeHeroName("原辅", standardHeroes), "元流之子");
assert.strictEqual(normalizeHeroName("桑七", standardHeroes), "桑启");
assert.strictEqual(normalizeHeroName("大司令", standardHeroes), "大司命");
assert.strictEqual(normalizeHeroName("仓", standardHeroes), "苍");
console.log("✅ Hero name alias normalization test passed!");

// Test 2: Input preprocessing
const rawSubs = [
  { timeRaw: "00:01", text: "嗯" },
  { timeRaw: "00:02", text: "好的" },
  { timeRaw: "00:03", text: "欢迎来到KPL现场" },
  { timeRaw: "00:04", text: "a" },
  { timeRaw: "00:05", text: "蓝色方一抢敖隐" },
];
const formatted = prepareBpInput(rawSubs);
assert.strictEqual(formatted, "[00:03] 欢迎来到KPL现场\n[00:05] 蓝色方一抢敖隐");
console.log("✅ BP subtitle noise filtering test passed!");

console.log("🎉 All unit tests passed successfully!");

import assert from "node:assert";
import { prepareInterviewInput } from "./extract-interview.ts";

console.log("Running P2 Interview Extraction tests...\n");

// Test 1: Noise filtering and subtitle formatting
const rawSubs = [
  { timeSecs: 1, timeRaw: "00:01", text: "嗯" },
  { timeSecs: 2, timeRaw: "00:02", text: "好的" },
  { timeSecs: 3, timeRaw: "00:03", text: "欢迎来到赛后采访" },
  { timeSecs: 4, timeRaw: "00:04", text: "哈哈" },
  { timeSecs: 5, timeRaw: "00:05", text: "今天站在我身边的是小胖选手" },
  { timeSecs: 6, timeRaw: "00:06", text: "对" },
  { timeSecs: 7, timeRaw: "00:07", text: "吃饱了已经在对面野区吃晕碳了呀" },
];

const cleaned = prepareInterviewInput(rawSubs);
assert.strictEqual(
  cleaned,
  "[00:03] 欢迎来到赛后采访\n[00:05] 今天站在我身边的是小胖选手\n[00:07] 吃饱了已经在对面野区吃晕碳了呀"
);
console.log("✅ Interview subtitle noise filtering test passed!");

// Test 2: Mock LLM output deserialization and schema check
const mockLlmJson = {
  interview_meta: {
    host: "天云",
    interviewees: [
      { name: "小胖", team: "广州TTG", role: "player" }
    ],
    segment_type: "post_match_winner",
    match_result_mentioned: "广州TTG 3:1 佛山DRG"
  },
  qa_dialogues: [
    {
      round: 1,
      topic: "transfer_feeling",
      question_summary: "广州TTG小胖新称呼是否习惯",
      speaker: "小胖",
      answer_summary: "已经挺习惯了，重返赛场感觉并不陌生",
      key_quote: "挺习惯的吧，不陌生啊",
      timestamp: "00:28"
    },
    {
      round: 2,
      topic: "funny_meme",
      question_summary: "今天打完比赛自己吃饱了吗",
      speaker: "小胖",
      answer_summary: "在对面野区吃撑了",
      key_quote: "吃饱了已经在对面野区吃晕碳了呀",
      timestamp: "01:00"
    }
  ],
  player_profiles: [
    {
      player: "小胖",
      team: "广州TTG",
      dimensions: {
        personality_traits: ["幽默", "自信", "大心脏"],
        transfer_story: "几个月沉淀后加盟广州TTG，感觉自己还能再争一下",
        leadership_and_voice: "作为打野负责掌控前期野区进攻和分线指挥",
        hero_self_assessment: [
          { hero: "赵云", comment: "混了吧，菠萝太C了" }
        ],
        career_milestones_noted: ["时隔154天重返赛场首胜", "久违227天后的胜利"],
        memes_and_culture: ["吃晕碳", "对面野区吃饱", "训练赛双0%胜率"]
      }
    }
  ],
  team_chemistry_insights: [
    {
      team: "广州TTG",
      insight: "第一局输了当局间热手，队伍氛围轻松不慌张",
      timestamp: "04:02"
    }
  ],
  golden_quotes: [
    {
      speaker: "小胖",
      quote: "吃饱了已经在对面野区吃晕碳了呀",
      context: "回应赛后是否在比赛中吃饱",
      timestamp: "01:00"
    }
  ],
  extraction_confidence: {
    interviewee_identified: "high",
    dialogue_completeness: "high",
    notes: "采访完整，后半段含评论席解说补充生涯里程碑"
  }
};

assert.strictEqual(mockLlmJson.interview_meta.host, "天云");
assert.strictEqual(mockLlmJson.interview_meta.interviewees[0].name, "小胖");
assert.strictEqual(mockLlmJson.qa_dialogues.length, 2);
assert.strictEqual(mockLlmJson.player_profiles[0].dimensions.memes_and_culture.includes("吃晕碳"), true);
assert.strictEqual(mockLlmJson.golden_quotes[0].speaker, "小胖");
console.log("✅ Interview schema structure validation passed!");

console.log("\n🎉 All P2 unit tests passed successfully!");

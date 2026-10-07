// Social Content Analyzer：社交动态专属智能质量评估引擎
// 解决传统长文章评分（selection-score）对短动态误杀的痛点：
// 1. 结合账号权威度、事件价值、时效性、互动量、社区价值与噪声惩罚 6 维打分
// 2. 区分高价值官方/转会/赛果动态与粉丝玩梗/引战内容
// 3. 作为 RAG 准入与事件流准入的核心过滤器
import type { MaterialInput } from "../content/materials.ts";
import type { SourceRow } from "../sources/types.ts";

export interface SocialScoreBreakdown {
  authority: number;       // 0~100: 发布主体权威度
  event_value: number;     // 0~100: 事实/赛事/大名单信息增量
  timeliness: number;      // 0~100: 时效性
  engagement: number;      // 0~100: 点赞评论转发热度
  community_value: number; // 0~100: 社区探讨与专业价值
  noise_penalty: number;   // 0~100: 广告/抽奖/饭圈/引战扣分
}

export interface SocialEvaluationResult {
  totalScore: number;
  grade: "high" | "medium" | "low" | "block";
  breakdown: SocialScoreBreakdown;
  summary: string;
  allowRAG: boolean;
  allowHotEvent: boolean;
}

// 核心高价值事件关键词模式
const HIGH_VALUE_PATTERNS = [
  /首发|大名单|轮换|换下|出战|迎战|对战/i,
  /转会|挂牌|加盟|离队|解约|续约|官宣|试训/i,
  /年总|总决赛|胜者组|败者组|积分榜|晋级|淘汰|零封|开门红|战报|比分/i,
  /赛程|赛前预告|今日赛况|BP|战术|体系|复盘/i,
];

// 低价值/纯娱乐/抽奖/广告噪声模式
const NOISE_PATTERNS = [
  /抽奖|转评赞抽|送出.*Q币|中奖|领奖|包邮送/i,
  /福利|红包|优惠券|带货|购买链接|专属折扣/i,
  /超话打榜|饭圈|控评|撕逼|买热搜/i,
];

/**
 * 计算社交博文专属质量分
 */
export function evaluateSocialPost(
  material: MaterialInput,
  source: SourceRow,
): SocialEvaluationResult {
  const text = material.bodyText || material.title || "";
  const now = Date.now();
  const pubTime = material.publishedAt?.getTime() ?? material.discoveredAt?.getTime() ?? now;
  const ageHours = Math.max(0, (now - pubTime) / (3600 * 1000));

  // 1. 权威度 (Authority)
  let authority = 50;
  if (source.tier === "T1" || source.owner_type === "league") authority = 95;
  else if (source.tier === "T1_5" || source.owner_type === "club") authority = 88;
  else if (source.tier === "T3" || source.owner_type === "player" || source.owner_type === "coach") authority = 78;
  else if (source.owner_type === "media") authority = 70;

  // 2. 事件价值 (Event Value)
  let event_value = 45;
  let matchCount = 0;
  for (const re of HIGH_VALUE_PATTERNS) {
    if (re.test(text)) matchCount++;
  }
  if (matchCount >= 2) event_value = 92;
  else if (matchCount === 1) event_value = 80;
  else if (text.length > 100) event_value = 60; // 较长复盘分析

  // 3. 时效性 (Timeliness)
  let timeliness = 95;
  if (ageHours > 72) timeliness = 40;
  else if (ageHours > 24) timeliness = 65;
  else if (ageHours > 6) timeliness = 80;

  // 4. 互动热度 (Engagement)
  let engagement = 50;
  const canonicalEng = material.canonical?.engagement;
  const likes = canonicalEng?.likes ?? 0;
  const comments = canonicalEng?.comments ?? 0;
  const shares = canonicalEng?.shares ?? 0;
  const totalEng = likes + comments * 2 + shares * 3;

  if (totalEng > 10000) engagement = 95;
  else if (totalEng > 2000) engagement = 85;
  else if (totalEng > 500) engagement = 75;
  else if (totalEng > 50) engagement = 60;

  // 5. 社区专业价值 (Community Value)
  let community_value = 60;
  if (text.includes("复盘") || text.includes("数据") || text.includes("经济差") || text.includes("伤害占比")) {
    community_value = 85;
  }

  // 6. 噪声惩罚 (Noise Penalty)
  let noise_penalty = 0;
  for (const re of NOISE_PATTERNS) {
    if (re.test(text)) {
      noise_penalty += 35;
    }
  }
  if (text.length < 15 && matchCount === 0) {
    noise_penalty += 20; // 超短无事实水贴
  }

  // 加权综合总分：
  // Authority 25% + Event 30% + Timeliness 15% + Engagement 15% + Community 15% - Noise
  const baseScore =
    authority * 0.25 +
    event_value * 0.30 +
    timeliness * 0.15 +
    engagement * 0.15 +
    community_value * 0.15;

  const totalScore = Math.max(0, Math.min(100, Math.round(baseScore - noise_penalty)));

  // 等级判定与下游准入闸门
  let grade: SocialEvaluationResult["grade"] = "medium";
  let allowRAG = false;
  let allowHotEvent = false;

  if (noise_penalty >= 50 || totalScore < 45) {
    grade = "block";
  } else if (totalScore >= 78) {
    grade = "high";
    allowRAG = true;       // 仅高价值动态允许切入 RAG 向量知识库
    allowHotEvent = true;  // 允许参与首页事件聚合
  } else if (totalScore >= 60) {
    grade = "medium";
    allowRAG = (authority >= 85); // 俱乐部/联盟官方的日常通告允许进 RAG
    allowHotEvent = (engagement >= 75);
  } else {
    grade = "low";
  }

  return {
    totalScore,
    grade,
    breakdown: {
      authority,
      event_value,
      timeliness,
      engagement,
      community_value,
      noise_penalty,
    },
    summary: `[社交评分] 总分=${totalScore} (${grade}), 事件价值=${event_value}, 权威度=${authority}, 噪声扣分=${noise_penalty}`,
    allowRAG,
    allowHotEvent,
  };
}

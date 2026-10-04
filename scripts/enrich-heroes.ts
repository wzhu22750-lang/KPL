// 英雄档案全维度富化：
// 1) 以 BP-For-HoK 的 S42 档案（industry/kpl-entities/heroes-meta.json，已转中文标签）为底座，
//    覆盖 positions / primary_pos / power_period / function_tags / version_strength / notes；
// 2) 当前版本梯度（T0–T3）以站方人工校准为准（本文件 OVERRIDES），其余按 1–10 强度映射；
// 3) 战术标签家族（呆射、战边/坦边、工具人中单/法刺等）按站方词表叠加。
// 幂等：重复运行结果一致。运行：node --env-file-if-exists=.env scripts/enrich-heroes.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";

const DIR = path.join(REPO_ROOT, "industry/kpl-entities");

// BP-For-HoK 的 22 类功能标签枚举（数字 → 中文）。
const BP_TAGS: Record<number, string> = {
  0: "爆发", 1: "消耗", 2: "点控", 3: "保护", 4: "突进", 5: "团控", 6: "带线", 7: "反野", 8: "视野", 9: "承伤",
  10: "核心", 11: "对线", 12: "拆火", 13: "转线", 14: "收割", 15: "强制位移", 16: "压制", 17: "护盾", 18: "真伤", 19: "阵地", 20: "回复", 21: "推进",
};

interface MetaEntry { positions: string[]; primary_pos: string; power_period: string; function_tags: number[]; version_strength: number | null; notes?: string }
type Meta = Record<string, MetaEntry>;

const meta = JSON.parse(readFileSync(path.join(DIR, "heroes-meta.json"), "utf8")) as Meta;

/** BP-For-HoK 未覆盖的新英雄与占位行：按官方 roles 手工补档。 */
const EXTRA_META: Record<string, MetaEntry> = {
  心魔六耳: { positions: ["对抗路", "打野"], primary_pos: "对抗路", power_period: "mid", function_tags: [4, 5, 9, 16], version_strength: 5, notes: "战士/坦克/刺客三定位的近战压制型英雄。" },
  卢雅那: { positions: ["游走", "发育路"], primary_pos: "游走", power_period: "mid,late", function_tags: [3, 1, 20], version_strength: 5, notes: "辅助/射手双定位的体系型英雄。" },
  王维: { positions: ["对抗路", "中路"], primary_pos: "对抗路", power_period: "early,mid", function_tags: [1, 5, 11], version_strength: 5, notes: "战士/法师双定位的边线压制型英雄。" },
};

const powerPeriodZh = (p: string | undefined): string => {
  const parts = (p ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const key = parts.join(",");
  const map: Record<string, string> = {
    "early": "前期", "early,mid": "中前期", "mid": "中前期", "mid,late": "中后期", "late": "大后期", "all": "全期平稳",
  };
  return map[key] ?? (parts.includes("all") ? "全期平稳" : parts.includes("late") ? "中后期" : "中前期");
};

const strengthToGrade = (v: number | null): string => (v === null ? "T2" : v >= 9 ? "T0.5" : v >= 7 ? "T1" : v >= 4 ? "T2" : "T3");

/**
 * 当前版本（2026 年度总决赛版本）的站方校准：BP-For-HoK 数据为 2026 年 4 月版本，
 * 代谢之后的热门梯度以人工校准为准；标签同时叠加站方战术词表。
 */
const OVERRIDES: Record<string, { positions?: string[]; tags?: string[]; strength?: string }> = {
  大乔: { positions: ["游走", "中路"], tags: ["体系核心", "电梯流", "全图调度", "团控", "视野"], strength: "T0" },
  鲁班大师: { tags: ["强力开团", "技能刷新", "功能辅助", "硬控前排"], strength: "T0" },
  朵莉亚: { tags: ["强力开团", "技能刷新", "功能辅助", "保护"], strength: "T0" },
  狂铁: { tags: ["对线霸线", "强开团", "承伤", "战边"], strength: "T0.5" },
  孙尚香: { tags: ["爆发射手", "后期大核", "太乙组合"], strength: "T0.5" },
  镜: { tags: ["突进刺客", "野核", "切后排"], strength: "T0.5" },
  澜: { tags: ["突进刺客", "野核", "切后排"], strength: "T0.5" },
  廉颇: { positions: ["对抗路", "游走"], tags: ["硬控前排", "强开团", "承伤", "坦边"] },
  露娜: { positions: ["打野", "对抗路"], tags: ["野核", "突进刺客", "带线"] },
};

/** 站方战术词表覆盖的经典标签家族（英雄 → 追加标签）。 */
const TAG_FAMILIES: Record<string, string[]> = {
  鲁班七号: ["呆射", "后期大核"], 狄仁杰: ["呆射"], 后羿: ["呆射", "后期大核"], 黄忠: ["呆射", "阵地"], 伽罗: ["呆射", "后期大核"],
  关羽: ["战边", "带线"], 马超: ["战边", "带线"], 夏侯惇: ["坦边", "硬控前排"], 蒙恬: ["坦边", "阵地"], 亚连: ["战边", "突进"],
  张良: ["工具人中单", "点控"], 西施: ["工具人中单", "强制位移"], 弈星: ["工具人中单", "阵地"], 不知火舞: ["法刺", "突进"], 上官婉儿: ["法刺", "突进"], 王昭君: ["工具人中单", "团控"],
  // BP-For-HoK 档案里这三个英雄的功能标签为空，按官方定位补齐。
  孙悟空: ["爆发", "突进", "收割", "战边"], 钟无艳: ["硬控前排", "坦边", "团控"], 雅典娜: ["突进", "带线", "视野"],
};

let updated = 0;
const rows = await sql<{ id: string; name: string }[]>`SELECT id, name FROM heroes`;
for (const row of rows) {
  const entry = meta[row.name] ?? EXTRA_META[row.name] ?? null;
  // id=0 的占位行（name 为空）没有档案可套：只给默认档位与说明，避免审计缺口。
  const positions = OVERRIDES[row.name]?.positions ?? entry?.positions ?? [];
  const primary = entry?.primary_pos ?? positions[0] ?? null;
  const bpTags = (entry?.function_tags ?? []).map((n) => BP_TAGS[n]).filter(Boolean);
  const tags = [...new Set([...bpTags, ...(OVERRIDES[row.name]?.tags ?? []), ...(TAG_FAMILIES[row.name] ?? [])])];
  const strength = OVERRIDES[row.name]?.strength ?? strengthToGrade(entry?.version_strength ?? null);
  const period = powerPeriodZh(entry?.power_period);
  const notes = entry?.notes ?? (row.name ? null : "占位数据（无对应英雄档案）。");
  await sql`
    UPDATE heroes SET
      positions = ${positions},
      primary_pos = ${primary},
      power_period = ${period},
      function_tags = ${tags},
      version_strength = ${strength},
      notes = ${notes},
      updated_at = now()
    WHERE id = ${row.id}`;
  updated += 1;
}

const [stats] = await sql<{ graded: number; t0: number; tagged: number }[]>`
  SELECT count(*) FILTER (WHERE version_strength IS NOT NULL)::int AS graded,
         count(*) FILTER (WHERE version_strength = 'T0')::int AS t0,
         count(*) FILTER (WHERE array_length(function_tags, 1) > 0)::int AS tagged
  FROM heroes`;
console.log(`heroes enriched: ${updated} rows — ${stats.graded} with version_strength (${stats.t0} T0), ${stats.tagged} with function_tags`);
await closeDb();

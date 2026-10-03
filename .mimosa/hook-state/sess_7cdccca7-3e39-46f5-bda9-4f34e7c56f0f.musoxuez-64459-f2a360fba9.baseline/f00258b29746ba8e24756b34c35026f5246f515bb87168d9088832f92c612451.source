// 一次性生成 KPL 种子数据：官方赛事数据的战队与赛季（prod.comp.smoba.qq.com，无鉴权）+ 官方英雄表
// （pvp.qq.com/web201605/js/herolist.json）。产物写进 industry/kpl-entities/，入库用 scripts/seed-kpl.ts。
// 选手名单不在本脚本：官方接口没有独立的 roster 端点，选手从比赛数据回灌（Phase 3，kb 回灌脚本）。
// 重跑安全：只重新生成 JSON，不碰数据库。运行：node scripts/fetch-kpl-seeds.ts
//
// 英雄的赛场分析字段（positions/主位置/功能标签/版本强度）官方没有：positions 由 hero_type 推导（粗略初值），
// 其余留空由后台人工或 AI 维护。字段体系参考了 BP-For-HoK 的设计（数据未复制，该项目无 LICENSE）。
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";

const OUT_DIR = path.join(REPO_ROOT, "industry/kpl-entities");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, origin: "https://pvp.qq.com", referer: "https://pvp.qq.com/" } as Record<string, string>;

/** 官方 team_id → 本站 slug（与 industry/taxonomy.ts 的 ENTITIES 一致）。历史队伍不在表里的用 "t{id}" 占位。 */
const SLUG_BY_OFFICIAL_ID: Record<string, string> = {
  "10001": "wolves", "10002": "edgm", "10003": "wb", "10005": "ksg", "10006": "estar",
  "10007": "hero", "10008": "dyg", "10009": "rngm", "10010": "we", "10016": "drg",
  "10017": "ttg", "10018": "rw", "10020": "jdg", "10027": "ag", "10028": "tes-a",
  "10031": "lgd-nbw", "10601": "tcg", "10903": "qingjiu",
};

/** hero_type → 官方定位与赛场位置的粗略推导。roles 字段的编码与 hero_type 不同（实测推得）。 */
const HERO_TYPE: Record<number, string> = { 1: "战士", 2: "法师", 3: "坦克", 4: "刺客", 5: "射手", 6: "辅助" };
const ROLE_CODE: Record<number, string> = { 1: "坦克", 2: "战士", 3: "法师", 4: "射手", 5: "辅助", 6: "刺客" };
const POSITION_OF_ROLE: Record<string, string> = { 战士: "对抗路", 法师: "中路", 射手: "发育路", 刺客: "打野", 辅助: "游走", 坦克: "对抗路" };

interface Camp { team_id: string; team_name: string; team_abbreviation?: string; team_icon?: string }
interface MatchRow { camp1: Camp; camp2: Camp }

async function getJson(url: string): Promise<unknown> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error("unreachable");
}

// ── 赛季与战队 ──────────────────────────────────────────────────────────────────────────

/** 近几个赛季的 league_id：YYYY0001=春季、YYYY0002=夏季。抓不到的赛季跳过。 */
const LEAGUE_IDS = ["20260001", "20260002", "20250001", "20250002", "20240001", "20240002", "20230001", "20230002"];

const teams = new Map<string, { id: string; name: string; short_name: string | null; external_id: string; logo_url: string | null; is_active: boolean }>();
const seasons: Array<{ id: string; name: string; year: number; split: string; external_id: string }> = [];

for (const leagueId of LEAGUE_IDS) {
  const data = (await getJson(`https://prod.comp.smoba.qq.com/leaguesite/matches/open?league_id=${leagueId}`)) as { results?: MatchRow[] } | null;
  if (!data?.results?.length) {
    console.log(`league ${leagueId}: no data, skipped`);
    continue;
  }
  const year = Number(leagueId.slice(0, 4));
  const seq = leagueId.slice(4);
  const split = seq === "0001" ? "spring" : seq === "0002" ? "summer" : "annual";
  seasons.push({
    id: `kpl-${year}-${split === "annual" ? "annual" : split}`,
    name: `${year}年KPL${split === "spring" ? "春季赛" : split === "summer" ? "夏季赛" : "年度赛事"}`,
    year, split, external_id: leagueId,
  });
  for (const row of data.results) {
    for (const camp of [row.camp1, row.camp2]) {
      if (!camp?.team_id || teams.has(camp.team_id)) continue;
      const slug = SLUG_BY_OFFICIAL_ID[camp.team_id] ?? `t${camp.team_id}`;
      teams.set(camp.team_id, {
        id: slug,
        name: camp.team_name,
        short_name: camp.team_abbreviation ?? null,
        external_id: camp.team_id,
        logo_url: camp.team_icon ?? null,
        is_active: leagueId.startsWith("2026"),
      });
    }
  }
  console.log(`league ${leagueId}: ${data.results.length} matches, teams so far ${teams.size}`);
  await new Promise((r) => setTimeout(r, 800));
}

// 2026 在赛队伍排前（sort_weight 按 2026 名单给 100，历史队伍 0）。
const teamList = [...teams.values()].map((t) => ({ ...t, sort_weight: t.is_active ? 100 : 0 }));

// ── 英雄 ────────────────────────────────────────────────────────────────────────────────

const heroList = (await getJson("https://pvp.qq.com/web201605/js/herolist.json")) as Array<{
  ename: number; cname: string; id_name: string; title?: string; hero_type: number; roles?: string;
}>;
const heroes = heroList.map((h) => {
  const roles = [...new Set((h.roles ?? "").split("|").filter(Boolean).map((r) => ROLE_CODE[Number(r)] ?? r)
    .concat(HERO_TYPE[h.hero_type] ? [HERO_TYPE[h.hero_type]] : []))];
  const positions = [...new Set(roles.map((r) => POSITION_OF_ROLE[r]).filter(Boolean))];
  return {
    id: String(h.ename),
    slug: h.id_name,
    name: h.cname,
    title: h.title ?? null,
    roles,
    positions,
    primary_pos: positions[0] ?? null,
    power_period: null,
    function_tags: [] as string[],
    version_strength: null,
    notes: null,
    portrait_url: `https://game.gtimg.cn/images/yxzj/img201606/heroimg/${h.ename}/${h.ename}.jpg`,
  };
});

// ── 落盘 ────────────────────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, "seasons.json"), `${JSON.stringify(seasons, null, 2)}\n`);
writeFileSync(path.join(OUT_DIR, "teams.json"), `${JSON.stringify(teamList, null, 2)}\n`);
writeFileSync(path.join(OUT_DIR, "heroes.json"), `${JSON.stringify(heroes, null, 2)}\n`);
console.log(`written: ${seasons.length} seasons, ${teamList.length} teams, ${heroes.length} heroes -> ${OUT_DIR}`);

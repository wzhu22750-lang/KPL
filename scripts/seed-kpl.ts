// 把 KPL 种子数据（industry/kpl-entities/ 的赛季、战队、英雄）导入数据库。
// 幂等：ON CONFLICT 只更新官方字段，人工在后台维护的 style_notes、别名等不会被覆盖；
// team_aliases 只增不删。运行：node --env-file-if-exists=.env scripts/seed-kpl.ts
// 数据来源：先跑 node scripts/fetch-kpl-seeds.ts 生成（或手工修订后）再执行本脚本。
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { ENTITIES } from "@aihot/industry/taxonomy";

const DIR = path.join(REPO_ROOT, "industry/kpl-entities");

interface SeasonSeed { id: string; name: string; year: number; split: string; external_id: string }
interface TeamSeed { id: string; name: string; short_name: string | null; external_id: string; logo_url: string | null; is_active: boolean; sort_weight: number }
interface HeroSeed {
  id: string; slug: string; name: string; title: string | null; roles: string[]; positions: string[];
  primary_pos: string | null; power_period: string | null; function_tags: string[];
  version_strength: number | null; notes: string | null; portrait_url: string;
}

const seasons = JSON.parse(readFileSync(path.join(DIR, "seasons.json"), "utf8")) as SeasonSeed[];
const teams = JSON.parse(readFileSync(path.join(DIR, "teams.json"), "utf8")) as TeamSeed[];
const heroes = JSON.parse(readFileSync(path.join(DIR, "heroes.json"), "utf8")) as HeroSeed[];

let seasonCount = 0;
for (const s of seasons) {
  const rows = await sql`
    INSERT INTO seasons (id, name, year, split, external_id)
    VALUES (${s.id}, ${s.name}, ${s.year}, ${s.split}, ${s.external_id})
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, external_id = EXCLUDED.external_id
    RETURNING (xmax = 0) AS inserted`;
  seasonCount += rows.length;
}

let teamCount = 0;
for (const t of teams) {
  const rows = await sql`
    INSERT INTO teams (id, slug, name, short_name, logo_url, external_id, is_active, sort_weight)
    VALUES (${t.id}, ${t.id}, ${t.name}, ${t.short_name}, ${t.logo_url}, ${t.external_id}, ${t.is_active}, ${t.sort_weight})
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, short_name = EXCLUDED.short_name, logo_url = EXCLUDED.logo_url,
      external_id = EXCLUDED.external_id, is_active = teams.is_active OR EXCLUDED.is_active,
      sort_weight = EXCLUDED.sort_weight, updated_at = now()
    RETURNING (xmax = 0) AS inserted`;
  teamCount += rows.length;
  // 官方全名与缩写也是别名；taxonomy 的口语别名一起入库（只增不删）。
  const aliases = new Set([t.name, ...(t.short_name ? [t.short_name] : []), ...Object.entries(ENTITIES)
    .filter(([id, e]) => id === t.id)
    .flatMap(([, e]) => [...e.aliases, ...(e.otherNames ?? [])])]);
  for (const alias of aliases) {
    const normalized = alias.toLowerCase().replace(/\s+/g, "");
    await sql`
      INSERT INTO team_aliases (team_id, alias, normalized, source)
      VALUES (${t.id}, ${alias}, ${normalized}, ${alias === t.name ? "official" : "taxonomy"})
      ON CONFLICT (team_id, alias) DO NOTHING`;
  }
}

let heroCount = 0;
for (const h of heroes) {
  const rows = await sql`
    INSERT INTO heroes (id, slug, name, title, roles, positions, primary_pos, power_period, function_tags, version_strength, notes, portrait_url)
    VALUES (${h.id}, ${h.slug}, ${h.name}, ${h.title}, ${h.roles}, ${h.positions}, ${h.primary_pos},
            ${h.power_period}, ${h.function_tags}, ${h.version_strength}, ${h.notes}, ${h.portrait_url})
    ON CONFLICT (id) DO UPDATE SET
      slug = EXCLUDED.slug, name = EXCLUDED.name, title = EXCLUDED.title, roles = EXCLUDED.roles,
      portrait_url = EXCLUDED.portrait_url,
      positions = COALESCE(heroes.positions, EXCLUDED.positions),
      updated_at = now()
    RETURNING (xmax = 0) AS inserted`;
  heroCount += rows.length;
}

console.log(`kpl seeds: ${seasonCount} seasons, ${teamCount} teams, ${heroCount} heroes written (${seasons.length}/${teams.length}/${heroes.length} in pack)`);
await closeDb();

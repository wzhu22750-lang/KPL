// KPL 数据资产审计：断言荣誉、选手档案、转会履历、英雄梯度与新闻实体关联的量化门槛。
// 退出码非 0 表示有门槛未过。运行：node --env-file-if-exists=.env scripts/audit-kpl-data.ts
import { closeDb, sql } from "@aihot/backend/db";

const GATES: Array<{ name: string; query: string; expect: (n: number) => boolean; label: string }> = [
  { name: "team_honors", query: "SELECT count(*)::int AS n FROM team_honors", expect: (n) => n >= 80, label: "≥ 80" },
  { name: "player_honors", query: "SELECT count(*)::int AS n FROM player_honors", expect: (n) => n >= 40, label: "≥ 40" },
  { name: "players with real_name+bio", query: "SELECT count(*)::int AS n FROM players WHERE real_name IS NOT NULL AND bio IS NOT NULL", expect: (n) => n >= 50, label: "≥ 50" },
  { name: "player_stints with left_at", query: "SELECT count(*)::int AS n FROM player_stints WHERE left_at IS NOT NULL", expect: (n) => n >= 100, label: "≥ 100" },
  { name: "heroes with version_strength", query: "SELECT count(*)::int AS n FROM heroes WHERE version_strength IS NOT NULL", expect: (n) => n === 134, label: "= 134" },
  { name: "entity_mentions", query: "SELECT count(*)::int AS n FROM entity_mentions", expect: (n) => n >= 300, label: "≥ 300" },
];

let failed = 0;
for (const gate of GATES) {
  const [row] = await sql.unsafe<{ n: number }[]>(gate.query);
  const n = Number(row?.n ?? 0);
  const ok = gate.expect(n);
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${gate.name} = ${n}（要求 ${gate.label}）`);
}
console.log(failed === 0 ? "all gates passed" : `${failed} gate(s) failed`);
await closeDb();
if (failed > 0) process.exitCode = 1;

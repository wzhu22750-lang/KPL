// KPL 信源覆盖率看板（§25/§26）：联盟覆盖、战队覆盖（活跃战队清单来自官方赛事数据）、
// first-party 事件率、社区入口健康、信源健康分布与发现队列告警。
import { SITE } from "@aihot/industry/site";
import type { Route } from "./+types/coverage";
import { adminGet } from "../../lib/admin.server";
import { AdminPage, Badge, Card, DataTable, Empty, Stat } from "../../features/admin/ui";

// 看板契约：与 /api/admin/coverage 的响应一致。前端只经 HTTP 读后端（apps/web 不 import 后端源码）。
interface CoverageReport {
  league: { platforms: string[]; sources: Array<{ id: string; name: string; health: string; enabled: boolean }>; covered: boolean };
  teamCoverage: {
    total: number; covered: number; partial: number; missing: number; coverage: number;
    teams: Array<{ id: string; name: string; platforms: string[]; sources: string[]; state: "covered" | "partial" | "missing" }>;
  };
  firstParty: { stories7d: number; withFirstParty: number; rate: number };
  community: Array<{ platform: string; sourceId: string; name: string; health: string; enabled: boolean }>;
  health: { ok: number; degraded: number; failing: number; stale: number; paused: number };
  warnings: Array<{ kind: "source-stale" | "discovery"; entity: string; detail: string }>;
  queue: { pending: number; byPlatform: Array<{ platform: string; pending: number }> };
}

export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<CoverageReport>(request, "/api/admin/coverage");
}

export const meta: Route.MetaFunction = () => [{ title: `信源覆盖率 · ${SITE.name} 后台` }];

const STATE_BADGE: Record<string, { label: string; tone: "ok" | "warn" | "bad" }> = {
  covered: { label: "已覆盖", tone: "ok" },
  partial: { label: "部分覆盖", tone: "warn" },
  missing: { label: "未覆盖", tone: "bad" },
};

const HEALTH_LABEL: Record<string, string> = { ok: "健康", degraded: "退化", failing: "失败", stale: "停滞", paused: "停用" };

export default function CoverageAdmin({ loaderData }: Route.ComponentProps) {
  const r = loaderData;
  const tc = r.teamCoverage;
  return (
    <AdminPage title="信源覆盖率" subtitle="KPL 官方、俱乐部、社区三类信源的覆盖与健康。战队清单由官方赛事数据动态发现（kb/discover.ts），不靠人工维护名单。">
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label="战队覆盖"
          value={`${tc.covered}/${tc.total}`}
          tone={tc.coverage >= 90 ? "ok" : tc.coverage >= 70 ? "warn" : "bad"}
          hint={`覆盖率 ${tc.coverage}% · 部分覆盖 ${tc.partial} · 未覆盖 ${tc.missing}`}
        />
        <Stat
          label="联盟覆盖"
          value={r.league.covered ? "完整" : "缺口"}
          tone={r.league.covered ? "ok" : "bad"}
          hint={`已验证平台：${r.league.platforms.join("、") || "无"} · 活跃官方源 ${r.league.sources.filter((s) => s.enabled).length} 个`}
        />
        <Stat
          label="First-party 事件率"
          value={`${r.firstParty.rate}%`}
          tone={r.firstParty.rate >= 50 ? "ok" : "warn"}
          hint={`近 7 天 ${r.firstParty.stories7d} 个事件中 ${r.firstParty.withFirstParty} 个有官方一手来源`}
        />
        <Stat
          label="社区入口"
          value={`${r.community.filter((c) => c.enabled).length} 个`}
          hint={r.community.map((c) => `${c.platform}${c.enabled ? "" : "（停用）"}`).join(" · ") || "未接入"}
        />
        <Stat
          label="发现队列"
          value={r.queue.pending}
          tone={r.queue.pending ? "warn" : "ok"}
          hint={r.queue.byPlatform.map((q) => `${q.platform} ${q.pending}`).join(" · ") || "无缺口"}
        />
      </div>

      <div className="mb-5 grid gap-5 xl:grid-cols-2">
        <Card title="战队官方信源覆盖" subtitle={`当前活跃战队 ${tc.total} 支（官方赛事数据动态发现）`} pad={false}>
          <DataTable
            dense
            rows={tc.teams}
            rowKey={(t) => t.id}
            empty="官方赛事数据还没有比赛记录，等 esports_api 同步后自动出现"
            columns={[
              { key: "name", label: "战队", render: (t) => <span className="font-medium">{t.name}</span> },
              { key: "id", label: "实体", render: (t) => <span className="font-mono text-[12px] text-ink-3">{t.id}</span> },
              { key: "platforms", label: "已验证平台", render: (t) => t.platforms.join("、") || "—" },
              { key: "sources", label: "信源", render: (t) => t.sources.join("、") || "—" },
              { key: "state", label: "状态", render: (t) => <Badge tone={STATE_BADGE[t.state]!.tone}>{STATE_BADGE[t.state]!.label}</Badge> },
            ]}
          />
        </Card>

        <div className="space-y-5">
          <Card title="信源健康分布" subtitle={`Healthy ${r.health.ok} · Degraded ${r.health.degraded} · Failing ${r.health.failing} · Stale ${r.health.stale} · Disabled ${r.health.paused}`} pad={false}>
            <DataTable
              dense
              rows={r.community}
              rowKey={(c) => c.sourceId}
              empty="尚未接入社区信源"
              columns={[
                { key: "platform", label: "平台", render: (c) => <span>{c.platform}</span> },
                { key: "name", label: "信源", render: (c) => <span>{c.name}</span> },
                { key: "health", label: "健康", render: (c) => <Badge tone={c.enabled ? (c.health === "ok" ? "ok" : c.health === "failing" || c.health === "stale" ? "bad" : "warn") : "muted"}>{c.enabled ? HEALTH_LABEL[c.health] ?? c.health : "停用"}</Badge> },
              ]}
            />
          </Card>

          <Card title="覆盖告警" subtitle="俱乐部官方源失联与账号缺口（§26 coverage warning）" pad={false}>
            {r.warnings.length === 0 ? (
              <Empty>没有告警</Empty>
            ) : (
              <ul className="divide-y divide-line text-[13px]">
                {r.warnings.map((w, i) => (
                  <li key={i} className="px-4 py-2.5">
                    <Badge tone={w.kind === "source-stale" ? "bad" : "warn"}>{w.kind === "source-stale" ? "信源失联" : "账号缺口"}</Badge>{" "}
                    <span className="ml-1 font-medium">{w.entity}</span>
                    <span className="ml-2 text-ink-3">{w.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </AdminPage>
  );
}

import { useLoaderData } from "react-router";
import type { Route } from "./+types/teams";
import type { TeamsResponse } from "@aihot/contracts/kpl";
import { apiGet, edgeTtl } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";
import { IconArrowUpRight, IconTrophy, IconUsers } from "../components/icons";
import { EmptyState } from "../components/ui/Page";

export const handle: Screen = { name: "战队" };

export async function loader({ request }: { request: Request }) {
  return apiGet<TeamsResponse>("/api/site/kb/teams", { signal: request.signal });
}

export function meta({}: Route.MetaArgs) {
  return pageMeta({ title: "战队一览", description: `KPL 全部战队：阵容、荣誉、战绩与最近比赛，数据来自官方赛事接口。`, path: "/teams" });
}

export function headers() {
  return edgeTtl(300);
}

export default function TeamsPage() {
  const { teams } = useLoaderData<typeof loader>();
  const active = teams.filter((t) => t.isActive);
  const past = teams.filter((t) => !t.isActive);
  return (
    <div className="pb-10">
      <PhoneBar title="战队" />
      <header className="border-b border-line pb-6 pt-3 lg:pt-1">
        <h1 data-page-title="" className="text-[28px] font-semibold leading-[1.3] tracking-tight text-ink">战队一览</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          现役 <span className="num">{active.length}</span> 支战队，来自官方赛事数据；点开看阵容、荣誉与最近比赛。
        </p>
      </header>
      <div className="mb-4 mt-6 flex items-center gap-2">
        <h2 className="text-[15px] font-semibold text-ink">现役战队</h2>
        <span className="num rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-ink">{active.length}</span>
      </div>
      {active.length === 0 && <EmptyState title="暂无现役战队数据">战队资料同步后将在这里展示。</EmptyState>}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
        {active.map((t) => (
          <li key={t.slug}>
            <IntentLink viewTransition to={`/teams/${t.slug}`} className="card card-hover group flex h-full flex-col p-4 sm:p-5">
              <span className="mb-5 flex items-start justify-between gap-2">
                <span className="flex size-16 shrink-0 items-center justify-center rounded-panel border border-line-soft bg-bg-sunk">
                  {t.logo ? <img src={t.logo} alt="" width={48} height={48} loading="lazy" className="size-12 object-contain" /> : <IconUsers size={28} className="text-ink-4" />}
                </span>
                <IconArrowUpRight size={16} className="mt-1 shrink-0 text-ink-4 transition-colors group-hover:text-accent" />
              </span>
              <span className="text-[15px] font-semibold leading-snug text-ink">{t.name}</span>
              <span className="mt-1 text-[12px] text-ink-4">{t.city || t.shortName || "KPL 战队"}</span>
              <span className="mt-auto pt-4">
                {t.champions > 0 ? (
                  <span className="inline-flex items-center gap-1.5 rounded-mark bg-amber-soft px-2 py-1 text-[11px] font-medium text-amber-ink"><IconTrophy size={13} /><span className="num">{t.champions} 次冠军</span></span>
                ) : (
                  <span className="text-[11px] text-ink-4">阵容与赛事资料</span>
                )}
              </span>
            </IntentLink>
          </li>
        ))}
      </ul>
      {past.length > 0 && (
        <section className="pt-8">
          <h2 className="text-[15px] font-bold text-ink">历史战队</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {past.map((t) => (
              <li key={t.slug}>
                <IntentLink to={`/teams/${t.slug}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink-3 transition-colors hover:border-accent hover:text-accent">
                  {t.name}
                </IntentLink>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

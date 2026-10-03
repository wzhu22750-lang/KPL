import { useLoaderData } from "react-router";
import { SITE } from "@aihot/industry/site";
import type { Route } from "./+types/teams";
import type { TeamsResponse } from "@aihot/contracts/kpl";
import { apiGet, edgeTtl } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";

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
      <header className="pb-2 pt-3 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">战队一览</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          现役 <span className="num">{active.length}</span> 支战队，来自官方赛事数据；点开看阵容、荣誉与最近比赛。
        </p>
      </header>
      <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {active.map((t) => (
          <li key={t.slug}>
            <IntentLink viewTransition to={`/teams/${t.slug}`} className="card card-hover flex h-full flex-col items-center gap-2 px-4 py-5 text-center">
              {t.logo && <img src={t.logo} alt="" width={56} height={56} loading="lazy" className="h-14 w-14 rounded-full object-contain" />}
              <span className="text-[14.5px] font-semibold leading-tight text-ink">{t.name}</span>
              {t.city && <span className="text-[11.5px] text-ink-4">{t.city}</span>}
              {t.champions > 0 && <span className="text-[11.5px] font-medium text-amber">{t.champions} 次冠军</span>}
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
                <IntentLink to={`/teams/${t.slug}`} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink-3 transition-colors hover:text-accent">
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

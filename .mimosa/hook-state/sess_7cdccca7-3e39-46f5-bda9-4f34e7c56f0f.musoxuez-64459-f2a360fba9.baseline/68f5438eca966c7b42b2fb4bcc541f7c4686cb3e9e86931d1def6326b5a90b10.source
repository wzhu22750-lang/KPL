import { useLoaderData } from "react-router";
import type { Route } from "./+types/matches";
import type { ScheduleResponse } from "@aihot/contracts/kpl";
import { apiGet, edgeTtl } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { name: "赛程" };

export async function loader({ request }: { request: Request }) {
  return apiGet<ScheduleResponse>("/api/site/kb/schedule?limit=60", { signal: request.signal });
}

export function meta({}: Route.MetaArgs) {
  return pageMeta({ title: "赛程与赛果", description: "KPL 赛程、比分与赛果，来自官方赛事数据，含每场比赛的 BP 与选手数据。", path: "/matches" });
}

export function headers() {
  return edgeTtl(30);
}

const fmtDate = (iso: string | null) => (iso ? iso.slice(5, 10).replace("-", "/") : "");
const fmtTime = (iso: string | null) => (iso ? iso.slice(11, 16) : "");

export default function MatchesPage() {
  const { season, matches } = useLoaderData<typeof loader>();
  return (
    <div className="pb-10">
      <PhoneBar title="赛程" />
      <header className="pb-2 pt-3 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">赛程与赛果</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">{season?.name ?? "暂无赛季数据"} · 点开看每局的 BP 与选手数据</p>
      </header>
      <ul className="mt-3 divide-y divide-line-soft overflow-hidden rounded-card border border-line bg-surface">
        {matches.map((m) => {
          const homeWon = m.winner === m.home.slug;
          const awayWon = m.winner === m.away.slug;
          const at = m.status === "finished" ? fmtDate(m.playedAt ?? m.scheduledAt) : `${fmtDate(m.scheduledAt)} ${fmtTime(m.scheduledAt)}`;
          return (
            <li key={m.id}>
              <IntentLink to={`/matches/${m.id}`} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:text-accent">
                <span className="w-12 shrink-0 text-[11.5px] leading-tight text-ink-4">{at}</span>
                <span className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right">
                  <span className={`truncate text-[14px] ${homeWon ? "font-semibold text-ink" : homeWon === false && m.status === "finished" ? "text-ink-3" : "text-ink"}`}>{m.home.name}</span>
                  {m.home.logo && <img src={m.home.logo} alt="" width={26} height={26} loading="lazy" className="h-[26px] w-[26px] rounded-full object-contain" />}
                </span>
                <span className="shrink-0 rounded-full bg-bg-sunk px-3 py-1 text-[14px] font-bold tabular-nums text-ink">
                  {m.status === "scheduled" ? "vs" : `${m.home.score} : ${m.away.score}`}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {m.away.logo && <img src={m.away.logo} alt="" width={26} height={26} loading="lazy" className="h-[26px] w-[26px] rounded-full object-contain" />}
                  <span className={`truncate text-[14px] ${awayWon ? "font-semibold text-ink" : awayWon === false && m.status === "finished" ? "text-ink-3" : "text-ink"}`}>{m.away.name}</span>
                </span>
                <span className="hidden shrink-0 text-[12px] text-ink-4 sm:block">{m.stage ?? ""}</span>
              </IntentLink>
            </li>
          );
        })}
      </ul>
      {matches.length === 0 && <p className="mt-6 text-[13px] text-ink-4">该赛季暂无比赛数据。</p>}
    </div>
  );
}

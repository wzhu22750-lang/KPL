import { useLoaderData } from "react-router";
import type { Route } from "./+types/team";
import type { TeamDetailResponse } from "@aihot/contracts/kpl";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { name: "战队" };

export async function loader({ request, params }: Route.LoaderArgs) {
  return loadOr404<TeamDetailResponse>(`/api/site/kb/teams/${params.slug}`, { signal: request.signal });
}

export function meta({ loaderData, params }: Route.MetaArgs) {
  const name = loaderData?.team.name ?? params.slug;
  return pageMeta({ title: `${name}：阵容、荣誉与最近比赛`, description: `${name}的现役阵容、历史荣誉、赛季战绩与最近比赛，数据来自官方赛事接口。`, path: `/teams/${params.slug}` });
}

export function headers() {
  return edgeTtl(60);
}

const HONOR_LABEL: Record<string, string> = { champion: "总冠军", runner_up: "亚军", third: "季军", fmvp: "总决赛FMVP", regular_champion: "常规赛第一", regular_mvp: "常规赛MVP" };

export default function TeamPage() {
  const { team, record, roster, honors, recentMatches } = useLoaderData<typeof loader>();
  return (
    <div className="pb-10">
      <PhoneBar back={{ to: "/teams", label: "战队" }} title={team.name} />
      <header className="pt-3 lg:pt-1">
        <div className="flex items-center gap-4">
          {team.logo && <img src={team.logo} alt="" width={64} height={64} className="h-16 w-16 shrink-0 rounded-full object-contain" />}
          <div className="min-w-0">
            <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">{team.name}</h1>
            <p className="mt-1 text-[13px] text-ink-3">
              {team.city && <span>{team.city} · </span>}
              <span className="num">赛季 {record.wins} 胜 {record.losses} 负</span>
              {team.historyNames.length > 0 && <span className="text-ink-4"> · 曾用名 {team.historyNames.join("、")}</span>}
            </p>
          </div>
        </div>
        {team.styleNotes && <p className="mt-3 rounded-card border border-line bg-surface px-4 py-3 text-[13px] leading-relaxed text-ink-2">{team.styleNotes}</p>}
      </header>

      <section className="pt-7">
        <h2 className="text-[15px] font-bold text-ink">现役阵容</h2>
        {roster.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-4">暂无注册选手数据</p>
        ) : (
          <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {roster.map((p) => (
              <li key={p.slug}>
                <IntentLink to={`/players/${p.slug}`} className="card card-hover flex items-center gap-3 px-3.5 py-3">
                  {p.portrait && <img src={p.portrait} alt="" width={38} height={38} loading="lazy" className="h-10 w-10 rounded-full object-cover" />}
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-semibold text-ink">{p.nickname}</span>
                    <span className="block text-[11.5px] text-ink-4">{p.position ?? "—"}</span>
                  </span>
                </IntentLink>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="pt-7">
        <h2 className="text-[15px] font-bold text-ink">最近比赛</h2>
        <ul className="mt-3 divide-y divide-line-soft overflow-hidden rounded-card border border-line bg-surface">
          {recentMatches.map((m) => {
            const isHome = m.home.slug === team.slug;
            const mine = isHome ? m.home : m.away;
            const theirs = isHome ? m.away : m.home;
            const won = m.winner && ((isHome && m.winner === m.home.slug) || (!isHome && m.winner === m.away.slug));
            return (
              <li key={m.id}>
                <IntentLink to={`/matches/${m.id}`} className="flex items-center gap-3 px-4 py-3 text-[13.5px] transition-colors hover:text-accent">
                  <span className={`w-8 shrink-0 text-center text-[12px] font-bold ${won ? "text-accent" : "text-ink-4"}`}>{m.status === "finished" ? (won ? "胜" : "负") : "—"}</span>
                  <span className="min-w-0 flex-1 truncate text-ink">
                    {mine.name} <span className="num font-semibold">{mine.score} : {theirs.score}</span> {theirs.name}
                  </span>
                  <span className="hidden shrink-0 text-[12px] text-ink-4 sm:block">{m.stage ?? m.seasonName}</span>
                </IntentLink>
              </li>
            );
          })}
        </ul>
      </section>

      {honors.length > 0 && (
        <section className="pt-7">
          <h2 className="text-[15px] font-bold text-ink">荣誉</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {honors.map((h, i) => (
              <li key={i} className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink-2">
                <span className="font-semibold text-ink">{HONOR_LABEL[h.kind] ?? h.kind}</span>
                {h.season && <span className="text-ink-4"> · {h.season}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

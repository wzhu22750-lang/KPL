import { useLoaderData } from "react-router";
import type { Route } from "./+types/team";
import type { TeamDetailResponse } from "@aihot/contracts/kpl";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";
import { IconVs } from "../components/icons";

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

const HONOR_LABEL: Record<string, string> = { champion: "冠军", runner_up: "亚军", third: "季军", fmvp: "总决赛FMVP", regular_champion: "常规赛第一", regular_mvp: "常规赛MVP" };
const HONOR_MEDAL: Record<string, string> = { champion: "🏆", runner_up: "🥈", third: "🥉", fmvp: "🏅", regular_champion: "⭐", regular_mvp: "⭐" };

export default function TeamPage() {
  const { team, record, roster, honors, recentMatches, news } = useLoaderData<typeof loader>();
  const champions = honors.filter((h) => h.kind === "champion").length;
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
        <div className="mt-3 flex items-center gap-2">
          <IntentLink
            to={`/h2h?teamA=${team.slug}&teamB=${team.slug === 'wolves' ? 'ag' : 'wolves'}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-ink-2 hover:border-accent hover:text-accent transition-colors"
          >
            <IconVs size={14} />
            <span>与宿敌交手历史 (H2H)</span>
          </IntentLink>
        </div>
        {team.styleNotes && <p className="mt-3 rounded-card border border-line bg-surface px-4 py-3 text-[13px] leading-relaxed text-ink-2">{team.styleNotes}</p>}
      </header>

      {honors.length > 0 && (
        <section className="pt-7">
          <h2 className="text-[15px] font-bold text-ink">
            荣誉陈列室
            {champions > 0 && <span className="ml-2 text-[12.5px] font-semibold text-amber">队史 {champions} 冠</span>}
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {honors.map((h, i) => (
              <li key={i} className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] ${h.kind === "champion" ? "border-amber/40 bg-amber/10" : "border-line bg-surface"}`}>
                <span aria-hidden>{HONOR_MEDAL[h.kind] ?? "🎖️"}</span>
                <span className={`font-semibold ${h.kind === "champion" ? "text-ink" : "text-ink-2"}`}>{h.title ?? h.season ?? HONOR_LABEL[h.kind]}</span>
                <span className="text-ink-4">{h.kind === "fmvp" ? (h.note ?? HONOR_LABEL[h.kind]) : HONOR_LABEL[h.kind]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

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

      {news.length > 0 && (
        <section className="pt-7">
          <h2 className="text-[15px] font-bold text-ink">战队相关动态</h2>
          <ul className="mt-3 divide-y divide-line-soft overflow-hidden rounded-card border border-line bg-surface">
            {news.map((n) => (
              <li key={n.id}>
                <IntentLink to={`/items/${n.id}`} className="block px-4 py-3 transition-colors hover:text-accent">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{n.title}</span>
                    {n.kind === "social_post" && (
                      <span className="shrink-0 rounded bg-bg-sunk px-1.5 py-0.5 text-[10.5px] font-medium text-ink-3 border border-line-soft">
                        动态
                      </span>
                    )}
                    {n.selected && <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[10.5px] font-semibold text-accent">精选</span>}
                  </span>
                  {n.summary && <span className="mt-1 line-clamp-2 block text-[12.5px] leading-relaxed text-ink-3">{n.summary}</span>}
                </IntentLink>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

import { useLoaderData } from "react-router";
import type { Route } from "./+types/team";
import type { TeamDetailResponse } from "@aihot/contracts/kpl";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";
import { IconVs } from "../components/icons";
import { EsportsNav, PageHeader, Metric, Portrait, MatchRow } from "../components/esports/Esports";
import { formatNumber, formatRate } from "../lib/esports";
import "../esports-teams.css";

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
  const recordedMatches = record.wins + record.losses;
  return (
    <div className="esports-page esports-team pb-10">
      <PhoneBar back={{ to: "/teams", label: "战队" }} title={team.name} />
      <EsportsNav />
      <header>
        <div className="team-profile">
          <div className="team-profile-logo"><Portrait src={team.logo} name={team.name} size={144} kind="team" eager /></div>
          <div className="team-profile-copy">
            <PageHeader kicker={team.isActive ? "现役战队" : "历史战队"} title={team.name} description={team.city || "KPL 战队档案"} />
            {team.historyNames.length > 0 && <p className="team-history">曾用名 · {team.historyNames.join("、")}</p>}
          </div>
        </div>
        <div className="team-record-metrics" aria-label="已收录赛事战绩">
          <Metric label="大场胜场" value={formatNumber(record.wins)} primary />
          <Metric label="大场负场" value={formatNumber(record.losses)} />
          <Metric label="大场胜率" value={formatRate(recordedMatches ? record.wins / recordedMatches : null, recordedMatches)} note={`${formatNumber(recordedMatches)} 场有胜负结果的比赛`} />
          <Metric label="冠军荣誉" value={formatNumber(champions)} note="已收录荣誉" />
        </div>
        <p className="team-record-note">战绩统计已收录的完赛且有胜负结果的大场，不限单个赛季。</p>
        <div className="mt-3 flex items-center gap-2">
          <IntentLink
            to={`/h2h?teamA=${team.slug}&teamB=${team.slug === 'wolves' ? 'ag' : 'wolves'}`}
            className="teams-control team-h2h"
          >
            <IconVs size={14} />
            <span>查看历史交手 (H2H)</span>
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
          <ul className="team-roster">
            {roster.map((p) => (
              <li key={p.slug}>
                <IntentLink to={`/players/${p.slug}`} className="team-roster-card">
                  <Portrait src={p.portrait} name={p.nickname} size={80} kind="player" />
                  <span className="min-w-0">
                    <span className="block text-[16px] font-semibold text-ink">{p.nickname}</span>
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
        {recentMatches.length === 0 ? <p className="teams-empty">暂无比赛数据</p> : (
          <ul className="team-match-list">
            {recentMatches.map(m => <li key={m.id}><MatchRow match={m} /></li>)}
          </ul>
        )}
      </section>

      {news.length > 0 && (
        <section className="pt-7">
          <h2 className="text-[15px] font-bold text-ink">战队相关动态</h2>
          <ul className="mt-3 divide-y divide-line-soft overflow-hidden rounded-card border border-line bg-surface">
            {news.map((n) => (
              <li key={n.id}>
                <IntentLink to={`/items/${n.id}`} className="block px-4 py-3 transition-colors hover:text-accent">
                  <span className="flex items-baseline gap-2">
                    <span className="team-news-title min-w-0 flex-1 text-[13.5px] font-medium text-ink">{n.title}</span>
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

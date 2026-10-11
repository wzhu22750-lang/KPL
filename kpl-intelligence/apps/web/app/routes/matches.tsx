import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/matches";
import type { ScheduleMatch, ScheduleResponse } from "@aihot/contracts/kpl";
import { apiGet, edgeTtl } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";
import { EsportsNav, PageHeader, Metric, MatchRow } from "../components/esports/Esports";
import { formatNumber, matchDate } from "../lib/esports";
import "../esports-matches.css";

export const handle: Screen = { name: "赛程" };

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const season = url.searchParams.get("season");
  const query = season ? `season=${encodeURIComponent(season)}&limit=150` : "limit=150";
  return apiGet<ScheduleResponse>(`/api/site/kb/schedule?${query}`, { signal: request.signal });
}

export function meta({}: Route.MetaArgs) {
  return pageMeta({ title: "赛程与赛果", description: "KPL 赛程、比分与赛果，来自官方赛事数据，含每场比赛的 BP 与选手数据。", path: "/matches" });
}

export function headers() { return edgeTtl(30); }
const fmtFullDate = (iso: string | null) => matchDate(iso);

export default function MatchesPage() {
  const { season, availableSeasons = [], matches = [] } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const selectSeason = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("season", id);
    navigate(`/matches?${next.toString()}`);
  };
  const matchesByDate = new Map<string, ScheduleMatch[]>();
  for (const m of matches) {
    const dateKey = fmtFullDate(m.status === "scheduled" ? m.scheduledAt : m.playedAt ?? m.scheduledAt);
    if (!matchesByDate.has(dateKey)) matchesByDate.set(dateKey, []);
    matchesByDate.get(dateKey)!.push(m);
  }
  return <div className="esports-page esports-schedule pb-10">
    <PhoneBar title="赛程" />
    <EsportsNav />
    <PageHeader kicker="MATCH CENTER / 赛事日历" title="赛程与赛果" description={`${season?.name ?? "暂无赛季数据"} · 比分、BP 与选手表现，一场一档`} />
    <div className="ep-metrics">
      <Metric label="收录大场" value={formatNumber(matches.length)} note="当前赛季列表 · 最多 150 场" primary />
      <Metric label="已完赛" value={formatNumber(matches.filter(m => m.status === "finished").length)} note="按服务端状态统计" />
      <Metric label="待开赛" value={formatNumber(matches.filter(m => m.status === "scheduled").length)} note="时间以赛事安排为准" />
    </div>
    <section className="ep-filter-panel ep-panel" aria-label="赛季筛选">
      {availableSeasons.length > 0 && <div className="ep-select-field">
        <label htmlFor="season-select">选择赛季</label>
        <select id="season-select" value={season?.id ?? ""} onChange={e => selectSeason(e.target.value)}>
          {availableSeasons.map(s => <option key={s.id} value={s.id}>{s.name}{s.isCurrent ? " · 最新" : ""}</option>)}
        </select>
      </div>}
      {availableSeasons.length > 1 && <div className="ep-season-actions" aria-label="快捷赛季">
        {availableSeasons.slice(0, 6).map(s => <button key={s.id} type="button" aria-pressed={season?.id === s.id} onClick={() => selectSeason(s.id)}>{s.name}</button>)}
      </div>}
      <p className="ep-muted">状态来自赛事数据，不按开赛时间推测正在直播。</p>
    </section>
    <div className="ep-schedule-days">
      {[...matchesByDate.entries()].map(([dateKey, list]) => <section key={dateKey} className="ep-schedule-day">
        <div className="ep-section-heading"><h2>{dateKey}</h2><span>{list.length} 场比赛</span></div>
        <ul className="ep-match-list ep-panel">{list.map(m => <li key={m.id}><MatchRow match={m} /></li>)}</ul>
      </section>)}
    </div>
    {!matches.length && <p className="ep-empty ep-panel">该赛季暂无比赛数据，可切换其他赛季。</p>}
  </div>;
}

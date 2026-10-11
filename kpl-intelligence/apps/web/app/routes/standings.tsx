import { useLoaderData, useSearchParams } from "react-router";
import type { Route } from "./+types/standings";
import type { StandingRow, StandingsResponse } from "@aihot/contracts/kpl";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";
import { EsportsNav, PageHeader, Portrait } from "../components/esports/Esports";
import { formatNumber, formatRate } from "../lib/esports";
import "../esports-teams.css";

export const handle: Screen = { name: "积分榜" };

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const season = url.searchParams.get("season") ?? "";
  const stage = url.searchParams.get("stage") ?? "";
  const query = new URLSearchParams();
  if (season) query.set("season", season);
  if (stage) query.set("stage", stage);
  const qs = query.toString();

  return loadOr404<StandingsResponse>(`/api/site/kb/standings${qs ? `?${qs}` : ""}`, { signal: request.signal });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const sName = loaderData?.season.name ?? "当前赛季";
  return pageMeta({
    title: `${sName}：赛段积分榜与战队战绩`,
    description: `查看 ${sName} 各赛段分组、大场胜负、小局净胜差与胜率，含年度总决赛大师组、精英组积分。`,
    path: "/standings",
  });
}

export function headers() {
  return edgeTtl(60);
}

function GroupTable({ groupName, rows }: { groupName: string; rows: StandingRow[] }) {
  return (
    <section className="standings-group" aria-label={`${groupName}积分榜`}>
      <header className="standings-group-header">
        <h2>{groupName}<span>积分榜</span></h2>
        <p>本赛段战绩 · 晋级规则以官方赛制为准</p>
      </header>
      <table className="standings-table" role="table" aria-label={`${groupName}战队战绩`}>
        <thead role="rowgroup"><tr role="row">
          <th scope="col" role="columnheader">排名</th><th scope="col" role="columnheader">战队</th>
          <th scope="col" role="columnheader">已赛</th><th scope="col" role="columnheader">胜 - 负</th>
          <th scope="col" role="columnheader">净胜局</th><th scope="col" role="columnheader">胜率</th>
          <th scope="col" role="columnheader">积分</th><th scope="col" role="columnheader">近期走势</th>
        </tr></thead>
        <tbody role="rowgroup">{rows.map(r => (
          <tr key={r.team.slug} role="row">
            <td className="standing-rank" role="cell" data-label="排名"><span>{formatNumber(r.rank)}</span></td>
            <td className="standing-team" role="cell" data-label="战队">
              <IntentLink to={`/teams/${r.team.slug}`}><Portrait src={r.team.logo} name={r.team.name} size={36} kind="team" /><span>{r.team.name}</span></IntentLink>
            </td>
            <td className="standing-played" role="cell" data-label="已赛">{formatNumber(r.matchesPlayed)}</td>
            <td className="standing-record" role="cell" data-label="胜 - 负"><strong>{formatNumber(r.wins)}</strong> - {formatNumber(r.losses)}</td>
            <td className="standing-diff" role="cell" data-label="净胜局">{r.gameDiff > 0 ? `+${formatNumber(r.gameDiff)}` : formatNumber(r.gameDiff)}</td>
            <td className="standing-rate" role="cell" data-label="胜率">{formatRate(r.winRate, r.matchesPlayed)}</td>
            <td className="standing-points" role="cell" data-label="积分"><strong>{formatNumber(r.points)}</strong></td>
            <td className="standing-streak" role="cell" data-label="近期走势">{r.streak || "—"}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}

export default function StandingsPage() {
  const { season, availableSeasons, currentStage, stages, standingsByGroup, notes, rulesDescription, rulesSourceUrl } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  const handleSeasonChange = (seasonId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("season", seasonId);
    next.delete("stage");
    setSearchParams(next, { preventScrollReset: true });
  };

  const handleStageChange = (stageName: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("stage", stageName);
    setSearchParams(next, { preventScrollReset: true });
  };

  const groupKeys = Object.keys(standingsByGroup);

  return (
    <div className="esports-page esports-standings pb-14">
      <PhoneBar title="赛季积分榜" />
      <EsportsNav />
      <PageHeader kicker="赛季战绩" title={`${season.name} 积分榜`} description="按赛季与赛段查看积分、胜负和净胜局；分组以已核实的官方名单为准。">
        <select value={season.id} onChange={e => handleSeasonChange(e.target.value)} aria-label="切换赛季" className="teams-control">
          {availableSeasons.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </PageHeader>
      {stages.length > 0 && <div className="standings-stages" aria-label="选择赛段">
        {stages.map(stg => <button key={stg} type="button" aria-pressed={currentStage === stg} onClick={() => handleStageChange(stg)} className="teams-control">{stg}</button>)}
      </div>}
      <details className="standings-rules" aria-label="统计口径与赛制">
        <summary>赛制与统计口径 · 查看官方说明</summary>
        {rulesDescription && <p>{rulesDescription}</p>}
        {notes?.map(note => <p key={note}>{note}</p>)}
        {rulesSourceUrl && <a href={rulesSourceUrl} target="_blank" rel="noopener noreferrer">官方赛制与分组公告 ↗</a>}
      </details>
      <div className="standings-groups">
        {groupKeys.length === 0 ? <p className="teams-empty">当前赛段暂无对局积分数据</p> : groupKeys.map(groupName => <GroupTable key={groupName} groupName={groupName} rows={standingsByGroup[groupName] ?? []} />)}
      </div>
    </div>
  );
}

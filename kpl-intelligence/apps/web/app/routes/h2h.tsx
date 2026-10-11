import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/h2h";
import type { H2HResponse, TeamsResponse } from "@aihot/contracts/kpl";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";
import { EsportsNav, PageHeader, Portrait, MatchRow, RateBar } from "../components/esports/Esports";
import { formatNumber, formatRate, matchDate } from "../lib/esports";
import "../esports-matches.css";

export const handle: Screen = { name: "战队对决" };

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const teamA = url.searchParams.get("teamA") || "wolves";
  const teamB = url.searchParams.get("teamB") || "ag";
  const [h2hData, teamsData] = await Promise.all([
    loadOr404<H2HResponse>(`/api/site/kb/h2h?teamA=${teamA}&teamB=${teamB}`, { signal: request.signal }),
    loadOr404<TeamsResponse>("/api/site/kb/teams", { signal: request.signal }),
  ]);
  return { h2h: h2hData, teams: teamsData.teams, teamA, teamB };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const tA = loaderData?.h2h?.teamA.name ?? "战队A";
  const tB = loaderData?.h2h?.teamB.name ?? "战队B";
  return pageMeta({ title: `${tA} vs ${tB}：宿命对决历史交手记录与总比分`, description: `${tA}与${tB}历年 KPL 历史交手总战绩、BO7 季后赛胜负、小局总得失分与胜负走势。`, path: "/h2h" });
}
export function headers() { return edgeTtl(60); }

export default function H2HPage() {
  const { h2h, teams, teamA, teamB } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const selectTeams = (a: string, b: string) => {
    const next = new URLSearchParams(params);
    next.set("teamA", a);
    next.set("teamB", b);
    navigate(`/h2h?${next.toString()}`);
  };
  const swap = () => selectTeams(teamB, teamA);
  const { teamA: tA, teamB: tB, stats, matches } = h2h;
  const gameSample = stats.teamAGames + stats.teamBGames;
  const bo7Sample = stats.teamABo7Wins + stats.teamBBo7Wins;
  const unaccounted = stats.totalMatches - stats.teamAWins - stats.teamBWins;
  const comparisons = [
    { label: "大场胜率", a: stats.teamAWins, b: stats.teamBWins, sample: stats.totalMatches, note: `全部 ${formatNumber(stats.totalMatches)} 场交手；${unaccounted >= 0 ? `${formatNumber(unaccounted)} 场未计入两队胜场` : "胜场合计与交手数不一致"}` },
    { label: "小局胜局占比", a: stats.teamAGames, b: stats.teamBGames, sample: gameSample, note: `已记录胜方的小局样本：${formatNumber(gameSample)} 局` },
    { label: "BO7 胜场占比", a: stats.teamABo7Wins, b: stats.teamBBo7Wins, sample: bo7Sample, note: `已记录胜方的 BO7 样本：${formatNumber(bo7Sample)} 场，不推断未决场次或淘汰阶段` },
  ];
  return <div className="esports-page esports-h2h pb-14">
    <PhoneBar title="战队对决" />
    <EsportsNav />
    <PageHeader kicker="HEAD TO HEAD / 历史交锋" title="战队对决" description="两队同场交手的真实记录，不以历史战绩预测未来。" />
    <section className="ep-duel-controls ep-panel" aria-label="选择对决战队">
      <div className="ep-select-field"><label htmlFor="team-a-select">战队 A</label><select id="team-a-select" value={teamA} onChange={e => e.target.value === teamB ? swap() : selectTeams(e.target.value, teamB)}>{teams.map(t => <option key={t.slug} value={t.slug}>{t.name}</option>)}</select></div>
      <button type="button" onClick={swap} className="ep-swap" aria-label="对调两队位置">⇄ 对调</button>
      <div className="ep-select-field"><label htmlFor="team-b-select">战队 B</label><select id="team-b-select" value={teamB} onChange={e => e.target.value === teamA ? swap() : selectTeams(teamA, e.target.value)}>{teams.map(t => <option key={t.slug} value={t.slug}>{t.name}</option>)}</select></div>
    </section>
    <section className="ep-duel ep-panel" aria-label="历史大场总胜场">
      <div className="ep-duel-team"><IntentLink to={`/teams/${tA.slug}`}><Portrait src={tA.logo} name={tA.name} kind="team" size={88} eager /><h2>{tA.name}</h2></IntentLink><p className="ep-muted">{tA.city ?? "KPL 战队"}</p><strong className="ep-win-count">{formatNumber(stats.teamAWins)}</strong><span className="ep-muted">大场胜利</span></div>
      <div className="ep-versus"><span>VS</span><p>历史交手</p><strong>{formatNumber(stats.totalMatches)} 场</strong></div>
      <div className="ep-duel-team"><IntentLink to={`/teams/${tB.slug}`}><Portrait src={tB.logo} name={tB.name} kind="team" size={88} eager /><h2>{tB.name}</h2></IntentLink><p className="ep-muted">{tB.city ?? "KPL 战队"}</p><strong className="ep-win-count">{formatNumber(stats.teamBWins)}</strong><span className="ep-muted">大场胜利</span></div>
    </section>
    <section className="ep-section">
      <div className="ep-section-heading"><h2>交锋数据比较</h2><span>样本内统计</span></div>
      <div className="ep-comparison-list">{comparisons.map(c => <article key={c.label} className="ep-panel ep-comparison">
        <h3>{c.label}</h3><p className="ep-muted">{c.note}</p>
        <div className="ep-comparison-sides">
          <div><p className="ep-comparison-value">{formatNumber(c.a)} 胜 <strong>{formatRate(c.sample ? c.a / c.sample : null, c.sample)}</strong></p><RateBar label={tA.name} value={c.sample ? c.a / c.sample : null} tone="accent" sample={`${c.sample} ${c.label === "小局胜局占比" ? "局" : "场"}`} /></div>
          <div><p className="ep-comparison-value">{formatNumber(c.b)} 胜 <strong>{formatRate(c.sample ? c.b / c.sample : null, c.sample)}</strong></p><RateBar label={tB.name} value={c.sample ? c.b / c.sample : null} tone="blue" sample={`${c.sample} ${c.label === "小局胜局占比" ? "局" : "场"}`} /></div>
        </div>
      </article>)}</div>
      <div className="ep-recent-winners ep-panel"><h3>近 5 次胜者 · 最近在前</h3><ol>{stats.last5WinnerSlugs.map((slug, i) => <li key={i}><span className="ep-muted">{i + 1}</span><span>{slug === tA.slug ? tA.shortName ?? tA.name : slug === tB.slug ? tB.shortName ?? tB.name : "胜方待确认"}</span></li>)}</ol>{!stats.last5WinnerSlugs.length && <p className="ep-muted">暂无胜者记录。</p>}</div>
    </section>
    <section className="ep-section">
      <div className="ep-section-heading"><h2>交手历史时间线</h2><span>{matches.length} 场档案 · 最近在前</span></div>
      <p className="ep-muted">日期、状态与赛果以收录记录为准，点击查看每局 BP、选手表现与战报。</p>
      {matches.length ? <ol className="ep-timeline ep-history">{matches.map(m => <li key={m.id}>
        <p className="ep-history-date">{m.playedAt ?? m.scheduledAt ? <time dateTime={(m.playedAt ?? m.scheduledAt)!}>{matchDate(m.playedAt ?? m.scheduledAt)}</time> : "日期待确认"} · {m.seasonName}{m.stage ? ` · ${m.stage}` : ""}</p>
        <div className="ep-panel"><MatchRow match={m} /></div>
      </li>)}</ol> : <p className="ep-empty ep-panel">两队暂无已收录交手记录。</p>}
    </section>
  </div>;
}

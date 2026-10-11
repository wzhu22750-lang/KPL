import { useLoaderData } from "react-router";
import type { Route } from "./+types/player";
import type { PlayerDetailResponse } from "@aihot/contracts/kpl";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";
import { EsportsNav, PageHeader, Portrait, Metric } from "../components/esports/Esports";
import { formatNumber, formatRate } from "../lib/esports";
import "../esports-matches.css";

export const handle: Screen = { name: "选手" };

export async function loader({ request, params }: Route.LoaderArgs) {
  return loadOr404<PlayerDetailResponse>(`/api/site/kb/players/${params.slug}`, { signal: request.signal });
}

export function meta({ loaderData, params }: Route.MetaArgs) {
  const name = loaderData?.player.nickname ?? params.slug;
  return pageMeta({ title: `${name}：职业履历、荣誉与数据`, description: `${name}的真实姓名、个人荣誉、转会履历、赛季数据变化、英雄池与相关赛事动态。`, path: `/players/${params.slug}` });
}

export function headers() { return edgeTtl(60); }

const HONOR_LABEL: Record<string, string> = { fmvp: "总决赛FMVP", regular_mvp: "常规赛MVP", annual_mvp: "年度最佳选手", best_lineup: "最佳阵容一阵", champion: "冠军成员", finals_mvp: "总决赛FMVP" };
const fmtDate = (d: string | null) => d ? d.slice(0, 7).replace("-", ".") : "日期待补充";

export default function PlayerPage() {
  const { player, stints, seasons, heroes, honors, news } = useLoaderData<typeof loader>();
  const totals = seasons.reduce((acc, s) => ({ games: acc.games + s.games, mvps: acc.mvps + s.mvps, wins: acc.wins + s.wins }), { games: 0, mvps: 0, wins: 0 });
  return <div className="esports-page esports-player pb-10">
    <PhoneBar title={player.nickname} />
    <EsportsNav />
    <div className="ep-athlete ep-panel">
      <Portrait src={player.portrait} name={player.nickname} kind="player" size={144} eager />
      <div className="ep-athlete-copy">
        <PageHeader kicker="PLAYER / 选手档案" title={player.nickname} description={[player.realName, player.position, player.debutAt ? `${player.debutAt.slice(0, 4)} 年出道` : null].filter(Boolean).join(" · ")} />
        {player.team && <p className="ep-affiliation">效力战队 · {player.teamSlug ? <IntentLink to={`/teams/${player.teamSlug}`}>{player.team}</IntentLink> : player.team}</p>}
        <p className="ep-muted">以下统计来自已收录赛季，不代表完整职业生涯。</p>
      </div>
    </div>
    <div className="ep-metrics">
      <Metric label="收录小局" value={formatNumber(totals.games)} note={`${seasons.length} 个赛季样本`} primary />
      <Metric label="小局胜率" value={formatRate(totals.games ? totals.wins / totals.games : null, totals.games)} note={`${formatNumber(totals.wins)} 胜 / ${formatNumber(totals.games)} 局`} />
      <Metric label="单局 MVP" value={formatNumber(totals.mvps)} note="官方对局记录" />
    </div>
    {player.bio && <p className="ep-bio ep-panel">{player.bio}</p>}
    <div className="ep-career-grid">
      <section className="ep-section">
        <div className="ep-section-heading"><h2>职业履历</h2><span>CAREER</span></div>
        {stints.length ? <ol className="ep-timeline">{[...stints].reverse().map((s, i) => <li key={`${s.teamSlug}-${i}`}>
          <p className="ep-muted">{fmtDate(s.joinedAt)} — {s.leftAt ? fmtDate(s.leftAt) : "至今"}</p>
          <h3>{s.teamSlug ? <IntentLink to={`/teams/${s.teamSlug}`}>{s.team ?? "未知战队"}</IntentLink> : s.team ?? "未知战队"}</h3>
          {!s.leftAt && <span className="ep-tag">当前履历</span>}
        </li>)}</ol> : <p className="ep-empty">职业转会记录待补充。</p>}
      </section>
      <section className="ep-section">
        <div className="ep-section-heading"><h2>个人荣誉</h2><span>{honors.length} 项记录</span></div>
        {honors.length ? <ul className="ep-honors">{honors.map((h, i) => <li key={i}>
          <span className="ep-kicker">{h.year ?? h.season ?? "赛季待补充"}</span>
          <h3>{h.title ?? HONOR_LABEL[h.kind] ?? h.kind}</h3>
          <p className="ep-muted">{h.season} · {HONOR_LABEL[h.kind] ?? h.kind}{h.note ? ` · ${h.note}` : ""}</p>
        </li>)}</ul> : <p className="ep-empty">暂无已收录荣誉。</p>}
      </section>
    </div>
    <section className="ep-section">
      <div className="ep-section-heading"><h2>赛季表现</h2><span>真实场均 K / D / A</span></div>
      {seasons.length ? <ul className="ep-season-list">{seasons.map(s => <li key={s.seasonId} className="ep-panel ep-season-card">
        <h3>{s.seasonName}</h3>
        <dl className="ep-stat-grid">
          <div><dt>小局</dt><dd>{formatNumber(s.games)}</dd></div>
          <div><dt>胜率</dt><dd>{formatRate(s.games ? s.wins / s.games : null, s.games)}</dd></div>
          <div><dt>MVP</dt><dd>{formatNumber(s.mvps)}</dd></div>
          <div><dt>场均 K / D / A</dt><dd>{formatNumber(s.avgKills, 1)} / {formatNumber(s.avgDeaths, 1)} / {formatNumber(s.avgAssists, 1)}</dd></div>
        </dl>
      </li>)}</ul> : <p className="ep-empty">暂无赛季对局数据。</p>}
    </section>
    <section className="ep-section">
      <div className="ep-section-heading"><h2>英雄池</h2><span>出场样本与胜率</span></div>
      {heroes.length ? <ul className="ep-hero-grid">{heroes.map(h => <li key={h.hero} className="ep-panel ep-hero-card">
        <Portrait src={h.heroIcon} name={h.hero} kind="hero" size={48} />
        <div><h3>{h.hero}</h3><p className="ep-muted">{formatNumber(h.wins)} 胜 / {formatNumber(h.games)} 局</p></div>
        <strong>{formatRate(h.games ? h.wins / h.games : null, h.games)}</strong>
      </li>)}</ul> : <p className="ep-empty">英雄池数据待补充。</p>}
    </section>
    {news.length > 0 && <section className="ep-section">
      <div className="ep-section-heading"><h2>相关赛事动态</h2><span>{news.length} 条</span></div>
      <ul className="ep-news-list ep-panel">{news.map(n => <li key={n.id}><IntentLink to={`/items/${n.id}`}>
        <div className="ep-news-meta">{n.publishedAt && <time dateTime={n.publishedAt}>{n.publishedAt.slice(0, 10)}</time>}{n.kind === "social_post" && <span>动态</span>}{n.selected && <span className="ep-tag">精选</span>}</div>
        <h3>{n.title}</h3>{n.summary && <p className="ep-muted">{n.summary}</p>}
      </IntentLink></li>)}</ul>
    </section>}
    {stints.length === 0 && seasons.length === 0 && heroes.length === 0 && <p className="ep-empty">该选手暂无对局数据（数据自 2026 春季赛起累积）。</p>}
  </div>;
}

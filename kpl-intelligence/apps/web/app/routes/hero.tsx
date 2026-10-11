import { useLoaderData, useSearchParams } from "react-router";
import type { Route } from "./+types/hero";
import type { HeroDetailResponse } from "@aihot/contracts/kpl";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { formatNumber, formatRate } from "../lib/esports";
import { EsportsNav, MatchRow, Metric, PageHeader, Portrait, RateBar, TierBadge } from "../components/esports/Esports";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";
import "../esports-hero.css";

export const handle: Screen = { name: "英雄" };

export async function loader({ request, params }: Route.LoaderArgs) {
  return loadOr404<HeroDetailResponse>(`/api/site/kb/heroes/${params.slug}`, { signal: request.signal });
}

export function meta({ loaderData, params }: Route.MetaArgs) {
  const name = loaderData?.hero.name ?? params.slug;
  const title = loaderData?.hero.title ? `${loaderData.hero.title} · ${name}` : name;
  return pageMeta({
    title: `${title}：职业赛场 BP、胜率、招牌选手与阵容交手记录`,
    description: `KPL 官方数据：${name}的出场数、禁用率、红蓝方胜率、招牌代表选手 Top 5、同队搭档与对方阵容交手记录。`,
    path: `/heroes/${params.slug}`,
  });
}

export function headers() {
  return edgeTtl(60);
}

/** Only the heroes index and its query can be a return destination. */
function heroesReturnTo(value: string | null): string {
  if (!value || !/^\/heroes(?:\?[^#]*)?$/.test(value) || /[\\\u0000-\u001f\u007f]/.test(value)) return "/heroes";
  return value;
}

export default function HeroDetailPage() {
  const { hero, stats, topPlayers, bestPartners, counters, recentMatches } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const returnTo = heroesReturnTo(searchParams.get("returnTo"));
  const hasAppearances = Number.isFinite(stats.picks) && stats.picks > 0;
  const relations = [
    { title: "同队高胜率搭档", description: "同阵营出场时的历史胜率", empty: "暂无足量搭档数据", rows: bestPartners, sampleLabel: "共同出场" },
    { title: "对方阵容交手记录", description: "对方阵容包含下列英雄时的历史胜率", empty: "暂无足量交手记录", rows: counters, sampleLabel: "交手" },
  ];

  return (
    <div className="esports-page hero-dossier">
      <PhoneBar back={{ to: returnTo, label: "英雄榜" }} title={hero.name} />
      <EsportsNav />
      <IntentLink to={returnTo} className="hero-return">← 返回英雄榜 · 保留筛选</IntentLink>

      <section className="hero-profile" aria-label="英雄档案">
        <div className="hero-profile-art">
          <Portrait src={hero.avatar} name={hero.name} kind="hero" size={144} eager />
          <span className="hero-position">{hero.primaryPos}</span>
        </div>
        <div className="hero-profile-copy">
          <PageHeader kicker="英雄档案 / HERO DOSSIER" title={hero.name} description={hero.title || "职业赛场数据档案"}>
            <TierBadge tier={hero.versionStrength} />
          </PageHeader>
          <p className="hero-profile-meta">分路：{hero.positions.join(" / ") || "暂未提供"}{hero.powerPeriod && <> · 发力期：{hero.powerPeriod}</>}</p>
          <div className="hero-tags">{hero.functionTags.map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}</div>
        </div>
      </section>

      <section className="hero-section" aria-labelledby="hero-core-heading">
        <div className="hero-section-heading"><h2 id="hero-core-heading">赛场核心数据</h2><p>历史统计，不代表单局表现或版本预测</p></div>
        <div className="hero-primary-metrics">
          <Metric primary label="BP 参与率" value={formatRate(stats.bpRate)} note={<>禁用 {formatNumber(stats.bans)} 局 · 总 BP 样本未提供</>} />
          <Metric primary label="出场胜率" value={formatRate(stats.winRate, stats.picks)} note={<>{formatNumber(stats.wins)} 胜 / {formatNumber(stats.losses)} 负</>} />
          <Metric primary label="出场样本" value={formatNumber(stats.picks)} note="局 · 解读胜率时请结合样本量" />
        </div>
        <div className="hero-secondary-metrics">
          <Metric label="场均 KDA · 接口值" value={formatNumber(hasAppearances ? stats.avgKda : null, 2)} note="缺失记录接口默认 3.0，不能区分完整实测" />
          <Metric label="场均伤害占比 · 接口值" value={formatRate(stats.avgDamageShare, stats.picks)} note="缺失记录接口默认 20%，不能区分完整实测" />
        </div>
        <div className="hero-side-panel">
          <div className="hero-section-heading"><h3>红蓝方胜率</h3><p>独立比例 · 同一 0–100% 刻度</p></div>
          <RateBar label="蓝方胜率" tone="blue" value={hasAppearances ? stats.blueWinRate : null} />
          <RateBar label="红方胜率" tone="red" value={hasAppearances ? stats.redWinRate : null} />
          <p className="hero-note">两条胜率分别计算，并非合计 100% 的份额。接口未提供各方出场样本；0% 也可能表示该侧无记录，不能据此判断选边优势。</p>
        </div>
      </section>

      <div className="hero-analysis-layout">
        <section className="hero-section hero-players" aria-labelledby="hero-players-heading">
          <div className="hero-section-heading"><h2 id="hero-players-heading">招牌选手榜 <span>Top 5</span></h2><p>按现有排名分展示，不等同于选手能力评级</p></div>
          {topPlayers.length === 0 ? <p className="hero-empty">暂无选手出场记录</p> : (
            <ol className="hero-player-list">
              {topPlayers.map((player, index) => (
                <li key={player.playerSlug}>
                  <IntentLink to={`/players/${player.playerSlug}`} className="hero-player-card">
                    <div className="hero-player-identity">
                      <span className="hero-player-rank" aria-label={`第 ${index + 1} 名`}>{String(index + 1).padStart(2, "0")}</span>
                      <Portrait src={player.portrait} name={player.nickname} kind="player" size={64} />
                      <div className="hero-player-name"><h3>{player.nickname}</h3><p>{player.teamName ?? "战队信息暂缺"}</p>
                        {player.isFmvpHero && <span className="hero-fmvp">FMVP 专属{player.fmvpSkinTitle ? ` · ${player.fmvpSkinTitle}` : ""}</span>}
                      </div>
                    </div>
                    <dl className="hero-player-metrics">
                      <div><dt>英雄胜率</dt><dd>{formatRate(player.winRate, player.games)}</dd></div>
                      <div><dt>出场 / 胜局</dt><dd>{formatNumber(player.games)} / {formatNumber(player.wins)}</dd></div>
                      <div><dt>MVP</dt><dd>{formatNumber(player.mvpCount)}</dd></div>
                      <div className="hero-player-score"><dt>现有排名分</dt><dd>{formatNumber(player.score, 1)}</dd></div>
                    </dl>
                  </IntentLink>
                </li>
              ))}
            </ol>
          )}
        </section>

        <div className="hero-relations">
          {relations.map((relation) => (
            <section className="hero-relation-panel" key={relation.title}>
              <div className="hero-section-heading"><h2>{relation.title}</h2><p>{relation.description} · Top 5</p></div>
              {relation.rows.length === 0 ? <p className="hero-empty">{relation.empty}</p> : (
                <ul className="hero-relation-list">
                  {relation.rows.map((row) => (
                    <li key={row.heroId}>
                      <IntentLink to={`/heroes/${row.heroId}?${new URLSearchParams({ returnTo }).toString()}`} className="hero-relation-row">
                        <Portrait src={row.avatar} name={row.name} kind="hero" size={44} />
                        <span className="hero-relation-name">{row.name}</span>
                        <span className="hero-relation-stat"><strong>{formatRate(row.winRate, row.games)}</strong><small>{relation.sampleLabel} {formatNumber(row.games)} 局</small></span>
                      </IntentLink>
                    </li>
                  ))}
                </ul>
              )}
              <p className="hero-note">相关性不等于因果；搭配或对方阵容结论需结合样本与阵容。</p>
            </section>
          ))}
        </div>
      </div>

      <section className="hero-section" aria-labelledby="hero-matches-heading">
        <div className="hero-section-heading"><h2 id="hero-matches-heading">近期出场比赛</h2><p>查看对局与 BP 记录</p></div>
        {recentMatches.length === 0 ? <p className="hero-empty">暂无最近对局</p> : (
          <ul className="hero-match-list">{recentMatches.map((match) => <li key={match.id}><MatchRow match={match} /></li>)}</ul>
        )}
      </section>
    </div>
  );
}

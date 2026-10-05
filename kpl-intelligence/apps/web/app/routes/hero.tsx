import { useLoaderData } from "react-router";
import type { Route } from "./+types/hero";
import type { HeroDetailResponse } from "@aihot/contracts/kpl";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";
import { IconSword, IconUsers } from "../components/icons";

export const handle: Screen = { name: "英雄" };

export async function loader({ request, params }: Route.LoaderArgs) {
  return loadOr404<HeroDetailResponse>(`/api/site/kb/heroes/${params.slug}`, { signal: request.signal });
}

export function meta({ loaderData, params }: Route.MetaArgs) {
  const name = loaderData?.hero.name ?? params.slug;
  const title = loaderData?.hero.title ? `${loaderData.hero.title} · ${name}` : name;
  return pageMeta({
    title: `${title}：职业赛场 BP、胜率、招牌选手与克制关系`,
    description: `KPL 官方数据：${name}的出场数、禁用率、红蓝方胜率、招牌代表选手 Top 5、同队最佳搭档与对位克制英雄。`,
    path: `/heroes/${params.slug}`,
  });
}

export function headers() {
  return edgeTtl(60);
}

function TierTag({ tier }: { tier: string }) {
  const color =
    tier === "T0"
      ? "bg-amber-500/15 text-amber-500 border-amber-500/30"
      : tier === "T0.5"
      ? "bg-amber-400/10 text-amber-400 border-amber-400/20"
      : tier === "T1"
      ? "bg-blue-500/10 text-blue-500 border-blue-500/20"
      : "bg-surface text-ink-3 border-line";
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold ${color}`}>
      梯度 {tier}
    </span>
  );
}

export default function HeroDetailPage() {
  const { hero, stats, topPlayers, bestPartners, counters, recentMatches } = useLoaderData<typeof loader>();

  const winPct = (stats.winRate * 100).toFixed(1);
  const bpPct = (stats.bpRate * 100).toFixed(1);
  const bluePct = (stats.blueWinRate * 100).toFixed(1);
  const redPct = (stats.redWinRate * 100).toFixed(1);

  return (
    <div className="pb-14">
      <PhoneBar back={{ to: "/heroes", label: "英雄榜" }} title={hero.name} />

      {/* 顶部英雄档案 Banner */}
      <header className="pt-3 lg:pt-1">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4.5 rounded-card border border-line bg-surface p-4 sm:p-5">
          <div className="relative shrink-0">
            <img
              src={hero.avatar}
              alt={hero.name}
              width={76}
              height={76}
              className="h-20 w-20 rounded-2xl object-cover ring-2 ring-line shadow-sm"
            />
            <span className="absolute -bottom-1 -right-1 rounded bg-bg-sunk px-1.5 py-0.5 text-[10px] font-bold text-ink-2 shadow-sm">
              {hero.primaryPos}
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 data-page-title="" className="text-[24px] sm:text-[28px] font-bold tracking-tight text-ink">
                {hero.name}
              </h1>
              {hero.title && <span className="text-[14px] text-ink-4">· {hero.title}</span>}
              <TierTag tier={hero.versionStrength} />
            </div>

            <p className="mt-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
              <span className="font-semibold text-ink-2">分路：{hero.positions.join(" / ")}</span>
              {hero.powerPeriod && <span>· 发力期：{hero.powerPeriod}</span>}
            </p>

            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {hero.functionTags.map((t, idx) => (
                <span
                  key={idx}
                  className="rounded-full bg-bg-sunk px-2.5 py-0.5 text-[11px] font-medium text-ink-2"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* 核心数据仪表盘 */}
      <section className="mt-6">
        <h2 className="text-[15px] font-bold text-ink">赛事核心数据</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-card border border-line bg-surface p-3.5">
            <div className="text-[12px] text-ink-4">出场 / 禁用 (场)</div>
            <div className="mt-1 text-[20px] font-bold text-ink">
              <span className="num">{stats.picks}</span>
              <span className="text-[13px] font-normal text-ink-4"> / {stats.bans}</span>
            </div>
            <div className="mt-1 text-[11.5px] text-ink-3">BP参与率 {bpPct}%</div>
          </div>

          <div className="rounded-card border border-line bg-surface p-3.5">
            <div className="text-[12px] text-ink-4">胜率</div>
            <div className="mt-1 text-[20px] font-bold text-ink">
              <span className={`num ${stats.winRate >= 0.5 ? "text-red-500" : "text-blue-500"}`}>
                {winPct}%
              </span>
            </div>
            <div className="mt-1 text-[11.5px] text-ink-3">
              {stats.wins} 胜 {stats.losses} 负
            </div>
          </div>

          <div className="rounded-card border border-line bg-surface p-3.5">
            <div className="text-[12px] text-ink-4">场均 KDA</div>
            <div className="mt-1 text-[20px] font-bold text-ink">
              <span className="num">{stats.avgKda}</span>
            </div>
            <div className="mt-1 text-[11.5px] text-ink-3">赛场综合评分表现</div>
          </div>

          <div className="rounded-card border border-line bg-surface p-3.5">
            <div className="text-[12px] text-ink-4">场均伤害占比</div>
            <div className="mt-1 text-[20px] font-bold text-ink">
              <span className="num">{(stats.avgDamageShare * 100).toFixed(1)}%</span>
            </div>
            <div className="mt-1 text-[11.5px] text-ink-3">输出贡献维度</div>
          </div>
        </div>

        {/* 红蓝方胜率对比条 */}
        <div className="mt-3 rounded-card border border-line bg-surface p-4">
          <div className="flex items-center justify-between text-[13px] font-medium">
            <div className="flex items-center gap-1.5 text-blue-500">
              <span className="inline-block size-2 rounded-full bg-blue-500" />
              <span>蓝方（先手）：{bluePct}%</span>
            </div>
            <div className="text-[12px] text-ink-4">阵营选边胜率对比</div>
            <div className="flex items-center gap-1.5 text-red-500">
              <span>红方（后手）：{redPct}%</span>
              <span className="inline-block size-2 rounded-full bg-red-500" />
            </div>
          </div>

          <div className="mt-2.5 flex h-2.5 w-full overflow-hidden rounded-full bg-bg-sunk">
            <div
              className="bg-blue-500 transition-all duration-300"
              style={{
                width: `${
                  stats.blueWinRate + stats.redWinRate > 0
                    ? (stats.blueWinRate / (stats.blueWinRate + stats.redWinRate)) * 100
                    : 50
                }%`,
              }}
            />
            <div
              className="bg-red-500 transition-all duration-300"
              style={{
                width: `${
                  stats.blueWinRate + stats.redWinRate > 0
                    ? (stats.redWinRate / (stats.blueWinRate + stats.redWinRate)) * 100
                    : 50
                }%`,
              }}
            />
          </div>
        </div>
      </section>

      {/* 招牌选手荣誉榜（Top Players） */}
      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-bold text-ink flex items-center gap-2">
            <span className="text-accent">
              <IconUsers size={18} />
            </span>
            KPL 招牌选手榜（Top 5）
          </h2>
          <span className="text-[12px] text-ink-4">综合胜场与胜率权衡评定</span>
        </div>

        {topPlayers.length === 0 ? (
          <p className="mt-3 text-[13px] text-ink-4">暂无选手出场记录</p>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
            {topPlayers.map((p, idx) => (
              <IntentLink
                key={p.playerSlug}
                to={`/players/${p.playerSlug}`}
                className="card card-hover flex items-center gap-3 p-3"
              >
                <div className="relative">
                  {p.portrait ? (
                    <img
                      src={p.portrait}
                      alt={p.nickname}
                      width={44}
                      height={44}
                      loading="lazy"
                      className="h-11 w-11 rounded-full object-cover ring-1 ring-line"
                    />
                  ) : (
                    <div className="grid h-11 w-11 place-items-center rounded-full bg-bg-sunk text-[13px] font-bold text-ink-3">
                      {p.nickname.slice(0, 1)}
                    </div>
                  )}
                  <span
                    className={`absolute -top-1 -left-1 grid size-4 place-items-center rounded-full text-[9px] font-extrabold text-white ${
                      idx === 0
                        ? "bg-amber-500"
                        : idx === 1
                        ? "bg-slate-400"
                        : idx === 2
                        ? "bg-amber-700"
                        : "bg-ink-4"
                    }`}
                  >
                    {idx + 1}
                  </span>
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="truncate text-[13.5px] font-bold text-ink">{p.nickname}</span>
                    {p.isFmvpHero && (
                      <span className="rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 text-[9.5px] font-bold text-amber-500">
                        FMVP专属 · {p.fmvpSkinTitle}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center justify-between text-[11px] text-ink-4">
                    <span>{p.teamName ?? "自由选手"}</span>
                    <span className="font-semibold text-accent">统治力指数 {p.score}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-3">
                    <span className="font-semibold text-ink">
                      {(p.winRate * 100).toFixed(0)}% 胜率
                    </span>
                    <span>({p.games}战{p.wins}胜)</span>
                    {p.mvpCount > 0 && <span className="text-amber-500 font-bold">{p.mvpCount} MVP</span>}
                  </div>
                </div>
              </IntentLink>
            ))}
          </div>
        )}
      </section>

      {/* 战术阵容搭配（最佳搭档 & 克制关系） */}
      <section className="mt-8">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* 同队最佳搭档 Top 5 */}
          <div className="rounded-card border border-line bg-surface p-4">
            <h3 className="text-[14.5px] font-bold text-ink flex items-center justify-between">
              <span>同队高胜率搭档 (Top 5)</span>
              <span className="text-[11.5px] font-normal text-ink-4">同阵营胜率最高</span>
            </h3>
            {bestPartners.length === 0 ? (
              <p className="mt-3 text-[13px] text-ink-4">暂无足量搭档数据</p>
            ) : (
              <ul className="mt-3 divide-y divide-line-soft">
                {bestPartners.map((bp) => (
                  <li key={bp.heroId} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                    <IntentLink to={`/heroes/${bp.heroId}`} className="flex items-center gap-2.5 group">
                      <img
                        src={bp.avatar}
                        alt={bp.name}
                        width={36}
                        height={36}
                        loading="lazy"
                        className="size-9 rounded-lg object-cover ring-1 ring-line-soft"
                      />
                      <span className="text-[13.5px] font-semibold text-ink group-hover:text-accent transition-colors">
                        {bp.name}
                      </span>
                    </IntentLink>
                    <div className="text-right">
                      <div className="num text-[13.5px] font-bold text-red-500">
                        {(bp.winRate * 100).toFixed(1)}% 胜率
                      </div>
                      <div className="text-[11px] text-ink-4">配合 {bp.games} 局</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 对位克制关系 Top 5 */}
          <div className="rounded-card border border-line bg-surface p-4">
            <h3 className="text-[14.5px] font-bold text-ink flex items-center justify-between">
              <span>对位高胜率克制 (Top 5)</span>
              <span className="text-[11.5px] font-normal text-ink-4">面对该英雄时胜率</span>
            </h3>
            {counters.length === 0 ? (
              <p className="mt-3 text-[13px] text-ink-4">暂无足量克制数据</p>
            ) : (
              <ul className="mt-3 divide-y divide-line-soft">
                {counters.map((c) => (
                  <li key={c.heroId} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                    <IntentLink to={`/heroes/${c.heroId}`} className="flex items-center gap-2.5 group">
                      <img
                        src={c.avatar}
                        alt={c.name}
                        width={36}
                        height={36}
                        loading="lazy"
                        className="size-9 rounded-lg object-cover ring-1 ring-line-soft"
                      />
                      <span className="text-[13.5px] font-semibold text-ink group-hover:text-accent transition-colors">
                        {c.name}
                      </span>
                    </IntentLink>
                    <div className="text-right">
                      <div className="num text-[13.5px] font-bold text-green-500">
                        {(c.winRate * 100).toFixed(1)}% 胜率
                      </div>
                      <div className="text-[11px] text-ink-4">交手 {c.games} 局</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* 最近使用该英雄的比赛 */}
      <section className="mt-8">
        <h2 className="text-[15px] font-bold text-ink flex items-center gap-2">
          <span className="text-accent">
            <IconSword size={18} />
          </span>
          近期出场比赛对决
        </h2>
        {recentMatches.length === 0 ? (
          <p className="mt-3 text-[13px] text-ink-4">暂无最近对局</p>
        ) : (
          <ul className="mt-3 divide-y divide-line-soft overflow-hidden rounded-card border border-line bg-surface">
            {recentMatches.map((m) => (
              <li key={m.id}>
                <IntentLink
                  to={`/matches/${m.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-[13.5px] transition-colors hover:text-accent"
                >
                  <div className="min-w-0 flex-1 truncate text-ink">
                    <span className="font-semibold">{m.home.name}</span>
                    <span className="num font-bold px-2">
                      {m.home.score} : {m.away.score}
                    </span>
                    <span className="font-semibold">{m.away.name}</span>
                  </div>
                  <span className="hidden shrink-0 text-[12px] text-ink-4 sm:block">
                    {m.seasonName} {m.stage ? `· ${m.stage}` : ""}
                  </span>
                </IntentLink>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

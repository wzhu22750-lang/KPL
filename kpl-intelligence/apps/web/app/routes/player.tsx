import { useLoaderData } from "react-router";
import type { Route } from "./+types/player";
import type { PlayerDetailResponse } from "@aihot/contracts/kpl";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { name: "选手" };

export async function loader({ request, params }: Route.LoaderArgs) {
  return loadOr404<PlayerDetailResponse>(`/api/site/kb/players/${params.slug}`, { signal: request.signal });
}

export function meta({ loaderData, params }: Route.MetaArgs) {
  const name = loaderData?.player.nickname ?? params.slug;
  return pageMeta({ title: `${name}：职业履历、荣誉与数据`, description: `${name}的真实姓名、个人荣誉、转会履历、赛季数据变化、英雄池与相关赛事动态。`, path: `/players/${params.slug}` });
}

export function headers() {
  return edgeTtl(60);
}

const HONOR_LABEL: Record<string, string> = { fmvp: "总决赛FMVP", regular_mvp: "常规赛MVP", annual_mvp: "年度最佳选手", best_lineup: "最佳阵容一阵", champion: "冠军成员", finals_mvp: "总决赛FMVP" };
const HONOR_MEDAL: Record<string, string> = { fmvp: "🏅", regular_mvp: "⭐", annual_mvp: "🌟", best_lineup: "🎖️", champion: "🏆", finals_mvp: "🏅" };

const fmtDate = (d: string | null) => (d ? d.slice(0, 7).replace("-", ".") : "?");

export default function PlayerPage() {
  const { player, stints, seasons, heroes, honors, news } = useLoaderData<typeof loader>();
  const totals = seasons.reduce((acc, s) => ({ games: acc.games + s.games, mvps: acc.mvps + s.mvps, wins: acc.wins + s.wins }), { games: 0, mvps: 0, wins: 0 });
  return (
    <div className="pb-10">
      <PhoneBar title={player.nickname} />
      <header className="pt-3 lg:pt-1">
        <div className="flex items-center gap-4">
          {player.portrait && <img src={player.portrait} alt="" width={64} height={64} className="h-16 w-16 rounded-full object-cover" />}
          <div className="min-w-0">
            <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">
              {player.nickname}
              {player.realName && <span className="ml-2 text-[15px] font-medium text-ink-3">{player.realName}</span>}
            </h1>
            <p className="mt-1 text-[13px] text-ink-3">
              {player.position ?? "—"}
              {player.team && (
                <>
                  {" · "}
                  {player.teamSlug ? <IntentLink to={`/teams/${player.teamSlug}`} className="font-medium text-accent">{player.team}</IntentLink> : player.team}
                </>
              )}
              {player.debutAt && <span className="text-ink-4"> · {player.debutAt.slice(0, 4)} 年出道</span>}
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3 text-center">
          <div className="rounded-card border border-line bg-surface px-3 py-3">
            <span className="num block text-[20px] font-bold text-ink">{totals.games}</span>
            <span className="text-[11.5px] text-ink-4">场次</span>
          </div>
          <div className="rounded-card border border-line bg-surface px-3 py-3">
            <span className="num block text-[20px] font-bold text-accent">{totals.mvps}</span>
            <span className="text-[11.5px] text-ink-4">单局 MVP</span>
          </div>
          <div className="rounded-card border border-line bg-surface px-3 py-3">
            <span className="num block text-[20px] font-bold text-ink">{totals.games > 0 ? Math.round((totals.wins / totals.games) * 100) : 0}%</span>
            <span className="text-[11.5px] text-ink-4">胜率</span>
          </div>
        </div>
      </header>

      {player.bio && (
        <p className="mt-3 rounded-card border border-line bg-surface px-4 py-3 text-[13px] leading-relaxed text-ink-2">{player.bio}</p>
      )}

      {honors.length > 0 && (
        <section className="pt-7">
          <h2 className="text-[15px] font-bold text-ink">个人荣誉</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {honors.map((h, i) => (
              <li key={i} className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] ${h.kind === "fmvp" || h.kind === "finals_mvp" ? "border-amber/40 bg-amber/10" : "border-line bg-surface"}`}>
                <span aria-hidden>{HONOR_MEDAL[h.kind] ?? "🎖️"}</span>
                <span className={`font-semibold ${h.kind === "fmvp" || h.kind === "finals_mvp" ? "text-ink" : "text-ink-2"}`}>{h.title ?? h.season ?? HONOR_LABEL[h.kind]}</span>
                <span className="text-ink-4">{HONOR_LABEL[h.kind] ?? h.kind}{h.note ? ` · ${h.note}` : ""}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {stints.length > 0 && (
        <section className="pt-7">
          <h2 className="text-[15px] font-bold text-ink">职业转会履历</h2>
          <ol className="mt-4">
            {[...stints].reverse().map((s, i) => (
              <li key={i} className="relative flex gap-3 pb-5 last:pb-0">
                {i < stints.length - 1 && <span aria-hidden className="absolute left-[5px] top-4 h-[calc(100%-16px)] w-px bg-line" />}
                <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${s.leftAt ? "bg-line" : "bg-accent"}`} />
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-semibold text-ink">
                    {s.teamSlug ? <IntentLink to={`/teams/${s.teamSlug}`} className="hover:text-accent">{s.team ?? "未知战队"}</IntentLink> : s.team ?? "未知战队"}
                  </span>
                  <span className="num block text-[12px] text-ink-4">
                    {fmtDate(s.joinedAt)} – {s.leftAt ? fmtDate(s.leftAt) : "至今"}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {seasons.length > 0 && (
        <section className="pt-7">
          <h2 className="text-[15px] font-bold text-ink">赛季数据</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[440px] text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left text-ink-4">
                  <th className="py-1.5 pr-2 font-medium">赛季</th>
                  <th className="py-1.5 pr-2 text-right font-medium">场次</th>
                  <th className="py-1.5 pr-2 text-right font-medium">胜率</th>
                  <th className="py-1.5 pr-2 text-right font-medium">MVP</th>
                  <th className="py-1.5 text-right font-medium">场均 K/D/A</th>
                </tr>
              </thead>
              <tbody>
                {seasons.map((s) => (
                  <tr key={s.seasonId} className="border-b border-line-soft/60 last:border-0">
                    <td className="py-1.5 pr-2 font-medium text-ink">{s.seasonName}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-ink-2">{s.games}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums text-ink-2">{s.games > 0 ? Math.round((s.wins / s.games) * 100) : 0}%</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums font-semibold text-amber">{s.mvps}</td>
                    <td className="py-1.5 text-right tabular-nums text-ink-3">{s.avgKills ?? "-"}/{s.avgDeaths ?? "-"}/{s.avgAssists ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {heroes.length > 0 && (
        <section className="pt-7">
          <h2 className="text-[15px] font-bold text-ink">英雄池</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {heroes.map((h) => (
              <li key={h.hero} className="flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1.5 pr-3 text-[12.5px]">
                {h.heroIcon && <img src={h.heroIcon} alt="" width={24} height={24} loading="lazy" className="h-6 w-6 rounded-full object-cover" />}
                <span className="font-medium text-ink">{h.hero}</span>
                <span className="num text-ink-4">{h.games} 场</span>
                <span className="num font-semibold text-accent">{h.games > 0 ? Math.round((h.wins / h.games) * 100) : 0}%</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {news.length > 0 && (
        <section className="pt-7">
          <h2 className="text-[15px] font-bold text-ink">相关赛事动态</h2>
          <ul className="mt-3 divide-y divide-line-soft overflow-hidden rounded-card border border-line bg-surface">
            {news.map((n) => (
              <li key={n.id}>
                <IntentLink to={`/items/${n.id}`} className="block px-4 py-3 transition-colors hover:text-accent">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">{n.title}</span>
                    {n.selected && <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[10.5px] font-semibold text-accent">精选</span>}
                  </span>
                  {n.summary && <span className="mt-1 line-clamp-2 block text-[12.5px] leading-relaxed text-ink-3">{n.summary}</span>}
                </IntentLink>
              </li>
            ))}
          </ul>
        </section>
      )}

      {stints.length === 0 && seasons.length === 0 && heroes.length === 0 && (
        <p className="mt-6 text-[13px] text-ink-4">该选手暂无对局数据（数据自 2026 春季赛起累积）。</p>
      )}
    </div>
  );
}

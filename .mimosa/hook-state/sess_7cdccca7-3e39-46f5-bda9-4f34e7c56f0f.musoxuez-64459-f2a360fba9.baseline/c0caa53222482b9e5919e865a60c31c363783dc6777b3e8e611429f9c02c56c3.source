import { useLoaderData } from "react-router";
import type { Route } from "./+types/match";
import type { MatchDetailResponse } from "@aihot/contracts/kpl";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { name: "比赛" };

export async function loader({ request, params }: Route.LoaderArgs) {
  return loadOr404<MatchDetailResponse>(`/api/site/kb/matches/${params.id}`, { signal: request.signal });
}

export function meta({ loaderData, params }: Route.MetaArgs) {
  const m = loaderData?.match;
  const title = m ? `${m.home.name} ${m.home.score}:${m.away.score} ${m.away.name}` : params.id;
  return pageMeta({ title, description: m ? `${m.seasonName} ${m.stage ?? ""}：每局 BP、选手数据与关键统计。` : "比赛详情", path: `/matches/${params.id}` });
}

export function headers() {
  return edgeTtl(60);
}

const fmt = (secs: number | null) => (secs == null ? "" : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`);
const fmtGold = (g: number | null) => (g == null ? "—" : g >= 10000 ? `${(g / 1000).toFixed(1)}k` : String(g));

function BpLane({ game }: { game: MatchDetailResponse["games"][number] }) {
  const side = (s: "blue" | "red") => game.bp.filter((b) => b.side === s);
  const lane = (s: "blue" | "red") => (
    <div className="min-w-0 flex-1">
      {[...side(s).filter((b) => b.type === "ban"), ...side(s).filter((b) => b.type === "pick")].length === 0 ? (
        <span className="text-[12px] text-ink-4">暂无 BP 数据</span>
      ) : (
        <>
          <div className="flex flex-wrap gap-1">
            {side(s).filter((b) => b.type === "ban").map((b) => (
              <span key={b.step} title={`${b.side === "blue" ? "蓝" : "红"}方禁用 · 第${b.step}步`} className="rounded-md bg-bg-sunk px-1.5 py-0.5 text-[11px] text-ink-4 line-through">{b.hero.name}</span>
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {side(s).filter((b) => b.type === "pick").map((b) => (
              <span key={b.step} title={`${b.side === "blue" ? "蓝" : "红"}方选用${b.player ? ` · ${b.player}` : ""} · 第${b.step}步`} className="rounded-md border border-line-soft bg-surface px-1.5 py-0.5 text-[11.5px] font-medium text-ink">
                {b.hero.name}
                {b.player && <span className="ml-1 text-[10px] font-normal text-ink-4">{b.player}</span>}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
  return (
    <div className="flex gap-3">
      {lane("blue")}
      {lane("red")}
    </div>
  );
}

function PlayersTable({ game }: { game: MatchDetailResponse["games"][number] }) {
  const rows = [...game.players].sort((a, b) => (b.mvpScore ?? 0) - (a.mvpScore ?? 0));
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[430px] text-[12px]">
        <thead>
          <tr className="border-b border-line-soft text-left text-ink-4">
            <th className="py-1.5 pr-2 font-medium">选手</th>
            <th className="py-1.5 pr-2 font-medium">英雄</th>
            <th className="py-1.5 pr-2 text-right font-medium">K/D/A</th>
            <th className="py-1.5 pr-2 text-right font-medium">经济</th>
            <th className="py-1.5 pr-2 text-right font-medium">输出</th>
            <th className="py-1.5 text-right font-medium">评分</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={`${p.nickname}-${i}`} className={`border-b border-line-soft/60 last:border-0 ${p.mvp ? "bg-amber/5" : ""}`}>
              <td className="py-1.5 pr-2 font-medium text-ink">
                {p.nickname}
                {p.mvp && <span className="ml-1 rounded bg-amber/15 px-1 text-[10px] font-bold text-amber">MVP</span>}
              </td>
              <td className="py-1.5 pr-2 text-ink-3">{p.hero ?? "—"}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-ink-2">{p.kills ?? "-"}/{p.deaths ?? "-"}/{p.assists ?? "-"}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-ink-3">{fmtGold(p.gold)}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums text-ink-3">{p.damage != null ? fmtGold(p.damage) : "—"}</td>
              <td className="py-1.5 text-right tabular-nums font-semibold text-ink-2">{p.mvpScore ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MatchPage() {
  const { match, blue, red, games } = useLoaderData<typeof loader>();
  return (
    <div className="pb-10">
      <PhoneBar back={{ to: "/matches", label: "赛程" }} title={`${match.home.name} vs ${match.away.name}`} />
      <header className="pt-3 lg:pt-1">
        <p className="text-[12.5px] text-ink-4">{match.seasonName}{match.stage ? ` · ${match.stage}` : ""} · BO{match.bo ?? "?"}</p>
        <div className="mt-3 flex items-center justify-center gap-4 sm:gap-8">
          <IntentLink to={`/teams/${blue.slug}`} className="flex min-w-0 flex-1 flex-col items-center gap-2 sm:flex-row-reverse sm:justify-end">
            {blue.logo && <img src={blue.logo} alt="" width={56} height={56} className="h-14 w-14 rounded-full object-contain" />}
            <span className="truncate text-[16px] font-bold text-ink">{blue.name}</span>
          </IntentLink>
          <span className="num shrink-0 text-[34px] font-bold leading-none text-ink sm:text-[42px]">{match.home.score} : {match.away.score}</span>
          <IntentLink to={`/teams/${red.slug}`} className="flex min-w-0 flex-1 flex-col items-center gap-2 sm:flex-row sm:justify-start">
            {red.logo && <img src={red.logo} alt="" width={56} height={56} className="h-14 w-14 rounded-full object-contain" />}
            <span className="truncate text-[16px] font-bold text-ink">{red.name}</span>
          </IntentLink>
        </div>
        {match.winner && <p className="mt-2 text-center text-[12.5px] text-ink-3">{(match.winner === blue.slug ? blue : red).name} 获胜</p>}
      </header>

      <section className="pt-7">
        <h2 className="text-[15px] font-bold text-ink">每局详情</h2>
        <ul className="mt-3 space-y-3">
          {games.map((g) => (
            <li key={g.id} className="rounded-card border border-line bg-surface px-4 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[14px] font-bold text-ink">
                  第 {g.gameNo} 局
                  {g.mode === "pinnacle" && <span className="ml-2 rounded bg-amber/15 px-1.5 py-0.5 text-[10.5px] font-bold text-amber">巅峰对决</span>}
                </h3>
                <p className="text-[12px] text-ink-4">
                  {g.winner && <span className="font-semibold text-accent">{g.winner} 胜</span>}
                  {g.durationSecs != null && <span> · {fmt(g.durationSecs)}</span>}
                  {g.killsBlue != null && <span> · 击杀 {g.killsBlue}:{g.killsRed}</span>}
                  {g.goldBlue != null && <span> · 经济 {fmtGold(g.goldBlue)}:{fmtGold(g.goldRed)}</span>}
                  {g.mvp && <span> · MVP <span className="font-semibold text-ink-2">{g.mvp}</span></span>}
                </p>
              </div>
              {g.bp.length > 0 && <div className="mt-3"><BpLane game={g} /></div>}
              <PlayersTable game={g} />
            </li>
          ))}
        </ul>
        {games.length === 0 && <p className="mt-2 text-[13px] text-ink-4">对局数据尚未回灌。</p>}
      </section>
    </div>
  );
}

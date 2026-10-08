import { useLoaderData, useSearchParams } from "react-router";
import type { Route } from "./+types/standings";
import type { StandingRow, StandingsResponse } from "@aihot/contracts/kpl";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";
import { IconTrophy } from "../components/icons";

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

function GroupHeaderStyle(groupName: string) {
  if (groupName === "大师组") {
    return { border: "border-amber-500/40", badge: "bg-amber-500/15 text-amber-500 border border-amber-500/30", title: "大师组积分榜", sub: "组外单循环 · 组内独立排名" };
  }
  if (groupName === "精英组") {
    return { border: "border-slate-400/40", badge: "bg-slate-400/15 text-ink-3 border border-slate-400/30", title: "精英组积分榜", sub: "组外单循环 · 组内独立排名" };
  }
  if (groupName === "S组") {
    return {
      border: "border-amber-500/40",
      badge: "bg-amber-500/15 text-amber-500 border border-amber-500/30",
      title: "S 组积分榜",
      sub: "晋级规则以当前赛段官方赛制为准",
    };
  }
  if (groupName === "A组") {
    return {
      border: "border-slate-400/40",
      badge: "bg-slate-400/15 text-slate-300 border border-slate-400/30",
      title: "A 组积分榜",
      sub: "晋级规则以当前赛段官方赛制为准",
    };
  }
  if (groupName === "B组") {
    return {
      border: "border-amber-700/40",
      badge: "bg-amber-700/15 text-amber-600 border border-amber-700/30",
      title: "B 组积分榜",
      sub: "晋级规则以当前赛段官方赛制为准",
    };
  }
  return {
    border: "border-line",
    badge: "bg-bg-sunk text-ink-3 border border-line",
    title: groupName,
    sub: "仅汇总本赛段战绩",
  };
}

function GroupTable({ groupName, rows }: { groupName: string; rows: StandingRow[] }) {
  const meta = GroupHeaderStyle(groupName);

  return (
    <div className={`overflow-hidden rounded-card border ${meta.border} bg-surface shadow-sm`}>
      {/* 组头部 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 border-b border-line bg-surface-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-[11px] font-extrabold ${meta.badge}`}>
            {groupName}
          </span>
          <h3 className="text-[15px] font-bold text-ink">{meta.title}</h3>
        </div>
        <p className="text-[11.5px] text-ink-4">{meta.sub}</p>
      </div>

      {/* 表格 */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[540px] text-[13px]">
          <thead>
            <tr className="border-b border-line-soft bg-bg-sunk/30 text-left text-ink-4 text-[11.5px]">
              <th className="py-2.5 pl-4 pr-2 font-medium w-12 text-center">排名</th>
              <th className="py-2.5 pr-2 font-medium">战队</th>
              <th className="py-2.5 pr-2 font-medium text-center">已赛</th>
              <th className="py-2.5 pr-2 font-medium text-center">胜 - 负</th>
              <th className="py-2.5 pr-2 font-medium text-center">净胜局</th>
              <th className="py-2.5 pr-2 font-medium text-center">胜率</th>
              <th className="py-2.5 pr-2 font-medium text-center">积分</th>
              <th className="py-2.5 pr-4 font-medium text-right">近期走势</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft/60">
            {rows.map((r) => {
              return (
                <tr
                  key={r.team.slug}
                  className="transition-colors hover:bg-bg-sunk/40 group cursor-pointer"
                >
                  {/* 排名 */}
                  <td className="py-3 pl-4 pr-2 text-center font-bold">
                    <span
                      className={`inline-grid size-5.5 place-items-center rounded-full text-[11px] ${
                        r.rank === 1
                          ? "bg-amber-500 text-white font-extrabold"
                          : r.rank === 2
                          ? "bg-slate-400 text-white font-bold"
                          : r.rank === 3
                          ? "bg-amber-700 text-white font-bold"
                          : "text-ink-4 font-medium"
                      }`}
                    >
                      {r.rank}
                    </span>
                  </td>

                  {/* 战队 */}
                  <td className="py-3 pr-2">
                    <IntentLink
                      to={`/teams/${r.team.slug}`}
                      className="flex items-center gap-2.5 text-ink group-hover:text-accent font-semibold transition-colors"
                    >
                      {r.team.logo && (
                        <img
                          src={r.team.logo}
                          alt={r.team.name}
                          width={26}
                          height={26}
                          className="size-6.5 rounded-full object-contain shrink-0"
                        />
                      )}
                      <span className="truncate">{r.team.name}</span>
                    </IntentLink>
                  </td>

                  <td className="py-3 pr-2 text-center tabular-nums text-ink-3">{r.matchesPlayed}</td>
                  {/* 胜 - 负 */}
                  <td className="py-3 pr-2 text-center tabular-nums text-ink">
                    <span className="font-bold text-accent">{r.wins}</span>
                    <span className="text-ink-4 mx-1">-</span>
                    <span>{r.losses}</span>
                  </td>

                  {/* 净胜局 */}
                  <td className="py-3 pr-2 text-center tabular-nums font-semibold">
                    <span className={r.gameDiff > 0 ? "text-red-500" : r.gameDiff < 0 ? "text-blue-500" : "text-ink-4"}>
                      {r.gameDiff > 0 ? `+${r.gameDiff}` : r.gameDiff}
                    </span>
                  </td>

                  {/* 胜率 */}
                  <td className="py-3 pr-2 text-center tabular-nums text-ink-3">
                    {r.matchesPlayed ? `${(r.winRate * 100).toFixed(1)}%` : "—"}
                  </td>

                  {/* 积分 */}
                  <td className="py-3 pr-2 text-center tabular-nums font-extrabold text-[14px] text-ink">
                    {r.points}
                  </td>

                  {/* 走势与区域提示 */}
                  <td className="py-3 pr-4 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="text-[11.5px] text-ink-4 font-medium">
                        {r.streak}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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
    <div className="pb-14">
      <PhoneBar title="赛季积分榜" large sub={`${season.name} · ${currentStage}`} />

      {/* 顶部控制器 */}
      <header className="pt-3 lg:pt-1">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-line pb-4">
          <div>
            <h1 data-page-title="" className="text-[26px] font-bold tracking-tight text-ink flex items-center gap-2.5">
              <span className="text-accent">
                <IconTrophy size={26} />
              </span>
              {season.name} 积分榜
            </h1>
            <p className="mt-1 text-[13px] text-ink-3">
              按赛季与赛段统计战队积分、胜负和净胜局；分组以已核实的官方名单为准
            </p>
          </div>

          {/* 赛季切换下拉 */}
          <div className="shrink-0">
            <select
              value={season.id}
              onChange={(e) => handleSeasonChange(e.target.value)}
              aria-label="切换赛季"
              className="h-9 rounded-lg border border-line bg-surface px-3 text-[13px] font-semibold text-ink focus:border-accent focus:outline-none"
            >
              {availableSeasons.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 赛段 Tab 横滑 */}
        {stages.length > 0 && (
          <div className="mt-4 flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
            {stages.map((stg) => {
              const active = currentStage === stg;
              return (
                <button
                  key={stg}
                  type="button"
                  onClick={() => handleStageChange(stg)}
                  className={`shrink-0 rounded-full px-4 py-1.5 text-[13px] transition-all ${
                    active
                      ? "bg-accent text-white font-semibold shadow-sm"
                      : "bg-surface border border-line text-ink-3 hover:text-ink hover:border-ink-4"
                  }`}
                >
                  {stg}
                </button>
              );
            })}
          </div>
        )}
      </header>

      <aside className="mt-4 rounded-card border border-line bg-surface px-4 py-3 text-[12px] leading-relaxed text-ink-3" aria-label="统计口径与赛制">
        {rulesDescription && <p>{rulesDescription}</p>}
        {notes?.map(note => <p key={note} className="mt-1">{note}</p>)}
        {rulesSourceUrl && <a href={rulesSourceUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-accent underline">官方赛制与分组公告</a>}
      </aside>

      {/* 分组积分榜列表 */}
      <section className="mt-6 space-y-6">
        {groupKeys.length === 0 ? (
          <div className="rounded-card border border-line bg-surface py-12 text-center text-[13.5px] text-ink-4">
            当前赛段暂无对局积分数据
          </div>
        ) : (
          groupKeys.map((groupName) => (
            <GroupTable
              key={groupName}
              groupName={groupName}
              rows={standingsByGroup[groupName] ?? []}
            />
          ))
        )}
      </section>
    </div>
  );
}

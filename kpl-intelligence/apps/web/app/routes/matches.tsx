import { useLoaderData, useNavigate } from "react-router";
import type { Route } from "./+types/matches";
import type { ScheduleMatch, ScheduleResponse } from "@aihot/contracts/kpl";
import { apiGet, edgeTtl } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";

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

export function headers() {
  return edgeTtl(30);
}

const fmtDate = (iso: string | null) => (iso ? iso.slice(5, 10).replace("-", "/") : "");
const fmtFullDate = (iso: string | null) => (iso ? iso.slice(0, 10).replace(/-/g, "/") : "其他日期");
const fmtTime = (iso: string | null) => (iso ? iso.slice(11, 16) : "");

export default function MatchesPage() {
  const { season, availableSeasons = [], matches = [] } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  // 按日期将比赛分段
  const matchesByDate = new Map<string, ScheduleMatch[]>();
  for (const m of matches) {
    const rawDate = m.playedAt ?? m.scheduledAt;
    const dateKey = fmtFullDate(rawDate);
    if (!matchesByDate.has(dateKey)) {
      matchesByDate.set(dateKey, []);
    }
    matchesByDate.get(dateKey)!.push(m);
  }

  // 快捷赛季药丸列表（展示最新几个赛季）
  const quickSeasons = availableSeasons.slice(0, 6);

  return (
    <div className="pb-10">
      <PhoneBar title="赛程" />
      <header className="pb-3 pt-3 lg:pt-1">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">赛程与赛果</h1>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-3">
              {season?.name ?? "暂无赛季数据"} · 点开看每局的 BP 与选手数据
            </p>
          </div>

          {/* 赛季切换器下拉框 */}
          {availableSeasons.length > 0 && (
            <div className="flex items-center gap-2">
              <label htmlFor="season-select" className="shrink-0 text-[12.5px] font-medium text-ink-3">
                选择赛季:
              </label>
              <select
                id="season-select"
                value={season?.id ?? ""}
                onChange={(e) => navigate(`/matches?season=${encodeURIComponent(e.target.value)}`)}
                className="rounded-control border border-line bg-surface px-3 py-1.5 text-[13px] font-medium text-ink transition hover:border-ink-4 focus:border-accent focus:outline-none cursor-pointer"
              >
                {availableSeasons.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} {s.isCurrent ? "★最新" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* 快捷赛季切换胶囊横向滚动栏 */}
        {quickSeasons.length > 1 && (
          <div className="mt-3 flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
            {quickSeasons.map((s) => {
              const active = season?.id === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => navigate(`/matches?season=${encodeURIComponent(s.id)}`)}
                  className={`shrink-0 rounded-full px-3 py-1 text-[12px] font-medium transition ${
                    active
                      ? "bg-accent text-white shadow-sm"
                      : "bg-bg-sunk text-ink-3 hover:bg-surface hover:text-ink hover:border-line border border-transparent"
                  }`}
                >
                  {s.name.replace(/^[0-9]{4}年?/, "") || s.name}
                  {s.isCurrent && !active && <span className="ml-1 text-[10px] text-accent">●</span>}
                </button>
              );
            })}
          </div>
        )}
      </header>

      {/* 按日期分段展示赛程列表 */}
      <div className="mt-2 space-y-5">
        {[...matchesByDate.entries()].map(([dateKey, list]) => (
          <div key={dateKey}>
            <div className="mb-2 flex items-center justify-between px-1">
              <h2 className="text-[13px] font-bold text-ink-2">{dateKey}</h2>
              <span className="text-[11.5px] text-ink-4">{list.length} 场比赛</span>
            </div>
            <ul className="divide-y divide-line-soft overflow-hidden rounded-card border border-line bg-surface shadow-sm">
              {list.map((m) => {
                const homeWon = m.winner === m.home.slug;
                const awayWon = m.winner === m.away.slug;
                const isFinished = m.status === "finished";
                const isLive = m.status === "live";
                const atTime = fmtTime(m.playedAt ?? m.scheduledAt);

                return (
                  <li key={m.id}>
                    <IntentLink to={`/matches/${m.id}`} className="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-bg-sunk/40">
                      {/* 时间与状态徽标 */}
                      <div className="flex w-14 shrink-0 flex-col items-start gap-1">
                        <span className="text-[12px] font-medium tabular-nums text-ink-3">{atTime}</span>
                        {isLive ? (
                          <span className="inline-flex items-center gap-1 rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-bold text-rose-600">
                            <span className="size-1.5 rounded-full bg-rose-600 animate-pulse" />
                            进行中
                          </span>
                        ) : isFinished ? (
                          <span className="rounded bg-bg-sunk px-1.5 py-0.5 text-[10px] text-ink-4">已完赛</span>
                        ) : (
                          <span className="rounded bg-accent-soft/30 px-1.5 py-0.5 text-[10px] font-medium text-accent">未赛</span>
                        )}
                      </div>

                      {/* 战队 A */}
                      <span className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right">
                        <span className={`truncate text-[14px] ${homeWon ? "font-bold text-ink" : isFinished ? "text-ink-4" : "font-medium text-ink"}`}>
                          {m.home.name}
                        </span>
                        {m.home.logo && (
                          <img src={m.home.logo} alt="" width={26} height={26} loading="lazy" className="size-[26px] shrink-0 rounded-full object-contain" />
                        )}
                      </span>

                      {/* 比分牌 */}
                      <span
                        className={`shrink-0 rounded-full px-3 py-1 text-[14px] font-bold tabular-nums ${
                          isLive
                            ? "bg-rose-500/10 text-rose-600"
                            : isFinished
                            ? "bg-bg-sunk text-ink font-mono"
                            : "bg-bg-sunk/60 text-ink-4 font-normal"
                        }`}
                      >
                        {m.status === "scheduled" ? "VS" : `${m.home.score} : ${m.away.score}`}
                      </span>

                      {/* 战队 B */}
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        {m.away.logo && (
                          <img src={m.away.logo} alt="" width={26} height={26} loading="lazy" className="size-[26px] shrink-0 rounded-full object-contain" />
                        )}
                        <span className={`truncate text-[14px] ${awayWon ? "font-bold text-ink" : isFinished ? "text-ink-4" : "font-medium text-ink"}`}>
                          {m.away.name}
                        </span>
                      </span>

                      {/* 阶段名称与直达 */}
                      <div className="hidden shrink-0 items-center gap-2 text-right sm:flex">
                        <span className="text-[12px] text-ink-4">{m.stage ?? ""}</span>
                        <span className="text-[11px] text-ink-4 group-hover:text-accent">详情 ›</span>
                      </div>
                    </IntentLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      {matches.length === 0 && (
        <div className="mt-8 rounded-card border border-line bg-surface p-8 text-center">
          <p className="text-[14px] text-ink-3">该赛季暂无比赛数据。</p>
        </div>
      )}
    </div>
  );
}

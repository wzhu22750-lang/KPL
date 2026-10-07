import { useState, useMemo } from "react";
import { useLoaderData, useSearchParams, type ShouldRevalidateFunction } from "react-router";
import type { Route } from "./+types/heroes";
import type { HeroListResponse } from "@aihot/contracts/kpl";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";
import { IconSearch, IconSword } from "../components/icons";

export const handle: Screen = { name: "英雄榜" };

export const shouldRevalidate: ShouldRevalidateFunction = ({ currentUrl, nextUrl }) => {
  return currentUrl.pathname !== nextUrl.pathname;
};

export async function loader({ request }: Route.LoaderArgs) {
  return loadOr404<HeroListResponse>("/api/site/kb/heroes", { signal: request.signal });
}

export function meta() {
  return pageMeta({
    title: "KPL 英雄榜：职业赛场 BP 登场率与版本强度梯度",
    description: "涵盖全部英雄的职业赛场出场率、禁用率、总胜率、版本梯队评定与招牌选手荣誉榜。",
    path: "/heroes",
  });
}

export function headers() {
  return edgeTtl(60);
}

const POSITIONS = ["全部", "对抗路", "打野", "中路", "发育路", "游走"] as const;

const SORTS = [
  { key: "bpRate", label: "BP率最高" },
  { key: "winRate", label: "胜率最高" },
  { key: "picks", label: "出场最多" },
  { key: "tier", label: "版本强势(T0)" },
] as const;

function TierBadge({ tier }: { tier: string }) {
  if (tier === "T0") {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px] font-extrabold bg-amber-500/15 text-amber-500 border border-amber-500/30">
        T0
      </span>
    );
  }
  if (tier === "T0.5") {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px] font-bold bg-amber-400/10 text-amber-400 border border-amber-400/20">
        T0.5
      </span>
    );
  }
  if (tier === "T1") {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px] font-semibold bg-blue-500/10 text-blue-500 border border-blue-500/20">
        T1
      </span>
    );
  }
  if (tier === "T2") {
    return (
      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px] font-medium bg-ink-4/10 text-ink-3">
        T2
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px] text-ink-4 bg-bg-sunk">
      T3
    </span>
  );
}

export default function HeroesPage() {
  const { heroes, totalGames } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchKeyword, setSearchKeyword] = useState("");

  const selectedPos = searchParams.get("pos") || "全部";
  const selectedSort = searchParams.get("sort") || "bpRate";

  const handlePosChange = (pos: string) => {
    const next = new URLSearchParams(searchParams);
    if (pos === "全部") next.delete("pos");
    else next.set("pos", pos);
    setSearchParams(next, { preventScrollReset: true });
  };

  const handleSortChange = (sort: string) => {
    const next = new URLSearchParams(searchParams);
    if (sort === "bpRate") next.delete("sort");
    else next.set("sort", sort);
    setSearchParams(next, { preventScrollReset: true });
  };

  const filteredHeroes = useMemo(() => {
    let list = heroes;
    if (selectedPos && selectedPos !== "全部") {
      list = list.filter((h) => h.primaryPos === selectedPos || h.positions.includes(selectedPos));
    }
    if (selectedSort === "winRate") {
      list = [...list].sort((a, b) => {
        const aQual = a.picks >= 10 ? 1 : 0;
        const bQual = b.picks >= 10 ? 1 : 0;
        if (aQual !== bQual) return bQual - aQual;
        return b.winRate - a.winRate || b.picks - a.picks;
      });
    } else if (selectedSort === "picks") {
      list = [...list].sort((a, b) => b.picks - a.picks || b.bpRate - a.bpRate);
    } else if (selectedSort === "tier") {
      const tierWeight: Record<string, number> = { T0: 5, "T0.5": 4, T1: 3, T2: 2, T3: 1 };
      list = [...list].sort((a, b) => (tierWeight[b.versionStrength] ?? 0) - (tierWeight[a.versionStrength] ?? 0) || b.bpRate - a.bpRate);
    } else {
      list = [...list].sort((a, b) => b.bpRate - a.bpRate || b.picks - a.picks);
    }
    if (searchKeyword.trim()) {
      const q = searchKeyword.trim().toLowerCase();
      list = list.filter(
        (h) =>
          h.name.toLowerCase().includes(q) ||
          h.id.toLowerCase().includes(q) ||
          h.primaryPos.toLowerCase().includes(q) ||
          h.functionTags.some((t) => t.toLowerCase().includes(q))
      );
    }
    return list;
  }, [heroes, selectedPos, selectedSort, searchKeyword]);

  return (
    <div className="pb-14">
      <PhoneBar title="英雄榜" large sub={`基于职业赛事 ${totalGames.toLocaleString()} 局对局样本`} />

      <header className="pt-3 lg:pt-1">
        <div className="hidden lg:flex items-center justify-between">
          <div>
            <h1 data-page-title="" className="text-[26px] font-bold tracking-tight text-ink flex items-center gap-2.5">
              <span className="text-accent">
                <IconSword size={26} />
              </span>
              KPL 职业英雄榜
            </h1>
            <p className="mt-1 text-[13px] text-ink-3">
              聚合全职业联赛 BP 登场率、胜率分布、红蓝方优势与选手招牌英雄（统计样本 {totalGames.toLocaleString()} 局）
            </p>
          </div>
        </div>

        {/* 筛选与搜索控制器 */}
        <div className="mt-5 space-y-3.5">
          {/* 分路 Tab 横滑 */}
          <div className="flex items-center justify-between gap-2 border-b border-line pb-2.5">
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
              {POSITIONS.map((pos) => {
                const active = selectedPos === pos;
                return (
                  <button
                    key={pos}
                    type="button"
                    onClick={() => handlePosChange(pos)}
                    className={`shrink-0 rounded-full px-3.5 py-1 text-[13px] transition-all ${
                      active
                        ? "bg-accent text-white font-semibold shadow-sm"
                        : "bg-surface border border-line text-ink-3 hover:text-ink hover:border-ink-4"
                    }`}
                  >
                    {pos}
                  </button>
                );
              })}
            </div>

            {/* 排序下拉 */}
            <div className="shrink-0 flex items-center gap-1.5">
              <select
                value={selectedSort}
                onChange={(e) => handleSortChange(e.target.value)}
                aria-label="排序规则"
                className="h-8 rounded-lg border border-line bg-surface px-2 text-[12.5px] font-medium text-ink focus:border-accent focus:outline-none"
              >
                {SORTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 快速搜索栏 */}
          <div className="relative">
            <span className="absolute inset-y-0 left-3 flex items-center text-ink-4 pointer-events-none">
              <IconSearch size={16} />
            </span>
            <input
              type="text"
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              placeholder="搜索英雄名称、定位或战术标签（如：不知火舞、爆发射手）..."
              className="h-9 w-full rounded-control border border-line bg-surface pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none"
            />
            {searchKeyword && (
              <button
                type="button"
                onClick={() => setSearchKeyword("")}
                className="absolute inset-y-0 right-2.5 flex items-center text-[12px] text-ink-4 hover:text-ink"
              >
                清空
              </button>
            )}
          </div>
        </div>
      </header>

      {/* 英雄卡片网格 */}
      <section className="mt-6">
        {filteredHeroes.length === 0 ? (
          <div className="rounded-card border border-line bg-surface py-12 text-center text-[13.5px] text-ink-4">
            未找到符合条件的英雄
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {filteredHeroes.map((h) => {
              const bpPct = (h.bpRate * 100).toFixed(1);
              const winPct = (h.winRate * 100).toFixed(1);

              return (
                <IntentLink
                  key={h.id}
                  to={`/heroes/${h.id}`}
                  className="card card-hover group relative flex flex-col justify-between overflow-hidden p-3.5"
                >
                  <div>
                    {/* 顶部头像与基础标识 */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="relative">
                        <img
                          src={h.avatar}
                          alt={h.name}
                          width={48}
                          height={48}
                          loading="lazy"
                          className="h-12 w-12 rounded-xl object-cover ring-1 ring-line-soft transition-transform duration-200 group-hover:scale-105"
                        />
                        <span className="absolute -bottom-1 -right-1 rounded bg-bg-sunk/90 px-1 text-[9.5px] font-bold text-ink-3">
                          {h.primaryPos}
                        </span>
                      </div>
                      <TierBadge tier={h.versionStrength} />
                    </div>

                    {/* 英雄名称与战术标签 */}
                    <div className="mt-2.5">
                      <h2 className="text-[15px] font-bold text-ink group-hover:text-accent transition-colors">
                        {h.name}
                      </h2>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {h.functionTags.slice(0, 2).map((t, idx) => (
                          <span
                            key={idx}
                            className="rounded bg-bg-sunk px-1.5 py-0.5 text-[10.5px] text-ink-3"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* 核心数据进度条 */}
                  <div className="mt-4 pt-3 border-t border-line-soft space-y-2">
                    {/* BP 参与率 */}
                    <div>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-ink-4">BP 参与率</span>
                        <span className="num font-semibold text-ink">{bpPct}%</span>
                      </div>
                      <div className="mt-1 h-1.5 w-full rounded-full bg-bg-sunk overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent transition-all duration-300"
                          style={{ width: `${Math.min(100, Math.max(2, h.bpRate * 100))}%` }}
                        />
                      </div>
                    </div>

                    {/* 胜率 */}
                    <div>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-ink-4">
                          胜率 <span className="text-[10px] text-ink-4">({h.picks}场)</span>
                        </span>
                        <span
                          className={`num font-semibold ${
                            h.winRate >= 0.52
                              ? "text-red-500 font-bold"
                              : h.winRate <= 0.47
                              ? "text-blue-500"
                              : "text-ink"
                          }`}
                        >
                          {winPct}%
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 w-full rounded-full bg-bg-sunk overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            h.winRate >= 0.5 ? "bg-red-500" : "bg-blue-500"
                          }`}
                          style={{ width: `${Math.min(100, Math.max(2, h.winRate * 100))}%` }}
                        />
                      </div>
                    </div>

                    {/* 招牌选手小贴士 */}
                    {h.topPlayer && (
                      <div className="mt-2.5 flex items-center justify-between pt-1.5 text-[11px] text-ink-3 border-t border-line-soft/40">
                        <span className="text-ink-4 text-[10.5px]">招牌选手</span>
                        <div className="flex items-center gap-1 min-w-0">
                          {h.topPlayer.isFmvpHero && (
                            <span className="rounded bg-amber-500/15 border border-amber-500/30 px-1 text-[9px] font-bold text-amber-500">
                              FMVP
                            </span>
                          )}
                          <span className="truncate max-w-[90px] font-medium text-ink">
                            {h.topPlayer.nickname}
                          </span>
                          <span className="text-[10px] text-ink-4">
                            ({(h.topPlayer.winRate * 100).toFixed(0)}%)
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </IntentLink>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

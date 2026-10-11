import { useEffect, useMemo } from "react";
import { useLoaderData, useSearchParams, type ShouldRevalidateFunction } from "react-router";
import type { Route } from "./+types/heroes";
import type { HeroListResponse } from "@aihot/contracts/kpl";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { formatNumber, formatRate } from "../lib/esports";
import { EsportsNav, PageHeader, Portrait, RateBar, TierBadge } from "../components/esports/Esports";
import { PhoneBar } from "../components/shell/PhoneBar";
import { IntentLink } from "../components/ui/IntentLink";
import type { Screen } from "../components/shell/screens";
import { IconSearch } from "../components/icons";

export const handle: Screen = { name: "英雄榜" };
export const shouldRevalidate: ShouldRevalidateFunction = ({ currentUrl, nextUrl }) => currentUrl.pathname !== nextUrl.pathname;
export async function loader({ request }: Route.LoaderArgs) {
  return loadOr404<HeroListResponse>("/api/site/kb/heroes", { signal: request.signal });
}
export function meta() {
  return pageMeta({ title: "KPL 英雄榜：职业赛场 BP 登场率与版本强度梯度", description: "涵盖全部英雄的职业赛场出场率、禁用率、总胜率、版本梯队评定与招牌选手荣誉榜。", path: "/heroes" });
}
export function headers() { return edgeTtl(60); }
const POSITIONS = ["全部", "对抗路", "打野", "中路", "发育路", "游走"] as const;
const SORTS = [
  { key: "bpRate", label: "BP率最高" }, { key: "winRate", label: "胜率最高" },
  { key: "picks", label: "出场最多" }, { key: "tier", label: "版本强势(T0)" },
] as const;

export default function HeroesPage() {
  const { heroes, totalGames, season } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchKeyword = searchParams.get("q") || "";
  const selectedPos = searchParams.get("pos") || "全部";
  const selectedSort = searchParams.get("sort") || "bpRate";
  const returnTo = `/heroes${searchParams.size ? `?${searchParams}` : ""}`;

  // Existing sort and eligibility rules deliberately unchanged.
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
      list = list.filter((h) => h.name.toLowerCase().includes(q) || h.id.toLowerCase().includes(q) || h.primaryPos.toLowerCase().includes(q) || h.functionTags.some((t) => t.toLowerCase().includes(q)));
    }
    return list;
  }, [heroes, selectedPos, selectedSort, searchKeyword]);

  const updateFilter = (key: string, value: string, fallback = "", replace = false) => {
    const next = new URLSearchParams(searchParams);
    if (value === fallback) next.delete(key); else next.set(key, value);
    setSearchParams(next, { preventScrollReset: true, replace });
  };
  const resetFilters = () => {
    const next = new URLSearchParams(searchParams);
    ["pos", "sort", "q"].forEach(key => next.delete(key));
    setSearchParams(next, { preventScrollReset: true });
  };
  const rememberPosition = () => {
    try { sessionStorage.setItem("kpl:heroes:return", JSON.stringify({ url: returnTo, y: window.scrollY })); } catch { /* Storage may be disabled. Native history restoration still works. */ }
  };
  useEffect(() => {
    let frame = 0;
    try {
      const saved = JSON.parse(sessionStorage.getItem("kpl:heroes:return") ?? "null") as { url?: string; y?: number } | null;
      if (saved?.url === window.location.pathname + window.location.search && typeof saved.y === "number" && Number.isFinite(saved.y)) {
        frame = requestAnimationFrame(() => {
          try { sessionStorage.removeItem("kpl:heroes:return"); } catch { /* Optional storage. */ }
          window.scrollTo({ top: saved.y!, behavior: "instant" });
        });
      } else sessionStorage.removeItem("kpl:heroes:return");
    } catch { /* No storage is required to browse. */ }
    return () => cancelAnimationFrame(frame);
  }, []);

  return <div className="esports-page esports-heroes">
    <PhoneBar title="英雄榜" />
    <EsportsNav />
    <section className="heroes-intro">
      <PageHeader kicker="KPL INTELLIGENCE / 职业赛场" title="KPL 职业英雄榜" description="从 BP 优先级到出场表现，读懂职业赛场的英雄选择。" />
      <div className="heroes-sample"><strong>{formatNumber(totalGames)}</strong><span>局职业赛事样本</span><small>{season || "全部已收录赛事 · 历史汇总"}</small></div>
      <div className="heroes-intro-portraits" aria-hidden="true">{heroes.slice(0, 3).map(h => <Portrait key={h.id} name={h.name} src={h.avatar} size={58} eager />)}</div>
    </section>
    <section className="heroes-filter" aria-label="英雄筛选工具">
      <div className="heroes-lanes" aria-label="选择分路">{POSITIONS.map(pos => <button type="button" key={pos} aria-pressed={selectedPos === pos} onClick={() => updateFilter("pos", pos, "全部")}>{pos}</button>)}</div>
      <div className="heroes-tools">
        <div className="heroes-search-field"><label htmlFor="hero-search">搜索英雄</label><div className="heroes-search"><IconSearch size={18} /><input id="hero-search" type="search" autoComplete="off" value={searchKeyword} onChange={e => updateFilter("q", e.target.value, "", true)} placeholder="名称、分路或战术标签" />{searchKeyword && <button type="button" onClick={() => updateFilter("q", "", "", true)} aria-label="清空英雄搜索">清空</button>}</div></div>
        <div className="heroes-sort"><label htmlFor="hero-sort">排序规则</label><select id="hero-sort" value={selectedSort} onChange={e => updateFilter("sort", e.target.value, "bpRate")}>{SORTS.map(sort => <option key={sort.key} value={sort.key}>{sort.label}</option>)}</select></div>
      </div>
    </section>
    <div className="heroes-results-heading"><p role="status" aria-live="polite"><strong>{filteredHeroes.length}</strong> 位英雄{selectedPos !== "全部" ? ` · ${selectedPos}` : " · 全部分路"}{searchKeyword && <> · 搜索「{searchKeyword}」</>}</p><span>胜率请结合出场样本解读</span></div>
    <section aria-label="英雄排行榜">
      {filteredHeroes.length === 0 ? <div className="esports-empty"><h2>没有符合条件的英雄</h2><p>试试其他名称、分路，或恢复全部英雄。</p><button type="button" className="esports-button" onClick={resetFilters}>恢复全部筛选</button></div> : <ol className="heroes-grid">{filteredHeroes.map((h, index) => {
        const smallSample = !Number.isFinite(h.picks) || h.picks < 10;
        return <li key={h.id}><IntentLink to={`/heroes/${h.id}?${new URLSearchParams({ returnTo })}`} onClick={rememberPosition} className="hero-rank-card" data-leading={index < 3 && !smallSample ? "true" : undefined}>
          <div className="hero-rank-identity"><Portrait src={h.avatar} name={h.name} size={88} eager={index < 6} /><div className="hero-rank-name"><p className="hero-rank-position">{h.primaryPos}</p><h2>{h.name}</h2><div className="hero-rank-tags">{h.functionTags.slice(0, 2).map((tag, i) => <span key={`${tag}-${i}`}>{tag}</span>)}</div></div><span className="hero-rank-number" aria-label={`当前结果第 ${index + 1} 位`}>{String(index + 1).padStart(2, "0")}</span></div>
          <div className="hero-rank-stats"><div><p>BP 参与率</p><strong>{formatRate(h.bpRate, totalGames)}</strong></div><div className="hero-rank-win"><p>出场胜率</p><strong>{formatRate(h.winRate, h.picks)}</strong><small>{formatNumber(h.picks)} 局{smallSample ? " · 低样本" : " · 出场样本"}</small></div></div>
          <RateBar label="BP 参与率" value={totalGames > 0 ? h.bpRate : null} />
          <div className="hero-rank-footer"><span className="hero-rank-tier"><TierBadge tier={h.versionStrength} /><span>版本梯度</span></span>{h.topPlayer ? <span className="hero-rank-signature">招牌 · <strong>{h.topPlayer.nickname}</strong></span> : <span>查看档案 →</span>}</div>
        </IntentLink></li>;
      })}</ol>}
    </section>
    <details className="heroes-method"><summary>统计口径与阅读说明</summary><p>数据来自已收录的 KPL 官方赛事记录。BP 参与率为选用与禁用次数占对局样本的比例，出场胜率仅统计选用对局。版本梯度保留现有接口评定，不代表当前实时版本。</p><p>胜率排序沿用现有规则：出场不少于 10 局的英雄优先；不足 10 局标记低样本，不据此作绝对强弱判断。卡片序位是当前筛选结果的顺序，不是额外的综合实力排名。</p></details>
  </div>;
}

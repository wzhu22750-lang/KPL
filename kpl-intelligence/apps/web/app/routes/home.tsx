import { data as withHeaders, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/home";
import type { TimelineResponse } from "@aihot/contracts/site";
import type { ScheduleMatch, ScheduleResponse, TeamsResponse } from "@aihot/contracts/kpl";
import { apiDeadlineCache, apiGet, loadOr404 } from "../lib/api.server";
import { filterParams, itemListLd, listPath, pageMeta, readFilters, siteLd } from "../lib/seo";
import type { Screen } from "../components/shell/screens";
import { Timeline } from "../features/feed/Timeline";
import { HotTopics } from "../features/feed/HotTopics";
import { ActiveFilters, CategoryTabs, FeedBar, SearchField } from "../features/feed/Filters";
import { IntentLink } from "../components/ui/IntentLink";
import { IconArrowRight, IconSparkles } from "../components/icons";

export const handle: Screen = { tab: "featured", name: "精选" };

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(`/all${url.search}`);
  const filters = readFilters(url.searchParams);
  const upstream = new Headers();
  const [data, schedule, teams] = await Promise.all([
    loadOr404<TimelineResponse>(listPath("/api/site/timeline", filterParams(filters)), { responseHeaders: upstream, signal: request.signal }),
    apiGet<ScheduleResponse>("/api/site/kb/schedule?limit=5", { signal: request.signal }).catch(() => null),
    apiGet<TeamsResponse>("/api/site/kb/teams", { signal: request.signal }).catch(() => null),
  ]);
  return withHeaders({ data, filters, schedule, teams }, { headers: apiDeadlineCache(60, Date.now(), upstream) });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const path = listPath("/", loaderData ? filterParams(loaderData.filters) : {});
  const titles = loaderData?.data.cards.map((c) => c.item.title) ?? [];
  return pageMeta({ path, jsonLd: path === "/" ? [...siteLd(), itemListLd("/", "精选", titles)] : undefined });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

const fmtAt = (m: ScheduleMatch) =>
  m.status === "scheduled" ? `${(m.scheduledAt ?? "").slice(5, 10).replace("-", "/")} ${(m.scheduledAt ?? "").slice(11, 16)}` : `${(m.playedAt ?? "").slice(5, 10).replace("-", "/")} 已赛`;

/** 临近赛程与最近赛果；比分牌点进比赛详情。 */
function MatchStrip({ matches }: { matches: ScheduleResponse["matches"] }) {
  if (matches.length === 0) return null;
  return (
    <section aria-label="近期赛事" className="mt-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-semibold text-ink">近期赛事</h2>
        <IntentLink to="/matches" className="inline-flex min-h-10 items-center gap-1 text-[12px] font-medium text-accent transition-colors hover:text-accent-ink">全部赛程 <IconArrowRight size={14} /></IntentLink>
      </div>
      <ul className="scrollbar-none mt-1 flex snap-x snap-proximity gap-3 overflow-x-auto px-0.5 pb-3 pt-1">
        {matches.map((m) => (
          <li key={m.id} className="shrink-0 snap-start">
            <IntentLink to={`/matches/${m.id}`} className="card card-hover flex w-[252px] flex-col gap-4 px-4 py-3.5">
              <span className="flex items-center justify-between text-[11px] text-ink-4">
                <span className="num shrink-0">{fmtAt(m)}</span>
                <span className="truncate rounded-mark bg-bg-sunk px-1.5 py-0.5">{m.stage ?? m.seasonName}</span>
              </span>
              <span className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  {m.home.logo && <img src={m.home.logo} alt="" width={22} height={22} loading="lazy" className="h-[22px] w-[22px] rounded-full object-contain" />}
                  <span className="truncate text-[12.5px] font-medium text-ink">{m.home.shortName ?? m.home.name}</span>
                </span>
                <span className={`num shrink-0 text-[21px] font-bold tracking-tight ${m.status === "live" ? "text-hot" : "text-ink"}`}>{m.status === "scheduled" ? "VS" : `${m.home.score} : ${m.away.score}`}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-medium text-ink">{m.away.shortName ?? m.away.name}</span>
                  {m.away.logo && <img src={m.away.logo} alt="" width={22} height={22} loading="lazy" className="h-[22px] w-[22px] rounded-full object-contain" />}
                </span>
              </span>
            </IntentLink>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 热门战队：一排队徽，直达战队页。 */
function TeamStrip({ teams }: { teams: TeamsResponse["teams"] }) {
  if (teams.length === 0) return null;
  return (
    <section aria-label="战队" className="mb-6 mt-3 border-b border-line pb-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-bold text-ink">战队</h2>
        <IntentLink to="/teams" className="inline-flex min-h-10 items-center gap-1 text-[12px] font-medium text-accent transition-colors hover:text-accent-ink">全部战队 <IconArrowRight size={14} /></IntentLink>
      </div>
      <ul className="mt-2.5 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {teams.map((t) => (
          <li key={t.slug} className="shrink-0">
            <IntentLink to={`/teams/${t.slug}`} className="flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface py-1.5 pl-2 pr-3.5 transition-colors hover:border-accent hover:bg-accent-softer">
              {t.logo && <img src={t.logo} alt="" width={24} height={24} loading="lazy" className="h-6 w-6 rounded-full object-contain" />}
              <span className="text-[12.5px] font-medium text-ink">{t.shortName ?? t.name}</span>
            </IntentLink>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Home() {
  const { data, filters, schedule, teams } = useLoaderData<typeof loader>();
  const title = filters.tag ? `#${filters.tag}` : "精选";
  return (
    <div className="pb-6">
      {/* Phones: the bar (精选 | 全部, filter, search), the filter in use, today's hot topics, the feed. */}
      <FeedBar base="/" category={filters.category} channel={filters.channel} />
      <ActiveFilters base="/" category={filters.category} channel={filters.channel} tag={filters.tag} />
      <div className="hidden lg:block">
        <header className="flex items-center justify-between gap-6 border-b border-line pb-6">
          <div>
            <h1 className="text-[28px] font-semibold leading-[1.3] tracking-tight text-ink">{title}</h1>
            <p className="mt-2 text-[13px] text-ink-3">追踪赛场动态，读懂每一次胜负。</p>
          </div>
          <IntentLink to="/ask" className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-control border border-line-strong bg-surface px-4 text-[13px] font-medium text-accent transition-colors hover:border-accent hover:bg-accent-softer">
            <IconSparkles size={17} /> 问问 KPL <IconArrowRight size={15} />
          </IntentLink>
        </header>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <CategoryTabs base="/" category={filters.category} channel={filters.channel} layoutId="home-cat-desk" className="min-w-0" />
          <SearchField keep={{ category: filters.category }} />
        </div>
      </div>

      {schedule && <MatchStrip matches={schedule.matches} />}
      {teams && <TeamStrip teams={teams.teams} />}

      {data.hot && <HotTopics entries={data.hot} />}

      <Timeline initial={data} filters={data.filters} />
    </div>
  );
}

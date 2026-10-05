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

/** 今日赛事：临近赛程，休赛期显示最近赛果；比分牌点进比赛详情。 */
function MatchStrip({ matches }: { matches: ScheduleResponse["matches"] }) {
  if (matches.length === 0) return null;
  return (
    <section aria-label="今日赛事" className="mt-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-bold text-ink">今日赛事</h2>
        <IntentLink to="/matches" className="text-[12px] text-ink-4 transition-colors hover:text-accent">全部赛程 →</IntentLink>
      </div>
      <ul className="mt-2.5 flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {matches.map((m) => (
          <li key={m.id} className="shrink-0">
            <IntentLink to={`/matches/${m.id}`} className="card card-hover flex w-[230px] flex-col gap-2 px-4 py-3">
              <span className="flex items-center justify-between text-[11px] text-ink-4">
                <span>{fmtAt(m)}</span>
                <span className="truncate pl-2">{m.stage ?? m.seasonName}</span>
              </span>
              <span className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  {m.home.logo && <img src={m.home.logo} alt="" width={22} height={22} loading="lazy" className="h-[22px] w-[22px] rounded-full object-contain" />}
                  <span className="truncate text-[12.5px] font-medium text-ink">{m.home.shortName ?? m.home.name}</span>
                </span>
                <span className="num shrink-0 text-[15px] font-bold text-ink">{m.status === "scheduled" ? "vs" : `${m.home.score}:${m.away.score}`}</span>
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
    <section aria-label="热门战队" className="mt-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[15px] font-bold text-ink">战队</h2>
        <IntentLink to="/teams" className="text-[12px] text-ink-4 transition-colors hover:text-accent">全部战队 →</IntentLink>
      </div>
      <ul className="mt-2.5 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {teams.map((t) => (
          <li key={t.slug} className="shrink-0">
            <IntentLink to={`/teams/${t.slug}`} className="flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pl-1.5 pr-3 transition-colors hover:border-accent">
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
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{title}</h1>
        <div className="mb-5 mt-4 flex items-center justify-between gap-4">
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

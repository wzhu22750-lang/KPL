import { data as withHeaders, redirect, useLoaderData } from 'react-router';
import type { Route } from './+types/home';
import type { RadarResponse, MatchOverviewResponse } from '@aihot/contracts/radar';
import type { TimelineResponse, HotStripEntry } from '@aihot/contracts/site';
import { apiDeadlineCache, apiGet } from '../lib/api.server';
import { filterParams, listPath, readFilters, itemListLd, pageMeta, siteLd } from '../lib/seo';
import type { Screen } from '../components/shell/screens';
import { IntentLink } from '../components/ui/IntentLink';
import { IconArrowRight } from '../components/icons';
import { ContentRadar } from '../features/feed/ContentRadar';
import { HotTopics } from '../features/feed/HotTopics';
import { Timeline } from '../features/feed/Timeline';
import { SourceTabs } from '../features/feed/Filters';
import { SOURCE_GROUP_LABELS } from '@aihot/contracts/taxonomy';
import '../features/feed/home-mobile.css';

export const handle: Screen = { tab: 'featured', name: '发现' };

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  // Search/filter bookmarks still work, but the homepage itself is a current overview.
  if (url.searchParams.get('q')?.trim() || url.searchParams.get('tag')?.trim() || ['category', 'channel'].some(key => url.searchParams.get(key)?.trim() && url.searchParams.get(key) !== 'all')) {
    const filters = new URLSearchParams(url.search);
    filters.delete('radarDay');
    throw redirect(`/all?${filters}`);
  }
  if (url.searchParams.has('radarDay')) throw redirect('/');
  const radarHeaders = new Headers();
  const timelineHeaders = new Headers();
  const hotHeaders = new Headers();
  const matchHeaders = new Headers();
  const filters = readFilters(url.searchParams);
  const optional = <T,>(promise: Promise<T>) => promise.catch(error => {
    if (request.signal.aborted) throw error;
    return null;
  });
  const [radar, timeline, hotStrip, overview] = await Promise.all([
    optional(apiGet<RadarResponse>('/api/site/radar?current=true', { responseHeaders: radarHeaders, signal: request.signal })),
    optional(apiGet<TimelineResponse>(listPath('/api/site/timeline', filterParams(filters)), { responseHeaders: timelineHeaders, signal: request.signal })),
    filters.sourceGroup ? optional(apiGet<{ entries: HotStripEntry[] }>('/api/site/hot/strip', { responseHeaders: hotHeaders, signal: request.signal })) : null,
    optional(apiGet<MatchOverviewResponse>('/api/site/match-overview', { responseHeaders: matchHeaders, signal: request.signal })),
  ]);
  // Official scorecards do not depend on experimental judging being enabled or healthy.
  const matches = (overview?.matches ?? []).map(match => ({ ...match, materials: radar?.matches.find(m => m.id === match.id)?.materials ?? [] }));
  const headers = apiDeadlineCache(30, Date.now(), [radarHeaders, timelineHeaders, matchHeaders, ...(filters.sourceGroup ? [hotHeaders] : [])]);
  return withHeaders({ radar, matches, matchesUnavailable: overview === null, timeline, filters, hot: hotStrip?.entries ?? timeline?.hot ?? [] }, { headers });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const path = listPath('/', filterParams(loaderData?.filters ?? { channel: 'all', category: null, tag: null }));
  const radar = loaderData?.radar;
  const titles = [...new Set([...(loaderData?.hot ?? []).map(h => h.title), ...(radar?.topics ?? []).map(t => t.title), ...(loaderData?.matches ?? []).map(m => m.title), ...(loaderData?.timeline?.cards ?? []).map(c => c.item.title)])];
  return pageMeta({ path, jsonLd: path === '/' ? [...siteLd(), itemListLd('/', '发现', titles)] : undefined });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export default function Home() {
  const { radar, matches, matchesUnavailable, hot, timeline, filters } = useLoaderData<typeof loader>();
  return <div className="home-overview pb-6">
    <header className="flex items-center justify-between gap-4">
      <h1 className="text-[24px] font-semibold tracking-tight text-ink sm:text-[28px]">发现</h1>
      <IntentLink to="/all" className="inline-flex min-h-11 items-center gap-1 text-[13px] text-ink-3 hover:text-accent">全部 KPL 动态<IconArrowRight size={14} /></IntentLink>
    </header>
    {hot.length > 0 && <div className="mt-5"><HotTopics entries={hot} /></div>}
    <ContentRadar radar={radar} matches={matches} matchesUnavailable={matchesUnavailable} />
    <section aria-labelledby="featured-updates" className="mt-7">
      <h2 id="featured-updates" className="border-b border-line pb-4 text-[18px] font-semibold text-ink">发现动态{filters.sourceGroup && <span className="ml-2 text-[13px] font-normal text-ink-3">· {SOURCE_GROUP_LABELS[filters.sourceGroup]}</span>}</h2>
      <SourceTabs base="/" sourceGroup={filters.sourceGroup} className="mb-4 mt-4" />
      {timeline ? <Timeline initial={timeline} filters={filters} groupByDay={false} /> : <p className="py-5 text-[14px] text-ink-3">发现动态暂不可用，可前往全部动态查看。</p>}
    </section>
  </div>;
}

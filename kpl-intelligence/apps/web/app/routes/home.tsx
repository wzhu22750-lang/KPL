import { data as withHeaders, redirect, useLoaderData } from 'react-router';
import type { Route } from './+types/home';
import type { RadarResponse } from '@aihot/contracts/radar';
import type { TimelineResponse } from '@aihot/contracts/site';
import { apiDeadlineCache, apiGet } from '../lib/api.server';
import { itemListLd, pageMeta, siteLd } from '../lib/seo';
import type { Screen } from '../components/shell/screens';
import { IntentLink } from '../components/ui/IntentLink';
import { IconArrowRight } from '../components/icons';
import { ContentRadar } from '../features/feed/ContentRadar';
import { HotTopics } from '../features/feed/HotTopics';
import { Timeline } from '../features/feed/Timeline';
import '../features/feed/home-mobile.css';

export const handle: Screen = { tab: 'featured', name: '精选' };

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
  const optional = <T,>(promise: Promise<T>) => promise.catch(error => {
    if (request.signal.aborted) throw error;
    return null;
  });
  const [radar, timeline] = await Promise.all([
    optional(apiGet<RadarResponse>('/api/site/radar?current=true', { responseHeaders: radarHeaders, signal: request.signal })),
    optional(apiGet<TimelineResponse>('/api/site/timeline', { responseHeaders: timelineHeaders, signal: request.signal })),
  ]);
  // The composed page must expire no later than either upstream response.
  const headers = apiDeadlineCache(30, Date.now(), [radarHeaders, timelineHeaders]);
  return withHeaders({ radar, timeline, hot: timeline?.hot ?? [] }, { headers });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const path = '/';
  const radar = loaderData?.radar;
  const titles = [...new Set([...(loaderData?.hot ?? []).map(h => h.title), ...(radar?.topics ?? []).map(t => t.title), ...(radar?.matches ?? []).map(m => m.title), ...(loaderData?.timeline?.cards ?? []).map(c => c.item.title)])];
  return pageMeta({ path, jsonLd: path === '/' ? [...siteLd(), itemListLd('/', '精选', titles)] : undefined });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export default function Home() {
  const { radar, hot, timeline } = useLoaderData<typeof loader>();
  return <div className="home-overview pb-6">
    <header className="flex items-center justify-between gap-4">
      <h1 className="text-[24px] font-semibold tracking-tight text-ink sm:text-[28px]">精选</h1>
      <IntentLink to="/all" className="inline-flex min-h-11 items-center gap-1 text-[13px] text-ink-3 hover:text-accent">全部 KPL 动态<IconArrowRight size={14} /></IntentLink>
    </header>
    {hot.length > 0 && <div className="mt-5"><HotTopics entries={hot} /></div>}
    {radar ? <ContentRadar radar={radar} /> : <div className="mt-6 rounded-card border border-line p-6">
      <h2 className="text-[18px] font-semibold text-ink">圈内焦点暂不可用</h2>
      <p className="mt-2 text-[14px] text-ink-3">你仍然可以查看全部动态与比赛赛程。</p>
      <div className="mt-4 flex gap-5 text-[13px] text-accent"><IntentLink to="/all" className="inline-flex min-h-11 items-center">全部动态</IntentLink><IntentLink to="/matches" className="inline-flex min-h-11 items-center">全部赛程</IntentLink></div>
    </div>}
    <section aria-labelledby="featured-updates" className="mt-7">
      <h2 id="featured-updates" className="mb-4 border-b border-line pb-4 text-[18px] font-semibold text-ink">精选动态</h2>
      {timeline ? <Timeline initial={timeline} filters={timeline.filters} groupByDay={false} /> : <p className="py-5 text-[14px] text-ink-3">精选动态暂不可用，可前往全部动态查看。</p>}
    </section>
  </div>;
}

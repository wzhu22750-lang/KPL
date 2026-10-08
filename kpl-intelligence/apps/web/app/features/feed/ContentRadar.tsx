import { useRef, useState } from 'react';
import type { RadarMaterial, RadarResponse, RadarMatch, RadarTopic } from '@aihot/contracts/radar';
import { IntentLink } from '../../components/ui/IntentLink';
import { TeamLogo } from '../../components/ui/TeamLogo';
import { IconArrowUpRight, IconChevronDown, IconChevronLeft, IconChevronRight } from '../../components/icons';

const CLAIM = { fact: '事实陈述', opinion: '观点', rumor: '未证实传闻', joke: '玩笑 / 二创' };
const STATUS: Record<string, string> = { scheduled: '未开始', live: '进行中', finished: '已结束', postponed: '延期', cancelled: '取消' };
const timeOf = (date: string) => new Date(date).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

function ClaimLabel({ item }: { item: RadarMaterial }) {
  return <span className={item.claimStatus === 'rumor' ? 'font-medium text-hot' : 'text-ink-3'}>{CLAIM[item.claimStatus]}</span>;
}

/** Provenance stays available without turning every story into a scoring dashboard. */
function Evidence({ item }: { item: RadarMaterial }) {
  return <details className="disclosure group/evidence mt-2 text-[12px] text-ink-3">
    <summary className="inline-flex min-h-11 items-center gap-1.5 rounded-control hover:text-accent">
      来源与判断依据 <IconChevronDown size={14} className="transition-transform group-open/evidence:rotate-180" />
    </summary>
    <div className="space-y-2 border-l-2 border-line pl-3 leading-relaxed">
      <p>{item.source}{item.publishedAt && <> · {timeOf(item.publishedAt)}</>} · 内容分类不代表事实已核实</p>
      {item.stance && <p>立场：{item.stance}</p>}
      {item.evidence.map((quote, i) => <blockquote key={i}>{quote}</blockquote>)}
      {item.evidence.length === 0 && <p>本站不展开此来源的原文引文，请前往原文核对。</p>}
      <p>基础 {item.score.base} · 官方 {item.score.official} · 热度 {item.score.heat ?? '未知'} · 噪声扣分 {item.score.noise} · 合计 {item.score.total}</p>
      <p>{item.score.heatCoverage === 'unknown' ? '热度未知，不按零互动处理。' : '热度仅为观测信号，不代表事实成立。'}</p>
      {item.score.heatPlatform && <p>{item.score.heatPlatform} 观测：{Object.entries(item.score.metrics).map(([key, n]) => `${({ likes: '赞', comments: '评论', shares: '转发', views: '阅读', replies: '回复' } as Record<string, string>)[key] ?? key} ${n ?? '未知'}`).join(' · ')}</p>}
      {item.matchId && <IntentLink to={`/matches/${item.matchId}`} className="inline-flex min-h-11 items-center text-accent">查看比赛背景{item.gameNo ? ` · 第 ${item.gameNo} 局` : ''}</IntentLink>}
    </div>
  </details>;
}

export function RadarMaterialArticle({ item, omitTitle = false, omitSummary = false }: { item: RadarMaterial; omitTitle?: boolean; omitSummary?: boolean }) {
  return <article className="min-w-0 py-4">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
      <ClaimLabel item={item} /><span aria-hidden="true">·</span><span>{item.source}</span>
      {item.gameNo && <span>第 {item.gameNo} 局</span>}
      {item.publishedAt && <time dateTime={item.publishedAt}>{timeOf(item.publishedAt)}</time>}
    </div>
    {!omitTitle && <a href={item.url} target="_blank" rel="noopener noreferrer" className="mt-2 block text-[15px] font-semibold leading-relaxed text-ink hover:text-accent">{item.title} <IconArrowUpRight size={14} className="inline align-baseline text-ink-3" /></a>}
    {!omitSummary && <p className="mt-2 max-w-[72ch] text-[14px] leading-[1.85] text-ink-2">{item.summary}</p>}
    {omitTitle && <a href={item.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1 text-[12px] text-accent">阅读原文 <IconArrowUpRight size={14} /></a>}
    <Evidence item={item} />
  </article>;
}

function Topic({ topic, lead = false }: { topic: RadarTopic; lead?: boolean }) {
  const first = topic.materials[0];
  return <article className={`focus-story ${lead ? 'min-w-0 rounded-card border border-line bg-surface p-5 sm:p-6' : 'min-w-0 border-b border-line py-5 first:pt-0 last:border-0 last:pb-0'}`}>
    <div className="focus-meta flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
      {first && <ClaimLabel item={first} />}
      <span>{topic.materials.length} 条来源</span>
      <time dateTime={topic.updatedAt}>{timeOf(topic.updatedAt)}</time>
    </div>
    <h3 className={`focus-title mt-3 font-semibold text-ink ${lead ? 'max-w-[28em] text-[23px] leading-[1.5] tracking-tight sm:text-[26px]' : 'text-[17px] leading-relaxed'}`}>{topic.title}</h3>
    {first && <p className={`focus-summary mt-3 text-ink-2 ${lead ? 'max-w-[65ch] text-[14px] leading-[1.9]' : 'line-clamp-3 text-[13px] leading-[1.85]'}`}>{first.summary}</p>}
    <details className="focus-details disclosure group/topic mt-3">
      <summary className="flex min-h-11 w-fit items-center gap-2 rounded-control text-[13px] font-medium text-accent hover:text-accent-ink">
        查看来源与观点 <IconChevronDown size={15} className="transition-transform group-open/topic:rotate-180" />
      </summary>
      <div className="mt-2 border-t border-line-soft">
        <p className="pt-3 text-[12px] text-ink-3">来源观点不代表所有观众；时间为最近实质进展。</p>
        <div className="divide-y divide-line-soft">{topic.materials.map((item, index) => <RadarMaterialArticle key={item.id} item={item} omitTitle={index === 0 && item.title === topic.title} omitSummary={lead && index === 0} />)}</div>
      </div>
    </details>
  </article>;
}

function GameMaterials({ items }: { items: RadarMaterial[] }) {
  const reports = items.filter(m => m.kind === 'match' && /战胜|击败|拿下.*局/.test(m.title));
  const extras = items.filter(m => !reports.includes(m));
  const representative = [...reports].sort((a, b) => b.score.official - a.score.official || b.score.total - a.score.total)[0];
  return <>
    {representative && <RadarMaterialArticle item={representative} />}
    {reports.length > 1 && <details className="disclosure mb-3 text-[12px] text-ink-3">
      <summary className="inline-flex min-h-11 items-center gap-1">另有 {reports.length - 1} 条同局战报 <IconChevronDown size={14} /></summary>
      {reports.filter(m => m.id !== representative?.id).map(m => <a key={m.id} href={m.url} target="_blank" rel="noopener noreferrer" className="block py-2 leading-relaxed hover:text-accent">{m.source}：{m.title}</a>)}
    </details>}
    {extras.map(m => <RadarMaterialArticle key={m.id} item={m} />)}
  </>;
}

function MatchTimeline({ match }: { match: RadarMatch }) {
  const games = [...new Set([...match.games.map(g => g.gameNo), ...match.materials.flatMap(m => m.gameNo ? [m.gameNo] : [])])].sort((a, b) => a - b);
  const other = match.materials.filter(m => !m.gameNo);
  return <div className="border-t border-line px-5 pb-4">
    {games.map(n => {
      const game = match.games.find(g => g.gameNo === n);
      return <details key={n} className="disclosure group/game border-b border-line-soft last:border-0">
        <summary className="flex min-h-16 items-start gap-3 py-4">
          <span className="num rounded-mark bg-bg-sunk px-2 py-1 text-[12px] font-semibold text-ink">G{n}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium text-ink">第 {n} 局{game && ` · ${game.winner ? `${game.winner} 胜` : '胜方待确认'}`}</span>
            {game && <span className="mt-1 block text-[12px] text-ink-3">MVP · {game.mvp ?? '待确认'}</span>}
          </span>
          <IconChevronDown size={15} className="mt-1 shrink-0 text-ink-3 transition-transform group-open/game:rotate-180" />
        </summary>
        <div className="pl-3 sm:pl-12"><GameMaterials items={match.materials.filter(m => m.gameNo === n)} /></div>
      </details>;
    })}
    {other.length > 0 && <details className="disclosure group/other border-t border-line-soft">
      <summary className="flex min-h-14 items-center justify-between gap-3 text-[13px] font-medium text-ink">赛前 / 赛后及局次待确认 <span className="flex items-center gap-2 text-ink-3">{other.length} 条<IconChevronDown size={15} className="transition-transform group-open/other:rotate-180" /></span></summary>
      <div className="divide-y divide-line-soft">{other.map(m => <RadarMaterialArticle key={m.id} item={m} />)}</div>
    </details>}
    {!match.materials.length && <p className="pt-4 text-[13px] text-ink-3">暂无已评估报道，比分与小局数据仍可查看。</p>}
  </div>;
}

function MatchRadar({ match, expanded, onToggle }: { match: RadarMatch; expanded: boolean; onToggle: () => void }) {
  const teams = [match.home, match.away];
  const scored = match.status === 'live' || match.status === 'finished';
  return <section className="match-score-card w-[272px] shrink-0 snap-start rounded-card border border-line bg-surface sm:w-[292px]">
    <div className="match-score-content p-5 pb-2">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-3">
        <span className={match.status === 'live' ? 'font-medium text-accent' : ''}>{STATUS[match.status] ?? match.status}</span>
        <span>{match.scheduledAt && `${timeOf(match.scheduledAt)} · `}BO{match.bo ?? '?'}</span>
      </div>
      <h3 className="space-y-3" aria-label={`${match.title}，${scored ? `${match.homeScore} 比 ${match.awayScore}` : STATUS[match.status] ?? match.status}`}>
        {teams.map((team, i) => <span key={team.slug} className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2.5 text-[14px] font-semibold leading-relaxed text-ink"><TeamLogo name={team.shortName ?? team.name} logo={team.logo} /><span>{team.shortName ?? team.name}</span></span>
          <span className={`num text-[28px] font-semibold leading-none ${scored && (i === 0 ? match.homeScore > match.awayScore : match.awayScore > match.homeScore) ? 'text-accent' : 'text-ink-3'}`}>{scored ? (i === 0 ? match.homeScore : match.awayScore) : '·'}</span>
        </span>)}
      </h3>
      <button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls="match-quick-timeline" aria-label={`${expanded ? '收起' : '展开'} ${match.title} 时间线`} className="match-timeline-toggle mt-3 flex min-h-11 w-full items-center justify-between gap-2 text-left text-[12px] text-ink-3 hover:text-accent">
        <span>{expanded ? '收起' : '展开'}时间线 · {match.materials.length} 条报道</span><IconChevronDown size={16} className={`transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`} />
      </button>
    </div>
    <IntentLink to={`/matches/${match.id}`} className="flex min-h-11 items-center justify-center gap-1.5 border-t border-line-soft text-[12px] font-medium text-accent transition-colors hover:bg-accent-softer">比赛档案与报道 <IconChevronRight size={14} /></IntentLink>
  </section>;
}

function MatchCarousel({ matches, unavailable }: { matches: RadarMatch[]; unavailable: boolean }) {
  const rail = useRef<HTMLDivElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expanded = matches.find(match => match.id === expandedId);
  const scroll = (direction: number) => {
    const element = rail.current;
    if (!element) return;
    const step = (element.firstElementChild?.getBoundingClientRect().width ?? 292) + parseFloat(window.getComputedStyle(element).columnGap);
    element.scrollBy({ left: direction * step, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  return <section aria-labelledby="radar-matches">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 id="radar-matches" className="text-[18px] font-semibold text-ink">比赛速览</h2>
      <div className="flex items-center gap-2">
        <IntentLink to="/matches" className="mr-1 inline-flex min-h-11 items-center gap-1 text-[12px] text-ink-3 hover:text-accent">全部赛程<IconChevronRight size={14} /></IntentLink>
        {matches.length > 1 && <><button type="button" onClick={() => scroll(-1)} aria-label="向左查看比赛" aria-controls="match-score-rail" className="inline-flex size-11 items-center justify-center rounded-control border border-line text-ink-3 hover:bg-surface"><IconChevronLeft size={16} /></button>
        <button type="button" onClick={() => scroll(1)} aria-label="向右查看比赛" aria-controls="match-score-rail" className="inline-flex size-11 items-center justify-center rounded-control border border-line text-ink-3 hover:bg-surface"><IconChevronRight size={16} /></button></>}
      </div>
    </div>
    {matches.length > 0 ? <div id="match-score-rail" ref={rail} role="region" aria-label="比赛卡片，可横向滑动" tabIndex={0} className="scrollbar-none flex snap-x snap-proximity items-start gap-3 overflow-x-auto px-1 pb-3 pt-1">
      {matches.map(match => <MatchRadar key={match.id} match={match} expanded={expandedId === match.id} onToggle={() => setExpandedId(id => id === match.id ? null : match.id)} />)}
    </div> : <p className="rounded-card border border-dashed border-line px-5 py-6 text-[14px] leading-relaxed text-ink-3">{unavailable ? '赛程暂时无法加载，请稍后重试或前往全部赛程。' : '暂无已收录的赛程，可前往全部赛程查看。'}</p>}
    <section id="match-quick-timeline" hidden={!expanded} className="mt-2 rounded-card border border-line bg-surface">
      {expanded && <>
        <header className="flex items-center justify-between gap-4 px-5 py-3"><h3 className="text-[15px] font-semibold text-ink">{expanded.title}</h3><button type="button" onClick={() => setExpandedId(null)} className="min-h-11 shrink-0 text-[12px] text-accent">收起时间线</button></header>
        <MatchTimeline key={expanded.id} match={expanded} />
      </>}
    </section>
  </section>;
}

export function ContentRadar({ radar, matches, matchesUnavailable }: { radar: RadarResponse | null; matches: RadarMatch[]; matchesUnavailable: boolean }) {
  const [lead, ...topics] = radar?.topics ?? [];
  const empty = radar && !lead && !matches.length;
  return <section aria-label="KPL内容雷达" className="radar-overview my-6 space-y-7 sm:space-y-8">

    {lead && <section aria-labelledby="radar-focus">
      <div className="focus-heading mb-4 flex items-baseline gap-3"><h2 id="radar-focus" className="text-[18px] font-semibold text-ink">圈内焦点</h2><span className="text-[12px] text-ink-3">近期最值得关注的讨论</span></div>
      <div className={topics.length ? 'grid items-start gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] lg:gap-8' : ''}>
        <Topic topic={lead} lead />
        {topics.length > 0 && <div className="focus-list divide-y divide-line">{topics.map(topic => <Topic key={topic.id} topic={topic} />)}</div>}
      </div>
    </section>}

    <MatchCarousel matches={matches} unavailable={matchesUnavailable} />

    {empty && <div className="rounded-card border border-dashed border-line-strong px-5 py-8 sm:px-8">
      <h2 className="text-[20px] font-semibold text-ink">暂时没有新焦点</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-ink-3">近期暂无通过评估的话题或动态，可前往全部动态查看已收录内容。</p>
      <IntentLink to="/all" className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-control bg-accent px-4 text-[13px] font-medium text-accent-contrast hover:bg-accent-ink">全部动态<IconChevronRight size={15} /></IntentLink>
    </div>}

    {radar && <details className="disclosure border-t border-line pt-2 text-[12px] text-ink-3">
      <summary className="flex min-h-11 w-fit items-center gap-2">关于内容筛选与热度<IconChevronDown size={14} /></summary>
      <p className="max-w-[80ch] pb-2 leading-relaxed">焦点汇集最近七天仍有进展的讨论，按内容价值与真实互动信号综合排序；不是全网热搜榜。比赛独立展示进行中、接下来的赛程和最近赛果。</p>
      <p className="max-w-[80ch] pb-2 leading-relaxed">{radar.coverage.note}</p>
      {radar.coverage.pending > 0 && <p className="pb-2 leading-relaxed">还有 {radar.coverage.pending} 份素材待评估；技术失败与待复核不会自动发布。</p>}
    </details>}
  </section>;
}

import { useState } from 'react';
import { useLoaderData } from 'react-router';
import type { Route } from './+types/match';
import type { MatchDetailResponse, GameDetail } from '@aihot/contracts/kpl';
import type { RadarMaterial, RadarResponse } from '@aihot/contracts/radar';
import { RadarMaterialArticle } from '../features/feed/ContentRadar';
import { selectMatchNews, type MatchNewsFilter } from '../features/feed/match-news';
import { edgeTtl, loadOr404, apiGet } from '../lib/api.server';
import { pageMeta } from '../lib/seo';
import { PhoneBar } from '../components/shell/PhoneBar';
import { IntentLink } from '../components/ui/IntentLink';
import { EsportsNav, PageHeader, Portrait } from '../components/esports/Esports';
import { formatNumber } from '../lib/esports';
import '../esports-matches.css';
import { IconArrowLeft, IconArrowUpRight, IconChevronDown } from '../components/icons';
import type { Screen } from '../components/shell/screens';

export const handle: Screen = { name: '比赛' };

export async function loader({ request, params }: Route.LoaderArgs) {
  const [detail, radar] = await Promise.all([
    loadOr404<MatchDetailResponse>(`/api/site/kb/matches/${params.id}`, { signal: request.signal }),
    apiGet<RadarResponse>(`/api/site/radar?match=${encodeURIComponent(params.id!)}`, { signal: request.signal }).catch(error => {
      if (request.signal.aborted) throw error;
      return null;
    }),
  ]);
  return { ...detail, radar };
}

export function meta({ loaderData, params }: Route.MetaArgs) {
  const m = loaderData?.match;
  const title = m ? `${m.home.name} ${m.home.score}:${m.away.score} ${m.away.name}` : params.id;
  return pageMeta({ title, description: m ? `${m.seasonName} ${m.stage ?? ''}：本场报道、每局 BP、选手数据与官方回放。` : '比赛详情', path: `/matches/${params.id}` });
}

export function headers() { return edgeTtl(30); }

const fmt = (secs: number | null) => typeof secs !== 'number' || !Number.isFinite(secs) || secs < 0 ? '待补充' : `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
const fmtGold = (n: number | null) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 ? '待补充' : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : formatNumber(n);
const STATUS = { scheduled: '未开始', live: '进行中', finished: '已结束', cancelled: '已取消', postponed: '已延期' };

function BpLane({ game }: { game: GameDetail }) {
  const steps = [...game.bp].sort((a, b) => a.step - b.step);
  return <div className="ep-bp">
    <div className="ep-bp-sides">{(['blue', 'red'] as const).map(side => <p key={side} data-side={side}><strong>{side === 'blue' ? '蓝方' : '红方'}</strong> · {game.players.find(p => p.side === side && p.team)?.team ?? '队伍待确认'}</p>)}</div>
    {steps.length ? <details className="ep-bp-details" open>
      <summary>完整 BP 顺序 · {steps.length} 步{game.mode === 'standard' && steps.length !== 20 ? '（记录未齐）' : ''}</summary>
      <ol className="ep-bp-steps">{steps.map((b, i) => <li key={`${b.step}-${i}`} data-side={b.side} data-action={b.type}>
        <IntentLink to={`/heroes/${b.hero.id || encodeURIComponent(b.hero.name)}`}>
          <span className="ep-bp-order">{String(b.step).padStart(2, '0')}</span>
          <Portrait src={b.hero.icon} name={b.hero.name} size={40} kind="hero" />
          <span className="ep-bp-copy"><span className="ep-bp-action">{b.side === 'blue' ? '蓝方' : '红方'} · {b.type === 'ban' ? '禁用 BAN' : '选用 PICK'}</span><strong>{b.hero.name}</strong><span className="ep-muted">{b.type === 'pick' ? `${b.player ?? '选手待确认'}${b.position ? ` · ${b.position}` : ''}` : '禁用英雄'}</span></span>
        </IntentLink>
      </li>)}</ol>
    </details> : <p className="ep-empty">{game.mode === 'pinnacle' ? '巅峰对决：阵容见下方选手表现，不补造常规 BP。' : '暂无 BP 数据。'}</p>}
  </div>;
}

function PlayersTable({ game }: { game: GameDetail }) {
  const rows = [...game.players].sort((a, b) => (b.mvpScore ?? 0) - (a.mvpScore ?? 0));
  if (!rows.length) return <p className="py-4 text-[13px] text-ink-3">选手数据待补充。</p>;
  return <div className="ep-performance" role="region" aria-label={`第 ${game.gameNo} 局选手统计`}>
    <table className="ep-performance-table" role="table">
      <caption className="sr-only">第 {game.gameNo} 局选手数据，按评分排列</caption>
      <thead role="rowgroup"><tr role="row" className="border-b border-line text-left text-ink-3">
        {['选手 / 队伍', '英雄', 'K/D/A', '经济', '输出', '评分'].map((label, i) => <th key={label} role="columnheader" scope="col" className={`py-3 pr-2 font-medium last:pr-0 ${i > 1 ? 'text-right' : ''}`}>{label}</th>)}
      </tr></thead>
      <tbody role="rowgroup">{rows.map((p, i) => <tr role="row" key={`${p.nickname}-${i}`} className={`border-b border-line-soft last:border-0 ${p.mvp ? 'bg-accent-softer' : ''}`}>
        <th scope="row" role="rowheader" className="ep-player-cell py-3 pr-2 text-left font-medium text-ink"><span>{p.nickname}{p.mvp && <span className="ml-1 rounded-mark bg-accent-soft px-1 text-[10px] text-accent">MVP</span>}</span><span className="mt-1 block text-[10px] font-normal text-ink-3">{p.side === 'blue' ? '蓝方 · ' : p.side === 'red' ? '红方 · ' : ''}{p.team ?? '队伍待确认'}{p.position ? ` · ${p.position}` : ''}</span></th>
        <td role="cell" data-label="英雄" className="py-3 pr-2 text-ink-3">{p.hero ? <IntentLink to={`/heroes/${game.bp.find(b => b.hero.name === p.hero)?.hero.id ?? encodeURIComponent(p.hero)}`} className="inline-flex items-center gap-1.5 hover:text-accent"><Portrait src={p.heroIcon} name={p.hero} size={22} kind="hero" /><span>{p.hero}</span></IntentLink> : '待补充'}</td>
        <td role="cell" data-label="K / D / A" className="num py-3 pr-2 text-right text-ink-2">{formatNumber(p.kills)}/{formatNumber(p.deaths)}/{formatNumber(p.assists)}</td>
        <td role="cell" data-label="经济" className="num py-3 pr-2 text-right text-ink-3">{fmtGold(p.gold)}</td>
        <td role="cell" data-label="输出" className="num py-3 pr-2 text-right text-ink-3">{fmtGold(p.damage)}</td>
        <td role="cell" data-label="官方评分" className="num py-3 text-right font-semibold text-ink-2">{formatNumber(p.mvpScore, 1)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function MatchNews({ materials, filter, onFilter, available }: { materials: RadarMaterial[]; filter: MatchNewsFilter; onFilter: (filter: MatchNewsFilter) => void; available: boolean }) {
  const [shown, setShown] = useState(6);
  const games = [...new Set(materials.flatMap(m => m.gameNo === null ? [] : [m.gameNo]))].sort((a, b) => a - b);
  const choices: { value: MatchNewsFilter; label: string }[] = [{ value: 'all', label: '全部' }, ...games.map(n => ({ value: n, label: `G${n}` })), { value: 'other', label: '未分局' }];
  const items = selectMatchNews(materials, filter);
  return <section id="match-news" className="min-w-0 scroll-mt-24">
    <div className="flex items-baseline justify-between gap-3"><h2 className="text-[18px] font-semibold text-ink">本场报道</h2><span className="num text-[12px] text-ink-3">{materials.length} 条 · 最新在前</span></div>
    <p className="mt-2 text-[12px] leading-relaxed text-ink-3">汇集已采集、已关联且可公开的内容，不代表全网覆盖。</p>
    <nav aria-label="筛选比赛报道" className="mt-3 flex flex-wrap gap-1 border-b border-line pb-3">
      {choices.map(choice => <button key={choice.value} type="button" aria-pressed={filter === choice.value} onClick={() => { onFilter(choice.value); setShown(6); }} className={`min-h-11 rounded-control px-3 text-[12px] transition-colors ${filter === choice.value ? 'bg-accent text-accent-contrast' : 'text-ink-3 hover:bg-bg-sunk'}`}>{choice.label}</button>)}
    </nav>
    <p className="mt-3 text-[12px] text-ink-3" role="status">{filter === 'other' ? '赛前、赛后及局次待确认' : filter === 'all' ? '全部关联报道' : `第 ${filter} 局报道`} · {items.length} 条</p>
    {!available ? <p className="py-6 text-[13px] text-ink-3">报道暂不可用，官方比赛数据仍可查看。</p> : items.length ? <>
      <div className="divide-y divide-line-soft">{items.slice(0, shown).map(item => <RadarMaterialArticle key={item.id} item={item} />)}</div>
      {items.length > shown && <button type="button" onClick={() => setShown(n => n + 6)} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-control border border-line text-[13px] text-accent hover:bg-accent-softer">继续查看报道（{items.length - shown} 条）<IconChevronDown size={15} /></button>}
    </> : <p className="py-6 text-[13px] leading-relaxed text-ink-3">{filter === 'all' ? '暂未关联到可公开报道。不会把仅提到同一支战队的新闻混入本场。' : '这个分组暂时没有报道，可切换“全部”查看其他内容。'}</p>}
  </section>;
}

function MatchArchive({ data }: { data: ReturnType<typeof useLoaderData<typeof loader>> }) {
  const { match, games, videos = [], radar } = data;
  const [selectedGame, setSelectedGame] = useState(games[0]?.gameNo ?? null);
  const [newsFilter, setNewsFilter] = useState<MatchNewsFilter>('all');
  const game = games.find(g => g.gameNo === selectedGame) ?? games[0];
  const materials = radar?.matches.find(m => m.id === match.id)?.materials ?? [];
  const scored = match.status === 'live' || match.status === 'finished';
  const date = match.playedAt ?? match.scheduledAt;
  const winnerName = (winner: string | null) => winner === match.home.slug ? match.home.name : winner === match.away.slug ? match.away.name : winner;
  const gameVideos = game ? videos.filter(v => v.battleSeq === game.gameNo) : [];
  return <div className="esports-page esports-match pb-10">
    <PhoneBar back={{ to: '/matches', label: '赛程' }} title="比赛档案" />
    <EsportsNav />
    <IntentLink to="/matches" className="mb-3 hidden min-h-11 w-fit items-center gap-2 text-[13px] text-ink-3 hover:text-accent lg:flex"><IconArrowLeft size={15} />全部赛程</IntentLink>
    <section className="ep-scoreboard ep-panel" aria-label="比赛比分与服务端状态">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-3"><p>{match.seasonName}{match.stage ? ` · ${match.stage}` : ''} · BO{match.bo ?? '?'}</p>{date && <time dateTime={date}>{new Date(date).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</time>}</div>
      <PageHeader kicker="MATCH ARCHIVE / 比赛档案" title={`${match.home.name} vs ${match.away.name}`} />
      <div className="mx-auto mt-6 grid max-w-[700px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 sm:gap-8">
        <IntentLink to={`/teams/${match.home.slug}`} className="flex min-w-0 flex-col items-center gap-3 text-center"><Portrait name={match.home.name} src={match.home.logo} kind="team" size={72} eager /><span className="text-[14px] font-semibold text-ink sm:text-[18px]">{match.home.name}</span></IntentLink>
        <div className="text-center"><span className="num block whitespace-nowrap text-[36px] font-semibold leading-none tracking-tight text-ink sm:text-[48px]">{scored ? `${formatNumber(match.home.score)} : ${formatNumber(match.away.score)}` : 'VS'}</span><span className={`mt-3 inline-block rounded-mark px-2 py-1 text-[12px] ${match.status === 'live' ? 'bg-accent-soft text-accent' : 'bg-bg-sunk text-ink-3'}`}>{STATUS[match.status]}</span></div>
        <IntentLink to={`/teams/${match.away.slug}`} className="flex min-w-0 flex-col items-center gap-3 text-center"><Portrait name={match.away.name} src={match.away.logo} kind="team" size={72} eager /><span className="text-[14px] font-semibold text-ink sm:text-[18px]">{match.away.name}</span></IntentLink>
      </div>
      {match.winner && <p className="mt-5 text-center text-[13px] text-ink-3">{winnerName(match.winner)} 获胜</p>}
      <p className="ep-status-note">状态由服务端提供 · 不按时间或比分推断直播</p>
    </section>

    <nav aria-label="比赛档案导航" className="my-5 flex flex-wrap items-center gap-x-6 border-b border-line text-[13px] text-ink-3">
      <a href="#game-data" className="inline-flex min-h-12 items-center font-medium text-accent">对局数据 · {games.length} 局</a>
      <a href="#match-news" className="inline-flex min-h-12 items-center hover:text-accent">本场报道 · {materials.length} 条</a>
      {videos.length > 0 && <a href="#match-replays" className="inline-flex min-h-12 items-center hover:text-accent">官方回放 · {videos.length}</a>}
    </nav>

    <div className="ep-archive-columns">
      <div className="min-w-0">
        <section id="game-data" className="scroll-mt-24">
          <h2 className="text-[18px] font-semibold text-ink">对局数据</h2>
          <nav aria-label="选择小局，查看赛果与数据" className="ep-game-selector">{games.map(g => <button key={g.id} type="button" aria-pressed={game?.gameNo === g.gameNo} onClick={() => setSelectedGame(g.gameNo)}>
            <span className="ep-game-number">G{g.gameNo}</span><span className="ep-game-result">{g.winner ? `${winnerName(g.winner)} 胜` : '胜方待确认'}</span><span className="ep-muted">{fmt(g.durationSecs)}{g.mode === 'pinnacle' ? ' · 巅峰对决' : ''}</span>
          </button>)}</nav>
          {game ? <article key={game.id} className="rounded-card border border-line bg-surface p-4 sm:p-5" aria-label={`第 ${game.gameNo} 局数据`}>
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-[17px] font-semibold text-ink">第 {game.gameNo} 局{game.mode === 'pinnacle' && <span className="ml-2 text-[12px] text-accent">巅峰对决</span>}</h3><p className="mt-1.5 text-[13px] font-medium text-accent">{game.winner ? `${winnerName(game.winner)} 胜` : '胜方待确认'}</p></div><div className="text-right text-[12px] text-ink-3"><p>时长 {fmt(game.durationSecs)}</p><p className="mt-1.5">MVP <span className="font-semibold text-ink">{game.mvp ?? '待确认'}</span></p></div></div>
            <div className="my-5 border-y border-line-soft py-3"><p className="text-[11px] text-ink-3">统计顺序：{match.home.shortName ?? match.home.name} / {match.away.shortName ?? match.away.name}（不代表蓝方 / 红方）</p><div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-[12px] text-ink-3"><p>击杀 <span className="num ml-2 font-semibold text-ink">{formatNumber(game.killsBlue)} : {formatNumber(game.killsRed)}</span></p><p>经济 <span className="num ml-2 font-semibold text-ink">{fmtGold(game.goldBlue)} : {fmtGold(game.goldRed)}</span></p></div></div>
            <h4 className="mb-2 text-[15px] font-semibold text-ink">英雄 BP · 按原始步骤排序</h4>
            <p className="ep-muted mb-3">禁用与选用分别标注；选手、位置及阵营以该局记录为准。</p>
            <BpLane game={game} />
            <div className="mt-6 border-t border-line pt-4"><h4 className="text-[13px] font-semibold text-ink">选手表现</h4><PlayersTable game={game} /></div>
            <div className="mt-4 flex flex-wrap items-center gap-x-5 border-t border-line-soft pt-2 text-[12px] text-accent"><a href="#match-news" className="inline-flex min-h-11 items-center" onClick={() => setNewsFilter(game.gameNo)}>查看本局报道（{materials.filter(m => m.gameNo === game.gameNo).length}）</a>{gameVideos.map((v, i) => <a key={`${v.url}-${i}`} href={v.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1">本局官方回放<IconArrowUpRight size={14} /></a>)}</div>
          </article> : <p className="rounded-card border border-line p-5 text-[13px] text-ink-3">对局数据尚未补齐，已关联报道仍可在本场报道中查看。</p>}
        </section>
        <section id="match-replays" className="mt-7 scroll-mt-24">
          <h2 className="text-[16px] font-semibold text-ink">官方回放</h2>
          {videos.length > 0 ? <div className="mt-3 divide-y divide-line-soft rounded-card border border-line bg-surface px-4">{videos.map((v, i) => <a key={`${v.url}-${i}`} href={v.url} target="_blank" rel="noopener noreferrer" className="flex min-h-12 items-center justify-between gap-3 py-3 text-[13px] text-ink-2 hover:text-accent"><span><span className="num mr-3 text-ink-3">G{v.battleSeq}</span>{v.title || `第 ${v.battleSeq} 局官方回放`}</span><IconArrowUpRight size={15} className="shrink-0" /></a>)}</div> : <p className="mt-3 text-[13px] text-ink-3">官方回放链接尚未补充。</p>}
        </section>
      </div>
      <MatchNews key={`${match.id}:${newsFilter}`} materials={materials} filter={newsFilter} onFilter={setNewsFilter} available={radar !== null} />
    </div>
  </div>;
}

export default function MatchPage() {
  const data = useLoaderData<typeof loader>();
  return <MatchArchive key={data.match.id} data={data} />;
}

// 首页混合信息流（P4）：热榜 entries 与时间线 cards 按分桶配比混排。
// 热榜条目走紧凑行（沿用 HotTopics 的行样式），时间线卡片复用 FeedItem。
// 每条都带状态标识：topic_kind 徽标（争议/趣评）、heat 值、coverage（热度未知/待复核）。
import { useState } from "react";
import { Link } from "react-router";
import type { HomeFeedEntry, HomeFeedResponse } from "@aihot/contracts/site";
import { Badge } from "../../components/ui/Badge";
import { FeedItem } from "./FeedItem";
import { Faces } from "../hot/Faces";
import { IconArrowRight, IconChevronDown } from "../../components/icons";

const RANK_COLOR = ["text-[15px] font-black text-rank-1", "text-[15px] font-black text-rank-2", "text-[15px] font-black text-rank-3"];

/** topic_kind 徽标：争议/趣评；general 不展示。 */
function TopicKindBadge({ entry }: { entry: HomeFeedEntry }) {
  if (entry.topicKind === "dispute") return <Badge tone="hot" title="存在多方分歧的话题">争议</Badge>;
  if (entry.topicKind === "fun") return <Badge tone="accent" title="轻松向内容">趣评</Badge>;
  return null;
}

/** coverage 状态：热度未知 / 待复核；已知的不打扰。 */
function CoverageMark({ entry }: { entry: HomeFeedEntry }) {
  if (entry.coverage === "pending_review") return <Badge tone="amber" title="尚未经过编辑精选，信息待复核">待复核</Badge>;
  if (entry.coverage === "unknown") return <Badge title="暂无热度观测数据">热度未知</Badge>;
  return null;
}

/** 热榜行：名次、标题、状态徽标、参与方、热度。 */
function HotRow({ entry, rank }: { entry: HomeFeedEntry; rank: number }) {
  const h = entry.hot;
  if (!h) return null;
  const href = h.storyPublicId ? `/story/${h.storyPublicId}` : h.itemId ? `/items/${h.itemId}` : "/hot";
  return (
    <Link
      viewTransition
      to={href}
      className="group -mx-2 grid min-h-10 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-tile px-2 py-1.5 transition-colors hover:bg-bg-sunk/70 active:bg-bg-sunk sm:grid-cols-[20px_minmax(0,1fr)_120px_64px] sm:gap-x-4 sm:py-2 dark:hover:bg-bg-muted/40"
    >
      <span className={`num text-center leading-none ${RANK_COLOR[rank] ?? "text-[14px] font-bold text-rank-rest"}`}>{h.rank}</span>
      <span className="min-w-0">
        <span className="line-clamp-1 text-[14.5px] font-semibold leading-[1.5] text-ink transition-colors group-hover:text-accent lg:text-[14px]">{h.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <TopicKindBadge entry={entry} />
          <CoverageMark entry={entry} />
        </span>
      </span>
      <span className="hidden justify-end sm:flex">
        <Faces participants={h.participants} total={h.participantCount} size={20} interactive={false} />
      </span>
      <span className="whitespace-nowrap text-right text-[12.5px] text-ink-4" title="热度指数">
        <span className="num text-[13.5px] font-semibold text-ink-2">{Math.round(h.heat)}</span> 热度
      </span>
    </Link>
  );
}

/** 时间线卡片：FeedItem + 状态标识行。 */
function FeedRow({ entry }: { entry: HomeFeedEntry }) {
  const card = entry.card;
  if (!card) return null;
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <TopicKindBadge entry={entry} />
        <CoverageMark entry={entry} />
        {entry.heat !== null && (
          <span className="text-[11.5px] text-ink-4" title="热度指数">
            <span className="num font-semibold text-ink-2">{Math.round(entry.heat)}</span> 热度
          </span>
        )}
      </div>
      <FeedItem item={card.item} group={card.group} at={card.anchorAt} />
    </div>
  );
}

function entryKey(e: HomeFeedEntry, i: number): string {
  if (e.kind === "hot") return `hot:${e.storyPublicId ?? e.hot?.rank ?? i}`;
  return e.card?.key ?? `tl:${i}`;
}

/** 首页热点流：首屏 SSR，加载更多走客户端分页（游标保证同一榜单内不重复）。 */
export function HomeFeed({ initial }: { initial: HomeFeedResponse }) {
  const [entries, setEntries] = useState(initial.entries);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loading, setLoading] = useState(false);

  async function more() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/site/homefeed?limit=20&cursor=${encodeURIComponent(cursor)}`);
      if (!res.ok) return;
      const data = (await res.json()) as HomeFeedResponse;
      const seen = new Set(entries.map((e, i) => entryKey(e, i)));
      setEntries((prev) => [...prev, ...data.entries.filter((e, i) => !seen.has(entryKey(e, entries.length + i)))]);
      setCursor(data.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  let hotRank = 0;
  return (
    <section aria-label="热点动态">
      <ul className="flex flex-col gap-3">
        {entries.map((e, i) => (
          <li key={entryKey(e, i)}>
            {e.kind === "hot" ? <HotRow entry={e} rank={hotRank++} /> : <FeedRow entry={e} />}
          </li>
        ))}
      </ul>
      {cursor && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={more}
            disabled={loading}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-5 text-[13px] font-medium text-ink-2 transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {loading ? "加载中…" : "加载更多"} <IconChevronDown size={15} />
          </button>
        </div>
      )}
      {!cursor && entries.length === 0 && (
        <p className="py-10 text-center text-[13px] text-ink-4">
          暂无动态，去 <Link to="/all" className="text-accent">全部动态 <IconArrowRight size={13} className="inline" /></Link> 看看。
        </p>
      )}
    </section>
  );
}

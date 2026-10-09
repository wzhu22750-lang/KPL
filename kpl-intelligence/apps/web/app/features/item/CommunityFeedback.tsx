// 社区反馈组件（CommunityFeedback）：为论坛帖、视频帖、动态帖统一提供社区讨论与评论区呈现。
// 严格遵守：所有原话来自真实抓取；AI 只出现在标记为"AI 整理"的讨论焦点；未知指标显示为 null；
// 区分已采集(fetchedReplies)与平台总数(totalReplies)；支持 partial/unavailable 空状态与原文直达。
import type { CommunityView, DiscussionPostView } from "@aihot/contracts/site";
import { fullDateTime } from "../../lib/format";

const PLATFORM_NAME: Record<string, string> = {
  weibo: "微博",
  bilibili: "B站",
  hupu: "虎扑",
};

function Avatar({ name, url }: { name: string | null; url: string | null }) {
  if (!url) {
    return (
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-bg-sunk text-[12px] font-semibold text-ink-3" aria-hidden="true">
        {(name ?? "?").slice(0, 1).toUpperCase()}
      </span>
    );
  }
  return <img src={url} alt="" loading="lazy" className="size-8 shrink-0 rounded-full object-cover" />;
}

export function DiscussionComment({ post }: { post: DiscussionPostView }) {
  const at = post.publishedAt;
  const platform = post.platform ? PLATFORM_NAME[post.platform] ?? post.platform : null;
  return (
    <div className="flex gap-3">
      <Avatar name={post.author} url={post.avatarUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
          {post.parentCommentId && <span className="text-[11.5px] text-ink-4">回复评论 #{post.parentCommentId}</span>}
          <span className="font-semibold text-ink-2 break-words [overflow-wrap:anywhere]">{post.author ?? "匿名用户"}</span>
          {platform && <span className="rounded bg-bg-sunk px-1 py-0.2 text-[10.5px] text-ink-4">{platform}</span>}
          {post.floor !== null && <span className="text-[11.5px] text-ink-4">#{post.floor}楼</span>}
          {post.isOriginalAuthor && post.floor !== 1 && (
            <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10.5px] font-medium text-accent">楼主</span>
          )}
          {at && <time dateTime={at} className="text-[11.5px] text-ink-4">{fullDateTime(at)}</time>}
          {typeof post.likes === "number" && post.likes > 0 && <span className="text-[11.5px] text-ink-4">👍 {post.likes}</span>}
          {typeof post.replyCount === "number" && post.replyCount > 0 && (
            <span className="text-[11.5px] text-ink-4">💬 {post.replyCount} 条回复</span>
          )}
        </div>
        {post.quote && (
          <blockquote className="mt-1.5 rounded border-l-2 border-line-strong bg-bg-sunk/60 px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink-3 break-words [overflow-wrap:anywhere]">
            {post.quote.author && <span className="font-semibold text-ink-2">{post.quote.author}：</span>}
            <span className="whitespace-pre-line">{post.quote.text}</span>
          </blockquote>
        )}
        <p className="mt-1 whitespace-pre-line break-words [overflow-wrap:anywhere] text-[14.5px] sm:text-[15px] leading-[1.75] text-ink">
          {post.text}
        </p>
      </div>
    </div>
  );
}

export function CommunityFeedback({
  community,
  originalUrl,
  title = "社区讨论",
}: {
  community?: CommunityView | null;
  originalUrl: string;
  title?: string;
}) {
  if (!community) {
    return (
      <section aria-label={title} className="mt-5 rounded-card border border-line-soft bg-surface p-4 sm:p-5 text-[13px] text-ink-3">
        <h2 className="mb-3 text-[13px] font-semibold tracking-wide text-ink-3">{title}</h2>
        <div className="rounded-control border border-dashed border-line-soft p-5 text-center">
          <p className="text-[13px] text-ink-3">评论暂不可用，未生成替代评论。</p>
          <a
            href={originalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex min-h-11 items-center font-medium text-accent hover:underline [overflow-wrap:anywhere]"
          >
            前往原文查看讨论 ↗
          </a>
        </div>
      </section>
    );
  }

  const {
    highlightedReplies,
    totalReplies,
    fetchedReplies,
    collection,
    communitySummary,
  } = community;

  const isUnavailable = collection?.coverage === "unavailable";
  const isPartial = collection?.coverage === "partial";
  const hasReplies = highlightedReplies.length > 0;

  return (
    <section aria-label={title} className="mt-5 rounded-card border border-line-soft bg-surface p-4 sm:p-5">
      <h2 className="mb-3 text-[13px] font-semibold tracking-wide text-ink-3">{title}</h2>
      {collection?.collectedAt && <p className="mb-3 text-[12px] text-ink-3">采集于 <time dateTime={collection.collectedAt}>{fullDateTime(collection.collectedAt)}</time>{isPartial ? " · 覆盖有限，不代表全部观众" : ""}</p>}

      {communitySummary && (
        <div className="mb-4 rounded-md bg-accent-soft/35 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink-2 border border-accent/15 break-words [overflow-wrap:anywhere]">
          <span className="mr-1.5 inline-block rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-accent">AI 整理</span>
          {communitySummary}
        </div>
      )}

      {isUnavailable ? (
        <div className="rounded-control border border-dashed border-line-strong p-5 text-center">
          <p className="text-[13px] text-ink-3">{collection?.error === "pendingSafetyReview" ? "讨论证据待审核，暂不展示精选评论；原文讨论可自行查看。" : "评论暂无法直接加载，完整讨论请前往原文查看。"}</p>
          <a
            href={originalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex min-h-11 items-center font-medium text-accent hover:underline [overflow-wrap:anywhere]"
          >
            前往原文查看评论 ↗
          </a>
        </div>
      ) : !hasReplies ? (
        <div className="rounded-control border border-dashed border-line-soft p-5 text-center">
          <p className="text-[13px] text-ink-3">
            {isPartial ? "仅采集部分讨论，暂无高价值评论入选。" : "暂无精选讨论。"}
          </p>
          <a
            href={originalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex min-h-11 items-center font-medium text-accent hover:underline [overflow-wrap:anywhere]"
          >
            前往原文查看全部评论 ↗
          </a>
        </div>
      ) : (
        <div className="space-y-4">
          {highlightedReplies.map((post, index) => (
            <DiscussionComment key={post.id ?? index} post={post} />
          ))}
        </div>
      )}

      {hasReplies && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-line pt-3 text-[12.5px] text-ink-4">
          <span>
            {totalReplies !== null && fetchedReplies !== null && fetchedReplies !== undefined
              ? `共 ${totalReplies} 条评论 · 已采集 ${fetchedReplies} 条 · 仅展示精选讨论`
              : totalReplies !== null
              ? `共 ${totalReplies} 条评论 · 仅展示精选讨论`
              : fetchedReplies !== null && fetchedReplies !== undefined
              ? `已采集 ${fetchedReplies} 条讨论 · 仅展示精选讨论`
              : "仅展示精选讨论"}
          </span>
          <a
            href={originalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center font-medium text-accent transition-colors hover:text-accent/85 [overflow-wrap:anywhere]"
          >
            查看完整讨论 ↗
          </a>
        </div>
      )}
    </section>
  );
}

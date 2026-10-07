// 社区帖子（forum_thread）的展示：原帖、楼主补充、社区讨论焦点、高亮讨论分层呈现。
// "原话"全部来自真实抓取；AI 只出现在标着"AI 整理"的讨论焦点里。
import type { CommunityView, DiscussionPostView } from "@aihot/contracts/site";
import { fullDateTime } from "../../lib/format";

const RULE = <div aria-hidden="true" className="my-5 border-t border-dashed border-line" />;

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

function Post({ post }: { post: DiscussionPostView }) {
  const at = post.publishedAt;
  return (
    <div className="flex gap-3">
      <Avatar name={post.author} url={post.avatarUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
          <span className="font-semibold text-ink-2">{post.author ?? "匿名用户"}</span>
          {post.floor !== null && <span className="text-[11.5px] text-ink-4">#{post.floor}楼</span>}
          {post.isOriginalAuthor && post.floor !== 1 && <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10.5px] font-medium text-accent">楼主</span>}
          {at && <time dateTime={at} className="text-[11.5px] text-ink-4">{fullDateTime(at)}</time>}
          {post.likes !== null && post.likes > 0 && <span className="text-[11.5px] text-ink-4">👍 {post.likes}</span>}
        </div>
        {post.quote && (
          <blockquote className="mt-1.5 border-l-2 border-line-strong pl-2.5 text-[12.5px] leading-relaxed text-ink-4">
            {post.quote.author && <span className="font-medium">{post.quote.author}：</span>}
            {post.quote.text.length > 120 ? `${post.quote.text.slice(0, 120)}…` : post.quote.text}
          </blockquote>
        )}
        <p className="mt-1 whitespace-pre-line text-[15px] leading-[1.75] text-ink">{post.text}</p>
      </div>
    </div>
  );
}

export function ForumThread({ community, originalUrl }: { community: CommunityView; originalUrl: string }) {
  const { originalPost, authorFollowups, highlightedReplies, totalReplies, communitySummary } = community;
  return (
    <section aria-label="社区帖子">
      <div className="rounded-card border border-line-soft bg-surface p-4 sm:p-5">
        <h2 className="mb-3 text-[12px] font-semibold tracking-wide text-ink-3">原帖</h2>
        <Post post={originalPost} />
        {authorFollowups.length > 0 && (
          <>
            {RULE}
            <h2 className="mb-3 text-[12px] font-semibold tracking-wide text-ink-3">楼主补充</h2>
            <div className="space-y-4">
              {authorFollowups.map((p, i) => <Post key={i} post={p} />)}
            </div>
          </>
        )}
        {communitySummary && (
          <>
            {RULE}
            <h2 className="mb-1.5 text-[12px] font-semibold tracking-wide text-ink-3">社区讨论焦点</h2>
            <div className="rounded-md bg-accent-soft/35 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink-2 border border-accent/15">
              <span className="mr-1.5 inline-block rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-accent">AI 整理</span>
              {communitySummary}
            </div>
          </>
        )}
        {highlightedReplies.length > 0 && (
          <>
            {RULE}
            <h2 className="mb-3 text-[12px] font-semibold tracking-wide text-ink-3">高亮讨论</h2>
            <div className="space-y-4">
              {highlightedReplies.map((p, i) => <Post key={i} post={p} />)}
            </div>
          </>
        )}
        {RULE}
        <div className="flex items-center justify-between text-[12.5px] text-ink-4">
          <span>{totalReplies !== null ? `共 ${totalReplies} 条回复 · 仅展示高价值讨论` : "仅展示高价值讨论"}</span>
          <a href={originalUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-accent transition-colors hover:text-accent/85">
            查看原帖 ↗
          </a>
        </div>
      </div>
    </section>
  );
}

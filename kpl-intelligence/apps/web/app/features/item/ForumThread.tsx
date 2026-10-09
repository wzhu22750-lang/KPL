// 社区帖子（forum_thread）的展示：原帖、楼主补充、社区讨论焦点、高亮讨论分层呈现。
// "原话"全部来自真实抓取；AI 只出现在标着"AI 整理"的讨论焦点里。
import type { CommunityView } from "@aihot/contracts/site";
import { CommunityFeedback, DiscussionComment } from "./CommunityFeedback";

const RULE = <div aria-hidden="true" className="my-5 border-t border-dashed border-line" />;

export function ForumThread({ community, originalUrl }: { community?: CommunityView | null; originalUrl: string }) {
  if (!community) {
    return <CommunityFeedback community={null} originalUrl={originalUrl} title="社区讨论" />;
  }
  const { originalPost, authorFollowups } = community;
  const followups = authorFollowups ?? [];

  return (
    <div className="space-y-4" aria-label="社区帖子">
      {originalPost && (
        <section aria-label="社区主帖" className="rounded-card border border-line-soft bg-surface p-4 sm:p-5">
          <h2 className="mb-3 text-[12px] font-semibold tracking-wide text-ink-3">原帖</h2>
          <DiscussionComment post={originalPost} />
          {followups.length > 0 && (
            <>
              {RULE}
              <h2 className="mb-3 text-[12px] font-semibold tracking-wide text-ink-3">楼主补充</h2>
              <div className="space-y-4">
                {followups.map((p, i) => (
                  <DiscussionComment key={p.id ?? i} post={p} />
                ))}
              </div>
            </>
          )}
        </section>
      )}
      <CommunityFeedback community={community} originalUrl={originalUrl} title="高亮讨论" />
    </div>
  );
}

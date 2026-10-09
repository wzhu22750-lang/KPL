// 短社交内容（social_post，非 X 渠道）的展示：原始内容、引用、来源入口、指标与讨论。
import type { CommunityView, SocialView } from "@aihot/contracts/site";
import { CommunityFeedback } from "./CommunityFeedback";

const compact = (n: number | null | undefined): string | null => {
  if (n === null || n === undefined) return null;
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return String(n);
};

function Stat({ label, value }: { label: string; value: string | null }) {
  if (value === null) return null;
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="mono text-[13px] font-semibold text-ink-2">{value}</span>
      <span className="text-[11.5px] text-ink-4">{label}</span>
    </span>
  );
}

export function SocialPost({
  social,
  community,
  originalUrl,
}: {
  social: SocialView;
  community?: CommunityView | null;
  originalUrl?: string;
}) {
  const hasStats = [social.views, social.likes, social.comments, social.shares, social.favorites].some(
    (v) => typeof v === "number"
  );

  return (
    <div className="space-y-4">
      <section aria-label="动态">
        <div className="rounded-card border border-line-soft bg-surface p-4 sm:p-5">
          <p className="whitespace-pre-line break-words [overflow-wrap:anywhere] text-[16px] leading-[1.8] text-ink">{social.postText}</p>
          {social.quoted && (
            <blockquote className="mt-4 rounded-md border-l-2 border-line-strong bg-bg-sunk px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink-3 break-words [overflow-wrap:anywhere]">
              {social.quoted.author && (
                <span className="mb-1 block text-[12px] font-semibold text-ink-4">引用 {social.quoted.author}</span>
              )}
              <span className="whitespace-pre-line">{social.quoted.text}</span>
            </blockquote>
          )}
          {hasStats && (
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line-soft pt-3">
              <Stat label="阅读" value={compact(social.views)} />
              <Stat label="点赞" value={compact(social.likes)} />
              <Stat label="评论" value={compact(social.comments)} />
              <Stat label="转发" value={compact(social.shares)} />
              <Stat label="收藏" value={compact(social.favorites)} />
            </div>
          )}
        </div>
      </section>

      {originalUrl && community !== undefined && (
        <CommunityFeedback community={community} originalUrl={originalUrl} title="动态评论" />
      )}
    </div>
  );
}

// 短社交内容（social_post，非 X 渠道）的展示：原始内容、引用、来源入口。
import type { SocialView } from "@aihot/contracts/site";

export function SocialPost({ social }: { social: SocialView }) {
  return (
    <section aria-label="动态">
      <div className="rounded-card border border-line-soft bg-surface p-4 sm:p-5">
        <p className="whitespace-pre-line text-[16px] leading-[1.8] text-ink">{social.postText}</p>
        {social.quoted && (
          <blockquote className="mt-4 rounded-md border-l-2 border-line-strong bg-bg-sunk px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink-3">
            {social.quoted.author && <span className="mb-1 block text-[12px] font-semibold text-ink-4">引用 {social.quoted.author}</span>}
            {social.quoted.text}
          </blockquote>
        )}
      </div>
    </section>
  );
}

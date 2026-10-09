// Source-aware ContentRenderer：按 content kind 分流到最适合的呈现，不再默认一切 = ArticleBody。
// article/news/official_announcement 走原有正文通道（item.tsx），这里处理其余形态与正文状态提示。
import type { ContentView, SiteContentKind } from "@aihot/contracts/site";
import { MediaGallery } from "./MediaGallery";
import { ForumThread } from "./ForumThread";
import { VideoContent } from "./VideoContent";
import { SocialPost } from "./SocialPost";
import { CommunityFeedback } from "./CommunityFeedback";

export const CONTENT_KIND_LABEL: Record<SiteContentKind, string> = {
  news: "报道",
  article: "报道",
  official_announcement: "官方",
  forum_thread: "社区",
  social_post: "动态",
  video_post: "视频",
  interview: "采访",
  analysis: "观点",
  unknown: "内容",
};

/** Feed 卡片与列表的轻度类型标签（不做视觉过载）。 */
export function ContentKindChip({ kind }: { kind: SiteContentKind }) {
  const label = CONTENT_KIND_LABEL[kind] ?? null;
  if (!label || kind === "news" || kind === "article") return null;
  return (
    <span className="inline-flex items-center rounded bg-bg-sunk px-1.5 py-0.5 text-[10.5px] font-medium text-ink-3 border border-line-soft">
      {label}
    </span>
  );
}

/** 正文状态如实表达：partial → 提示可能不完整；summary_only → 说明仅收录摘要。 */
export function QualityNotice({ content }: { content: ContentView }) {
  const { completeness } = content.quality;
  if (completeness === "partial") {
    return (
      <p className="mt-6 rounded-control bg-bg-sunk px-4 py-3 text-[13px] leading-relaxed text-ink-3">正文提取可能不完整，完整内容请查看原文。</p>
    );
  }
  if (completeness === "summary_only") {
    return (
      <p className="mt-6 rounded-control bg-bg-sunk px-4 py-3 text-[13px] leading-relaxed text-ink-3">当前仅收录摘要，完整内容请阅读原文。</p>
    );
  }
  return null;
}

/** kind → 专属视图的分流；article 族返回 null（item.tsx 走原有 ArticleBody）。 */
export function ContentRenderer({ content, originalUrl }: { content: ContentView; originalUrl: string }) {
  switch (content.kind) {
    case "forum_thread":
      return (
        <>
          {content.community ? (
            <ForumThread community={content.community} originalUrl={originalUrl} />
          ) : (
            <CommunityFeedback community={null} originalUrl={originalUrl} />
          )}
          {content.gallery && content.gallery.length > 0 && <MediaGallery media={content.gallery} postUrl={originalUrl} />}
        </>
      );
    case "video_post":
      return content.video ? (
        <>
          <VideoContent video={content.video} community={content.community} originalUrl={originalUrl} />
          {content.gallery && content.gallery.length > 0 && <MediaGallery media={content.gallery} postUrl={originalUrl} />}
        </>
      ) : null;
    case "social_post":
      return content.social ? (
        <>
          <SocialPost social={content.social} community={content.community} originalUrl={originalUrl} />
          {content.gallery && content.gallery.length > 0 && <MediaGallery media={content.gallery} postUrl={originalUrl} />}
        </>
      ) : null;
    default:
      return null;
  }
}

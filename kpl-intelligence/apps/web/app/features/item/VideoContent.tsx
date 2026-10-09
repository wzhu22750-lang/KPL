// 视频内容（video_post）的展示：封面、视频信息、视频简介——简介永远不叫"正文"。
// 没有字幕/transcript 时绝不生成"视频讲了什么"的内容。
import type { CommunityView, VideoView } from "@aihot/contracts/site";
import { CommunityFeedback } from "./CommunityFeedback";

const duration = (s: number | null): string | null => {
  if (s === null || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

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

export function VideoContent({
  video,
  community,
  originalUrl,
}: {
  video: VideoView;
  community?: CommunityView | null;
  originalUrl: string;
}) {
  const at = duration(video.durationSeconds);
  return (
    <div className="space-y-4">
      <section aria-label="视频内容">
        <div className="rounded-card border border-line-soft bg-surface p-4 sm:p-5">
          {video.cover && (
            <a href={originalUrl} target="_blank" rel="noopener noreferrer" className="group relative mb-4 block overflow-hidden rounded-tile">
              <img src={video.cover.url} srcSet={video.cover.srcSet} alt="视频封面" loading="lazy" className="block max-h-[420px] w-full object-cover transition-transform duration-300 group-hover:scale-[1.01]" />
              {at && (
                <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 mono text-[11.5px] text-white">{at}</span>
              )}
            </a>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line-soft pb-3">
            <span className="text-[12px] font-semibold text-ink-3">视频信息</span>
            {at && <Stat label="时长" value={at} />}
            <Stat label="播放" value={compact(video.views)} />
            <Stat label="点赞" value={compact(video.likes)} />
            <Stat label="评论" value={compact(video.comments)} />
            <Stat label="收藏" value={compact(video.favorites)} />
            <Stat label="投币" value={compact(video.coins)} />
            <Stat label="弹幕" value={compact(video.danmaku)} />
          </div>
          {video.description && (
            <div className="mt-4">
              <h2 className="mb-1.5 text-[12px] font-semibold tracking-wide text-ink-3">视频简介</h2>
              <p className="whitespace-pre-line break-words [overflow-wrap:anywhere] text-[15px] leading-[1.75] text-ink">{video.description}</p>
            </div>
          )}
          {video.transcriptSummary && (
            <div className="mt-4 rounded-md bg-accent-soft/35 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-ink-2 border border-accent/15 break-words [overflow-wrap:anywhere]">
              <span className="mr-1.5 inline-block rounded bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-accent">AI 整理</span>
              {video.transcriptSummary}
            </div>
          )}
          <div className="mt-5 flex justify-end">
            <a
              href={originalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-accent px-5 text-[13px] font-medium text-white shadow-sm transition hover:bg-accent/90 active:scale-[0.98]"
            >
              打开原视频 ↗
            </a>
          </div>
        </div>
      </section>

      {originalUrl && community !== undefined && (
        <CommunityFeedback community={community} originalUrl={originalUrl} title="视频讨论" />
      )}
    </div>
  );
}

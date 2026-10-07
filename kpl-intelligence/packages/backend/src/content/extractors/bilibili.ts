// Bilibili extractor：视频投稿 / 专栏 / 动态，绝不让简介冒充正文。
// 数据链：页面 __INITIAL_STATE__（videoData / readInfo）→ view API（fetchJson 受限回调）→ meta 标签。
// 产出的 CanonicalContent：video_post，main 为空（视频没有"正文"），简介放 video.description。
import { metaContent, type ContentExtractor, type ExtractionInput } from "./base.ts";
import type { CanonicalContent } from "./types.ts";

const BV = /\/video\/(BV[\w]+)|bvid=(BV[\w]+)/i;

interface BiliVideo {
  bvid: string;
  title: string;
  desc: string;
  cover: string | null;
  durationSeconds: number | null;
  publishedAt: string | null;
  owner: { name: string | null; avatar: string | null; mid: number | null };
  stat: { view: number | null; like: number | null; comment: number | null; favorite: number | null; share: number | null; coin: number | null };
}

function fromViewApi(v: any): BiliVideo | null {
  if (!v || typeof v !== "object" || !v.bvid || typeof v.title !== "string") return null;
  return {
    bvid: String(v.bvid),
    title: String(v.title),
    desc: String(v.desc ?? ""),
    cover: typeof v.pic === "string" ? v.pic.replace(/^http:/, "https:") : null,
    durationSeconds: Number.isFinite(v.duration) ? Number(v.duration) : null,
    publishedAt: Number.isFinite(v.pubdate) ? new Date(v.pubdate * 1000).toISOString() : null,
    owner: {
      name: v.owner?.name ?? null,
      avatar: v.owner?.face ? String(v.owner.face).replace(/^http:/, "https:") : null,
      mid: v.owner?.mid ?? null,
    },
    stat: {
      view: v.stat?.view ?? null, like: v.stat?.like ?? null, comment: v.stat?.reply ?? null,
      favorite: v.stat?.favorite ?? null, share: v.stat?.share ?? null, coin: v.stat?.coin ?? null,
    },
  };
}

function fromInitialState(html: string): BiliVideo | null {
  const m = html.match(/window\.__INITIAL_STATE__\s*=\s*/);
  if (!m) return null;
  const start = m.index! + m[0].length;
  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  for (let i = start; i < html.length && i < start + 4_000_000; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) {
        try {
          const state = JSON.parse(html.slice(start, i + 1)) as Record<string, any>;
          if (state.videoData) return fromViewApi(state.videoData);
        } catch {
          // not pure JSON
        }
        break;
      }
    }
  }
  return null;
}

async function fromViewApiFetch(bvid: string, input: ExtractionInput): Promise<BiliVideo | null> {
  if (!input.fetchJson) return null;
  try {
    const data = await input.fetchJson(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`) as Record<string, any> | null;
    if (data?.code === 0 && data.data) return fromViewApi(data.data);
  } catch {
    // offline / blocked: fall through to meta
  }
  return null;
}

function fromMeta(html: string): BiliVideo | null {
  const title = metaContent(html, "og:title") ?? metaContent(html, "title");
  if (!title) return null;
  const bvid = html.match(BV)?.[1] ?? html.match(BV)?.[2] ?? null;
  return {
    bvid: bvid ?? "",
    title,
    desc: metaContent(html, "description") ?? "",
    cover: metaContent(html, "og:image") ?? metaContent(html, "image") ?? null,
    durationSeconds: null,
    publishedAt: metaContent(html, "uploadDate") ?? null,
    owner: { name: metaContent(html, "author") ?? null, avatar: null, mid: null },
    stat: { view: null, like: null, comment: null, favorite: null, share: null, coin: null },
  };
}

export const bilibiliExtractor: ContentExtractor = {
  id: "bilibili",
  version: "1.0.0",

  canHandle(input: ExtractionInput): boolean {
    return /(^|\.)(?:bilibili\.com|b23\.tv)$/i.test(hostOf(input.url)) || input.profile.preferredExtractor === "bilibili";
  },

  async extract(input: ExtractionInput): Promise<CanonicalContent | null> {
    const html = input.html;
    const bvid = (html?.match(BV)?.[1] ?? html?.match(BV)?.[2] ?? input.url.match(BV)?.[1] ?? input.url.match(BV)?.[2]) ?? null;

    let video: BiliVideo | null = null;
    if (html) video = fromInitialState(html);
    if (!video && bvid) video = await fromViewApiFetch(bvid, input);
    if (!video && html) video = fromMeta(html);
    // 专栏（/read/cv…）与动态：页面本身就是图文正文，交给 generic 处理。
    if (!video && !/\/read\/cv|\/opus\//.test(input.url)) return null;
    if (!video) return null;

    const content: CanonicalContent = {
      kind: "video_post",
      title: video.title || input.title,
      author: {
        name: video.owner.name ?? input.author,
        avatarUrl: video.owner.avatar,
        profileUrl: video.owner.mid ? `https://space.bilibili.com/${video.owner.mid}` : null,
        role: "UP 主",
      },
      publishedAt: video.publishedAt ?? input.publishedAt?.toISOString() ?? null,
      lead: null,
      // 视频没有正文：main 恒空，简介在 video.description，UI 明确标"视频简介"。
      main: [],
      media: video.cover ? [{ type: "image", url: video.cover, caption: null, alt: video.title, width: null, height: null }] : [],
      discussion: null,
      video: {
        description: video.desc || null,
        cover: video.cover,
        durationSeconds: video.durationSeconds,
        transcriptSummary: null,
        chapters: null,
      },
      social: null,
      engagement: {
        views: video.stat.view,
        likes: video.stat.like,
        comments: video.stat.comment,
        shares: video.stat.share,
        favorites: video.stat.favorite,
      },
      extraction: {
        extractor: "bilibili",
        version: "1.0.0",
        sourceId: input.sourceId,
        sourceFamily: input.profile.contentFamily,
        fallbackUsed: false,
        bodyProvenance: video.owner.name && video.durationSeconds != null ? "source_api" : "page_dom",
        sourceAuthority: "official",
      },
      quality: { score: 0, completeness: video.desc ? "summary_only" : "partial", warnings: [] },
    };
    return content;
  },
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

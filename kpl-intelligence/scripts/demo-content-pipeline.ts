#!/usr/bin/env node
/**
 * Multi-source Content Intelligence Pipeline 的端到端演示：6 个案例各自走完整链路，
 * 打印每一步的真实产物（发现 → Raw → Profile → Extractor → CanonicalContent → Quality → AI 输入 → 网页视图）。
 *
 * 用法:
 *   node --import ./tests/databases.ts scripts/demo-content-pipeline.ts
 *   （需要 DATABASE_URL，或用 fixtures 离线模式：PIPELINE_DEMO_OFFLINE=1）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extractCanonical, profileFor } from "@aihot/backend/content/extractors/index";
import { canonicalToBody } from "@aihot/backend/content/canonical";
import { toContentView, contentKindOf } from "@aihot/backend/publication/items";
import { CONTENT_KIND_LABELS } from "@aihot/backend/editorial/input";
import { buildMaterial } from "@aihot/backend/editorial/input";
import type { ExtractionInput } from "@aihot/backend/content/extractors/base";
import type { ItemRow } from "@aihot/backend/publication/items";

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../tests/fixtures/content/${name}`, import.meta.url)), "utf8");

// 演示只需要签发站内图片代理地址；没有配置时给一个本地占位值（不接触任何真实密钥）。
process.env.IMG_PROXY_SIGN_SECRET ??= "demo-only-local-secret";
process.env.SITE_URL ??= "http://127.0.0.1:5173";

interface Case {
  name: string;
  url: string;
  sourceId: string;
  sourceKind: string;
  sourceConfig?: Record<string, unknown>;
  html: string | null;
  title?: string | null;
  xPost?: Record<string, unknown> | null;
  fetchJson?: ((url: string) => Promise<unknown>) | null;
  /** 该案例的"发现方式"（用于演示第一步）。 */
  discovery: string;
}

const cases: Case[] = [
  {
    name: "1. KPL 官方公众号文章",
    url: "https://mp.weixin.qq.com/s/fixture-official",
    sourceId: "mp-kpl-official",
    sourceKind: "mp_account",
    sourceConfig: { ghid: "gh_49991182cd21", nickname: "KPL王者荣耀职业联赛" },
    html: fixture("wechat-article.html"),
    title: "KPL 秋季赛常规赛第六周观赛指南",
    discovery: "mp_account 轮询（极致了 list API）→ 新帖 URL；或 web_list 抓到 mp.weixin.qq.com 链接",
  },
  {
    name: "2. 俱乐部公众号文章（AG 超玩会）",
    url: "https://mp.weixin.qq.com/s/fixture-club",
    sourceId: "mp-ag",
    sourceKind: "rss",
    sourceConfig: { feedUrl: "wechat://成都AG超玩会" },
    html: fixture("wechat-article.html").replace(/KPL王者荣耀职业联赛/g, "成都AG超玩会").replace(/KPL 秋季赛常规赛第六周观赛指南/g, "赛后战报：AG 主场 4:1 拿下对手"),
    title: "赛后战报：AG 主场 4:1 拿下对手",
    discovery: "rss transport（wechat:// 桥）→ 俱乐部公众号新帖",
  },
  {
    name: "3. 普通新闻媒体文章",
    url: "https://news.example-daily.com/kpl/2026-final",
    sourceId: "media-daily",
    sourceKind: "web_list",
    html: fixture("generic-news.html"),
    discovery: "web_list 列表页（无专用 adapter）→ 文章链接",
  },
  {
    name: "4. 虎扑社区帖子",
    url: "https://bbs.hupu.com/67890123.html",
    sourceId: "hupu-kog",
    sourceKind: "json_list",
    sourceConfig: { mode: "html_window_var", windowVar: "$$data" },
    html: fixture("hupu-thread.html"),
    discovery: "json_list（bbs.hupu.com/kog-postdate 的 $$data）→ 帖子链接",
  },
  {
    name: "5. Bilibili 视频",
    url: "https://www.bilibili.com/video/BV1FIXTURE01",
    sourceId: "bili-kpl-community",
    sourceKind: "json_list",
    sourceConfig: { url: "https://api.bilibili.com/x/web-interface/wbi/search/type" },
    html: fixture("bilibili-video.html"),
    discovery: "json_list（B站搜索 API，order=pubdate）→ 视频 BV 号",
  },
  {
    name: "6. 无专用 adapter 的普通网页",
    url: "https://blog.some-fan-site.example/kpl-review",
    sourceId: "fan-blog",
    sourceKind: "rss",
    sourceConfig: { feedUrl: "https://blog.some-fan-site.example/feed.xml" },
    html: `<!DOCTYPE html><html><head><title>一个粉丝站的决赛长评 - 站点</title><meta name="description" content="从观众视角写的决赛长评。"></head><body>
      <header><nav><a href="/">首页</a><a href="/kpl">KPL</a><a href="/tags">标签</a></nav></header>
      <div class="entry-content">
        <h1>一个粉丝站的决赛长评</h1>
        <p>看了整场决赛，最直观的感受是双方对版本的准备程度差距被放大到了运营层面。前两局的资源置换几乎是教科书级别。</p>
        <p>第三局的 BP 转折点出现在第二手，放出了对方最擅长的野核组合，随后的对线和节奏都被牵着走。这一点在赛后数据里也能看到。</p>
        <p>后面的比赛，落后一方试图通过换线找回节奏，但每次团战前的站位都差了半秒，导致先手永远在对方手里。这不是操作问题，是决策问题。</p>
        <p>总的来说，这是一场值得回看的决赛，双方都拿出了本赛季最高水平的执行力。</p>
      </div>
      <footer><a href="/about">关于</a><a href="/subscribe">订阅</a></footer>
    </body></html>`,
    discovery: "rss transport（聚合源）→ 原文链接；无专用 adapter",
  },
];

const line = (s = "") => console.log(s);
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function main() {
  line("=".repeat(78));
  line("Multi-source Content Intelligence Pipeline — 端到端演示（6 个案例）");
  line("=".repeat(78));

  for (const c of cases) {
    line(`\n${"━".repeat(78)}\n${c.name}\n${"━".repeat(78)}`);
    line(`① 发现链接：${c.discovery}`);
    line(`   URL: ${c.url}`);
    line(`   Raw Source: ${c.html ? `${c.html.length} 字节 HTML（如页面已被抓取）` : "无 HTML（结构化数据）"}`);

    const profile = profileFor({ sourceId: c.sourceId, url: c.url, kind: c.sourceKind, config: c.sourceConfig ?? null });
    line(`② Source Profile: ${profile.id} · family=${profile.contentFamily} · preferred=${profile.preferredExtractor} · presentation=${profile.presentation}`);
    line(`   supports: fullText=${profile.supports.fullText} comments=${profile.supports.comments} videoMeta=${profile.supports.videoMeta} nestedReplies=${profile.supports.nestedReplies}`);

    const input: ExtractionInput = {
      url: c.url,
      html: c.html,
      profile,
      sourceId: c.sourceId,
      sourceKind: c.sourceKind,
      title: c.title ?? null,
      excerpt: null,
      author: null,
      publishedAt: null,
      xPost: c.xPost ?? null,
      raw: null,
      sourceConfig: c.sourceConfig ?? null,
      fetchJson: c.fetchJson ?? null,
    };
    const result = await extractCanonical(input);
    if (!result) {
      line("✖ 整条 extractor 链无产出（该内容将保持 unconfirmed，绝不伪装）");
      continue;
    }
    const { content, body } = result;
    line(`③ Extractor: ${content.extraction.extractor} v${content.extraction.version} · provenance=${content.extraction.bodyProvenance} · fallback=${content.extraction.fallbackUsed}`);
    line(`④ CanonicalContent: kind=${content.kind}（${CONTENT_KIND_LABELS[content.kind] ?? content.kind}）`);
    line(`   title: ${cut(content.title ?? "(无)", 60)}`);
    line(`   author: ${content.author?.name ?? "(无)"} · publishedAt: ${content.publishedAt ?? "(无)"}`);
    line(`   main: ${content.main.length} 块 · media: ${content.media.length} 张图`);
    const firstBlocks = content.main.slice(0, 2).map((b) => `     - [${b.type}] ${cut("text" in b ? b.text : "", 70)}`).join("\n");
    if (firstBlocks) line(firstBlocks);
    if (content.discussion) {
      const d = content.discussion;
      line(`   discussion: 主帖 ${d.originalPost.text.length} 字 / 楼主补充 ${d.authorFollowups.length} / 高亮回复 ${d.highlightedReplies.length} / 总回复 ${d.totalReplies}`);
      for (const r of d.highlightedReplies.slice(0, 2)) line(`     - 高亮 @${r.author.name ?? "网友"}（👍${r.likes ?? 0}）${cut(r.text, 60)}`);
    }
    if (content.video) {
      line(`   video: 时长 ${content.video.durationSeconds ?? "-"}s · 封面 ${content.video.cover ? "有" : "无"} · 简介 ${content.video.description?.length ?? 0} 字`);
      line(`   views=${content.engagement?.views ?? "-"} likes=${content.engagement?.likes ?? "-"} comments=${content.engagement?.comments ?? "-"}`);
    }
    if (content.social) {
      line(`   social: ${cut(content.social.postText, 60)}${content.social.quoted ? "（含引用）" : ""}`);
    }
    line(`⑤ Quality: score=${content.quality.score} completeness=${content.quality.completeness} warnings=[${content.quality.warnings.join(", ")}]`);
    line(`⑥ 派生 body: html ${body.html.length} 字节 · text ${body.text.length} 字符 · images ${body.images.length}`);

    // AI 输入（分析步骤看到的材料）
    const aiInput = buildMaterial({
      id: "demo", revision: 1, title: content.title ?? "", url: c.url, author: content.author?.name ?? null,
      publishedAt: content.publishedAt ? new Date(content.publishedAt) : null, bodyText: body.text, excerpt: null,
      bodyStatus: "ok", contentKind: content.kind, xPost: null, media: [],
      source: { name: c.sourceId, kind: c.sourceKind, tier: "T1", firstParty: false },
    });
    line(`⑦ AI 理解输入（节选）:\n${cut(aiInput, 400).split("\n").map((l) => `   ${l}`).join("\n")}`);

    // 网页视图（site contract 的 content 视图）
    const row = {
      id: "demo", title: content.title ?? "", channel: "news", content_kind: content.kind,
      canonical_content: content as unknown as Record<string, unknown>,
      content_quality_score: content.quality.score, content_completeness: content.quality.completeness,
    } as unknown as ItemRow;
    const view = toContentView(row);
    line(`⑧ 前端 ContentRenderer 分流: ${view ? `${view.kind} → ${view.kind === "forum_thread" ? "<ForumThread />" : view.kind === "video_post" ? "<VideoContent />" : view.kind === "social_post" ? "<SocialPost />" : "正文状态提示"}` : "article 族 → <ArticleBody />"}`);
    if (view?.community) line(`   community 视图: 原帖 ${view.community.originalPost.text.length} 字 · 楼主补充 ${view.community.authorFollowups.length} · 高亮 ${view.community.highlightedReplies.length}`);
    if (view?.video) line(`   video 视图: 简介 ${view.video.description?.length ?? 0} 字（UI 标"视频简介"）`);
    void contentKindOf;
  }

  line(`\n${"=".repeat(78)}\n演示结束。\n${"=".repeat(78)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { exportMarkdown, loadItemDetail, markdownAvailable } from "@aihot/backend/publication/detail";
import { loadRadar } from "@aihot/backend/publication/radar";
import { assessRadar } from "@aihot/backend/editorial/radar";
import { canPublishSignalDetail, isCommunityFeedbackApproved, canonicalEvidenceHash } from "@aihot/backend/publication/rules";
import { toContentView, toFeedItemSummary, postView } from "@aihot/backend/publication/items";
import { RADAR } from "@aihot/industry/radar";
import { buildApp } from "../apps/api/src/app.ts";
import type { CanonicalContent } from "@aihot/backend/content/extractors/types";
import { canonicalToBody } from "@aihot/backend/content/canonical";

RADAR.enabled = true;

const t = tag();
const editorialWeiboSourceId = `ed-weibo-src-${t}`;
const editorialBiliSourceId = `ed-bili-src-${t}`;
const editorialHupuSourceId = `ed-hupu-src-${t}`;
const summaryEditorialSourceId = `ed-sum-src-${t}`;
const signalSourceId = `sig-src-${t}`;
const day = "2026-10-14";
const at = new Date(`${day}T12:00:00+08:00`);

const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body);
  const input = JSON.parse(body.messages.at(-1).content);
  const original = String(input.original ?? "");
  const isSafe = !original.includes("违规危险言论") && !original.includes("假赛恶意引文");
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            relevant: true,
            safe: isSafe,
            kind: "controversy",
            title: input.title,
            summary: `已确认的公开内容与观点：${input.title}`,
            claimStatus: "opinion",
            stance: "中立",
            evidence: [input.title],
            topicKey: null,
            information: 80,
            interpretation: 80,
            distinctiveness: 80,
            timeliness: 85,
            interest: 85,
            noise: 5,
            newDevelopment: false,
            reason: "社区讨论评估",
          }),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  };
});

process.env.ZHIPU_BASE_URL = `${provider.url}/v1`;
process.env.ZHIPU_API_KEY = "test-key";
process.env.COMMUNITY_PUBLICATION_ENABLED = "true";

const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources(id, name, kind, tier, owner_type, participation_mode, site_fulltext, enabled) VALUES
    (${editorialWeiboSourceId}, '微博官方俱乐部', 'weibo', 'T1_5', 'club', 'editorial', true, true),
    (${editorialBiliSourceId}, 'B站官方频道', 'json_list', 'T1_5', 'league', 'editorial', true, true),
    (${editorialHupuSourceId}, '虎扑王者专区', 'json_list', 'T2', 'community', 'editorial', true, true),
    (${summaryEditorialSourceId}, '编辑部摘要信源', 'weibo', 'T2', 'media', 'editorial', false, true),
    (${signalSourceId}, '热点信号社区', 'json_list', 'T2', 'community', 'hot_signal', true, true)`;
});

after(async () => {
  delete process.env.COMMUNITY_PUBLICATION_ENABLED;
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("editorial Bili/Weibo article details: original remains 200, raw unsafe comments/quotes withheld until assessed safe", async () => {
  const artId = `ed-weibo-art-${t}`;
  const rawPostText = "官方公告：2026年KPL春季赛季后赛赛程正式出炉。各战队积极备战。";
  const unsafeQuoteInjection = "违规危险言论！假赛恶意引文！";
  const unsafeCommentText = "黑粉恶意评论假赛抹黑。";

  const canonical: CanonicalContent = {
    kind: "social_post",
    title: "春季赛季后赛赛程出炉",
    author: { name: "官方战队", avatarUrl: null, profileUrl: null, role: null },
    publishedAt: at.toISOString(),
    lead: null,
    main: [],
    media: [],
    video: null,
    social: {
      postText: rawPostText,
      quoted: null,
    },
    engagement: {
      likes: 1000,
      shares: 200,
      comments: 50,
      views: 50000,
      favorites: 100,
    },
    extraction: {
      extractor: "weibo",
      version: "1.0.0",
      sourceId: editorialWeiboSourceId,
      sourceFamily: "social",
      fallbackUsed: false,
      bodyProvenance: "source_api",
      sourceAuthority: "official",
    },
    discussion: {
      originalPost: {
        id: "post-op",
        author: { name: "官方战队" },
        text: rawPostText,
        publishedAt: at.toISOString(),
        likes: 1000,
        floor: 1,
        isOriginalAuthor: true,
        platform: "weibo",
      },
      authorFollowups: [
        {
          id: "post-af1",
          author: { name: "官方战队" },
          text: "楼主补充：首轮对决将于本周五晚开启。",
          publishedAt: at.toISOString(),
          likes: 200,
          floor: 2,
          isOriginalAuthor: true,
          platform: "weibo",
        },
      ],
      highlightedReplies: [
        {
          id: "rep-unsafe",
          author: { name: "恶意黑粉" },
          quote: { author: "假借博主", text: unsafeQuoteInjection },
          text: unsafeCommentText,
          publishedAt: at.toISOString(),
          likes: 15,
          floor: 3,
          isOriginalAuthor: false,
          platform: "weibo",
        },
      ],
      totalReplies: 50,
      fetchedReplies: 5,
      collection: {
        collectedAt: at.toISOString(),
        coverage: "partial",
        provenance: "source_api",
        sourceUrl: `https://weibo.com/detail/${artId}`,
      },
      communitySummary: "AI总结提示存在假赛争议讨论",
    },
    quality: { score: 85, completeness: "full", warnings: [] },
  };

  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, canonical_content, content_kind, content_completeness, content_quality_score)
    VALUES (${artId}, ${editorialWeiboSourceId}, ${artId}, ${`https://weibo.com/detail/${artId}`}, '春季赛季后赛赛程出炉',
      ${rawPostText}, 'ok', ${at}, ${at}, ${at}, 1, ${sql.json(canonical as never)}, 'social_post', 'full', 85)`;

  await sql`INSERT INTO publications (article_id, source_id, title, summary, channel, url, discovered_at, timeline_at, published_at, sort_at,
    eligible, selected, seat, visible_after, visibility, body_mode, syndicate)
    VALUES (${artId}, ${editorialWeiboSourceId}, '春季赛季后赛赛程出炉', '官方发布赛程', 'news', ${`https://weibo.com/detail/${artId}`}, ${at}, ${at}, ${at}, ${at},
      true, true, true, ${at}, 'public', 'full', false)`;

  // 1. BEFORE radar assessment:
  // - Detail page must return 200 (kind: 'found', original editorial article access preserved!)
  // - Original article/social text is preserved and rendered
  // - Raw unsafe quote injection, unsafe reply, author followups, and communitySummary are WITHHELD
  // - Explicit waiting state coverage unavailable(error pendingSafetyReview) with no misleading timestamp
  const detailBefore = await loadItemDetail(artId);
  assert.equal(detailBefore.kind, "found", "editorial article detail must remain found (200)");
  assert.equal(detailBefore.item.title, "春季赛季后赛赛程出炉");
  assert.equal(detailBefore.item.content?.kind, "social_post");
  assert.equal(detailBefore.item.content?.social?.postText, rawPostText, "original social post text must be preserved");

  const commBefore = detailBefore.item.content?.community;
  assert.ok(commBefore, "community object must exist in waiting state");
  assert.deepEqual(commBefore.highlightedReplies, [], "raw unsafe comments must be withheld before assessment");
  assert.deepEqual(commBefore.authorFollowups, [], "author followups must be withheld before assessment");
  assert.equal(commBefore.communitySummary, null, "communitySummary must be withheld before assessment");
  assert.equal(commBefore.collection?.coverage, "unavailable", "coverage must be unavailable waiting state");
  assert.equal(commBefore.collection?.error, "pendingSafetyReview", "error must be pendingSafetyReview");
  assert.equal(commBefore.collection?.collectedAt, "", "collectedAt must be empty string to prevent misleading old timestamp display");

  // Feed preview must also suppress unchecked preview
  const feedSummary = toFeedItemSummary(detailBefore.row);
  assert.equal(feedSummary.commentPreview, null, "feed card must suppress unapproved comment preview");

  // Markdown export and body_html/body_text must NOT leak unreviewed comments
  if (detailBefore.item.body?.zh) {
    assert.ok(!detailBefore.item.body.zh.includes(unsafeQuoteInjection), "body zh must not leak unsafe quote before review");
    assert.ok(!detailBefore.item.body.zh.includes(unsafeCommentText), "body zh must not leak unsafe comment before review");
  }
  const mdBefore = await exportMarkdown(artId);
  assert.ok(mdBefore, "markdown export must remain available");
  assert.ok(!mdBefore.body.includes(unsafeQuoteInjection), "markdown export must not leak unsafe quote before review");
  assert.ok(!mdBefore.body.includes(unsafeCommentText), "markdown export must not leak unsafe comment before review");
  assert.ok(mdBefore.body.includes(rawPostText), "markdown export must retain original post text");

  // HTTP API test: endpoint returns 200, but raw unsafe quote injection does NOT leak into response JSON
  const apiRes = await app.inject({ method: "GET", url: `/api/site/items/${artId}` });
  assert.equal(apiRes.statusCode, 200);
  const apiBody = apiRes.body;
  assert.ok(!apiBody.includes(unsafeQuoteInjection), "raw unsafe quote injection must not be exposed in API before assessment");
  assert.ok(!apiBody.includes(unsafeCommentText), "raw unsafe comment text must not be exposed in API before assessment");
  assert.ok(apiBody.includes(rawPostText), "original official post text must be present in API");

  // 2. AFTER radar assessment marks safe & accepted with matching evidence hash:
  const hash = canonicalEvidenceHash(canonical);
  const safeJudgment = {
    relevant: true,
    safe: true,
    kind: "controversy",
    title: "春季赛季后赛赛程出炉",
    summary: "赛程公布引发讨论",
    claimStatus: "opinion",
    stance: "中立",
    evidence: [rawPostText],
    topicKey: null,
    information: 85,
    interpretation: 80,
    distinctiveness: 80,
    timeliness: 90,
    interest: 80,
    noise: 5,
    newDevelopment: false,
    reason: "赛程讨论",
  };

  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment,
    base_score, official_bonus, noise, score_version, reason, input_evidence_hash)
    VALUES (${artId}, 1, 'accepted', 'controversy', '春季赛季后赛赛程出炉', '赛程公布引发讨论', 'opinion', '中立',
      ${sql.json([rawPostText])}, ${sql.json(safeJudgment)}, 80, 10, 0, ${RADAR.version}, '赛程讨论', ${hash})`;

  const detailAfter = await loadItemDetail(artId);
  assert.equal(detailAfter.kind, "found");
  const commAfter = detailAfter.item.content?.community;
  assert.ok(commAfter);
  assert.equal(commAfter.highlightedReplies.length, 1, "safe comments exposed once radar assessment accepted");
  assert.equal(commAfter.highlightedReplies[0]!.quote?.text, unsafeQuoteInjection);
  assert.equal(commAfter.authorFollowups.length, 1, "author followups exposed once safe");
  assert.equal(commAfter.communitySummary, "AI总结提示存在假赛争议讨论", "communitySummary exposed once safe");
  assert.equal(commAfter.collection?.coverage, "partial", "original collection coverage restored");
  assert.equal(commAfter.collection?.collectedAt, at.toISOString(), "original collectedAt restored");
});

test("signal staleblocked unchanged: stale hash or unassessed signal items return 404", async () => {
  const sigArtId = `sig-art-stale-${t}`;
  const canonical: CanonicalContent = {
    kind: "forum_thread",
    title: "信号信源讨论帖",
    author: { name: "网友" },
    publishedAt: at.toISOString(),
    lead: null,
    main: [],
    media: [],
    video: null,
    social: null,
    engagement: null,
    extraction: {
      extractor: "forum",
      version: "1.0.0",
      sourceId: signalSourceId,
      sourceFamily: "community",
      fallbackUsed: false,
      bodyProvenance: "page_dom",
      sourceAuthority: "community",
    },
    discussion: {
      originalPost: { id: "p1", author: { name: "网友" }, text: "信号讨论", publishedAt: at.toISOString(), isOriginalAuthor: true },
      authorFollowups: [],
      highlightedReplies: [],
      totalReplies: 10,
      fetchedReplies: 2,
      collection: { collectedAt: at.toISOString(), coverage: "partial", provenance: "page_dom", sourceUrl: "https://example.test/sig" },
    },
    quality: { score: 75, completeness: "full", warnings: [] },
  };

  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, canonical_content, content_kind, content_completeness, content_quality_score)
    VALUES (${sigArtId}, ${signalSourceId}, ${sigArtId}, ${`https://example.test/sig/${sigArtId}`}, '信号信源讨论帖',
      '信号讨论', 'ok', ${at}, ${at}, ${at}, 1, ${sql.json(canonical as never)}, 'forum_thread', 'full', 75)`;

  // 1. Without radar material: signal item 404s
  const resNoRadar = await loadItemDetail(sigArtId);
  assert.equal(resNoRadar.kind, "not_found", "unassessed signal item must return 404");

  // 2. With stale hash in radar_materials: signal item still 404s
  const staleHash = "0000000000000000000000000000000000000000000000000000000000000000";
  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment,
    base_score, official_bonus, noise, score_version, reason, input_evidence_hash)
    VALUES (${sigArtId}, 1, 'accepted', 'controversy', '信号信源讨论帖', '摘要', 'opinion', '中立',
      ${sql.json(["信号讨论"])}, ${sql.json({ relevant: true, safe: true })}, 75, 0, 0, ${RADAR.version}, '分析', ${staleHash})`;

  const resStale = await loadItemDetail(sigArtId);
  assert.equal(resStale.kind, "not_found", "stale hash signal item must remain blocked (404)");

  // 3. With matching hash: signal item published
  const correctHash = canonicalEvidenceHash(canonical);
  await sql`UPDATE radar_materials SET input_evidence_hash = ${correctHash} WHERE article_id = ${sigArtId}`;
  const resMatch = await loadItemDetail(sigArtId);
  assert.equal(resMatch.kind, "found", "signal item with matching hash must be accessible");
});

test("sources licences preserved: site_fulltext false restricts full text to summary while preserving editorial access", async () => {
  const sumArtId = `ed-sum-art-${t}`;
  const bodyText = "这是未授权全文的编辑部文章，正文不可直接公开。";

  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, excerpt, body_status, published_at, discovered_at, timeline_at, revision, content_kind, content_completeness, content_quality_score)
    VALUES (${sumArtId}, ${summaryEditorialSourceId}, ${sumArtId}, ${`https://example.test/sum/${sumArtId}`}, '摘要授权文章',
      ${bodyText}, '合规摘要内容', 'ok', ${at}, ${at}, ${at}, 1, 'article', 'summary_only', 70)`;

  await sql`INSERT INTO publications (article_id, source_id, title, summary, channel, url, discovered_at, timeline_at, published_at, sort_at,
    eligible, selected, seat, visible_after, visibility, body_mode, syndicate)
    VALUES (${sumArtId}, ${summaryEditorialSourceId}, '摘要授权文章', '合规摘要内容', 'news', ${`https://example.test/sum/${sumArtId}`}, ${at}, ${at}, ${at}, ${at},
      true, true, true, ${at}, 'public', 'summary', false)`;

  const detail = await loadItemDetail(sumArtId);
  assert.equal(detail.kind, "found", "editorial article remains found even with summary-only license");
  assert.equal(detail.item.body, null, "site_fulltext false must not expose full body");
  assert.equal(detail.item.summary, "合规摘要内容", "summary must be exposed");

  // Markdown export exports only summary for summary-licensed sources
  const md = await exportMarkdown(sumArtId);
  assert.ok(md);
  assert.ok(!md.body.includes("## 正文"), "summary-licensed markdown must not contain full body section");
  assert.ok(md.body.includes("## 摘要"), "summary-licensed markdown must contain summary section");
});

test("regression test: new comments text changes evidence hash and triggers rejudging; counters change does not", async () => {
  const baseCanonical: CanonicalContent = {
    kind: "video_post",
    title: "B站精彩团战集锦",
    author: { name: "赛事运营" },
    publishedAt: at.toISOString(),
    lead: null,
    main: [],
    media: [],
    video: {
      description: "本期集锦收录总决赛第五局精彩团战。",
      cover: "https://example.test/cover.jpg",
      durationSeconds: 180,
      transcriptSummary: null,
    },
    social: null,
    engagement: {
      views: 100000,
      likes: 5000,
      comments: 300,
      shares: 100,
      favorites: 50,
      coins: 800,
      danmaku: 400,
    },
    extraction: {
      extractor: "bilibili",
      version: "1.0.0",
      sourceId: editorialBiliSourceId,
      sourceFamily: "video",
      fallbackUsed: false,
      bodyProvenance: "source_api",
      sourceAuthority: "official",
    },
    discussion: {
      originalPost: {
        id: "b-op",
        author: { name: "赛事运营" },
        text: "本期集锦收录总决赛第五局精彩团战。",
        publishedAt: at.toISOString(),
        likes: 5000,
        floor: 1,
        isOriginalAuthor: true,
        platform: "bilibili",
      },
      authorFollowups: [],
      highlightedReplies: [
        {
          id: "rep-1",
          author: { name: "观众甲" },
          text: "公孙离这波大招推三个太绝了！",
          publishedAt: at.toISOString(),
          likes: 200,
          floor: 2,
          isOriginalAuthor: false,
          platform: "bilibili",
        },
      ],
      totalReplies: 300,
      fetchedReplies: 10,
      collection: {
        collectedAt: at.toISOString(),
        coverage: "partial",
        provenance: "source_api",
        sourceUrl: "https://bilibili.com/video/1",
      },
      communitySummary: "观众盛赞公孙离高光表现",
    },
    quality: { score: 85, completeness: "full", warnings: [] },
  };

  const hashOriginal = canonicalEvidenceHash(baseCanonical);
  assert.ok(hashOriginal && hashOriginal.length === 64);

  // 1. Changing counters only (likes, views, comments, replyCount, fetchedReplies, totalReplies)
  const canonicalWithNewCounters: CanonicalContent = {
    ...baseCanonical,
    engagement: {
      ...baseCanonical.engagement!,
      views: 999999,
      likes: 88888,
      comments: 7777,
      shares: 666,
      coins: 5555,
      danmaku: 3333,
    },
    discussion: {
      ...baseCanonical.discussion!,
      originalPost: { ...baseCanonical.discussion!.originalPost, likes: 88888 },
      highlightedReplies: [
        { ...baseCanonical.discussion!.highlightedReplies[0]!, likes: 9999, replyCount: 120 },
      ],
      totalReplies: 7777,
      fetchedReplies: 50,
    },
  };
  const hashCounters = canonicalEvidenceHash(canonicalWithNewCounters);
  assert.equal(hashCounters, hashOriginal, "modifying metrics/counters only must NOT change evidence hash");

  // 2. Modifying comment text MUST change evidence hash
  const canonicalWithNewCommentText: CanonicalContent = {
    ...baseCanonical,
    discussion: {
      ...baseCanonical.discussion!,
      highlightedReplies: [
        {
          ...baseCanonical.discussion!.highlightedReplies[0]!,
          text: "被修改的新评论文本：辅助开团时机把握更关键。",
        },
      ],
    },
  };
  const hashNewText = canonicalEvidenceHash(canonicalWithNewCommentText);
  assert.notEqual(hashNewText, hashOriginal, "modifying comment text MUST change evidence hash");

  // 3. Adding a new highlighted reply MUST change evidence hash
  const canonicalWithAddedReply: CanonicalContent = {
    ...baseCanonical,
    discussion: {
      ...baseCanonical.discussion!,
      highlightedReplies: [
        baseCanonical.discussion!.highlightedReplies[0]!,
        {
          id: "rep-2",
          author: { name: "观众乙" },
          text: "这局BP确实完全限制了对面的野核体系。",
          publishedAt: at.toISOString(),
          likes: 50,
          floor: 3,
          isOriginalAuthor: false,
          platform: "bilibili",
        },
      ],
    },
  };
  const hashAddedReply = canonicalEvidenceHash(canonicalWithAddedReply);
  assert.notEqual(hashAddedReply, hashOriginal, "adding comment MUST change evidence hash");

  // 4. Modifying quoted text inside reply MUST change evidence hash
  const canonicalWithQuoteMutated: CanonicalContent = {
    ...baseCanonical,
    discussion: {
      ...baseCanonical.discussion!,
      highlightedReplies: [
        {
          ...baseCanonical.discussion!.highlightedReplies[0]!,
          quote: { author: "原发声人", text: "引用的关键论点文本变动" },
        },
      ],
    },
  };
  const hashQuoteMutated = canonicalEvidenceHash(canonicalWithQuoteMutated);
  assert.notEqual(hashQuoteMutated, hashOriginal, "modifying quote text MUST change evidence hash");

  // 5. In DB and assessRadar integration:
  // Comments text refresh forces rejudge (new model hit); counters change reuses judgment
  const rejudgeArtId = `rejudge-art-${t}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, canonical_content, content_kind, content_completeness, content_quality_score)
    VALUES (${rejudgeArtId}, ${editorialBiliSourceId}, ${rejudgeArtId}, ${`https://bilibili.com/video/${rejudgeArtId}`}, 'B站精彩团战集锦',
      '本期集锦收录总决赛第五局精彩团战。', 'ok', ${at}, ${at}, ${at}, 1, ${sql.json(baseCanonical as never)}, 'video_post', 'full', 85)`;

  const hits0 = provider.hits();
  const resAssess1 = await assessRadar(rejudgeArtId);
  assert.equal(resAssess1.state, "accepted");
  assert.equal(provider.hits(), hits0 + 1, "first assessment must hit model");

  // Updating counters: no new model call
  await sql`UPDATE articles SET canonical_content = ${sql.json(canonicalWithNewCounters as never)} WHERE id = ${rejudgeArtId}`;
  const hitsAfterCounters = provider.hits();
  const resAssessCounters = await assessRadar(rejudgeArtId);
  assert.equal(resAssessCounters.state, "accepted");
  assert.equal(provider.hits(), hitsAfterCounters, "updating counters only must reuse judgment with no paid model call");

  // Updating comment text: stale hash triggers rejudgment with new model call
  await sql`UPDATE articles SET canonical_content = ${sql.json(canonicalWithNewCommentText as never)} WHERE id = ${rejudgeArtId}`;
  const hitsBeforeRejudge = provider.hits();
  const resAssessNewText = await assessRadar(rejudgeArtId);
  assert.equal(resAssessNewText.state, "accepted");
  assert.equal(provider.hits(), hitsBeforeRejudge + 1, "updating comment text MUST trigger rejudge with model call");
  const [updatedRm] = await sql<{ input_evidence_hash: string | null }[]>`SELECT input_evidence_hash FROM radar_materials WHERE article_id = ${rejudgeArtId}`;
  assert.equal(updatedRm?.input_evidence_hash, hashNewText, "rejudged row must persist new evidence hash");
});

test("forum OP retains originalPost and gallery in toContentView even when comments are pending review", () => {
  const forumCanonical = {
    kind: "forum_thread" as const,
    title: "总决赛前瞻：野区博弈分析",
    author: { name: "战术分析师" },
    publishedAt: at.toISOString(),
    lead: "从首轮比赛看双方控龙策略",
    main: [],
    media: [
      { url: "https://example.test/map1.jpg", caption: "第一局控龙路线图", alt: "路线图" },
      { url: "https://example.test/map2.jpg", caption: "第二局控龙路线图", alt: "路线图2" },
    ],
    video: null,
    social: null,
    engagement: { comments: 50, likes: 120 },
    discussion: {
      originalPost: {
        id: "op-1",
        author: { name: "战术分析师" },
        text: "总决赛前瞻核心观点：前期控龙策略决定胜负走向。",
        publishedAt: at.toISOString(),
        likes: 120,
        floor: 1,
        isOriginalAuthor: true,
      },
      authorFollowups: [
        {
          id: "op-f1",
          author: { name: "战术分析师" },
          text: "楼主补充：双方打野刷野路线对比。",
          publishedAt: at.toISOString(),
          likes: 30,
          floor: 3,
          isOriginalAuthor: true,
        },
      ],
      highlightedReplies: [
        {
          id: "rep-1",
          author: { name: "读者A" },
          text: "完全赞同，前四分钟的节奏非常关键。",
          publishedAt: at.toISOString(),
          likes: 15,
          floor: 2,
          isOriginalAuthor: false,
        },
      ],
      totalReplies: 50,
      fetchedReplies: 5,
      collection: {
        collectedAt: at.toISOString(),
        coverage: "partial" as const,
        provenance: "page_dom" as const,
        sourceUrl: "https://example.test/thread/1",
      },
      communitySummary: "多数读者认同控龙策略核心论点",
    },
    quality: { score: 80, completeness: "full" as const, warnings: [] },
  };

  const forumRow: any = {
    id: "forum-pending-1",
    channel: "news",
    content_kind: "forum_thread",
    body_mode: "full",
    body_status: "ok",
    canonical_content: forumCanonical,
    source_name: "某论坛",
    source_mode: "hot_signal",
  };

  // 1. Explicitly pending review: feedbackApproved === false
  const pendingView = toContentView(forumRow, false);
  assert.ok(pendingView);
  assert.equal(pendingView.kind, "forum_thread");

  // OP text and author must remain intact
  assert.equal(pendingView.community?.originalPost.author, "战术分析师");
  assert.equal(pendingView.community?.originalPost.text, "总决赛前瞻核心观点：前期控龙策略决定胜负走向。");

  // Gallery media must remain intact
  assert.ok(pendingView.gallery && pendingView.gallery.length === 2, "gallery media must be retained even pending comments");

  // Comments and summary must be empty awaiting review
  assert.deepEqual(pendingView.community?.highlightedReplies, []);
  assert.deepEqual(pendingView.community?.authorFollowups, []);
  assert.equal(pendingView.community?.communitySummary, null);

  // Waiting state metadata
  assert.equal(pendingView.community?.collection?.coverage, "unavailable");
  assert.equal(pendingView.community?.collection?.error, "pendingSafetyReview");
  assert.equal(pendingView.community?.collection?.collectedAt, "");

  // 2. Explicitly approved: feedbackApproved === true
  const approvedView = toContentView(forumRow, true);
  assert.ok(approvedView);
  assert.equal(approvedView.community?.highlightedReplies.length, 1);
  assert.equal(approvedView.community?.authorFollowups.length, 1);
  assert.equal(approvedView.community?.communitySummary, "多数读者认同控龙策略核心论点");
  assert.equal(approvedView.community?.collection?.coverage, "partial");
  assert.equal(approvedView.community?.collection?.collectedAt, at.toISOString());
});

test("editorial Hupu forum thread: fail-closed safety gate, OP sanitized blocks retained, unreviewed flattened comments withheld from body and markdown until approved", async () => {
  const hupuArtId = `ed-hupu-art-${t}`;
  const opTitle = "虎扑深度探讨：总决赛中野控制链";
  const opParagraphText = "从近三场淘汰赛数据来看，胜者组队伍在第一条暴君处的先手权达到85%。";
  const followupText = "楼主复盘补充：辅助视野布控位置对比图。";
  const unsafeComment = "恶意抹黑言论！假赛违规指控！";

  const canonical: CanonicalContent = {
    kind: "forum_thread",
    title: opTitle,
    author: { name: "虎扑数据分析师" },
    publishedAt: at.toISOString(),
    lead: opParagraphText.slice(0, 50),
    main: [{ type: "paragraph", text: opParagraphText }],
    media: [],
    video: null,
    social: null,
    engagement: { comments: 80, likes: 250 },
    extraction: {
      extractor: "hupu",
      version: "1.0.0",
      sourceId: editorialHupuSourceId,
      sourceFamily: "community",
      fallbackUsed: false,
      bodyProvenance: "page_dom",
      sourceAuthority: "community",
    },
    discussion: {
      originalPost: {
        id: "hupu-op",
        author: { name: "虎扑数据分析师" },
        text: opParagraphText,
        publishedAt: at.toISOString(),
        likes: 250,
        floor: 1,
        isOriginalAuthor: true,
        platform: "hupu",
      },
      authorFollowups: [
        {
          id: "hupu-f1",
          author: { name: "虎扑数据分析师" },
          text: followupText,
          publishedAt: at.toISOString(),
          likes: 60,
          floor: 3,
          isOriginalAuthor: true,
          platform: "hupu",
        },
      ],
      highlightedReplies: [
        {
          id: "hupu-rep-1",
          author: { name: "极端喷子" },
          text: unsafeComment,
          publishedAt: at.toISOString(),
          likes: 20,
          floor: 2,
          isOriginalAuthor: false,
          platform: "hupu",
        },
      ],
      totalReplies: 80,
      fetchedReplies: 10,
      collection: {
        collectedAt: at.toISOString(),
        coverage: "partial",
        provenance: "page_dom",
        sourceUrl: `https://bbs.hupu.com/thread/${hupuArtId}`,
      },
      communitySummary: "社区讨论激烈",
    },
    quality: { score: 85, completeness: "full", warnings: [] },
  };

  // 模拟真实落库流程：canonicalToBody 将 discussion 回复压平成 body_html 与 body_text
  const derived = canonicalToBody(canonical);
  assert.ok(derived.html.includes(unsafeComment), "raw derived body initially includes flattened replies");

  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_html, body_text, body_status, published_at, discovered_at, timeline_at, revision, canonical_content, content_kind, content_completeness, content_quality_score)
    VALUES (${hupuArtId}, ${editorialHupuSourceId}, ${hupuArtId}, ${`https://bbs.hupu.com/thread/${hupuArtId}`}, ${opTitle},
      ${derived.html}, ${derived.text}, 'ok', ${at}, ${at}, ${at}, 1, ${sql.json(canonical as never)}, 'forum_thread', 'full', 85)`;

  await sql`INSERT INTO publications (article_id, source_id, title, summary, channel, url, discovered_at, timeline_at, published_at, sort_at,
    eligible, selected, seat, visible_after, visibility, body_mode, syndicate)
    VALUES (${hupuArtId}, ${editorialHupuSourceId}, ${opTitle}, '控龙策略探讨', 'news', ${`https://bbs.hupu.com/thread/${hupuArtId}`}, ${at}, ${at}, ${at}, ${at},
      true, true, true, ${at}, 'public', 'full', false)`;

  // 1. BEFORE Radar Assessment:
  // - 详情页 200（editorial 原文可访问性保留）
  // - 主帖 OP 纯净段落块保留
  // - 未审核的压平评论及【楼主补充】从 body_html/body_text/Markdown 中彻底剔除
  // - typed community 中 highlightedReplies 与 authorFollowups 为空，coverage 为 unavailable(pendingSafetyReview)
  const detailBefore = await loadItemDetail(hupuArtId);
  assert.equal(detailBefore.kind, "found", "editorial Hupu thread must remain found (200)");
  assert.equal(detailBefore.item.content?.kind, "forum_thread");
  assert.equal(detailBefore.item.content?.community?.originalPost.text, opParagraphText, "OP retained");
  assert.deepEqual(detailBefore.item.content?.community?.highlightedReplies, [], "replies withheld pending review");
  assert.deepEqual(detailBefore.item.content?.community?.authorFollowups, [], "author followups withheld pending review");
  assert.equal(detailBefore.item.content?.community?.collection?.coverage, "unavailable");
  assert.equal(detailBefore.item.content?.community?.collection?.error, "pendingSafetyReview");

  // body 与 Markdown 绝不泄露未审核内容
  assert.ok(!detailBefore.item.body?.zh?.includes(unsafeComment), "body_html must not leak unreviewed comments");
  assert.ok(!detailBefore.item.body?.zh?.includes(followupText), "body_html must not leak unreviewed author followups");
  assert.ok(detailBefore.item.body?.zh?.includes(opParagraphText), "body_html retains sanitized OP blocks");

  const mdBefore = await exportMarkdown(hupuArtId);
  assert.ok(mdBefore, "markdown export available for full licensed editorial");
  assert.ok(!mdBefore.body.includes(unsafeComment), "markdown must not leak unreviewed comments");
  assert.ok(!mdBefore.body.includes(followupText), "markdown must not leak unreviewed author followups");
  assert.ok(mdBefore.body.includes(opParagraphText), "markdown retains sanitized OP blocks");

  // 列表 FeedPreview 抑制未审核评论
  const feedSummary = toFeedItemSummary(detailBefore.row);
  assert.equal(feedSummary.commentPreview, null, "feed card must withhold unapproved comment preview for Hupu");

  // HTTP API 不泄漏未审核言论
  const apiRes = await app.inject({ method: "GET", url: `/api/site/items/${hupuArtId}` });
  assert.equal(apiRes.statusCode, 200);
  assert.ok(!apiRes.body.includes(unsafeComment), "API JSON must not leak unreviewed comments");

  // 2. AFTER Radar Assessment marks safe & accepted with matching evidence hash:
  const hash = canonicalEvidenceHash(canonical);
  const safeJudgment = {
    relevant: true,
    safe: true,
    kind: "controversy",
    title: opTitle,
    summary: "控龙策略理性讨论",
    claimStatus: "opinion",
    stance: "中立",
    evidence: [opTitle],
    topicKey: null,
    information: 80,
    interpretation: 80,
    distinctiveness: 80,
    timeliness: 85,
    interest: 85,
    noise: 5,
    newDevelopment: false,
    reason: "战术分析讨论",
  };

  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment,
    base_score, official_bonus, noise, score_version, reason, input_evidence_hash)
    VALUES (${hupuArtId}, 1, 'accepted', 'controversy', ${opTitle}, '控龙策略理性讨论', 'opinion', '中立',
      ${sql.json([opTitle])}, ${sql.json(safeJudgment)}, 80, 0, 0, ${RADAR.version}, '战术分析讨论', ${hash})`;

  const detailAfter = await loadItemDetail(hupuArtId);
  assert.equal(detailAfter.kind, "found");
  assert.equal(detailAfter.item.content?.community?.highlightedReplies.length, 1, "replies revealed once approved");
  assert.equal(detailAfter.item.content?.community?.authorFollowups.length, 1, "followups revealed once approved");
  assert.equal(detailAfter.item.content?.community?.collection?.coverage, "partial", "coverage restored");

  const feedSummaryAfter = toFeedItemSummary(detailAfter.row);
  assert.ok(feedSummaryAfter.commentPreview, "feed preview revealed once approved");
});

test("legacy editorial article with no collection: safety gate bypassed and full original body accessible unchanged", async () => {
  const legacyArtId = `ed-legacy-art-${t}`;
  const articleBody = "<p>这是一篇无讨论集合抓取的传统编辑部文章正文，包含战队专访内容。</p>";

  const canonical: CanonicalContent = {
    kind: "article",
    title: "冠军战队独家专访",
    author: { name: "官方记者" },
    publishedAt: at.toISOString(),
    lead: "专访内容摘要",
    main: [{ type: "paragraph", text: "这是一篇无讨论集合抓取的传统编辑部文章正文，包含战队专访内容。" }],
    media: [],
    video: null,
    social: null,
    engagement: null,
    extraction: {
      extractor: "wechat",
      version: "1.0.0",
      sourceId: editorialWeiboSourceId,
      sourceFamily: "official",
      fallbackUsed: false,
      bodyProvenance: "page_dom",
      sourceAuthority: "official",
    },
    // 没有 discussion.collection
    discussion: null,
    quality: { score: 90, completeness: "full", warnings: [] },
  };

  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_html, body_text, body_status, published_at, discovered_at, timeline_at, revision, canonical_content, content_kind, content_completeness, content_quality_score)
    VALUES (${legacyArtId}, ${editorialWeiboSourceId}, ${legacyArtId}, ${`https://example.test/legacy/${legacyArtId}`}, '冠军战队独家专访',
      ${articleBody}, '这是一篇无讨论集合抓取的传统编辑部文章正文，包含战队专访内容。', 'ok', ${at}, ${at}, ${at}, 1, ${sql.json(canonical as never)}, 'article', 'full', 90)`;

  await sql`INSERT INTO publications (article_id, source_id, title, summary, channel, url, discovered_at, timeline_at, published_at, sort_at,
    eligible, selected, seat, visible_after, visibility, body_mode, syndicate)
    VALUES (${legacyArtId}, ${editorialWeiboSourceId}, '冠军战队独家专访', '专访内容摘要', 'news', ${`https://example.test/legacy/${legacyArtId}`}, ${at}, ${at}, ${at}, ${at},
      true, true, true, ${at}, 'public', 'full', false)`;

  // 无 discussion.collection 时：无需 radar feedback 审核，传统文章正文完全不受影响正常展示
  const detail = await loadItemDetail(legacyArtId);
  assert.equal(detail.kind, "found");
  assert.ok(detail.item.body?.zh?.includes("包含战队专访内容"), "original body preserved unchanged");

  const md = await exportMarkdown(legacyArtId);
  assert.ok(md);
  assert.ok(md.body.includes("包含战队专访内容"), "markdown export preserves full article body");
});

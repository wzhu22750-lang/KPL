import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { exportMarkdown, loadItemDetail, markdownAvailable } from "@aihot/backend/publication/detail";
import { loadRadar } from "@aihot/backend/publication/radar";
import { canPublishSignalDetail, isCommunityPublicationEnabled, canonicalEvidenceHash } from "@aihot/backend/publication/rules";
import { toContentView, toFeedItemSummary, postView } from "@aihot/backend/publication/items";
import { RADAR } from "@aihot/industry/radar";
import { buildApp } from "../apps/api/src/app.ts";
import { upsertMaterial } from "@aihot/backend/content/materials";

RADAR.enabled = true;

const t = tag();
const communitySourceId = `src-comm-${t}`;
const licensedSourceId = `src-comm-lic-${t}`;
const officialSourceId = `src-off-${t}`;
const day = "2026-10-08";
const at = new Date(`${day}T12:00:00+08:00`);

const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body);
  const input = JSON.parse(body.messages.at(-1).content);
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            relevant: true,
            safe: true,
            kind: "controversy",
            title: input.title,
            summary: `已确认的公开内容与观点：${input.title}`,
            claimStatus: "opinion",
            stance: "支持",
            evidence: [input.title],
            topicKey: null,
            information: 80,
            interpretation: 80,
            distinctiveness: 80,
            timeliness: 85,
            interest: 85,
            noise: 5,
            newDevelopment: false,
            reason: "社区热议内容",
          }),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  };
});
process.env.ZHIPU_BASE_URL = `${provider.url}/v1`;
process.env.ZHIPU_API_KEY = "test-key";

const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources(id, name, kind, tier, owner_type, participation_mode, site_fulltext, enabled) VALUES
    (${communitySourceId}, '未授权社区信源', 'json_list', 'T2', 'community', 'hot_signal', false, true),
    (${licensedSourceId}, '授权社区信源', 'json_list', 'T2', 'community', 'hot_signal', true, true),
    (${officialSourceId}, '官方信源', 'weibo', 'T1_5', 'club', 'editorial', true, true)`;
});

after(async () => {
  delete process.env.COMMUNITY_PUBLICATION_ENABLED;
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("signal detail gate: disabled by default, enabled ONLY when COMMUNITY_PUBLICATION_ENABLED === 'true' and criteria met", async () => {
  delete process.env.COMMUNITY_PUBLICATION_ENABLED;
  assert.equal(isCommunityPublicationEnabled(), false);

  const articleId = `art-gate-${t}`;
  const canonical = {
    kind: "forum_thread",
    title: "关于总决赛首发阵容的热议",
    author: { name: "电竞老炮" },
    publishedAt: at.toISOString(),
    lead: "首发名单公布后引发讨论",
    main: [],
    media: [],
    discussion: {
      originalPost: {
        id: "op-1",
        author: { name: "电竞老炮" },
        text: "这次淘汰赛首发的调整大家怎么看？打野轮换是否合理？",
        publishedAt: at.toISOString(),
        likes: 120,
        floor: 1,
        isOriginalAuthor: true,
        platform: "hupu",
        replyCount: 50,
      },
      authorFollowups: [],
      highlightedReplies: [
        {
          id: "rep-1",
          author: { name: "资深粉丝" },
          text: "常规赛后半段效果不错，值得一试，支持教练组决策。",
          publishedAt: at.toISOString(),
          likes: 88,
          floor: 2,
          isOriginalAuthor: false,
          platform: "hupu",
          parentCommentId: "op-1",
        },
      ],
      totalReplies: 50,
      fetchedReplies: 10,
      collection: {
        collectedAt: at.toISOString(),
        coverage: "partial" as const,
        provenance: "page_dom" as const,
        sourceUrl: `https://bbs.hupu.com/${t}/1`,
      },
      communitySummary: "多数球迷支持轮换调整",
    },
    quality: {
      score: 75,
      completeness: "full" as const,
      warnings: [],
    },
  };

  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, canonical_content, content_kind, content_completeness, content_quality_score)
    VALUES (${articleId}, ${licensedSourceId}, ${articleId}, ${`https://bbs.hupu.com/${t}/1`}, '关于总决赛首发阵容的热议',
      '这次淘汰赛首发的调整大家怎么看？打野轮换是否合理？', 'ok', ${at}, ${at}, ${at}, 1, ${sql.json(canonical)}, 'forum_thread', 'full', 75)`;

  await sql`INSERT INTO publications (article_id, source_id, title, summary, channel, url, discovered_at, timeline_at, published_at, sort_at,
    eligible, selected, seat, visible_after, visibility, body_mode, syndicate)
    VALUES (${articleId}, ${licensedSourceId}, '关于总决赛首发阵容的热议', '关于总决赛首发阵容的热议', 'news', ${`https://bbs.hupu.com/${t}/1`}, ${at}, ${at}, ${at}, ${at},
      false, false, false, ${at}, 'public', 'full', false)`;

  const judgment = {
    relevant: true,
    safe: true,
    kind: "controversy",
    title: "关于总决赛首发阵容的热议",
    summary: "讨论热烈",
    claimStatus: "opinion",
    stance: "支持",
    evidence: ["这次淘汰赛首发的调整大家怎么看？"],
    topicKey: null,
    information: 80,
    interpretation: 80,
    distinctiveness: 80,
    timeliness: 85,
    interest: 85,
    noise: 5,
    newDevelopment: false,
    reason: "高热度讨论",
  };

  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment,
    base_score, official_bonus, noise, score_version, reason)
    VALUES (${articleId}, 1, 'accepted', 'controversy', '关于总决赛首发阵容的热议', '讨论热烈', 'opinion', '支持',
      ${sql.json(["这次淘汰赛首发的调整大家怎么看？"])}, ${sql.json(judgment)}, 70, 0, 0, ${RADAR.version}, '高热度讨论')`;

  await sql`UPDATE radar_materials SET input_evidence_hash=${canonicalEvidenceHash(canonical)} WHERE article_id=${articleId}`;

  // 1. When COMMUNITY_PUBLICATION_ENABLED is off: detail returns 404
  const resOff = await loadItemDetail(articleId);
  assert.equal(resOff.kind, "not_found", "signal detail must not publish when feature flag is off");

  const apiResOff = await app.inject({ method: "GET", url: `/api/site/items/${articleId}` });
  assert.equal(apiResOff.statusCode, 404);

  // Radar should not have itemUrl when flag is off (links never 404)
  const radarOff = await loadRadar(day);
  const materialOff = radarOff.standalone.find((m) => m.id === articleId);
  if (materialOff) {
    assert.equal(materialOff.itemUrl, null, "radar material must not link to 404 detail page");
  }

  // 2. When COMMUNITY_PUBLICATION_ENABLED === 'true'
  process.env.COMMUNITY_PUBLICATION_ENABLED = "true";
  assert.equal(isCommunityPublicationEnabled(), true);

  const resOn = await loadItemDetail(articleId);
  assert.equal(resOn.kind, "found", "accepted signal material with nonfailed quality must have detail page");
  assert.equal(resOn.item.content?.kind, "forum_thread");
  assert.equal(resOn.item.content?.community?.originalPost?.author, "电竞老炮");
  assert.equal(resOn.item.content?.community?.fetchedReplies, 10);
  assert.equal(resOn.item.content?.community?.totalReplies, 50);

  const apiResOn = await app.inject({ method: "GET", url: `/api/site/items/${articleId}` });
  assert.equal(apiResOn.statusCode, 200);

  // Admitted page markdown export (licensed source)
  assert.equal(resOn.item.markdownAvailable, true, "admitted page must have markdownAvailable === true");
  const mdOn = await exportMarkdown(articleId);
  assert.ok(mdOn, "admitted page must export markdown");
  assert.ok(mdOn.body.includes("## 正文"), "licensed source must include body in markdown");
  const apiMdOn = await app.inject({ method: "GET", url: `/items/${articleId}/markdown` });
  assert.equal(apiMdOn.statusCode, 200, "markdown endpoint returns 200");

  // Radar material now carries itemUrl matching the detail page
  const radarOn = await loadRadar(day);
  const materialOn = radarOn.standalone.find((m) => m.id === articleId);
  assert.ok(materialOn, "material should appear in radar standalone");
  assert.ok(materialOn.itemUrl?.includes(articleId), "radar material should carry safe non-404 itemUrl");

  // Verify no blanket editorial conversion occurred
  const [sourceRow] = await sql<{ participation_mode: string }[]>`SELECT participation_mode FROM sources WHERE id = ${licensedSourceId}`;
  assert.equal(sourceRow!.participation_mode, "hot_signal", "source participation_mode must remain hot_signal");

  // 3. Negative Gate: Review state rejects publication
  await sql`UPDATE radar_materials SET state = 'review' WHERE article_id = ${articleId}`;
  assert.equal((await loadItemDetail(articleId)).kind, "not_found");
  assert.equal((await app.inject({ method: "GET", url: `/api/site/items/${articleId}` })).statusCode, 404);
  assert.equal(await exportMarkdown(articleId), null, "review state rejects markdown export");
  assert.equal((await app.inject({ method: "GET", url: `/items/${articleId}/markdown` })).statusCode, 404);

  // 4. Negative Gate: Stale revision rejects publication
  await sql`UPDATE radar_materials SET state = 'accepted', input_revision = 0 WHERE article_id = ${articleId}`;
  assert.equal((await loadItemDetail(articleId)).kind, "not_found");

  // 5. Negative Gate: Score version mismatch rejects publication
  await sql`UPDATE radar_materials SET input_revision = 1, score_version = 'old-v0' WHERE article_id = ${articleId}`;
  assert.equal((await loadItemDetail(articleId)).kind, "not_found");

  // 6. Negative Gate: Unsafe judgment rejects publication
  await sql`UPDATE radar_materials SET score_version = ${RADAR.version}, judgment = ${sql.json({ ...judgment, safe: false })} WHERE article_id = ${articleId}`;
  assert.equal((await loadItemDetail(articleId)).kind, "not_found");

  // 7. Negative Gate: Failed quality completeness rejects publication
  await sql`UPDATE radar_materials SET judgment = ${sql.json(judgment)} WHERE article_id = ${articleId}`;
  await sql`UPDATE articles SET content_completeness = 'failed' WHERE id = ${articleId}`;
  assert.equal((await loadItemDetail(articleId)).kind, "not_found");

  // 8. Negative Gate: Low quality score rejects publication
  await sql`UPDATE articles SET content_completeness = 'partial', content_quality_score = 25 WHERE id = ${articleId}`;
  assert.equal((await loadItemDetail(articleId)).kind, "not_found");

  // Restore valid quality
  await sql`UPDATE articles SET content_completeness = 'full', content_quality_score = 75 WHERE id = ${articleId}`;
  assert.equal((await loadItemDetail(articleId)).kind, "found");
});

test("licensing & preview: comment preview limited by site_fulltext permission, no fulltext grant automatically", async () => {
  process.env.COMMUNITY_PUBLICATION_ENABLED = "true";
  const unlicArticleId = `art-unlic-${t}`;

  const canonical = {
    kind: "forum_thread",
    title: "未授权信源讨论",
    author: { name: "匿名A" },
    publishedAt: at.toISOString(),
    lead: "未授权信源内容",
    main: [],
    media: [],
    discussion: {
      originalPost: {
        id: "op-unlic",
        author: { name: "匿名A" },
        text: "未获得授权的帖子正文与评论全文",
        publishedAt: at.toISOString(),
        likes: 10,
        floor: 1,
        isOriginalAuthor: true,
      },
      authorFollowups: [],
      highlightedReplies: [
        {
          id: "rep-unlic",
          author: { name: "匿名B" },
          text: "未获得授权的评论高亮内容",
          publishedAt: at.toISOString(),
          likes: 5,
          floor: 2,
          isOriginalAuthor: false,
        },
      ],
      totalReplies: 20,
      fetchedReplies: 5,
    },
    quality: {
      score: 60,
      completeness: "partial" as const,
      warnings: [],
    },
  };

  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, canonical_content, content_kind, content_completeness, content_quality_score)
    VALUES (${unlicArticleId}, ${communitySourceId}, ${unlicArticleId}, ${`https://bbs.hupu.com/${t}/unlic`}, '未授权信源讨论',
      '未获得授权的帖子正文与评论全文', 'ok', ${at}, ${at}, ${at}, 1, ${sql.json(canonical)}, 'forum_thread', 'partial', 60)`;

  await sql`INSERT INTO publications (article_id, source_id, title, summary, channel, url, discovered_at, timeline_at, published_at, sort_at,
    eligible, selected, seat, visible_after, visibility, body_mode, syndicate)
    VALUES (${unlicArticleId}, ${communitySourceId}, '未授权信源讨论', '未授权信源讨论摘要', 'news', ${`https://bbs.hupu.com/${t}/unlic`}, ${at}, ${at}, ${at}, ${at},
      false, false, false, ${at}, 'public', 'summary', false)`;

  const judgment = {
    relevant: true,
    safe: true,
    kind: "fun",
    title: "未授权信源讨论",
    summary: "摘要测试",
    claimStatus: "joke",
    stance: null,
    evidence: ["未获得授权的帖子正文与评论全文"],
    topicKey: null,
    information: 70,
    interpretation: 70,
    distinctiveness: 70,
    timeliness: 70,
    interest: 70,
    noise: 10,
    newDevelopment: false,
    reason: "趣味讨论",
  };

  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment,
    base_score, official_bonus, noise, score_version, reason)
    VALUES (${unlicArticleId}, 1, 'accepted', 'fun', '未授权信源讨论', '摘要测试', 'joke', null,
      ${sql.json(["未获得授权的帖子正文与评论全文"])}, ${sql.json(judgment)}, 65, 0, 0, ${RADAR.version}, '趣味讨论')`;

  // Radar check: site_fulltext is false -> evidence and commentPreview must be withheld
  const radar = await loadRadar(day);
  const material = radar.standalone.find((m) => m.id === unlicArticleId);
  assert.ok(material);
  assert.equal(material.evidence.length, 0, "evidence must be withheld without site_fulltext permission");
  assert.equal(material.commentPreview, null, "commentPreview must be withheld without site_fulltext permission");

  // Detail check: toContentView must withhold community body and mark completeness summary_only
  const detail = await loadItemDetail(unlicArticleId);
  assert.equal(detail.kind, "found");
  assert.equal(detail.item.content?.community, null, "community body must be null when body_mode is summary");
  assert.equal(detail.item.content?.quality.completeness, "summary_only");

  // Markdown export check: admitted unlicensed page exports without 404, but source license obeyed (no full text)
  assert.equal(detail.item.markdownAvailable, true, "admitted unlicensed page has markdownAvailable === true");
  const mdUnlic = await exportMarkdown(unlicArticleId);
  assert.ok(mdUnlic, "unlicensed admitted page exports markdown without 404");
  assert.ok(mdUnlic.body.includes("## 摘要"), "markdown includes summary");
  assert.equal(mdUnlic.body.includes("## 正文"), false, "source license obeyed: no full text");
  const apiMdUnlic = await app.inject({ method: "GET", url: `/items/${unlicArticleId}/markdown` });
  assert.equal(apiMdUnlic.statusCode, 200, "unlicensed markdown endpoint returns 200");
});

test("contract & discussion views: matching optional fields, nullable metrics, and fetched vs total distinction", () => {
  // 1. DiscussionPostView optional fields
  const post = postView({
    id: "comment-123",
    author: { name: "选手小明", avatarUrl: "https://example.test/avatar.png" },
    text: "下场比赛会全力以赴！",
    publishedAt: at.toISOString(),
    likes: 999,
    floor: 6,
    isOriginalAuthor: true,
    platform: "bilibili",
    parentCommentId: "root-1",
    replyCount: 15,
    originalUrl: "https://bilibili.com/reply/123",
    quote: { author: "队友小红", text: "加油！" },
  });

  assert.equal(post.id, "comment-123");
  assert.equal(post.author, "选手小明");
  assert.equal(post.platform, "bilibili");
  assert.equal(post.parentCommentId, "root-1");
  assert.equal(post.replyCount, 15);
  assert.equal(post.originalUrl, "https://bilibili.com/reply/123");
  assert.equal(post.quote?.author, "队友小红");

  // 2. Common feedback & nullable metrics for video and social
  const videoCanonical = {
    kind: "video_post",
    title: "总决赛高能集锦",
    author: { name: "赛事官方" },
    publishedAt: at.toISOString(),
    lead: "精彩操作集锦",
    main: [],
    media: [],
    video: {
      description: "淘汰赛第三日五杀集锦",
      cover: "https://example.test/cover.jpg",
      durationSeconds: 180,
      transcriptSummary: "选手一诺公孙离关键团战五杀翻盘",
    },
    engagement: {
      views: 50000,
      likes: 3200,
      comments: 480,
      coins: 1500,
      danmaku: 850,
      shares: 300,
    },
    discussion: {
      originalPost: { id: "v-op", author: { name: "官方" }, text: "视频简介", publishedAt: at.toISOString(), isOriginalAuthor: true },
      authorFollowups: [],
      highlightedReplies: [post],
      totalReplies: 480,
      fetchedReplies: 20,
      collection: {
        collectedAt: at.toISOString(),
        coverage: "complete" as const,
        provenance: "source_api" as const,
        sourceUrl: "https://bilibili.com/video/1",
      },
      communitySummary: "观众热议公孙离极限操作",
    },
    quality: { score: 85, completeness: "full" as const, warnings: [] },
  };

  const videoRow: any = {
    id: "video-item-1",
    channel: "news",
    content_kind: "video_post",
    body_mode: "full",
    body_status: "ok",
    canonical_content: videoCanonical,
    source_name: "B站KPL官方",
  };

  const videoView = toContentView(videoRow, true);
  assert.ok(videoView);
  assert.equal(videoView.kind, "video_post");
  assert.equal(videoView.video?.coins, 1500);
  assert.equal(videoView.video?.danmaku, 850);
  assert.equal(videoView.community?.fetchedReplies, 20);
  assert.equal(videoView.community?.totalReplies, 480);
  assert.equal(videoView.community?.collection?.coverage, "complete");

  // 3. Social post with nullable metrics
  const socialCanonical = {
    kind: "social_post",
    title: "选手赛后动态",
    author: { name: "Fly" },
    publishedAt: at.toISOString(),
    lead: null,
    main: [],
    media: [],
    social: {
      postText: "今天兄弟们打得很好，下一场继续冲！",
      quoted: null,
    },
    engagement: {
      views: 120000,
      likes: 8500,
      comments: 650,
      shares: 120,
      favorites: 90,
    },
    discussion: {
      originalPost: { id: "s-op", author: { name: "Fly" }, text: "动态正文", publishedAt: at.toISOString(), isOriginalAuthor: true },
      authorFollowups: [],
      highlightedReplies: [post],
      totalReplies: 650,
      fetchedReplies: 15,
      collection: {
        collectedAt: at.toISOString(),
        coverage: "partial" as const,
        provenance: "page_dom" as const,
        sourceUrl: "https://weibo.com/fly/1",
      },
    },
    quality: { score: 90, completeness: "full" as const, warnings: [] },
  };

  const socialRow: any = {
    id: "social-item-1",
    channel: "news",
    content_kind: "social_post",
    body_mode: "full",
    body_status: "ok",
    canonical_content: socialCanonical,
    source_name: "微博选手账号",
  };

  const socialView = toContentView(socialRow, true);
  assert.ok(socialView);
  assert.equal(socialView.kind, "social_post");
  assert.equal(socialView.social?.likes, 8500);
  assert.equal(socialView.social?.shares, 120);
  assert.equal(socialView.community?.fetchedReplies, 15);
  assert.equal(socialView.community?.totalReplies, 650);

  // 4. Feed comment preview
  const feedSummary = toFeedItemSummary({
    ...socialRow,
    title: "选手赛后动态",
    url: "https://weibo.com/fly/1",
    published_at: at,
    discovered_at: at,
    timeline_at: at,
    selected: true,
    seat: true,
    visibility: "public",
    indexable: true,
    fact_id: null,
    source_mode: "editorial",
    x_post: null,
    author: "Fly",
    language: "zh",
    story_public_id: null,
    story_title: null,
    zh_text: null,
    quoted_zh: null,
    tags: ["kpl"],
    score: 85,
    summary: "赛后感言",
    reason: "核心选手发声",
    category: null,
    original_title: null,
  }, true);

  assert.ok(feedSummary.commentPreview);
  assert.equal(feedSummary.commentPreview?.author, "选手小明");
  assert.equal(feedSummary.commentPreview?.text, "下场比赛会全力以赴！");
});

test("standalone radar: exposes standalone items, separates community discussion and factual info, official not naturally preferred", async () => {
  process.env.COMMUNITY_PUBLICATION_ENABLED = "true";

  // 1. Community controversy material
  const commArtId = `art-comm-stand-${t}`;
  const commTitle = "刺痛解说言论引发全网热议";
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, content_kind, content_completeness, content_quality_score)
    VALUES (${commArtId}, ${licensedSourceId}, ${commArtId}, ${`https://bbs.hupu.com/${t}/stand-comm`}, ${commTitle},
      '刺痛在二路直播中的分析引发粉丝广泛讨论。', 'ok', ${at}, ${at}, ${at}, 1, 'forum_thread', 'full', 80)`;

  const commJudgment = {
    relevant: true,
    safe: true,
    kind: "controversy",
    title: commTitle,
    summary: "二路解说观点引发不同看法",
    claimStatus: "opinion",
    stance: "中立",
    evidence: ["刺痛在二路直播中的分析"],
    topicKey: null,
    information: 85,
    interpretation: 85,
    distinctiveness: 80,
    timeliness: 90,
    interest: 90,
    noise: 5,
    newDevelopment: false,
    reason: "高关注解说言论",
  };

  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment,
    base_score, official_bonus, noise, score_version, reason)
    VALUES (${commArtId}, 1, 'accepted', 'controversy', ${commTitle}, '二路解说观点引发不同看法', 'opinion', '中立',
      ${sql.json(["刺痛在二路直播中的分析"])}, ${sql.json(commJudgment)}, 78, 0, 0, ${RADAR.version}, '高关注解说言论')`;

  // Engagement observation gives community discussion authentic heat
  await sql`INSERT INTO engagement_observations (article_id, source_id, platform, observed_at, method, metrics, coverage)
    VALUES (${commArtId}, ${licensedSourceId}, 'hupu', ${at}, 'source_api', ${sql.json({ likes: 3000, comments: 800, shares: 100 })}, 'observed')`;

  // 2. Official factual material
  const offArtId = `art-off-stand-${t}`;
  const offTitle = "KPL联盟发布季后赛赛程公告";
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, content_kind, content_completeness, content_quality_score)
    VALUES (${offArtId}, ${officialSourceId}, ${offArtId}, ${`https://weibo.com/${t}/stand-off`}, ${offTitle},
      '官方赛程时间表已定。', 'ok', ${at}, ${at}, ${at}, 1, 'official_announcement', 'full', 85)`;

  const offJudgment = {
    relevant: true,
    safe: true,
    kind: "official",
    title: offTitle,
    summary: "季后赛赛程公布",
    claimStatus: "fact",
    stance: null,
    evidence: ["官方赛程时间表已定。"],
    topicKey: null,
    information: 90,
    interpretation: 50,
    distinctiveness: 70,
    timeliness: 90,
    interest: 70,
    noise: 0,
    newDevelopment: false,
    reason: "官方赛程发布",
  };

  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment,
    base_score, official_bonus, noise, score_version, reason)
    VALUES (${offArtId}, 1, 'accepted', 'official', ${offTitle}, '季后赛赛程公布', 'fact', null,
      ${sql.json(["官方赛程时间表已定。"])}, ${sql.json(offJudgment)}, 60, 10, 0, ${RADAR.version}, '官方赛程发布')`;

  const radar = await loadRadar(day);
  assert.ok(radar.standalone.length > 0, "standalone radar must not be empty when materials exist");

  const commMaterial = radar.standalone.find((m) => m.id === commArtId);
  const offMaterial = radar.standalone.find((m) => m.id === offArtId);

  assert.ok(commMaterial, "community material must be exposed in standalone radar");
  assert.ok(offMaterial, "official material must be exposed in standalone radar");

  // Verify community discussion vs factual discrimination:
  assert.equal(commMaterial.kind, "controversy");
  assert.equal(commMaterial.claimStatus, "opinion");
  assert.equal(offMaterial.kind, "official");
  assert.equal(offMaterial.claimStatus, "fact");

  // Official source is not naturally preferred above community heat:
  // Community controversy has higher total score than official
  assert.ok(commMaterial.score.total >= offMaterial.score.total, "official bonus does not override community heat");

  // No invented AI summary:
  assert.equal(commMaterial.summary, "二路解说观点引发不同看法");
  assert.equal(offMaterial.summary, "季后赛赛程公布");
});

test("cross-platform topics intact and partial/unavailable empty states preserved", async () => {
  process.env.COMMUNITY_PUBLICATION_ENABLED = "true";

  // 1. Cross-platform topic grouping stays untouched
  const topicKey = `topic-cross-${t}`;
  const [topic] = await sql<{ id: number }[]>`INSERT INTO radar_topics(topic_key, title, last_development_at)
    VALUES (${topicKey}, '跨平台全网焦点事件', ${at}) RETURNING id`;

  const itemA = `art-topic-a-${t}`;
  const itemB = `art-topic-b-${t}`;

  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, content_kind, content_completeness, content_quality_score)
    VALUES (${itemA}, ${licensedSourceId}, ${itemA}, ${`https://bbs.hupu.com/${t}/topic-a`}, '虎扑角度看焦点事件', '虎扑讨论', 'ok', ${at}, ${at}, ${at}, 1, 'forum_thread', 'full', 80),
           (${itemB}, ${officialSourceId}, ${itemB}, ${`https://weibo.com/${t}/topic-b`}, '微博角度看焦点事件', '微博动态', 'ok', ${at}, ${at}, ${at}, 1, 'official_announcement', 'full', 85)`;

  const baseJudge = {
    relevant: true, safe: true, kind: "controversy" as const, title: "跨平台焦点",
    summary: "讨论跨平台汇总", claimStatus: "opinion" as const, stance: "关注", evidence: ["焦点"],
    topicKey, information: 80, interpretation: 80, distinctiveness: 80, timeliness: 85, interest: 85, noise: 5, newDevelopment: true, reason: "热点",
  };

  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment, base_score, official_bonus, noise, score_version, reason, topic_id)
    VALUES (${itemA}, 1, 'accepted', 'controversy', '虎扑角度看焦点事件', '虎扑讨论', 'opinion', '关注', ${sql.json(["焦点"])}, ${sql.json(baseJudge)}, 75, 0, 0, ${RADAR.version}, '热点', ${topic!.id}),
           (${itemB}, 1, 'accepted', 'official', '微博角度看焦点事件', '微博动态', 'fact', null, ${sql.json(["焦点"])}, ${sql.json({ ...baseJudge, kind: 'official', claimStatus: 'fact' })}, 70, 10, 0, ${RADAR.version}, '热点', ${topic!.id})`;

  const radar = await loadRadar(day);
  const foundTopic = radar.topics.find((tp) => tp.id === Number(topic!.id));
  assert.ok(foundTopic, "radar_topics cross platform grouping must remain intact");
  assert.equal(foundTopic.materials.length, 2, "both platforms must be grouped into the topic");
  assert.ok(foundTopic.materials.some((m) => m.source.includes("授权社区")));
  assert.ok(foundTopic.materials.some((m) => m.source.includes("官方")));

  // 2. Unavailable empty state in CommunityView
  const unavailCanonical = {
    kind: "forum_thread",
    title: "接口受限无法抓取评论的帖子",
    author: { name: "发帖人" },
    publishedAt: at.toISOString(),
    lead: "正文内容",
    main: [],
    media: [],
    discussion: {
      originalPost: { id: "op-u", author: { name: "发帖人" }, text: "主帖文本", publishedAt: at.toISOString(), isOriginalAuthor: true },
      authorFollowups: [],
      highlightedReplies: [],
      totalReplies: 100,
      fetchedReplies: 0,
      collection: {
        collectedAt: at.toISOString(),
        coverage: "unavailable" as const,
        provenance: "page_dom" as const,
        sourceUrl: "https://example.test/unavail",
        error: "anti_scraping_protection",
      },
    },
    quality: { score: 65, completeness: "partial" as const, warnings: [] },
  };

  const unavailView = toContentView({
    id: "unavail-item",
    channel: "news",
    content_kind: "forum_thread",
    body_mode: "full",
    body_status: "ok",
    canonical_content: unavailCanonical,
    source_name: "社区",
  } as any, true);

  assert.ok(unavailView?.community);
  assert.equal(unavailView.community.collection?.coverage, "unavailable");
  assert.equal(unavailView.community.highlightedReplies.length, 0);
  assert.equal(unavailView.community.fetchedReplies, 0);
  assert.equal(unavailView.community.totalReplies, 100);
  assert.equal(unavailView.community.collection?.error, "anti_scraping_protection");
});

test("isolated, disabled, and unknown quality: strictly gated for signals while retaining editorial paused compatibility", async () => {
  process.env.COMMUNITY_PUBLICATION_ENABLED = "true";

  const isolatedSourceId = `src-iso-${t}`;
  const disabledSignalSourceId = `src-dis-sig-${t}`;
  const pausedEditorialSourceId = `src-pau-ed-${t}`;

  await sql`INSERT INTO sources(id, name, kind, tier, owner_type, participation_mode, site_fulltext, enabled) VALUES
    (${isolatedSourceId}, '隔离信源', 'json_list', 'T2', 'community', 'isolated', false, true),
    (${disabledSignalSourceId}, '停用社区信源', 'json_list', 'T2', 'community', 'hot_signal', true, false),
    (${pausedEditorialSourceId}, '暂停编辑信源', 'weibo', 'T1_5', 'club', 'editorial', true, false)`;

  const baseJudgment = {
    relevant: true,
    safe: true,
    kind: "controversy" as const,
    title: "测试标题",
    summary: "测试摘要",
    claimStatus: "opinion" as const,
    stance: "支持",
    evidence: ["证据"],
    topicKey: null,
    information: 80,
    interpretation: 80,
    distinctiveness: 80,
    timeliness: 85,
    interest: 85,
    noise: 5,
    newDevelopment: false,
    reason: "测试",
  };

  const baseRadarMaterial = {
    state: "accepted",
    inputRevision: 1,
    scoreVersion: RADAR.version,
    judgment: baseJudgment,
  };

  // 1. ISOLATED SOURCE MODE:
  // Direct gate check:
  assert.equal(
    canPublishSignalDetail({
      visibility: "public",
      sourceMode: "isolated",
      enabled: true,
      articleRevision: 1,
      radarMaterial: baseRadarMaterial,
      quality: { score: 70, completeness: "full" },
    }),
    false,
    "isolated participation_mode must never publish signal detail"
  );

  const isoArtId = `art-iso-${t}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, content_kind, content_completeness, content_quality_score)
    VALUES (${isoArtId}, ${isolatedSourceId}, ${isoArtId}, ${`https://bbs.hupu.com/${t}/iso`}, '隔离信源帖子',
      '内容', 'ok', ${at}, ${at}, ${at}, 1, 'forum_thread', 'full', 80)`;
  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment,
    base_score, official_bonus, noise, score_version, reason)
    VALUES (${isoArtId}, 1, 'accepted', 'controversy', '隔离信源帖子', '测试摘要', 'opinion', '支持',
      ${sql.json(["证据"])}, ${sql.json(baseJudgment)}, 70, 0, 0, ${RADAR.version}, '测试')`;

  assert.equal((await loadItemDetail(isoArtId)).kind, "not_found", "isolated item detail must return not_found");
  assert.equal((await app.inject({ method: "GET", url: `/api/site/items/${isoArtId}` })).statusCode, 404);
  assert.equal(await exportMarkdown(isoArtId), null);
  assert.equal((await app.inject({ method: "GET", url: `/items/${isoArtId}/markdown` })).statusCode, 404);

  // 2. DISABLED SIGNAL SOURCE:
  // Direct gate check:
  assert.equal(
    canPublishSignalDetail({
      visibility: "public",
      sourceMode: "hot_signal",
      enabled: false,
      articleRevision: 1,
      radarMaterial: baseRadarMaterial,
      quality: { score: 70, completeness: "full" },
    }),
    false,
    "disabled signal source (enabled === false) must not publish"
  );
  assert.equal(
    canPublishSignalDetail({
      visibility: "public",
      sourceMode: "hot_signal",
      // enabled omitted
      articleRevision: 1,
      radarMaterial: baseRadarMaterial,
      quality: { score: 70, completeness: "full" },
    }),
    false,
    "omitted enabled for signal must not publish"
  );

  const disSigArtId = `art-dis-sig-${t}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, content_kind, content_completeness, content_quality_score)
    VALUES (${disSigArtId}, ${disabledSignalSourceId}, ${disSigArtId}, ${`https://bbs.hupu.com/${t}/dis-sig`}, '停用信源帖子',
      '内容', 'ok', ${at}, ${at}, ${at}, 1, 'forum_thread', 'full', 80)`;
  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment,
    base_score, official_bonus, noise, score_version, reason)
    VALUES (${disSigArtId}, 1, 'accepted', 'controversy', '停用信源帖子', '测试摘要', 'opinion', '支持',
      ${sql.json(["证据"])}, ${sql.json(baseJudgment)}, 70, 0, 0, ${RADAR.version}, '测试')`;

  assert.equal((await loadItemDetail(disSigArtId)).kind, "not_found", "disabled signal item detail must return not_found");
  assert.equal((await app.inject({ method: "GET", url: `/api/site/items/${disSigArtId}` })).statusCode, 404);
  assert.equal(await exportMarkdown(disSigArtId), null);
  assert.equal((await app.inject({ method: "GET", url: `/items/${disSigArtId}/markdown` })).statusCode, 404);

  // Radar also excludes disabled source
  const radar = await loadRadar(day);
  assert.equal(radar.standalone.some((m) => m.id === disSigArtId), false, "disabled source must be excluded from radar");

  // 3. EDITORIAL PAUSED COMPATIBILITY:
  // Paused editorial keeps its page
  assert.equal(
    canPublishSignalDetail({
      visibility: "public",
      sourceMode: "editorial",
      enabled: false,
      articleRevision: 1,
    }),
    true,
    "paused editorial source keeps page (compatibility preserved)"
  );
  assert.equal(
    canPublishSignalDetail({
      visibility: "public",
      sourceMode: "editorial",
      // enabled omitted
      articleRevision: 1,
    }),
    true,
    "editorial source without enabled in input keeps page"
  );

  const pauEdArtId = `art-pau-ed-${t}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, content_kind, content_completeness, content_quality_score)
    VALUES (${pauEdArtId}, ${pausedEditorialSourceId}, ${pauEdArtId}, ${`https://weibo.com/${t}/pau-ed`}, '暂停编辑信源文章',
      '编辑部正文内容。', 'ok', ${at}, ${at}, ${at}, 1, 'article', 'full', 85)`;
  await sql`INSERT INTO publications (article_id, source_id, title, summary, channel, url, discovered_at, timeline_at, published_at, sort_at,
    eligible, selected, seat, visible_after, visibility, body_mode, syndicate)
    VALUES (${pauEdArtId}, ${pausedEditorialSourceId}, '暂停编辑信源文章', '摘要', 'news', ${`https://weibo.com/${t}/pau-ed`}, ${at}, ${at}, ${at}, ${at},
      true, true, true, ${at}, 'public', 'full', false)`;

  assert.equal((await loadItemDetail(pauEdArtId)).kind, "found", "paused editorial item detail remains found");
  assert.equal((await app.inject({ method: "GET", url: `/api/site/items/${pauEdArtId}` })).statusCode, 200);
  assert.ok(await exportMarkdown(pauEdArtId), "paused editorial page can export markdown");
  assert.equal((await app.inject({ method: "GET", url: `/items/${pauEdArtId}/markdown` })).statusCode, 200);

  // 4. UNKNOWN / INVALID QUALITY GATES:
  // Known canonical quality score finite>=40 and completeness full/partial only (not null/summary/failed)
  const validBase = {
    visibility: "public",
    sourceMode: "hot_signal",
    enabled: true,
    articleRevision: 1,
    radarMaterial: baseRadarMaterial,
  };

  // Missing / undefined quality
  assert.equal(canPublishSignalDetail({ ...validBase }), false, "missing quality must reject");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: null }), false, "null quality must reject");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: undefined }), false, "undefined quality must reject");

  // Unknown / null / non-finite score
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: null, completeness: "full" } }), false, "null score must reject");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: undefined, completeness: "full" } }), false, "undefined score must reject");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: NaN, completeness: "full" } }), false, "NaN score must reject");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: Infinity, completeness: "full" } }), false, "Infinity score must reject");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: -Infinity, completeness: "full" } }), false, "-Infinity score must reject");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: 39, completeness: "full" } }), false, "score < 40 must reject");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: 40, completeness: "full" } }), true, "score == 40 must pass");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: 100, completeness: "full" } }), true, "score > 40 must pass");

  // Completeness full/partial only (not null/summary/failed)
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: 75, completeness: null } }), false, "null completeness must reject");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: 75, completeness: undefined } }), false, "undefined completeness must reject");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: 75, completeness: "summary" } }), false, "summary completeness must reject");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: 75, completeness: "summary_only" } }), false, "summary_only completeness must reject");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: 75, completeness: "failed" } }), false, "failed completeness must reject");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: 75, completeness: "unknown" } }), false, "unknown completeness must reject");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: 75, completeness: "partial" } }), true, "partial completeness must pass");
  assert.equal(canPublishSignalDetail({ ...validBase, quality: { score: 75, completeness: "full" } }), true, "full completeness must pass");
});

import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { assessRadar } from "@aihot/backend/editorial/radar";
import { loadRadar } from "@aihot/backend/publication/radar";
import { loadItemDetail } from "@aihot/backend/publication/detail";
import { canPublishSignalDetail, canonicalEvidenceHash } from "@aihot/backend/publication/rules";
import { RADAR } from "@aihot/industry/radar";
import { buildApp } from "../apps/api/src/app.ts";
import type { CanonicalContent } from "@aihot/backend/content/extractors/types";

RADAR.enabled = true;

const t = tag();
const communitySourceId = `comm-src-${t}`;
const officialSourceId = `off-src-${t}`;
const day = "2026-10-12";
const at = new Date(`${day}T12:00:00+08:00`);

const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body);
  const input = JSON.parse(body.messages.at(-1).content);
  const original = String(input.original);
  const controversy = original.includes("争议");
  const answer = {
    relevant: true,
    safe: !original.includes("违规危险言论"),
    kind: controversy ? "controversy" : "fun",
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
    reason: "社区热度分析",
  };
  return { choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
});

process.env.ZHIPU_BASE_URL = `${provider.url}/v1`;
process.env.ZHIPU_API_KEY = "test-key";
process.env.COMMUNITY_PUBLICATION_ENABLED = "true";

const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources(id, name, kind, tier, owner_type, participation_mode, site_fulltext, enabled) VALUES
    (${communitySourceId}, '测试社区', 'json_list', 'T2', 'community', 'hot_signal', true, true),
    (${officialSourceId}, '官方信源', 'weibo', 'T1_5', 'club', 'editorial', true, true)`;
});

after(async () => {
  delete process.env.COMMUNITY_PUBLICATION_ENABLED;
  await app.close();
  await provider.close();
  await stopBoss();
  await closeDb();
});

test("canonicalEvidenceHash: calculates over selected comments + original, ignores counters, falls back to plain body", () => {
  const canonicalA: CanonicalContent = {
    kind: "forum_thread",
    title: "第一局打野节奏复盘讨论",
    author: { name: "分析师A", avatarUrl: null, profileUrl: null, role: null },
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
      sourceId: communitySourceId,
      sourceFamily: "community",
      fallbackUsed: false,
      bodyProvenance: "page_dom",
      sourceAuthority: "community",
    },
    discussion: {
      originalPost: {
        id: "op-1",
        author: { name: "分析师A" },
        text: "第一局打野前期节奏偏慢，导致控龙受限。",
        publishedAt: at.toISOString(),
        likes: 50,
        floor: 1,
        isOriginalAuthor: true,
      },
      authorFollowups: [
        {
          id: "op-f1",
          author: { name: "分析师A" },
          text: "第二条暴君团战站位也有失误。",
          publishedAt: at.toISOString(),
          likes: 20,
          floor: 3,
          isOriginalAuthor: true,
        },
      ],
      highlightedReplies: [
        {
          id: "rep-1",
          author: { name: "粉丝B" },
          text: "确实，下路没有线权也有很大影响。",
          publishedAt: at.toISOString(),
          likes: 100,
          floor: 2,
          isOriginalAuthor: false,
          replyCount: 10,
        },
      ],
      totalReplies: 100,
      fetchedReplies: 10,
      collection: {
        collectedAt: at.toISOString(),
        coverage: "complete",
        provenance: "page_dom",
        sourceUrl: "https://example.test/1",
      },
    },
    quality: { score: 75, completeness: "full", warnings: [] },
  };

  const hashA = canonicalEvidenceHash(canonicalA);
  assert.ok(hashA && hashA.length === 64, "must return valid 64-char sha256 hex");

  // 1. Changing counters (likes, floor, totalReplies, replyCount) DOES NOT change evidence hash
  const canonicalWithDiffCounters: CanonicalContent = {
    ...canonicalA,
    discussion: {
      ...canonicalA.discussion!,
      originalPost: { ...canonicalA.discussion!.originalPost, likes: 9999, floor: 10 },
      authorFollowups: [{ ...canonicalA.discussion!.authorFollowups[0]!, likes: 8888, floor: 99 }],
      highlightedReplies: [{ ...canonicalA.discussion!.highlightedReplies[0]!, likes: 7777, replyCount: 500, floor: 88 }],
      totalReplies: 9999,
      fetchedReplies: 50,
    },
  };
  const hashCounters = canonicalEvidenceHash(canonicalWithDiffCounters);
  assert.equal(hashCounters, hashA, "counter metric updates must not alter canonical evidence hash");

  // 2. Modifying comment text changes the evidence hash
  const canonicalWithDiffText: CanonicalContent = {
    ...canonicalA,
    discussion: {
      ...canonicalA.discussion!,
      highlightedReplies: [
        {
          id: "rep-1",
          author: { name: "粉丝B" },
          text: "完全不同意，明明是中单支援太慢导致崩盘。",
          publishedAt: at.toISOString(),
          likes: 100,
          floor: 2,
          isOriginalAuthor: false,
        },
      ],
    },
  };
  const hashDiffText = canonicalEvidenceHash(canonicalWithDiffText);
  assert.notEqual(hashDiffText, hashA, "modified highlighted reply text must change evidence hash");

  // 2b. Displayed quotes and authors: quote-only mutation changes evidence hash
  const canonicalWithQuote: CanonicalContent = {
    ...canonicalA,
    discussion: {
      ...canonicalA.discussion!,
      highlightedReplies: [
        {
          id: "rep-1",
          author: { name: "粉丝B" },
          quote: { author: "分析师A", text: "第一局打野前期节奏偏慢，导致控龙受限。" },
          text: "确实，下路没有线权也有很大影响。",
          publishedAt: at.toISOString(),
          likes: 100,
          floor: 2,
          isOriginalAuthor: false,
        },
      ],
    },
  };
  const hashWithQuote = canonicalEvidenceHash(canonicalWithQuote);
  assert.notEqual(hashWithQuote, hashA, "adding quote must change evidence hash");

  const canonicalWithMutatedQuoteText: CanonicalContent = {
    ...canonicalWithQuote,
    discussion: {
      ...canonicalWithQuote.discussion!,
      highlightedReplies: [
        {
          ...canonicalWithQuote.discussion!.highlightedReplies[0]!,
          quote: { author: "分析师A", text: "打野节奏完全没问题，是中单的锅。" },
        },
      ],
    },
  };
  assert.notEqual(canonicalEvidenceHash(canonicalWithMutatedQuoteText), hashWithQuote, "quote-only text mutation must change evidence hash");

  const canonicalWithMutatedQuoteAuthor: CanonicalContent = {
    ...canonicalWithQuote,
    discussion: {
      ...canonicalWithQuote.discussion!,
      highlightedReplies: [
        {
          ...canonicalWithQuote.discussion!.highlightedReplies[0]!,
          quote: { author: "主教练", text: "第一局打野前期节奏偏慢，导致控龙受限。" },
        },
      ],
    },
  };
  assert.notEqual(canonicalEvidenceHash(canonicalWithMutatedQuoteAuthor), hashWithQuote, "quote-only author mutation must change evidence hash");

  // Quote-bearing comment counter updates DO NOT change evidence hash
  const canonicalQuoteWithDiffCounters: CanonicalContent = {
    ...canonicalWithQuote,
    discussion: {
      ...canonicalWithQuote.discussion!,
      highlightedReplies: [
        {
          ...canonicalWithQuote.discussion!.highlightedReplies[0]!,
          likes: 99999,
          floor: 55,
          replyCount: 888,
        },
      ],
    },
  };
  assert.equal(canonicalEvidenceHash(canonicalQuoteWithDiffCounters), hashWithQuote, "counter updates on quote comment must not alter evidence hash");

  // 3. Modifying OP text changes the evidence hash
  const canonicalWithDiffOp: CanonicalContent = {
    ...canonicalA,
    discussion: {
      ...canonicalA.discussion!,
      originalPost: { ...canonicalA.discussion!.originalPost, text: "修改后的原帖正文" },
    },
  };
  assert.notEqual(canonicalEvidenceHash(canonicalWithDiffOp), hashA, "modified original post text must change evidence hash");

  // 4. Plain body fallback when canonical is absent or null
  const plainHash1 = canonicalEvidenceHash(null, { title: "测试标题", bodyText: "测试正文" });
  assert.ok(plainHash1 && plainHash1.length === 64);
  const plainHash2 = canonicalEvidenceHash(null, { title: "测试标题", bodyText: "测试正文" });
  assert.equal(plainHash1, plainHash2);
  const plainHashDiff = canonicalEvidenceHash(null, { title: "测试标题", bodyText: "不同的正文内容" });
  assert.notEqual(plainHash1, plainHashDiff);
});

test("assessRadar: stores input_evidence_hash, reuses only when revision AND hash match, rejudges on stale hash or legacy null", async () => {
  const artId = `art-radar-hash-${t}`;
  const canonical: CanonicalContent = {
    kind: "forum_thread",
    title: "选手轮换引争议",
    author: { name: "老粉丝", avatarUrl: null, profileUrl: null, role: null },
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
      sourceId: communitySourceId,
      sourceFamily: "community",
      fallbackUsed: false,
      bodyProvenance: "page_dom",
      sourceAuthority: "community",
    },
    discussion: {
      originalPost: {
        id: "op-1",
        author: { name: "老粉丝" },
        text: "选手轮换引争议。教练组第三局突然换下首发射手是否合适？",
        publishedAt: at.toISOString(),
        likes: 10,
        floor: 1,
        isOriginalAuthor: true,
      },
      authorFollowups: [],
      highlightedReplies: [
        {
          id: "r-1",
          author: { name: "支持者" },
          text: "选手轮换引争议。训练赛状态不好，换人很正常。",
          publishedAt: at.toISOString(),
          likes: 20,
          floor: 2,
          isOriginalAuthor: false,
        },
      ],
      totalReplies: 30,
      fetchedReplies: 5,
      collection: {
        collectedAt: at.toISOString(),
        coverage: "partial",
        provenance: "page_dom",
        sourceUrl: `https://bbs.hupu.com/${t}/1`,
      },
    },
    quality: { score: 75, completeness: "full", warnings: [] },
  };

  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, canonical_content, content_kind, content_completeness, content_quality_score)
    VALUES (${artId}, ${communitySourceId}, ${artId}, ${`https://bbs.hupu.com/${t}/1`}, '选手轮换引争议',
      '选手轮换引争议。教练组第三局突然换下首发射手是否合适？', 'ok', ${at}, ${at}, ${at}, 1, ${sql.json(canonical as never)}, 'forum_thread', 'full', 75)`;

  const initialHits = provider.hits();
  const res1 = await assessRadar(artId);
  assert.equal(res1.state, "accepted");
  assert.equal(provider.hits(), initialHits + 1, "first assessment must make paid LLM call");

  const [row1] = await sql<{ input_revision: number; input_evidence_hash: string | null }[]>`
    SELECT input_revision, input_evidence_hash FROM radar_materials WHERE article_id = ${artId}`;
  assert.ok(row1?.input_evidence_hash, "assessRadar must record non-null input_evidence_hash");
  const expectedHash = canonicalEvidenceHash(canonical);
  assert.equal(row1.input_evidence_hash, expectedHash);

  // Re-assessing with exact same revision and evidence hash reuses judgment without paid call
  const hitsAfterFirst = provider.hits();
  const res2 = await assessRadar(artId);
  assert.equal(res2.state, "accepted");
  assert.equal(provider.hits(), hitsAfterFirst, "matching revision and evidence hash reuses judgment without paid call");

  // Simulating legacy null hash (pre-migration row): MUST FORCE REJUDGMENT on explicit assess
  await sql`UPDATE radar_materials SET receipt_id = NULL, input_evidence_hash = NULL WHERE article_id = ${artId}`;
  await sql`DELETE FROM receipts WHERE subject = ${`radar:${artId}@1`}`;
  const hitsBeforeLegacy = provider.hits();
  const resLegacy = await assessRadar(artId);
  assert.equal(resLegacy.state, "accepted");
  assert.equal(provider.hits(), hitsBeforeLegacy + 1, "legacy null hash must force rejudge on explicit assess");
  const [rowLegacy] = await sql<{ input_evidence_hash: string | null }[]>`
    SELECT input_evidence_hash FROM radar_materials WHERE article_id = ${artId}`;
  assert.equal(rowLegacy?.input_evidence_hash, expectedHash, "rejudged legacy row must persist new stable hash");

  // Comment refresh: new comment text refreshed (revision remains 1, but highlightedReplies text changes)
  const canonicalRefreshed: CanonicalContent = {
    ...canonical,
    discussion: {
      ...canonical.discussion!,
      highlightedReplies: [
        {
          id: "r-2",
          author: { name: "新评论" },
          text: "选手轮换引争议。新爆料说选手生病了才轮换的。",
          publishedAt: at.toISOString(),
          likes: 50,
          floor: 3,
          isOriginalAuthor: false,
        },
      ],
    },
  };
  await sql`UPDATE articles SET canonical_content = ${sql.json(canonicalRefreshed as never)} WHERE id = ${artId}`;

  const hitsBeforeRefresh = provider.hits();
  const resRefreshed = await assessRadar(artId);
  assert.equal(resRefreshed.state, "accepted");
  assert.equal(provider.hits(), hitsBeforeRefresh + 1, "stale evidence hash must NOT reuse judgment; must rejudge with new comment text");
  const [rowRefreshed] = await sql<{ input_evidence_hash: string | null }[]>`
    SELECT input_evidence_hash FROM radar_materials WHERE article_id = ${artId}`;
  const newHash = canonicalEvidenceHash(canonicalRefreshed);
  assert.equal(rowRefreshed?.input_evidence_hash, newHash);

  // Changing like metrics only: hash unchanged, NO new model calls
  const canonicalLikesUpdated: CanonicalContent = {
    ...canonicalRefreshed,
    discussion: {
      ...canonicalRefreshed.discussion!,
      originalPost: { ...canonicalRefreshed.discussion!.originalPost, likes: 9999 },
      highlightedReplies: [
        { ...canonicalRefreshed.discussion!.highlightedReplies[0]!, likes: 8888, replyCount: 999 },
      ],
      totalReplies: 500,
      fetchedReplies: 50,
    },
  };
  await sql`UPDATE articles SET canonical_content = ${sql.json(canonicalLikesUpdated as never)} WHERE id = ${artId}`;
  const hashAfterLikes = canonicalEvidenceHash(canonicalLikesUpdated);
  assert.equal(hashAfterLikes, newHash, "changing like metrics must not change evidence hash");

  const hitsBeforeLikesAssess = provider.hits();
  const resLikes = await assessRadar(artId);
  assert.equal(resLikes.state, "accepted");
  assert.equal(provider.hits(), hitsBeforeLikesAssess, "changing likes must make no new model calls");
});

test("in-flight invalidation: revision, body/evidence, or source changes during assessment aborts safely with no fake acceptance", async () => {
  const artId = `art-inflight-${t}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, content_kind, content_completeness, content_quality_score)
    VALUES (${artId}, ${communitySourceId}, ${artId}, ${`https://bbs.hupu.com/${t}/inflight`}, '选手轮换引争议',
      '选手轮换引争议。教练组第三局换人。', 'ok', ${at}, ${at}, ${at}, 1, 'forum_thread', 'full', 75)`;

  // Simulate in-flight revision change
  const origBegin = sql.begin.bind(sql);
  let intercepted = false;
  (sql as any).begin = async function (fn: any) {
    if (!intercepted) {
      intercepted = true;
      // Invalidate revision before transaction lock executes
      await sql`UPDATE articles SET revision = 2 WHERE id = ${artId}`;
    }
    return origBegin(fn);
  };

  try {
    const res = await assessRadar(artId);
    assert.equal(res.state, "stale", "in-flight revision mismatch must return stale and prevent write");
  } finally {
    (sql as any).begin = origBegin;
  }
});

test("publication & preview gating: stale hash excluded from radar and detail, legacy null allowed ONLY without collection", async () => {
  const artId = `art-gate-hash-${t}`;
  const canonical: CanonicalContent = {
    kind: "forum_thread",
    title: "选手轮换引争议：热议焦点",
    author: { name: "楼主", avatarUrl: null, profileUrl: null, role: null },
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
      sourceId: communitySourceId,
      sourceFamily: "community",
      fallbackUsed: false,
      bodyProvenance: "page_dom",
      sourceAuthority: "community",
    },
    discussion: {
      originalPost: {
        id: "op-1",
        author: { name: "楼主" },
        text: "选手轮换引争议：热议焦点。原帖内容。",
        publishedAt: at.toISOString(),
        likes: 10,
        floor: 1,
        isOriginalAuthor: true,
      },
      authorFollowups: [],
      highlightedReplies: [
        {
          id: "r-1",
          author: { name: "回复A" },
          text: "选手轮换引争议：热议焦点。赞同原帖观点。",
          publishedAt: at.toISOString(),
          likes: 5,
          floor: 2,
          isOriginalAuthor: false,
        },
      ],
      totalReplies: 20,
      fetchedReplies: 5,
      collection: {
        collectedAt: at.toISOString(),
        coverage: "partial",
        provenance: "page_dom",
        sourceUrl: `https://bbs.hupu.com/${t}/gate-hash`,
      },
    },
    quality: { score: 80, completeness: "full", warnings: [] },
  };

  const correctHash = canonicalEvidenceHash(canonical);

  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, canonical_content, content_kind, content_completeness, content_quality_score)
    VALUES (${artId}, ${communitySourceId}, ${artId}, ${`https://bbs.hupu.com/${t}/gate-hash`}, '选手轮换引争议：热议焦点',
      '选手轮换引争议：热议焦点。原帖内容。', 'ok', ${at}, ${at}, ${at}, 1, ${sql.json(canonical as never)}, 'forum_thread', 'full', 80)`;

  const judgment = {
    relevant: true,
    safe: true,
    kind: "controversy",
    title: "选手轮换引争议：热议焦点",
    summary: "讨论热烈",
    claimStatus: "opinion",
    stance: "中立",
    evidence: ["选手轮换引争议：热议焦点。原帖内容。"],
    topicKey: null,
    information: 80,
    interpretation: 80,
    distinctiveness: 80,
    timeliness: 85,
    interest: 85,
    noise: 5,
    newDevelopment: false,
    reason: "高热度",
  };

  // 1. Valid matching hash: published in detail, included in loadRadar with safe preview
  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment,
    base_score, official_bonus, noise, score_version, reason, input_evidence_hash)
    VALUES (${artId}, 1, 'accepted', 'controversy', '选手轮换引争议：热议焦点', '讨论热烈', 'opinion', '中立',
      ${sql.json(["选手轮换引争议：热议焦点。原帖内容。"])}, ${sql.json(judgment)}, 75, 0, 0, ${RADAR.version}, '高热度', ${correctHash})`;

  const detailRes = await loadItemDetail(artId);
  assert.equal(detailRes.kind, "found", "detail page must be accessible when evidence hash matches");

  const radarRes = await loadRadar(day);
  const foundInRadar = radarRes.standalone.find((m) => m.id === artId);
  assert.ok(foundInRadar, "material must appear in radar when evidence hash matches");
  assert.ok(foundInRadar.itemUrl?.includes(artId));

  // 2. Comments refreshed in article without updating radar_materials: stored hash is now STALE
  const staleCanonical: CanonicalContent = {
    ...canonical,
    discussion: {
      ...canonical.discussion!,
      highlightedReplies: [
        {
          id: "r-new",
          author: { name: "新黑粉" },
          text: "违规危险言论！假赛爆料！",
          publishedAt: at.toISOString(),
          likes: 99,
          floor: 3,
          isOriginalAuthor: false,
        },
      ],
    },
  };
  await sql`UPDATE articles SET canonical_content = ${sql.json(staleCanonical as never)} WHERE id = ${artId}`;

  // Public detail must reject stale hash (404) to prevent displaying new raw comments under old safe judgment
  const detailStale = await loadItemDetail(artId);
  assert.equal(detailStale.kind, "not_found", "detail must 404 when evidence hash is stale");

  // Radar must EXCLUDE the stale material before preview (must not surface accepted with old summary/safe)
  const radarStale = await loadRadar(day);
  const foundStaleInRadar = radarStale.standalone.find((m) => m.id === artId);
  assert.equal(foundStaleInRadar, undefined, "radar must exclude materials with fresh collection and stale hash before preview");

  // 2b. Quote-only mutation: mutating quoted text alone must invalidate hash and reject detail/preview
  const quoteArtId = `art-quote-mutation-${t}`;
  const canonicalWithQuoteArt: CanonicalContent = {
    ...canonical,
    discussion: {
      ...canonical.discussion!,
      highlightedReplies: [
        {
          id: "r-q1",
          author: { name: "回复A" },
          quote: { author: "楼主", text: "选手轮换引争议：热议焦点。原帖内容。" },
          text: "选手轮换引争议：热议焦点。赞同原帖观点。",
          publishedAt: at.toISOString(),
          likes: 5,
          floor: 2,
          isOriginalAuthor: false,
        },
      ],
    },
  };
  const quoteHash = canonicalEvidenceHash(canonicalWithQuoteArt);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, canonical_content, content_kind, content_completeness, content_quality_score)
    VALUES (${quoteArtId}, ${communitySourceId}, ${quoteArtId}, ${`https://bbs.hupu.com/${t}/quote-mut`}, '选手轮换引争议：热议焦点',
      '选手轮换引争议：热议焦点。原帖内容。', 'ok', ${at}, ${at}, ${at}, 1, ${sql.json(canonicalWithQuoteArt as never)}, 'forum_thread', 'full', 80)`;
  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment,
    base_score, official_bonus, noise, score_version, reason, input_evidence_hash)
    VALUES (${quoteArtId}, 1, 'accepted', 'controversy', '选手轮换引争议：热议焦点', '讨论热烈', 'opinion', '中立',
      ${sql.json(["选手轮换引争议：热议焦点。原帖内容。"])}, ${sql.json(judgment)}, 75, 0, 0, ${RADAR.version}, '高热度', ${quoteHash})`;

  const detailBeforeMut = await loadItemDetail(quoteArtId);
  assert.equal(detailBeforeMut.kind, "found", "detail page accessible before quote mutation");
  const radarBeforeMut = await loadRadar(day);
  assert.ok(radarBeforeMut.standalone.find((m) => m.id === quoteArtId), "radar surfaces item before quote mutation");

  // Mutate ONLY the quote text (raw quote mutation)
  const canonicalQuoteMutated: CanonicalContent = {
    ...canonicalWithQuoteArt,
    discussion: {
      ...canonicalWithQuoteArt.discussion!,
      highlightedReplies: [
        {
          ...canonicalWithQuoteArt.discussion!.highlightedReplies[0]!,
          quote: { author: "楼主", text: "被恶意篡改的假赛引文言论" },
        },
      ],
    },
  };
  await sql`UPDATE articles SET canonical_content = ${sql.json(canonicalQuoteMutated as never)} WHERE id = ${quoteArtId}`;

  // Detail and radar preview MUST reject stale quote hash
  const detailAfterMut = await loadItemDetail(quoteArtId);
  assert.equal(detailAfterMut.kind, "not_found", "detail must 404 on quote-only mutation");
  const radarAfterMut = await loadRadar(day);
  assert.equal(radarAfterMut.standalone.find((m) => m.id === quoteArtId), undefined, "radar preview must reject item on quote-only mutation");

  // 3. Backward compatibility: legacy null hash
  // A. Collection-bearing community article with legacy null hash: MUST BE REJECTED
  await sql`UPDATE radar_materials SET input_evidence_hash = NULL WHERE article_id = ${artId}`;
  const detailLegacyWithCollection = await loadItemDetail(artId);
  assert.equal(detailLegacyWithCollection.kind, "not_found", "collection-bearing community with null hash must not publish");

  const radarLegacyWithCollection = await loadRadar(day);
  assert.equal(radarLegacyWithCollection.standalone.some((m) => m.id === artId), false, "collection-bearing community with null hash excluded from radar");

  // B. Legacy article without collection (collection absent): ALLOWED (backward compatibility)
  const legacyNoCollectionArtId = `art-legacy-nocollect-${t}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, content_kind, content_completeness, content_quality_score)
    VALUES (${legacyNoCollectionArtId}, ${communitySourceId}, ${legacyNoCollectionArtId}, ${`https://bbs.hupu.com/${t}/legacy-nocollect`}, '历史老稿件',
      '历史老稿件正文。', 'ok', ${at}, ${at}, ${at}, 1, 'article', 'full', 80)`;

  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment,
    base_score, official_bonus, noise, score_version, reason, input_evidence_hash)
    VALUES (${legacyNoCollectionArtId}, 1, 'accepted', 'controversy', '历史老稿件', '老稿摘要', 'opinion', '中立',
      ${sql.json(["历史老稿件正文。"])}, ${sql.json(judgment)}, 75, 0, 0, ${RADAR.version}, '历史', NULL)`;

  const detailLegacyNoCollection = await loadItemDetail(legacyNoCollectionArtId);
  assert.equal(detailLegacyNoCollection.kind, "found", "legacy article without collection allowed with null hash");

  const radarLegacyNoCollection = await loadRadar(day);
  assert.ok(radarLegacyNoCollection.standalone.some((m) => m.id === legacyNoCollectionArtId), "legacy article without collection allowed in radar with null hash");
});

test("video summary_only gate: allows ONLY kind video_post with quality>=40, valid metadata, and no transcript fake", () => {
  const baseValidRadarMaterial = {
    state: "accepted",
    inputRevision: 1,
    scoreVersion: RADAR.version,
    judgment: { relevant: true, safe: true },
  };

  const validVideoCanonical: CanonicalContent = {
    kind: "video_post",
    title: "总决赛精彩回顾",
    author: { name: "KPL赛事", avatarUrl: null, profileUrl: null, role: null },
    publishedAt: at.toISOString(),
    lead: null,
    main: [],
    media: [],
    discussion: null,
    social: null,
    engagement: null,
    extraction: {
      extractor: "bilibili",
      version: "1.0.0",
      sourceId: communitySourceId,
      sourceFamily: "video",
      fallbackUsed: false,
      bodyProvenance: "source_api",
      sourceAuthority: "official",
    },
    video: {
      description: "本期视频带来总决赛精彩回顾与赛后采访分析。",
      cover: "https://example.test/cover.jpg",
      durationSeconds: 300,
      transcriptSummary: null, // No fake transcript
    },
    quality: { score: 65, completeness: "summary_only", warnings: ["summary_only_content"] },
  };

  const baseInput = {
    visibility: "public",
    sourceMode: "hot_signal",
    enabled: true,
    articleRevision: 1,
    radarMaterial: baseValidRadarMaterial,
  };

  // 1. Valid video_post with summary_only, score >= 40, valid metadata, no transcriptSummary: ALLOWED
  assert.equal(
    canPublishSignalDetail({
      ...baseInput,
      contentKind: "video_post",
      canonical: validVideoCanonical,
      quality: { score: 65, completeness: "summary_only" },
    }),
    true,
    "valid video_post summary_only with score >= 40 and real description must pass"
  );

  // 2. Video with score < 40: REJECTED
  assert.equal(
    canPublishSignalDetail({
      ...baseInput,
      contentKind: "video_post",
      canonical: validVideoCanonical,
      quality: { score: 35, completeness: "summary_only" },
    }),
    false,
    "video_post with score < 40 must reject"
  );

  // 3. Non-video kind (e.g. forum_thread or article) with summary_only: REJECTED
  assert.equal(
    canPublishSignalDetail({
      ...baseInput,
      contentKind: "forum_thread",
      canonical: { ...validVideoCanonical, kind: "forum_thread", video: null },
      quality: { score: 65, completeness: "summary_only" },
    }),
    false,
    "non-video kind with summary_only must reject"
  );

  // 4. Video missing metadata (empty description, no cover, duration null): REJECTED
  const invalidMetaVideo: CanonicalContent = {
    ...validVideoCanonical,
    video: {
      description: "",
      cover: null,
      durationSeconds: null,
      transcriptSummary: null,
    },
  };
  assert.equal(
    canPublishSignalDetail({
      ...baseInput,
      contentKind: "video_post",
      canonical: invalidMetaVideo,
      quality: { score: 65, completeness: "summary_only" },
    }),
    false,
    "video_post missing metadata must reject"
  );

  // 5. Video with transcript fake (transcriptSummary is set while claiming summary_only): REJECTED
  const fakeTranscriptVideo: CanonicalContent = {
    ...validVideoCanonical,
    video: {
      ...validVideoCanonical.video!,
      transcriptSummary: "伪造的视频字幕总结内容",
    },
  };
  assert.equal(
    canPublishSignalDetail({
      ...baseInput,
      contentKind: "video_post",
      canonical: fakeTranscriptVideo,
      quality: { score: 65, completeness: "summary_only" },
    }),
    false,
    "video claiming summary_only with fake transcriptSummary must reject"
  );

  // 6. Known partial/full unchanged: continues to pass for any kind with score >= 40
  assert.equal(
    canPublishSignalDetail({
      ...baseInput,
      contentKind: "forum_thread",
      canonical: null,
      quality: { score: 70, completeness: "full" },
    }),
    true,
    "known full completeness unchanged"
  );
  assert.equal(
    canPublishSignalDetail({
      ...baseInput,
      contentKind: "forum_thread",
      canonical: null,
      quality: { score: 70, completeness: "partial" },
    }),
    true,
    "known partial completeness unchanged"
  );
});

test("plainbody titleA modeltitleB still published: radar uses title_original for fallback hashing", async () => {
  const plainArtId = `art-plainbody-${t}`;
  const titleA = "官方公布常规赛MVP候选人名单";
  const modeltitleB = "常规赛MVP争夺白热化：多位顶尖选手入围";
  const bodyText = "2026年KPL春季赛常规赛MVP候选人正式出炉。多位选手凭借赛季高光表现入选，最终评选结果将于季后赛揭晓。";

  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at, revision, canonical_content, content_kind, content_completeness, content_quality_score)
    VALUES (${plainArtId}, ${officialSourceId}, ${plainArtId}, ${`https://example.test/plain-${t}`}, ${titleA},
      ${bodyText}, 'ok', ${at}, ${at}, ${at}, 1, NULL, 'news', 'full', 85)`;

  const plainEvidenceHash = canonicalEvidenceHash(null, { title: titleA, bodyText });

  const plainJudgment = {
    relevant: true,
    safe: true,
    kind: "official",
    title: modeltitleB,
    summary: "官方发布MVP候选人",
    claimStatus: "fact",
    stance: "中立",
    evidence: [bodyText.slice(0, 30)],
    topicKey: null,
    information: 90,
    interpretation: 75,
    distinctiveness: 80,
    timeliness: 95,
    interest: 85,
    noise: 5,
    newDevelopment: true,
    reason: "官方重要荣誉公告",
  };

  await sql`INSERT INTO radar_materials (article_id, input_revision, state, kind, title, summary, claim_status, stance, evidence, judgment,
    base_score, official_bonus, noise, score_version, reason, input_evidence_hash)
    VALUES (${plainArtId}, 1, 'accepted', 'official', ${modeltitleB}, '官方发布MVP候选人', 'fact', '中立',
      ${sql.json([bodyText.slice(0, 30)])}, ${sql.json(plainJudgment)}, 85, 10, 0, ${RADAR.version}, '荣誉', ${plainEvidenceHash})`;

  const radarRes = await loadRadar(day);
  const found = radarRes.standalone.find((m) => m.id === plainArtId);
  assert.ok(found, "plainbody article with titleA and modeltitleB must still be published in radar");
  assert.equal(found.title, modeltitleB, "radar card display title must remain generated modeltitleB");
  assert.ok(found.itemUrl, "itemUrl must be available when fallback hash matches");

  const detailRes = await loadItemDetail(plainArtId);
  assert.equal(detailRes.kind, "found", "detail page must be accessible");
});

// P2 比赛聚合（大场 → 小局 → 节点）测试。契约 docs/content-redesign-contracts.md §1.6、§3。
// 纯函数单测常跑；DB 测试需要本地 Postgres（DATABASE_URL 指向 *_test 或 *_ci）。
// 本文件不 import tests/setup.ts（它的 DATABASE_URL 硬校验会直接抛错）：无库时 DB 部分自动跳过并标注。
import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { areSameSeriesDifferentGame } from "@aihot/backend/lib/kpl-dedup";

const tag = () => `p2agg-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const T = tag();

// ── 纯函数：areSameSeriesDifferentGame（无 DB 照跑） ──────────────────────────

describe("areSameSeriesDifferentGame", () => {
  const at = (s: string) => new Date(`${s}T20:00:00+08:00`);
  const A1 = "2026年3月10日KPL春季赛苏州KSG迎战济南RW侠第一局KSG先下一城";
  const A3 = "2026年3月10日KPL春季赛苏州KSG迎战济南RW侠第三局RW侠扳回一城";
  const A1B = "2026年3月10日KPL春季赛苏州KSG迎战济南RW侠第一局赛后采访";

  test("同两队同日期同赛事、局次不同 → true", () => {
    assert.equal(areSameSeriesDifferentGame(A1, A3, at("2026-03-10"), at("2026-03-10")), true);
  });
  test("同局次 → false", () => {
    assert.equal(areSameSeriesDifferentGame(A1, A1B, at("2026-03-10"), at("2026-03-10")), false);
  });
  test("两篇都没局次 → false（不是“不同局”）", () => {
    assert.equal(
      areSameSeriesDifferentGame(
        "2026年3月10日KPL春季赛苏州KSG零封济南RW侠",
        "2026年3月10日KPL春季赛苏州KSG战胜济南RW侠拿下开门红",
        at("2026-03-10"), at("2026-03-10")),
      false);
  });
  test("一篇有局次一篇没有 → true（同系列不同粒度）", () => {
    assert.equal(
      areSameSeriesDifferentGame(A1, "2026年3月10日KPL春季赛苏州KSG迎战济南RW侠",
        at("2026-03-10"), at("2026-03-10")),
      true);
  });
  test("不同日期 → false", () => {
    // 标题不明文写日期时，fallback 日期决定 dateKey
    const noDate1 = "KPL春季赛苏州KSG迎战济南RW侠第一局KSG先下一城";
    const noDate3 = "KPL春季赛苏州KSG迎战济南RW侠第三局RW侠扳回一城";
    assert.equal(areSameSeriesDifferentGame(noDate1, noDate3, at("2026-03-10"), at("2026-03-11")), false);
    assert.equal(areSameSeriesDifferentGame(noDate1, noDate3, at("2026-03-10"), at("2026-03-10")), true);
  });
  test("不同对手 → false", () => {
    assert.equal(
      areSameSeriesDifferentGame(A1, "2026年3月10日KPL春季赛苏州KSG迎战成都AG超玩会第三局",
        at("2026-03-10"), at("2026-03-10")),
      false);
  });
  test("不同赛事 → false", () => {
    assert.equal(
      areSameSeriesDifferentGame(A1, "2026年3月10日KPL夏季赛苏州KSG迎战济南RW侠第三局",
        at("2026-03-10"), at("2026-03-10")),
      false);
  });
  test("无指纹标题 → false", () => {
    assert.equal(areSameSeriesDifferentGame("今日KPL赛事前瞻", A3, at("2026-03-10"), at("2026-03-10")), false);
  });
});

// ── DB 测试（本地无 Postgres 时跳过并标注） ────────────────────────────────────

const { sql } = await import("@aihot/backend/db");
const { linkStoryToMatch } = await import("@aihot/backend/events/match-link");
const { sameSeriesDifferentGameFacts } = await import("@aihot/backend/events/match-identity");
const { boostSourcesForMatch } = await import("@aihot/backend/sources/collect"); // P1 交付的 canonical 实现（契约 §1.5：以 P1 为准）
const { upsertMaterial } = await import("@aihot/backend/content/materials");
const { groupArticle } = await import("@aihot/backend/events/group");
const { publishArticle } = await import("@aihot/backend/publication/publish");

let dbReady = false;
try {
  await Promise.race([
    sql`SELECT 1`.then(() => true),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
  ]);
  dbReady = true;
} catch {
  dbReady = false;
}
if (!dbReady) {
  console.warn("[match-aggregation] 本地无 Postgres：DB 测试跳过（未执行），纯函数单测照跑。");
}

describe("match aggregation (DB)", { skip: !dbReady }, () => {
  const sourceId = `p2-src-${T}`;
  const seasonId = `kpl-test-${T}`;

  async function mkStory(title: string, factTitle: string, articleTitle: string, publishedAt: Date, gameInTitle: boolean) {
    const articleId = `p2a-${T}-${Math.random().toString(36).slice(2, 8)}`;
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, published_at, discovered_at, timeline_at, body_status)
              VALUES (${articleId}, ${sourceId}, ${`ik-${articleId}`}, ${`https://example.org/${articleId}`},
                      ${articleTitle}, ${publishedAt.toISOString()}, ${publishedAt.toISOString()}, ${publishedAt.toISOString()}, 'ok')`;
    const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at)
      VALUES (${randomUUID()}, ${title}, ${publishedAt.toISOString()}, ${publishedAt.toISOString()}) RETURNING id`;
    const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title)
      VALUES (${`f-${articleId}`}, ${story!.id}, ${factTitle}) RETURNING id`;
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${articleId}, 'primary')`;
    return { storyId: Number(story!.id), factId: Number(fact!.id), articleId, gameInTitle };
  }

  before(async () => {
    await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
              VALUES (${sourceId}, 'P2 test', 'rss', 'T2', 'editorial', '2100-01-01')`;
    await sql`INSERT INTO seasons (id, name, year) VALUES (${seasonId}, 'P2 测试赛季', 2026)`;
    for (const [slug, name] of [["ag", "成都AG超玩会"], ["wolves", "重庆狼队"], ["ksg", "苏州KSG"], ["rw", "济南RW侠"],
                                ["drg", "佛山DRG"], ["tes", "长沙TES.A"], ["edgm", "上海EDG.M"], ["rngm", "上海RNG.M"]] as const) {
      await sql`INSERT INTO teams (id, slug, name) VALUES (${slug}, ${slug}, ${name})
                ON CONFLICT (id) DO NOTHING`;
    }
    const at = (s: string) => new Date(`${s}+08:00`).toISOString();
    // A: ag vs wolves 2026-06-01（幂等/局次/未知局次/同队不同日期用）
    await sql`INSERT INTO matches (id, season_id, team_a_id, team_b_id, bo, status, played_at)
              VALUES (${`kpl-testA-${T}`}, ${seasonId}, 'ag', 'wolves', 5, 'finished', ${at("2026-06-01T20:00:00")})`;
    // B: ksg vs rw 同一天两场（多候选用）
    await sql`INSERT INTO matches (id, season_id, team_a_id, team_b_id, bo, status, played_at)
              VALUES (${`kpl-testB1-${T}`}, ${seasonId}, 'ksg', 'rw', 5, 'finished', ${at("2026-07-01T19:00:00")}),
                     (${`kpl-testB2-${T}`}, ${seasonId}, 'ksg', 'rw', 5, 'finished', ${at("2026-07-01T21:30:00")})`;
    // C: drg vs tes 跨午夜（赛事日 8-1，played_at 落在 8-2 00:30）
    await sql`INSERT INTO matches (id, season_id, team_a_id, team_b_id, bo, status, played_at)
              VALUES (${`kpl-testC-${T}`}, ${seasonId}, 'drg', 'tes', 7, 'finished', ${at("2026-08-02T00:30:00")})`;
    // E: edgm vs rngm postponed + BO9（迁移回归）
    await sql`INSERT INTO matches (id, season_id, team_a_id, team_b_id, bo, status, scheduled_at)
              VALUES (${`kpl-testE-${T}`}, ${seasonId}, 'edgm', 'rngm', 9, 'postponed', ${at("2026-09-01T19:00:00")})`;
  });

  test("linker 幂等：重复运行不重复建档", async () => {
    const s = await mkStory("2026年6月1日KPL夏季赛成都AG超玩会对阵重庆狼队第一局",
      "AG对狼队第一局", "2026年6月1日KPL夏季赛成都AG超玩会对阵重庆狼队第一局AG先下一城",
      new Date("2026-06-01T22:00:00+08:00"), true);
    const r1 = await linkStoryToMatch(sql, s.storyId);
    const r2 = await linkStoryToMatch(sql, s.storyId);
    assert.equal(r1?.matchId, `kpl-testA-${T}`);
    assert.equal(r1?.gameNo, 1);
    assert.equal(r1?.linkType, "game");
    assert.deepEqual(r2, r1);
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM match_story_links WHERE story_id = ${s.storyId}`;
    assert.equal(rows[0]!.n, 1);
  });

  test("多候选不写", async () => {
    const s = await mkStory("2026年7月1日KPL夏季赛苏州KSG迎战济南RW侠",
      "KSG迎战RW侠", "2026年7月1日KPL夏季赛苏州KSG迎战济南RW侠",
      new Date("2026-07-01T23:00:00+08:00"), false);
    const r = await linkStoryToMatch(sql, s.storyId);
    assert.equal(r, null);
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM match_story_links WHERE story_id = ${s.storyId}`;
    assert.equal(rows[0]!.n, 0);
  });

  test("跨午夜不拆档：赛事日口径 ±1 天", async () => {
    const s = await mkStory("2026年8月1日KPL夏季赛佛山DRG对阵长沙TES.A",
      "DRG对阵TES", "2026年8月1日KPL夏季赛佛山DRG对阵长沙TES.A",
      new Date("2026-08-02T01:00:00+08:00"), false);
    const r = await linkStoryToMatch(sql, s.storyId);
    assert.equal(r?.matchId, `kpl-testC-${T}`);
    assert.equal(r?.linkType, "series");
    assert.equal(r?.gameNo, null);
  });

  test("未知局次不误归档：整场级 series", async () => {
    const s = await mkStory("2026年6月1日KPL夏季赛成都AG超玩会3比2战胜重庆狼队",
      "AG战胜狼队", "2026年6月1日KPL夏季赛成都AG超玩会3比2战胜重庆狼队",
      new Date("2026-06-01T23:30:00+08:00"), false);
    const r = await linkStoryToMatch(sql, s.storyId);
    assert.equal(r?.matchId, `kpl-testA-${T}`);
    assert.equal(r?.gameNo, null);
    assert.equal(r?.linkType, "series");
  });

  test("同队不同日期不误合并", async () => {
    const s = await mkStory("2026年6月10日KPL夏季赛成都AG超玩会对阵重庆狼队",
      "AG对阵狼队", "2026年6月10日KPL夏季赛成都AG超玩会对阵重庆狼队",
      new Date("2026-06-10T20:00:00+08:00"), false);
    const r = await linkStoryToMatch(sql, s.storyId);
    assert.equal(r, null);
  });

  test("postponed 状态 + BO9 回归", async () => {
    const s = await mkStory("2026年9月1日KPL夏季赛上海EDG.M对阵上海RNG.M延期",
      "EDGM对阵RNGM延期", "2026年9月1日KPL夏季赛上海EDG.M对阵上海RNG.M延期举行",
      new Date("2026-09-01T20:00:00+08:00"), false);
    const r = await linkStoryToMatch(sql, s.storyId);
    assert.equal(r?.matchId, `kpl-testE-${T}`);
    const [m] = await sql<{ status: string; bo: number }[]>`SELECT status, bo FROM matches WHERE id = ${`kpl-testE-${T}`}`;
    assert.equal(m!.status, "postponed");
    assert.equal(m!.bo, 9);
  });

  test("sameSeriesDifferentGameFacts：只有局次分歧的 fact 不触发 veto", async () => {
    const pub = new Date("2026-06-01T21:00:00+08:00");
    const s = await mkStory("2026年6月1日KPL夏季赛成都AG超玩会对阵重庆狼队第一局",
      "AG对狼队第一局", "2026年6月1日KPL夏季赛成都AG超玩会对阵重庆狼队第一局AG先下一城", pub, true);
    const q = { title: "2026年6月1日KPL夏季赛成都AG超玩会对阵重庆狼队第三局狼队扳回一城", at: new Date("2026-06-01T22:30:00+08:00") };
    assert.deepEqual(await sameSeriesDifferentGameFacts(q, [s.factId]), [s.factId]);
    // 不同日期 → 仍 veto
    const q2 = { title: q.title, at: new Date("2026-06-05T22:30:00+08:00") };
    assert.deepEqual(await sameSeriesDifferentGameFacts(q2, [s.factId]), []);
  });

  test("boostSourcesForMatch：只给两队 weibo 源加频，同因幂等", async () => {
    const reason = `p2-test-${T}`;
    await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, owner_entity_id, next_fetch_at)
              VALUES (${`wb-ag-${T}`}, 'AG 微博', 'weibo', 'T1', 'editorial', 'ag', '2100-01-01'),
                     (${`wb-wolves-${T}`}, '狼队微博', 'weibo', 'T1', 'editorial', 'wolves', '2100-01-01'),
                     (${`rss-ag-${T}`}, 'AG RSS', 'rss', 'T2', 'editorial', 'ag', '2100-01-01'),
                     (${`wb-edgm-${T}`}, 'EDGM 微博', 'weibo', 'T1', 'editorial', 'edgm', '2100-01-01')`;
    const n = await boostSourcesForMatch(sql, { teamSlugs: ["ag", "wolves"], reason, minutes: 60 });
    assert.equal(n, 2);
    const rows = await sql<{ source_id: string; interval_override_minutes: number }[]>`
      SELECT source_id, interval_override_minutes FROM source_boosts WHERE reason = ${reason} ORDER BY source_id`;
    assert.deepEqual(rows.map((r) => r.source_id).sort(), [`wb-ag-${T}`, `wb-wolves-${T}`].sort());
    assert.ok(rows.every((r) => r.interval_override_minutes >= 1 && r.interval_override_minutes <= 60));
    // 同因重复调用不重复建档
    const n2 = await boostSourcesForMatch(sql, { teamSlugs: ["ag", "wolves"], reason, minutes: 60 });
    assert.equal(n2, 0);
    const cnt = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM source_boosts WHERE reason = ${reason}`;
    assert.equal(cnt[0]!.n, 2);
  });
});

// ── groupArticle SAME_SERIES：同系列不同小局进同 story、按局次分 fact ──────────
// 需要模型替身（本地 HTTP stub，不访问外部服务；MODEL_CALLS_ENABLED 只开给 stub）。
describe("groupArticle SAME_SERIES (DB)", { skip: !dbReady }, () => {
  process.env.MODEL_CALLS_ENABLED = "true";
  process.env.GROUP_MODEL ??= "deepseek-flash";
  const gsourceId = `p2-gsrc-${T}`;
  let stubBase = "";
  before(async () => {
    const answer = (body: string) => {
      // 批量判断：一律 UNRELATED——证明 SAME_SERIES 走的是确定性指纹规则，不是模型判断。
      const ids = [...body.matchAll(/【候选 (C\d+)】/g)].map((m) => m[1]);
      return {
        query: "stub",
        decisions: ids.map((id) => ({ id, relation: "UNRELATED", confidence: 0.9, note: "stub" })),
        selection: { addsValue: true, reason: "stub" },
      };
    };
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(Buffer.concat(chunks).toString("utf8"))) } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    stubBase = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    process.env.DEEPSEEK_BASE_URL ??= stubBase;
    process.env.DEEPSEEK_API_KEY ??= "test-key";
    await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
              VALUES (${gsourceId}, 'P2 group test', 'rss', 'T2', 'editorial', '2100-01-01')`;
  });

  async function ingest(title: string, summary: string, publishedAt: Date) {
    const { articleId } = await upsertMaterial({
      sourceId: gsourceId, url: `https://example.org/p2-${T}/${encodeURIComponent(title.slice(0, 20))}-${Math.random().toString(36).slice(2, 7)}`,
      title, bodyText: summary, bodyStatus: "ok", via: "fetch", publishedAt,
    });
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
      VALUES (${articleId}, 1, 'rule', 'pass', 'match-report', ${title}, ${summary}, 80, true,
              ${sql.json({ scope: "single", fact: { title, subject: "苏州KSG", action: "对阵", object: "济南RW侠" } })})`;
    await sql`UPDATE articles SET processing_state = 'analyzed' WHERE id = ${articleId}`;
    await publishArticle(articleId);
    return articleId;
  }

  test("SAME_SERIES：同系列不同小局 → 同 story 不同 fact", async () => {
    const a = await ingest(
      "2026年3月10日KPL春季赛苏州KSG迎战济南RW侠第一局KSG先下一城",
      "双方首局交锋回顾，KSG先下一城。",
      new Date("2026-03-10T20:00:00+08:00"));
    const rA = await groupArticle(a);
    assert.equal(rA.verdict, "new-story");
    assert.ok(rA.storyId != null && rA.factId != null);

    const b = await ingest(
      "2026年3月10日KPL春季赛苏州KSG迎战济南RW侠第三局RW侠扳回一城",
      "双方第三局交锋回顾，RW侠扳回一城。",
      new Date("2026-03-10T21:30:00+08:00"));
    const rB = await groupArticle(b);
    assert.equal(rB.verdict, "new-fact-in-story");
    assert.equal(rB.storyId, rA.storyId);
    assert.notEqual(rB.factId, rA.factId);
    // 同 story 下确有两个 fact（按局次分）
    const facts = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM facts WHERE story_id = ${rA.storyId}`;
    assert.equal(facts[0]!.n, 2);
  });
});

// KPL 信源发现与覆盖率（§24/§25/§26）：
// - 战队清单的事实库是官方赛事数据（matches/teams），不是硬编码的名单：discoverActiveTeams
//   从"当前赛季有比赛的战队"动态识别 active teams，战队改名/扩容自动跟随。
// - 已验证的官方账号档案（industry/team-accounts.json）导入 entity_accounts，人工或三重验证
//   过的账号标 official_verified；只有这里的行才有资格作为"已覆盖"。
// - 活跃战队与账号档案的缺口进 source_discovery_queue：系统永远看得见"哪个队缺哪个平台"，
//   不允许悄悄漏掉一支战队。
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";

export interface ActiveTeam {
  id: string;
  slug: string;
  name: string;
  shortName: string | null;
  externalId: string | null;
  /** 最近一场已排期/已完赛的比赛时间，说明它为什么算活跃。 */
  lastMatchAt: Date | null;
}

/**
 * 当前活跃战队：近 N 天完赛、或未来有排期的战队（KPL 联赛）。官方赛事数据（esports_api）持续
 * 回灌 matches，所以这份清单随赛季自动滚动——席位变化、城市冠名、战队合并都会反映出来。
 */
export async function discoverActiveTeams(days = 120): Promise<ActiveTeam[]> {
  const teams = await sql<{ id: string; slug: string; name: string; short_name: string | null; external_id: string | null; last_at: Date | null }[]>`
    SELECT t.id, t.slug, t.name, t.short_name, t.external_id, MAX(COALESCE(m.played_at, m.scheduled_at)) AS last_at
    FROM teams t
    JOIN matches m ON (m.team_a_id = t.id OR m.team_b_id = t.id) AND m.status <> 'cancelled'
    WHERE t.league = 'KPL' AND t.is_active
      AND COALESCE(m.played_at, m.scheduled_at) > now() - make_interval(days => ${days}::int)
      AND COALESCE(m.played_at, m.scheduled_at) < now() + make_interval(days => ${days}::int)
    GROUP BY t.id, t.slug, t.name, t.short_name, t.external_id
    ORDER BY last_at DESC NULLS LAST`;
  return teams.map((t) => ({ id: t.id, slug: t.slug, name: t.name, shortName: t.short_name, externalId: t.external_id, lastMatchAt: t.last_at }));
}

interface AccountSeed {
  entityId: string;
  entityName: string;
  platform: string;
  handle: string;
  displayName?: string;
  accountUrl?: string;
  sourceId?: string;
  verifiedEvidence: string;
}

interface AccountPack {
  league: AccountSeed[];
  teams: AccountSeed[];
}

/** 已验证官方账号档案（TeamSourceProfile 种子）：幂等导入，人工修正过的字段不被覆盖。 */
export async function seedTeamAccounts(): Promise<{ added: number; updated: number }> {
  const pack = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/team-accounts.json"), "utf8")) as AccountPack;
  let added = 0;
  let updated = 0;
  for (const [type, list] of [["league", pack.league], ["team", pack.teams]] as const) {
    for (const a of list) {
      // 信源可能已被后台删除或尚未 seed：档案仍然落库，只把关联置空。
      const [src] = a.sourceId ? await sql<{ id: string }[]>`SELECT id FROM sources WHERE id = ${a.sourceId}` : [];
      const res = await sql`
        INSERT INTO entity_accounts (entity_type, entity_id, entity_name, platform, handle, display_name, account_url, official_verified, verified_at, verified_evidence, source_id)
        VALUES (${type}, ${a.entityId}, ${a.entityName}, ${a.platform}, ${a.handle}, ${a.displayName ?? a.entityName}, ${a.accountUrl ?? null}, true, now(), ${a.verifiedEvidence}, ${src?.id ?? null})
        ON CONFLICT (entity_type, entity_id, platform, handle) DO UPDATE SET
          display_name = EXCLUDED.display_name, account_url = EXCLUDED.account_url,
          verified_evidence = EXCLUDED.verified_evidence, source_id = EXCLUDED.source_id, updated_at = now()
        RETURNING (xmax = 0) AS inserted`;
      if (res[0]?.inserted) added += 1;
      else updated += 1;
    }
  }
  return { added, updated };
}

/** 平台缺口：微信/微博/B站是俱乐部官宣的主阵地，三个平台都值得有账号。 */
const CLUB_PLATFORMS = ["wechat", "weibo", "bilibili"] as const;

/**
 * 活跃战队 × 账号档案的缺口入发现队列（幂等）。每支活跃战队缺微博账号都会有一条 pending——
 * 微博是 KPL 官宣第一阵地而当前无法稳定接入（见 SOURCE_CANDIDATES.md），这条记录就是那个缺口的
 * 常驻提醒，直到账号被验证接入或明确标记 unsupported。
 */
export async function refreshDiscoveryQueue(): Promise<{ queued: number; teams: number }> {
  const teams = await discoverActiveTeams();
  const covered = await sql<{ entity_id: string; platform: string; source_id: string | null }[]>`
    SELECT DISTINCT entity_id, platform, source_id FROM entity_accounts WHERE entity_type = 'team' AND active`;
  const have = new Set(covered.map((c) => `${c.entity_id}:${c.platform}`));
  let queued = 0;
  for (const team of teams) {
    for (const platform of CLUB_PLATFORMS) {
      if (have.has(`${team.slug}:${platform}`) || have.has(`${team.id}:${platform}`)) continue;
      const existing = await sql<{ status: string }[]>`
        SELECT status FROM source_discovery_queue WHERE entity_type = 'team' AND entity_id = ${team.slug} AND platform = ${platform}`;
      if (existing.length) continue;
      await sql`
        INSERT INTO source_discovery_queue (entity_type, entity_id, entity_name, platform, reason, note)
        VALUES ('team', ${team.slug}, ${team.name}, ${platform},
          ${platform === "weibo"
            ? "俱乐部官方微博缺账号档案：微博 API 免登录不可用（HTTP 432），需要登录态采集方案或人工验证后接入"
            : `俱乐部官方 ${platform} 账号未验证接入`},
          ${team.lastMatchAt ? `最近比赛 ${team.lastMatchAt.toISOString().slice(0, 10)}，属于当前活跃战队` : "官方赛事数据标记为活跃战队"}
          )
        ON CONFLICT (entity_type, entity_id, platform) DO NOTHING`;
      queued += 1;
    }
  }
  return { queued, teams: teams.length };
}

// 覆盖率看板（§25）

export interface CoverageReport {
  league: { platforms: string[]; sources: Array<{ id: string; name: string; health: string; enabled: boolean }>; covered: boolean };
  teamCoverage: {
    total: number;
    covered: number;
    partial: number;
    missing: number;
    coverage: number;
    teams: Array<{ id: string; name: string; platforms: string[]; sources: string[]; state: "covered" | "partial" | "missing" }>;
  };
  firstParty: { stories7d: number; withFirstParty: number; rate: number };
  community: Array<{ platform: string; sourceId: string; name: string; health: string; enabled: boolean }>;
  health: { ok: number; degraded: number; failing: number; stale: number; paused: number };
  warnings: Array<{ kind: "source-stale" | "discovery"; entity: string; detail: string }>;
  queue: { pending: number; byPlatform: Array<{ platform: string; pending: number }> };
}

const HEALTHY = new Set(["ok"]);

/** 后台覆盖率看板的全部数据：联盟覆盖、战队覆盖、first-party 事件率、社区入口健康、健康分布与告警。 */
export async function computeCoverage(): Promise<CoverageReport> {
  const teams = await discoverActiveTeams();

  const leagueAccounts = await sql<{ platform: string }[]>`SELECT DISTINCT platform FROM entity_accounts WHERE entity_type = 'league' AND active AND official_verified`;
  const leagueSources = await sql<{ id: string; name: string; health: string; enabled: boolean }[]>`
    SELECT id, name, health, enabled FROM sources WHERE owner_type = 'league' ORDER BY id`;

  const accounts = await sql<{ entity_id: string; platform: string; source_id: string | null; discovered_at: Date }[]>`
    SELECT entity_id, platform, source_id, discovered_at FROM entity_accounts WHERE entity_type = 'team' AND active AND official_verified`;
  const teamSources = await sql<{ id: string; owner_entity_id: string | null; name: string; health: string; enabled: boolean; articles_30d: string }[]>`
    SELECT id, owner_entity_id, name, health, enabled,
      -- 近 30 天该通道是否发布过内容：按内容自身时间判断。首次导入的历史归档也算"通道有内容"，
      -- 但停更账号（内容停在数月前）仍会被判为无产出——健康不等于有内容。
      (SELECT count(*) FROM articles a WHERE a.source_id = sources.id
         AND coalesce(a.published_at, a.discovered_at) > now() - interval '30 days')::text AS articles_30d
    FROM sources WHERE owner_type = 'club'`;
  const sourceByEntity = new Map<string, Array<{ id: string; name: string; health: string; enabled: boolean; articles_30d: string }>>();
  for (const s of teamSources) {
    if (!s.owner_entity_id) continue;
    sourceByEntity.set(s.owner_entity_id, [...(sourceByEntity.get(s.owner_entity_id) ?? []), { id: s.id, name: s.name, health: s.health, enabled: s.enabled, articles_30d: s.articles_30d }]);
  }
  const accountPlatform = new Map<string, string[]>();
  for (const a of accounts) accountPlatform.set(a.entity_id, [...(accountPlatform.get(a.entity_id) ?? []), a.platform]);
  // 未接入信源的已验证账号也是覆盖计划的一部分：看板能看到"已建档但还没接线"。
  const unlinked = accounts.filter((a) => !a.source_id).map((a) => `${a.entity_id}:${a.platform}`);

  const teamRows = teams.map((t) => {
    const platforms = [...new Set([...(accountPlatform.get(t.slug) ?? []), ...(accountPlatform.get(t.id) ?? [])])];
    const sources = sourceByEntity.get(t.slug) ?? [];
    // 已覆盖 = 有启用的健康信源，且近 30 天确有产出（账号停更的通道不算覆盖，按部分计）。
    const live = sources.filter((s) => s.enabled && HEALTHY.has(s.health) && Number(s.articles_30d) > 0);
    const state: "covered" | "partial" | "missing" = live.length > 0 ? "covered" : platforms.length > 0 || sources.length > 0 ? "partial" : "missing";
    return { id: t.slug, name: t.name, platforms, sources: sources.map((s) => s.id), state };
  });
  const covered = teamRows.filter((t) => t.state === "covered").length;
  const partial = teamRows.filter((t) => t.state === "partial").length;

  const [fp] = await sql<{ total: string; with_fp: string }[]>`
    SELECT count(DISTINCT st.id)::text AS total,
      count(DISTINCT st.id) FILTER (WHERE EXISTS (
        SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id
        JOIN articles a ON a.id = fa.article_id JOIN sources s ON s.id = a.source_id
        WHERE f.story_id = st.id AND s.tier = 'T1' AND fa.role IN ('primary', 'report')))::text AS with_fp
    FROM stories st WHERE st.first_report_at > now() - interval '7 days' AND st.merged_into IS NULL`;
  const stories7d = Number(fp?.total ?? 0);
  const withFirstParty = Number(fp?.with_fp ?? 0);

  const community = await sql<{ id: string; name: string; health: string; enabled: boolean; tags: string[] }[]>`
    SELECT id, name, health, enabled, tags FROM sources WHERE owner_type = 'community' ORDER BY id`;
  const healthRows = await sql<{ health: string; enabled: boolean; last_ok_at: Date | null }[]>`
    SELECT health, enabled, last_ok_at FROM sources WHERE enabled AND kind <> 'external'`;
  const health = { ok: 0, degraded: 0, failing: 0, stale: 0, paused: 0 };
  for (const r of healthRows) {
    if (r.health === "ok") health.ok += 1;
    else if (r.health === "degraded") health.degraded += 1;
    else if (r.health === "failing") health.failing += 1;
    else if (!r.last_ok_at || Date.now() - r.last_ok_at.getTime() > 24 * 3600_000) health.stale += 1;
    else health.ok += 1;
  }
  health.paused = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM sources WHERE NOT enabled`.then((r) => Number(r[0]?.n ?? 0));

  // 告警：重要的俱乐部官方源超过 24h 没有成功采集，或发现队列里有未处理的缺口。
  const warnings: CoverageReport["warnings"] = [];
  for (const s of teamSources) {
    if (!s.enabled) continue;
    const stale = s.health === "failing" || s.health === "degraded";
    if (stale) warnings.push({ kind: "source-stale", entity: s.name, detail: `俱乐部官方源 ${s.id} 健康状态 ${s.health}，超过 24h 未成功采集时官宣可能漏接` });
    // 采集正常但 30 天零产出：账号可能已停更（口径：健康 ≠ 有内容）。
    else if (Number(s.articles_30d) === 0) warnings.push({ kind: "source-stale", entity: s.name, detail: `俱乐部官方源 ${s.id} 近 30 天零产出，账号可能已停更或通道失效（覆盖按部分计）` });
  }
  const queueRows = await sql<{ platform: string; entity_name: string; note: string | null }[]>`
    SELECT platform, entity_name, note FROM source_discovery_queue WHERE status = 'pending' ORDER BY id`;
  for (const q of queueRows.slice(0, 30)) {
    warnings.push({ kind: "discovery", entity: q.entity_name, detail: `${q.entity_name} 缺少 ${q.platform} 官方账号档案（发现队列 pending${q.note ? `；${q.note}` : ""}）` });
  }
  for (const key of unlinked) {
    const [entityId, platform] = key.split(":") as [string, string];
    const name = teams.find((t) => t.slug === entityId || t.id === entityId)?.name ?? entityId;
    warnings.push({ kind: "discovery", entity: name, detail: `${name} 的 ${platform} 账号已验证建档，但没有关联信源（未接线采集）` });
  }

  const queueByPlatform = await sql<{ platform: string; pending: string }[]>`
    SELECT platform, count(*)::text AS pending FROM source_discovery_queue WHERE status = 'pending' GROUP BY platform ORDER BY platform`;

  return {
    league: {
      platforms: leagueAccounts.map((l) => l.platform),
      sources: leagueSources,
      covered: leagueSources.some((s) => s.enabled && HEALTHY.has(s.health)) && leagueAccounts.length > 0,
    },
    teamCoverage: {
      total: teamRows.length, covered, partial, missing: teamRows.length - covered - partial,
      coverage: teamRows.length ? Math.round((covered / teamRows.length) * 1000) / 10 : 100,
      teams: teamRows,
    },
    firstParty: { stories7d, withFirstParty, rate: stories7d ? Math.round((withFirstParty / stories7d) * 1000) / 10 : 0 },
    community: community.map((c) => ({ platform: c.tags.find((t) => ["虎扑", "B站", "微博", "贴吧"].includes(t)) ?? "其他", sourceId: c.id, name: c.name, health: c.health, enabled: c.enabled })),
    health,
    warnings,
    queue: { pending: queueRows.length, byPlatform: queueByPlatform.map((q) => ({ platform: q.platform, pending: Number(q.pending) })) },
  };
}

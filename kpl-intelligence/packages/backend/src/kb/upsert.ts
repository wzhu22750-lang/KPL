// KPL 知识库的结构化写入：官方赛事数据（战队、英雄、选手、比赛、对局、BP、单局数据）的幂等入库。
// 所有写入 ON CONFLICT：官方字段以最新抓取为准，人工在后台维护的 style_notes、别名等不被覆盖。
// 读取器（sources/esports.ts）与历史回灌脚本（scripts/import-kpl-history.ts）共用这一层。
import type { Db, Tx } from "../db.ts";
import { sql as rootSql } from "../db.ts";

export const SMOBA_BASE = "https://prod.comp.smoba.qq.com";

const SPLIT_BY_SEQ: Record<string, { split: string; label: string }> = {
  "0001": { split: "spring", label: "春季赛" },
  "0002": { split: "summer", label: "夏季赛" },
};

/**
 * 赛季命名优先看官方 cc_match_id 前缀（KPL2026S1/S2/S3、KCC），序号只是回退：
 * 2026 年起 0002 是 KCC 杯赛、0003 是夏季赛、0004 起是年度总决赛，与早期年份的“0002=夏季”不同。
 */
export function seasonMeta(leagueId: string, ccHint?: string | null): { split: string; label: string } {
  const cc = (ccHint ?? "").toUpperCase();
  if (cc.startsWith("KCC")) return { split: "challenger", label: "挑战者杯" };
  if (cc.startsWith("KPL")) {
    // 形如 KPL2026S1M1W1D1：S 后一位是赛季序。
    const at = cc.indexOf("S", 3);
    const n = at >= 0 ? cc.charAt(at + 1) : "";
    if (n === "1") return { split: "spring", label: "春季赛" };
    if (n === "2") return { split: "summer", label: "夏季赛" };
    if (n === "3") return { split: "annual", label: "年度总决赛" };
  }
  return SPLIT_BY_SEQ[leagueId.slice(4)] ?? { split: "annual", label: "年度总决赛" };
}

/** 赛季行：external_id（league_id）为准；id 由年份与分季（经 cc 前缀判定）生成。 */
export async function ensureSeason(db: Db, leagueId: string, ccHint?: string | null): Promise<string> {
  const meta = seasonMeta(leagueId, ccHint);
  const year = leagueId.slice(0, 4);
  const id = "kpl-" + year + "-" + meta.split;
  const name = year + "年KPL" + meta.label;
  await db`
    INSERT INTO seasons (id, name, year, split, external_id)
    VALUES (${id}, ${name}, ${Number(year)}, ${meta.split}, ${leagueId})
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, external_id = EXCLUDED.external_id`;
  const [row] = await db<{ id: string }[]>`SELECT id FROM seasons WHERE external_id = ${leagueId} ORDER BY id LIMIT 1`;
  return row!.id;
}

export interface TeamInput {
  externalId: string;
  name: string;
  shortName?: string | null;
  logoUrl?: string | null;
}

/** 官方 team_id → 本站战队。新队自动建行（slug 占位 t{id}，后台可改名改 slug 的展示字段）。 */
export async function ensureTeam(db: Db, t: TeamInput): Promise<string> {
  const [existing] = await db<{ id: string }[]>`SELECT id FROM teams WHERE external_id = ${t.externalId}`;
  if (existing) {
    await db`UPDATE teams SET name = ${t.name}, short_name = COALESCE(${t.shortName ?? null}, short_name),
      logo_url = COALESCE(${t.logoUrl ?? null}, logo_url), updated_at = now() WHERE id = ${existing.id}`;
    return existing.id;
  }
  const id = "t" + t.externalId;
  const rows = await db<{ id: string }[]>`
    INSERT INTO teams (id, slug, name, short_name, logo_url, external_id, is_active)
    VALUES (${id}, ${id}, ${t.name}, ${t.shortName ?? null}, ${t.logoUrl ?? null}, ${t.externalId}, true)
    ON CONFLICT (id) DO UPDATE SET external_id = EXCLUDED.external_id, updated_at = now() RETURNING id`;
  for (const alias of [t.name, ...(t.shortName ? [t.shortName] : [])]) {
    await db`INSERT INTO team_aliases (team_id, alias, normalized, source)
      VALUES (${id}, ${alias}, ${alias.toLowerCase().replace(/\s+/g, "")}, 'official') ON CONFLICT DO NOTHING`;
  }
  return rows[0]!.id;
}

export interface HeroInput {
  heroId: string | number;
  name: string;
  iconUrl?: string | null;
}

/** 英雄缺失时自动补种（herolist 覆盖之外的新英雄）；slug 占位 h{id}。 */
export async function ensureHero(db: Db, h: HeroInput): Promise<string> {
  const id = String(h.heroId);
  await db`
    INSERT INTO heroes (id, slug, name, portrait_url)
    VALUES (${id}, ${"h" + id}, ${h.name}, ${h.iconUrl ?? null})
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`;
  return id;
}

export interface PlayerInput {
  /** 官方 actual_player_name：“北京JDG.绝意”。 */
  actualName: string;
  teamId: string | null;
  /** 首次见到这名选手的比赛日期（转会履历 joined_at）。 */
  seenAt: Date | null;
  iconUrl?: string | null;
}

/** 从“北京JDG.绝意”解析昵称（队名前缀只是展示，队伍归属以 battle_player_list 的 team_id 为准）。 */
export function parseActualName(actualName: string): { nickname: string } {
  const dot = actualName.indexOf(".");
  const nickname = dot > 0 ? actualName.slice(dot + 1).trim() : actualName.trim();
  return { nickname: nickname || actualName.trim() };
}

async function freeSlug(db: Db, base: string, playerId: string): Promise<string> {
  const taken = async (slug: string) =>
    (await db<{ id: string }[]>`SELECT id FROM players WHERE slug = ${slug} AND id <> ${playerId}`).length > 0
    || (await db<{ id: string }[]>`SELECT id FROM players WHERE id = ${slug} AND id <> ${playerId}`).length > 0;
  if (!base) base = "player";
  let candidate = base;
  for (let n = 2; await taken(candidate); n++) candidate = base + "-" + n;
  return candidate;
}

/** 选手：昵称即身份（KPL 昵称基本唯一）；同昵称并入已有行，slug 首选拉丁昵称本身。 */
export async function ensurePlayer(db: Db, p: PlayerInput): Promise<string> {
  const { nickname } = parseActualName(p.actualName);
  const existing = await db<{ id: string; current_team_id: string | null }[]>`
    SELECT id, current_team_id FROM players WHERE nickname = ${nickname}
    ORDER BY (current_team_id = ${p.teamId}) DESC NULLS LAST, updated_at DESC LIMIT 1`;
  let id: string;
  if (existing[0]) {
    id = existing[0].id;
    await db`UPDATE players SET is_active = true, updated_at = now(),
      current_team_id = COALESCE(${p.teamId}, current_team_id) WHERE id = ${id}`;
  } else {
    // slug 首选拉丁昵称；中文昵称直接用昵称（URL 会转义但可读），冲突时后缀去重。
    const latin = nickname.toLowerCase().replace(/[^a-z0-9_-]+/g, "");
    const base = latin.length >= 2 ? latin : nickname.trim();
    id = await freeSlug(db, base, "pending-player-" + Date.now());
    const rows = await db<{ id: string }[]>`
      INSERT INTO players (id, slug, nickname, current_team_id, is_active, portrait_url)
      VALUES (${id}, ${id}, ${nickname}, ${p.teamId}, true, ${p.iconUrl ?? null})
      ON CONFLICT (id) DO UPDATE SET nickname = EXCLUDED.nickname RETURNING id`;
    id = rows[0]!.id;
  }
  for (const alias of new Set([nickname, p.actualName])) {
    await db`INSERT INTO player_aliases (player_id, alias, normalized, source)
      VALUES (${id}, ${alias}, ${alias.toLowerCase().replace(/\s+/g, "")}, 'official') ON CONFLICT DO NOTHING`;
  }
  // 转会履历：同队一条进行中的履历；换队后旧履历由后台确认补 left_at。
  if (p.teamId) {
    const stint = await db<{ id: number }[]>`
      SELECT id FROM player_stints WHERE player_id = ${id} AND team_id = ${p.teamId} AND left_at IS NULL LIMIT 1`;
    if (!stint.length) {
      const joinedAt = p.seenAt ? p.seenAt.toISOString().slice(0, 10) : null;
      await db`INSERT INTO player_stints (player_id, team_id, joined_at) VALUES (${id}, ${p.teamId}, ${joinedAt})
        ON CONFLICT (player_id, team_id, joined_at) DO NOTHING`;
    }
  }
  return id;
}

export interface MatchInput {
  leagueId: string;
  matchId: string;
  seasonId: string;
  ccKey?: string | null;
  stage?: string | null;
  bo?: number | null;
  teamAId: string;
  teamBId: string;
  scoreA: number;
  scoreB: number;
  winnerId: string | null;
  status: "scheduled" | "live" | "finished" | "cancelled" | "postponed";
  /** Time the source request started (or a source-provided revision timestamp), not response arrival. */
  observedAt?: Date;
  scheduledAt: Date | null;
  playedAt: Date | null;
  sourceUrl?: string | null;
  raw?: unknown;
}

/** 比分时间解析：官方给北京时间字符串（"2026-01-14 14:00:00"）；数据库里查回的已是 Date，原样收下。 */
export function beijingTime(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const iso = value.trim().replace(" ", "T") + "+08:00";
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** 比赛行：官方为真源，重复抓取更新比分与状态，不产生重复行。 */
export async function upsertMatch(db: Db, m: MatchInput): Promise<{ id: string; created: boolean; revised: boolean }> {
  const id = ["kpl", m.leagueId, m.matchId].join("-");
  const observedAt = m.observedAt ?? new Date();
  if (!Number.isFinite(observedAt.getTime())) throw new Error("invalid match observation time");
  const rows = await db<{ id: string; inserted: boolean }[]>`
    INSERT INTO matches (id, season_id, stage, bo, team_a_id, team_b_id, score_a, score_b, winner_id,
                         status, scheduled_at, played_at, source, source_key, cc_key, source_url, raw, score_observed_at)
    VALUES (${id}, ${m.seasonId}, ${m.stage ?? null}, ${m.bo ?? null}, ${m.teamAId}, ${m.teamBId},
            ${m.scoreA}, ${m.scoreB}, ${m.winnerId}, ${m.status}, ${m.scheduledAt?.toISOString() ?? null},
            ${m.playedAt?.toISOString() ?? null}, 'smoba', ${m.matchId}, ${m.ccKey ?? null}, ${m.sourceUrl ?? null},
            ${m.raw === undefined ? null : db.json(m.raw as never)}, ${observedAt})
    ON CONFLICT (id) DO UPDATE SET
      stage = EXCLUDED.stage, bo = EXCLUDED.bo, score_a = EXCLUDED.score_a, score_b = EXCLUDED.score_b,
      winner_id = EXCLUDED.winner_id, status = EXCLUDED.status, scheduled_at = EXCLUDED.scheduled_at,
      played_at = EXCLUDED.played_at, cc_key = EXCLUDED.cc_key, raw = EXCLUDED.raw, score_observed_at = EXCLUDED.score_observed_at, updated_at = now()
    WHERE matches.score_observed_at IS NULL OR EXCLUDED.score_observed_at > matches.score_observed_at
    RETURNING id, (xmax = 0) AS inserted`;
  return { id, created: rows[0]?.inserted ?? false, revised: rows.length > 0 && !rows[0]!.inserted };
}

export interface BattlePlayer {
  actual_player_name: string;
  team_id: string;
  camp: number;
  hero_id: number;
  hero_name: string;
  hero_icon?: string | null;
  player_icon?: string | null;
  position?: number | null;
  position_desc?: string | null;
  is_mvp?: number | boolean;
  is_lose_mvp?: number | boolean;
  mvp_score?: number | string | null;
  kill_num?: number; death_num?: number; assist_num?: number;
  gold?: number; participation_rate?: number | string | null;
  hurt_to_hero_total?: number; be_hurt_total?: number;
  [key: string]: unknown;
}

export interface BpEntry {
  camp: number;
  is_ban_or_pick: number; // 0 ban / 1 pick
  hero_id: number;
  hero_name: string;
  hero_icon?: string | null;
  position?: number | null;
}

export interface GameInput {
  matchId: string;
  bo: number | null;
  battleId: string;
  battleSeq: number;
  status: number;
  winCamp: number | null;
  durationMs: number | null;
  teamAId: string;
  teamBId: string;
  campTeams: { 1?: string | null; 2?: string | null };
  kills: { 1?: number | null; 2?: number | null };
  golds: { 1?: number | null; 2?: number | null };
  bpList: BpEntry[];
  players: BattlePlayer[];
  playedAt: Date | null;
  raw: unknown;
}

const LANES: Record<string, string> = { 对抗路: "对抗路", 打野: "打野", 中路: "中路", 发育路: "发育路", 游走: "游走", 辅助: "游走" };
const laneOf = (desc: string | null | undefined) => {
  const lane = (desc ?? "").split("/").map((s) => s.trim()).find((s) => LANES[s]);
  return lane ? LANES[lane]! : null;
};

/**
 * 一局完整数据：games 行 + 20 步 BP + 每名选手的单局数据。
 * camp 1/2 按本小局的队伍映射，不沿用大场顺序；kills/gold 落库时再对齐大场 A/B。
 * camp1 记为蓝方是站内稳定约定；
 * 巅峰对决（决胜局之后的盲选局）不产生 ban 记录，选取进 pinnacle_picks。
 *
 * 单事务 + 按对局 ID 的 advisory lock：worker 的自动同步与回灌脚本可能同时补同一局，
 * 先清后写的顺序必须在锁内完成，否则两边交错会撞主键（bp_actions_pkey）。
 */
export async function upsertGame(g: GameInput): Promise<{ id: string }> {
  const id = g.matchId + "-g" + g.battleSeq;
  return rootSql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
    return upsertGameTx(tx, g, id);
  });
}

async function upsertGameTx(db: Tx, g: GameInput, id: string): Promise<{ id: string }> {
  const finished = g.status === 2;
  const winnerId = finished && g.winCamp ? g.campTeams[g.winCamp as 1 | 2] ?? null : null;
  const aCamp = g.campTeams[1] === g.teamAId ? 1 : g.campTeams[2] === g.teamAId ? 2 : null;
  const bCamp = g.campTeams[1] === g.teamBId ? 1 : g.campTeams[2] === g.teamBId ? 2 : null;
  const mode = g.bo !== null && g.bo !== undefined && g.battleSeq > g.bo ? "pinnacle" : "standard";
  const mvp = g.players.find((p) => p.is_mvp);
  const mvpId = mvp ? await ensurePlayer(db, { actualName: mvp.actual_player_name, teamId: await teamIdOf(db, mvp.team_id), seenAt: g.playedAt, iconUrl: mvp.player_icon ?? null }) : null;
  await db`
    INSERT INTO games (id, match_id, game_no, mode, winner_id, duration_secs, mvp_player_id,
                       kills_a, kills_b, gold_a, gold_b, source, source_key, raw)
    VALUES (${id}, ${g.matchId}, ${g.battleSeq}, ${mode}, ${winnerId},
            ${g.durationMs !== null ? Math.round(g.durationMs / 1000) : null}, ${mvpId},
            ${aCamp ? g.kills[aCamp] ?? null : null}, ${bCamp ? g.kills[bCamp] ?? null : null}, ${aCamp ? g.golds[aCamp] ?? null : null}, ${bCamp ? g.golds[bCamp] ?? null : null},
            'smoba', ${g.battleId}, ${db.json(g.raw as never)})
    ON CONFLICT (id) DO UPDATE SET
      mode = EXCLUDED.mode, winner_id = EXCLUDED.winner_id, duration_secs = EXCLUDED.duration_secs,
      mvp_player_id = EXCLUDED.mvp_player_id, kills_a = EXCLUDED.kills_a, kills_b = EXCLUDED.kills_b,
      gold_a = EXCLUDED.gold_a, gold_b = EXCLUDED.gold_b, raw = EXCLUDED.raw`;

  // 先清后写 BP 与单局数据：重抓同一局时官方时序可能修正。
  await db`DELETE FROM bp_actions WHERE game_id = ${id}`;
  await db`DELETE FROM pinnacle_picks WHERE game_id = ${id}`;
  await db`DELETE FROM player_games WHERE game_id = ${id}`;

  const sideOf = (camp: number) => (camp === 2 ? "red" : "blue");
  const playerByHero = new Map<string, BattlePlayer>();
  for (const p of g.players) playerByHero.set(String(p.camp) + ":" + String(p.hero_id), p);
  const playerOf = async (entry: BpEntry) => {
    const p = playerByHero.get(String(entry.camp) + ":" + String(entry.hero_id));
    if (!p) return null;
    return ensurePlayer(db, { actualName: p.actual_player_name, teamId: await teamIdOf(db, p.team_id), seenAt: g.playedAt, iconUrl: p.player_icon ?? null });
  };

  if (mode === "pinnacle") {
    for (const entry of g.bpList.filter((b) => b.is_ban_or_pick === 1)) {
      const heroId = await ensureHero(db, { heroId: entry.hero_id, name: entry.hero_name, iconUrl: entry.hero_icon });
      const p = playerByHero.get(String(entry.camp) + ":" + String(entry.hero_id));
      const teamId = g.campTeams[entry.camp as 1 | 2] ?? (p ? await teamIdOf(db, p.team_id) : null);
      if (!teamId) continue;
      const playerId = await playerOf(entry);
      await db`INSERT INTO pinnacle_picks (game_id, team_id, hero_id, player_id, position)
        VALUES (${id}, ${teamId}, ${heroId}, ${playerId}, ${laneOf(p?.position_desc)}) ON CONFLICT DO NOTHING`;
    }
  } else {
    for (const [index, entry] of g.bpList.entries()) {
      const heroId = await ensureHero(db, { heroId: entry.hero_id, name: entry.hero_name, iconUrl: entry.hero_icon });
      const playerId = entry.is_ban_or_pick === 1 ? await playerOf(entry) : null;
      await db`
        INSERT INTO bp_actions (game_id, step_index, action_type, side, hero_id, player_id, position, raw_order)
        VALUES (${id}, ${index + 1}, ${entry.is_ban_or_pick === 1 ? "pick" : "ban"}, ${sideOf(entry.camp)},
                ${heroId}, ${playerId}, ${laneOf(p_desc(entry))}, ${index})
        ON CONFLICT (game_id, step_index) DO UPDATE SET
          action_type = EXCLUDED.action_type, side = EXCLUDED.side, hero_id = EXCLUDED.hero_id,
          player_id = EXCLUDED.player_id, position = EXCLUDED.position, raw_order = EXCLUDED.raw_order`;
    }
  }

  for (const p of g.players) {
    const heroId = await ensureHero(db, { heroId: p.hero_id, name: p.hero_name, iconUrl: p.hero_icon });
    const playerId = await ensurePlayer(db, { actualName: p.actual_player_name, teamId: await teamIdOf(db, p.team_id), seenAt: g.playedAt, iconUrl: p.player_icon ?? null });
    await db`
      INSERT INTO player_games (game_id, player_id, team_id, hero_id, side, position, kills, deaths, assists,
                                gold, damage_to_hero, damage_taken, participation_rate, mvp, lose_mvp, mvp_score, raw)
      VALUES (${id}, ${playerId}, ${await teamIdOf(db, p.team_id)}, ${heroId}, ${sideOf(p.camp)}, ${laneOf(p.position_desc)},
              ${p.kill_num ?? null}, ${p.death_num ?? null}, ${p.assist_num ?? null}, ${p.gold ?? null},
              ${p.hurt_to_hero_total ?? null}, ${p.be_hurt_total ?? null}, ${p.participation_rate != null ? String(p.participation_rate) : null},
              ${Boolean(p.is_mvp)}, ${Boolean(p.is_lose_mvp)}, ${p.mvp_score != null ? String(p.mvp_score) : null},
              ${db.json(p as never)})
      ON CONFLICT (game_id, player_id) DO NOTHING`;
  }
  return { id };
}

const p_desc = (entry: BpEntry): string | null => {
  const p = (entry as BpEntry & { position_desc?: string | null }).position_desc;
  return p ?? null;
};

async function teamIdOf(db: Db, externalId: string): Promise<string | null> {
  const [row] = await db<{ id: string }[]>`SELECT id FROM teams WHERE external_id = ${String(externalId)}`;
  return row?.id ?? null;
}

/** 一局是否已完整入库（重复抓取的幂等判断在 games.source_key 上）。 */
export async function battleStored(db: Db, battleId: string): Promise<boolean> {
  const [row] = await db<{ id: string }[]>`SELECT id FROM games WHERE source = 'smoba' AND source_key = ${battleId}`;
  return Boolean(row);
}

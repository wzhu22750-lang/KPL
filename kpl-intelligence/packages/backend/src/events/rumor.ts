// 事件的 rumor 状态机（§17/§29）：转会、退役、伤病这类"先爆料后官宣"的声明，事实上挂一个
// 可迁移的状态，爆料和定案在数据上是两个世界——虎扑热帖永远是 SIGNAL，营销号爆料永远进不了
// confirmed，直到俱乐部/联盟/本人这些有资格的发布方开口（authority ≥ CONFIRM_AUTHORITY）。
// 状态迁移全部写入 rumor_timeline：官宣推翻传闻时，爆料的时间线保留，不被抹掉。
import { sql, type Tx } from "../db.ts";
import { canConfirm, type AuthoritySource } from "../sources/authority.ts";
import { DENIAL_MARKERS, RUMOR_CLAIMS, type ClaimType } from "../sources/claims.ts";

export type RumorState = "unverified" | "multiple_reports" | "player_hint" | "club_hint" | "official_confirmed" | "official_denied";

const RANK: Record<RumorState, number> = {
  unverified: 1, multiple_reports: 2, player_hint: 3, club_hint: 3, official_confirmed: 5, official_denied: 5,
};

export interface RumorContext {
  current: RumorState | null;
  claimType: string;
  /** 这条材料的发布方（sources 投影）。 */
  source: AuthoritySource;
  /** 材料提到的实体（entity_mentions 的 team/player id）。 */
  mentionedEntityIds: string[];
  title: string;
  /** 佐证独立性：这个事实按原始发布方归并后的独立来源数（repost/syndication 不计数）。 */
  independentOriginOwners: number;
}

export interface RumorUpdate {
  from: RumorState | null;
  to: RumorState | null;
  changed: boolean;
}

/**
 * 纯函数：给定事实现状与新材料的证据，目标状态是什么。downgrade 一律不接受
 * （官宣确认后营销号的后续爆料不能把事实拉回 unverified）。
 */
export function nextRumorState(ctx: RumorContext): RumorState | null {
  if (!RUMOR_CLAIMS.includes(ctx.claimType as ClaimType)) return null;
  const denial = DENIAL_MARKERS.some((m) => ctx.title.includes(m));
  if (denial && canConfirm(ctx.source, ctx.claimType as ClaimType, ctx.mentionedEntityIds)) return "official_denied";
  if (canConfirm(ctx.source, ctx.claimType as ClaimType, ctx.mentionedEntityIds)) return "official_confirmed";
  // 有资格定案的来源还没出现：按发布方身份给线索等级。
  const owner = ctx.source.owner_type;
  const hinted: RumorState | null =
    owner === "player" ? "player_hint"
      : owner === "club" || owner === "coach" || owner === "staff" ? "club_hint"
      : null;
  const byIndependence: RumorState = ctx.independentOriginOwners >= 2 ? "multiple_reports" : "unverified";
  const target = hinted && RANK[hinted] > RANK[byIndependence] ? hinted : byIndependence;
  if (ctx.current && RANK[target] <= RANK[ctx.current]) return null;
  return target;
}

/**
 * 一篇报道入事实后推进状态。tx 由调用方持有（group.ts 的写入事务）：
 * 锁与 fact_articles 的写入在同一个事务里提交，状态与佐证永远一致。
 */
export async function updateRumorState(tx: Tx, factId: number, articleId: string): Promise<RumorUpdate> {
  const [fact] = await tx<{ claim_type: string | null; rumor_state: RumorState | null }[]>`
    SELECT claim_type, rumor_state FROM facts WHERE id = ${factId}`;
  if (!fact?.claim_type) return { from: null, to: null, changed: false };
  const [article] = await tx<{ title: string; summary: string | null }[]>`
    SELECT coalesce(an.title_zh, a.title) AS title, coalesce(an.summary_zh, a.excerpt) AS summary
    FROM articles a
    LEFT JOIN LATERAL (SELECT title_zh, summary_zh FROM analyses x WHERE x.article_id = a.id ORDER BY input_revision DESC, id DESC LIMIT 1) an ON true
    WHERE a.id = ${articleId}`;
  if (!article) return { from: null, to: null, changed: false };
  const [source] = await tx<(AuthoritySource & { id: string })[]>`
    SELECT s.id, s.kind, s.tier, s.first_party, s.owner_type, s.claim_types, s.owner_entity_id
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!source) return { from: null, to: null, changed: false };
  const mentions = await tx<{ entity_id: string }[]>`
    SELECT entity_id FROM entity_mentions WHERE article_id = ${articleId} AND entity_type IN ('team', 'player')`;
  // 独立佐证：这个事实的全部 primary/report 里，按原始发布方（owner 实体，转载不算）归并的来源数。
  const [owners] = await tx<{ n: string }[]>`
    SELECT count(DISTINCT coalesce(s.owner_entity_id, s.id))::text AS n
    FROM fact_articles fa
    JOIN articles a ON a.id = fa.article_id JOIN sources s ON s.id = a.source_id
    WHERE fa.fact_id = ${factId} AND fa.role IN ('primary', 'report') AND (a.origin_type IS NULL OR a.origin_type = 'original')`;
  const target = nextRumorState({
    current: fact.rumor_state, claimType: fact.claim_type, source, title: `${article.title}。${article.summary ?? ""}`,
    mentionedEntityIds: mentions.map((m) => m.entity_id),
    independentOriginOwners: Number(owners?.n ?? 1),
  });
  if (!target || target === fact.rumor_state) return { from: fact.rumor_state, to: fact.rumor_state, changed: false };
  const confirmed = target === "official_confirmed" || target === "official_denied";
  await tx`UPDATE facts SET rumor_state = ${target}, ${confirmed ? sql`confirmed_at = now(),` : sql``} updated_at = now() WHERE id = ${factId}`;
  // note 是给后台与用户看的可读迁移说明；source_id 是这次推进的发布方（官宣/辟谣/报道）。
  const note = target === "unverified" ? "状态推进" : RUMOR_NOTE[target];
  await tx`INSERT INTO rumor_timeline (fact_id, from_state, to_state, source_id, article_id, note)
           VALUES (${factId}, ${fact.rumor_state}, ${target}, ${source.id}, ${articleId}, ${note})`;
  return { from: fact.rumor_state, to: target, changed: true };
}

const RUMOR_NOTE: Record<Exclude<RumorState, "unverified">, string> = {
  multiple_reports: "两个及以上独立原始来源的报道（转载不计）",
  player_hint: "选手本人账号透露的线索，尚未由俱乐部/联盟确认",
  club_hint: "俱乐部/教练组方面透露的线索，尚未正式官宣",
  official_confirmed: "有确认资格的发布方（俱乐部/联盟/官方赛事数据）已确认",
  official_denied: "有确认资格的发布方已辟谣否认",
};

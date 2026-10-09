// Publication rules. Each rule is defined once here and used by every exit.
import { RADAR } from "@aihot/industry/radar";
import { canonicalEvidenceText, canonicalEvidenceHash } from "../content/canonical.ts";
import type { CanonicalContent } from "../content/extractors/types.ts";

export { canonicalEvidenceHash, canonicalEvidenceText };

export interface SourceFacts {
  id: string;
  name: string;
  kind: string;
  tier: string;
  participation_mode: string;
  first_party: boolean;
  site_fulltext: boolean;
  syndicate_fulltext: boolean;
}

export function channelOf(sourceKind: string, hasXPost: boolean): "x" | "news" {
  return sourceKind === "x_search" || hasXPost ? "x" : "news";
}

/** Public pool (/all): editorial sources, AI relevant, with a Chinese title and summary. */
export function isPoolEligible(input: {
  participationMode: string;
  relevance: string | null;
  title: string | null;
  summary: string | null;
}): boolean {
  return input.participationMode === "editorial" && input.relevance === "pass" && !!input.title && !!input.summary;
}

/**
 * Item detail page (and its Markdown export): every unwithdrawn item from an editorial source has one,
 * with or without a Chinese summary (noindex unless indexable). hot_signal material is heat evidence
 * only and has none. A paused source keeps its pages.
 */
export function hasItemPage(p: { visibility: string; sourceMode: string }): boolean {
  return p.visibility !== "withdrawn" && p.sourceMode === "editorial";
}

/** Selected: pool eligible, judged selected, and the source tier may enter the selection. */
export function isSelectable(eligible: boolean, judgedSelected: boolean | null, tier: string): boolean {
  return eligible && judgedSelected === true && tier !== "EXCLUDE_MP";
}

/**
 * Site full text: the source licence allows showing it and we have confirmed body text.
 * WeChat and paywalled content never get it just because it was fetchable (source flag false).
 */
export function bodyModeOf(source: SourceFacts, bodyStatus: string, hasBody: boolean): "full" | "summary" {
  return source.site_fulltext && bodyStatus === "ok" && hasBody ? "full" : "summary";
}

/** Full-RSS redistribution whitelist: only sources that explicitly allow it. */
export function mayRedistribute(source: SourceFacts, bodyMode: "full" | "summary"): boolean {
  return source.syndicate_fulltext && bodyMode === "full";
}

/**
 * Detail pages are noindex by default. Selected items are indexed automatically; an editor
 * can mark any other public page for indexing, or exclude a page, which then stays out.
 */
export function isIndexable(p: { visibility: string; hasSummary: boolean; selected: boolean; seoIndexedAt: Date | null; seoExcludedAt: Date | null }): boolean {
  return p.visibility === "public" && p.hasSummary && p.seoExcludedAt === null && (p.selected || p.seoIndexedAt !== null);
}

/** Display tags exclude internal entity markers. */
export function displayTags(tags: string[]): string[] {
  return tags.filter((t) => !t.startsWith("entity:"));
}

/**
 * The source name readers see. Admin names carry notes for editors in full-width brackets: the channel,
 * what a feed keeps, a person's role or why the account is followed (「OpenAI：官网动态（RSS · 排除企业/客户案例）」,
 * 「某媒体（热点 RSS）」, 「X：Clément Delangue（Hugging Face CEO） (@ClementDelangue)」). Readers get the name
 * without them, and an X account its display name (its handle when the name is only a note). Every
 * exit people read uses this, and search matches it; JSON fields keep the stored name, which programs
 * may match.
 */
export function publicSourceName(name: string): string {
  let bare = name;
  while (/（[^（）]*）/.test(bare)) bare = bare.replace(/（[^（）]*）/g, " ");
  const x = /^X[:：]\s*(.*?)\s*(?:\(@[^)]*\))?\s*$/.exec(bare);
  return (x ? x[1]! : bare).replace(/\s+/g, " ").trim() || /@\w+/.exec(name)?.[0] || name.trim();
}

export function isCommunityPublicationEnabled(): boolean {
  return process.env.COMMUNITY_PUBLICATION_ENABLED === "true";
}

export interface FeedbackPublicationGateInput {
  articleRevision: number;
  radarMaterial?: {
    state: string;
    inputRevision?: number;
    scoreVersion?: string;
    input_revision?: number;
    score_version?: string;
    inputEvidenceHash?: string | null;
    input_evidence_hash?: string | null;
    judgment?: {
      relevant?: boolean;
      safe?: boolean;
    } | null;
  } | null;
  canonical?: CanonicalContent | Record<string, any> | null;
  fallbackBody?: { title?: string | null; bodyText?: string | null; excerpt?: string | null } | null;
  currentEvidenceHash?: string | null;
}

/**
 * Community feedback safety gate:
 * For community feedback from a collection-bearing canonical on ANY mode,
 * expose raw highlightedReplies / authorFollowups + communitySummary ONLY AFTER:
 * 1. radar_materials entry is accepted
 * 2. radarMaterial matches current revision (input_revision === articleRevision)
 * 3. score_version === RADAR.version
 * 4. judgment is safe === true and relevant === true
 * 5. input_evidence_hash matches current evidenceHash (never null for collection-bearing)
 * Otherwise returns false (feedback empty awaiting review).
 * Legacy items without a collection are not gated by this rule (returns true).
 */
export function isCommunityFeedbackApproved(input: FeedbackPublicationGateInput): boolean {
  const canonical = (input.canonical ?? null) as CanonicalContent | null;
  const hasCollection = Boolean(canonical?.discussion?.collection);
  if (!hasCollection) return true;

  const rm = input.radarMaterial;
  if (!rm) return false;
  if (rm.state !== "accepted") return false;

  const inputRevision = rm.inputRevision ?? rm.input_revision;
  if (inputRevision !== input.articleRevision) return false;

  const scoreVersion = rm.scoreVersion ?? rm.score_version;
  if (scoreVersion !== RADAR.version) return false;

  if (!rm.judgment || rm.judgment.relevant !== true || rm.judgment.safe !== true) return false;

  const storedHash = rm.inputEvidenceHash ?? rm.input_evidence_hash ?? null;
  if (storedHash === null) return false;

  const currentHash = input.currentEvidenceHash ?? canonicalEvidenceHash(canonical, input.fallbackBody);
  if (storedHash !== currentHash) return false;

  return true;
}

export interface SignalPublicationGateInput {
  visibility: string;
  sourceMode: string;
  enabled?: boolean;
  articleRevision: number;
  radarMaterial?: {
    state: string;
    inputRevision?: number;
    scoreVersion?: string;
    input_revision?: number;
    score_version?: string;
    inputEvidenceHash?: string | null;
    input_evidence_hash?: string | null;
    judgment?: {
      relevant?: boolean;
      safe?: boolean;
    } | null;
  } | null;
  quality?: {
    completeness?: string | null;
    score?: number | null;
  } | null;
  canonical?: CanonicalContent | Record<string, any> | null;
  contentKind?: string | null;
  currentEvidenceHash?: string | null;
  fallbackBody?: { title?: string | null; bodyText?: string | null; excerpt?: string | null } | null;
}

/**
 * Signal detail safety gate:
 * An unwithdrawn item from an editorial source always has an item page (retains paused compatibility).
 * A hot_signal item has an item page ONLY IF:
 * 1. COMMUNITY_PUBLICATION_ENABLED === 'true'
 * 2. visibility !== 'withdrawn'
 * 3. sourceMode === 'hot_signal' and source enabled === true
 * 4. radar_materials entry is accepted, matches current revision & RADAR.version
 * 5. judgment is relevant & safe
 * 6. evidence hash matches when hash set; legacy null judgment allowed ONLY if canonical discussion.collection absent (old)
 * 7. known canonical quality has finite score >= 40 and completeness is 'full' or 'partial', or 'summary_only' ONLY for kind video_post with valid metadata and no transcript fake
 * Blanket editorial conversion is forbidden (source mode stays hot_signal / non-editorial).
 */
export function canPublishSignalDetail(input: SignalPublicationGateInput): boolean {
  if (input.visibility === "withdrawn") return false;
  if (input.sourceMode === "editorial") return true;
  if (!isCommunityPublicationEnabled()) return false;
  if (input.sourceMode !== "hot_signal") return false;
  if (input.enabled !== true) return false;

  const rm = input.radarMaterial;
  if (!rm) return false;
  if (rm.state !== "accepted") return false;
  const inputRevision = rm.inputRevision ?? rm.input_revision;
  if (inputRevision !== input.articleRevision) return false;
  const scoreVersion = rm.scoreVersion ?? rm.score_version;
  if (scoreVersion !== RADAR.version) return false;
  if (!rm.judgment || rm.judgment.relevant !== true || rm.judgment.safe !== true) return false;

  const storedHash = rm.inputEvidenceHash ?? rm.input_evidence_hash ?? null;
  const canonical = (input.canonical ?? null) as CanonicalContent | null;

  if (storedHash !== null) {
    const currentHash = input.currentEvidenceHash ?? canonicalEvidenceHash(canonical, input.fallbackBody);
    if (storedHash !== currentHash) return false;
  } else {
    // Legacy null judgment allowed ONLY if canonical discussion.collection absent (old)
    // Collection-bearing communities require matching hash
    const hasCollection = Boolean(canonical?.discussion?.collection);
    if (hasCollection) return false;
  }

  const q = input.quality;
  if (!q) return false;
  if (typeof q.score !== "number" || !Number.isFinite(q.score) || q.score < 40) return false;

  const completeness = q.completeness;
  if (completeness === "full" || completeness === "partial") {
    return true;
  }

  if (completeness === "summary_only") {
    const kind = input.contentKind ?? canonical?.kind;
    if (kind !== "video_post") return false;

    const video = canonical?.video;
    if (!video || typeof video !== "object") return false;

    const hasValidMeta = Boolean(
      (typeof video.description === "string" && video.description.trim().length > 0) ||
      (typeof video.cover === "string" && video.cover.trim().length > 0) ||
      (typeof video.durationSeconds === "number" && video.durationSeconds > 0)
    );
    if (!hasValidMeta) return false;

    if (video.transcriptSummary) return false;

    return true;
  }

  return false;
}

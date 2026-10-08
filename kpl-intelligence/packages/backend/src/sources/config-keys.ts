// The config keys each kind of source implements. Anything else is refused: a key a collector does not
// know would otherwise fall back silently to the generic parse (menus and sentence fragments as
// articles, dates never found).
import type { SourceRow } from "./types.ts";

// Rules applied in collect.ts to every kind read through collectSource.
const PUBLISHER = ["publisherRole", "publisherUrlPrefixes"];
// Content intelligence：来源的内容形态声明（SourceContentProfile 的选择与覆盖）。
const CONTENT_PROFILE = ["contentProfile", "contentFamily", "threadSelectors"];
const COLLECTED = [...PUBLISHER, ...CONTENT_PROFILE, "collectionPolicy", "_aihot", "allowUrlPrefixes", "denyUrlPrefixes", "ingestNoiseFilter", "itemUrlPrefixRewrite", "sortByPublishedAt", "detail", "fetchPublicContent"];

const KEYS: Record<SourceRow["kind"], string[]> = {
  rss: [...COLLECTED, "feedUrl", "summaryIsBody", "preserveUrlFragment", "allowCategories", "denyCategories"],
  web_list: [
    ...COLLECTED, "url", "baseUrl", "parseMode", "adapter", "cacheToleranceSeconds", "linksStartLine", "preserveUrlFragment",
    "itemSelector", "linkSelector", "titleSelector", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset",
  ],
  json_list: [
    ...COLLECTED, "url", "mode", "method", "headers", "bodyJson", "jsonKey", "windowVar", "itemsPath", "itemsObjectValues",
    "titlePaths", "summaryPaths", "summaryIsBody", "authorPaths", "publishedAtPath", "publishedAtUnit", "externalIdPath",
    "urlTemplate", "urlTemplateFallback", "rawDropKeys", "engagementPaths", "requireBoolean", "requireString", "minNumeric", "pagination",
  ],
  // X accounts are mostly read in shards, which apply only these.
  x_search: [...PUBLISHER, ...CONTENT_PROFILE, "collectionPolicy", "_aihot", "ingestNoiseFilter", "itemUrlPrefixRewrite", "query", "searchType"],
  mp_account: [...PUBLISHER, ...CONTENT_PROFILE, "collectionPolicy", "wxid", "ghid", "nickname"],
  external: [...PUBLISHER],
  // Structured esports data: writes matches/games/BP, not articles. baseUrl exists for tests and
  // mirror endpoints; the production default lives in sources/esports.ts.
  esports_api: ["leagueId", "baseUrl", "battlesPerRun", "dataMode"],
  weibo: [...COLLECTED, "uid", "containerid", "platform", "owner_type", "owner_entity_id", "maxPages", "mode", "query", "timeWindowDays"],
};

// Objects with fixed keys (headers and bodyJson are request data, free-form).
const NESTED: Record<string, string[]> = {
  _aihot: ["initialBackfillLimit", "initialBackfillMonths"],
  ingestNoiseFilter: ["dropMarkers", "dropMarkersTitleOnly", "keepIfMatches"],
  itemUrlPrefixRewrite: ["from", "to"],
  requireBoolean: ["path", "equals"],
  requireString: ["path", "equals"],
  minNumeric: ["path", "min"],
  engagementPaths: ["platform", "views", "likes", "comments", "shares", "favorites"],
  pagination: ["pageParam", "startPage", "maxPages", "itemsPath"],
  detail: [
    "maxFetches", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset", "publishedAtAuthoritative", "upgradeDatePrecision",
    "titleSelector", "titleRegex", "titleAuthoritative", "summarySelector",
  ],
  threadSelectors: ["post", "author", "content", "time", "likes", "floor", "quote", "title", "avatar"],
};

const VALUES: Record<string, string[]> = {
  publisherRole: ["organization", "person"],
  adapter: ["mimo_home"],
  parseMode: ["html", "markdown", "docusaurus_changelog"],
  contentFamily: ["publisher", "official", "forum", "social", "video", "blog", "aggregator", "unknown"],
};

/** The config entries a source of this kind would ignore or cannot run, e.g. ["adapter=site_cards", "detail.titleFoo"]. */
export function unsupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): string[] {
  const allowed = new Set(KEYS[kind] ?? []);
  const out: string[] = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!allowed.has(key)) out.push(key);
    else if (key === "collectionPolicy" && (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((k) => k !== "mode")
      || !["fixed", "adaptive"].includes(String((value as Record<string, unknown>).mode)))) out.push("collectionPolicy");
    else if (key === "publisherUrlPrefixes" && (!Array.isArray(value) || !value.every((v) => {
      if (typeof v !== "string") return false;
      try { const u = new URL(v); return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
    }))) out.push(key);
    else if (VALUES[key] && !VALUES[key]!.includes(String(value))) out.push(`${key}=${String(value)}`);
    else if (NESTED[key] && value && typeof value === "object") {
      for (const sub of Object.keys(value)) if (!NESTED[key]!.includes(sub)) out.push(`${key}.${sub}`);
    }
  }
  return out;
}

export class UnsupportedConfig extends Error {
  readonly statusCode = 400;
}

/** Refuses a config with entries its kind does not implement (admin create, edit and preview). */
export function assertSupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): void {
  const bad = unsupportedConfig(kind, config);
  if (bad.length) throw new UnsupportedConfig(`不支持的配置项：${bad.join("、")}`);
}

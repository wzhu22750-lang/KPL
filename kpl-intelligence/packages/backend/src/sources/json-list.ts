// JSON sources: plain JSON APIs, JSON embedded in HTML (script tags, window variables).
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";

export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

function firstString(obj: unknown, paths: string[] | undefined): string | null {
  for (const p of paths ?? []) {
    const v = getPath(obj, p);
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** "{path}" → encoded value, "{raw:path}" → raw value. Returns null when a referenced value is missing. */
export function renderTemplate(template: string, item: unknown): string | null {
  let missing = false;
  const out = template.replace(/\{(raw:)?([^}]+)\}/g, (_m, raw: string | undefined, path: string) => {
    const v = getPath(item, path);
    if (v === undefined || v === null || v === "") {
      missing = true;
      return "";
    }
    return raw ? String(v) : encodeURIComponent(String(v)).replace(/%2F/g, "/");
  });
  return missing ? null : out;
}

function toDate(v: unknown, unit: string | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (unit === "epoch_ms" || unit === "epoch_s") {
    try {
      const date = new Date(Number(v) * (unit === "epoch_s" ? 1000 : 1));
      return Number.isFinite(date.getTime()) ? date : null;
    } catch {
      return null;
    }
  }
  // 20260922: a calendar day at UTC midnight (some list APIs give dates as yyyymmdd).
  if (unit === "yyyymmdd") {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(v).trim());
    const d = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`) : null;
    return d && Number.isFinite(d.getTime()) && d.toISOString().startsWith(`${m![1]}-${m![2]}-${m![3]}`) ? d : null;
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t) : null;
}

function findKey(obj: unknown, key: string, depth = 0): unknown {
  if (depth > 12 || obj === null || typeof obj !== "object") return undefined;
  if (!Array.isArray(obj) && key in (obj as Record<string, unknown>)) {
    const v = (obj as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v;
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const found = findKey(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function embeddedJson(html: string, source: SourceRow): unknown {
  const mode = source.config.mode;
  if (mode === "html_window_var") {
    const name = String(source.config.windowVar);
    const re = new RegExp(`(?:window\\.)?${name.replace(/[$]/g, "\\$")}\\s*=\\s*`);
    const m = re.exec(html);
    if (!m) throw new FetchError(`window.${name} not found`);
    const start = m.index + m[0].length;
    // Balanced-brace scan to find the object literal's end.
    let depth = 0, inStr: string | null = null, esc = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return JSON.parse(html.slice(start, i + 1));
      }
    }
    throw new FetchError(`window.${name} not terminated`);
  }
  // html_json_key: scan JSON script blocks (e.g. __NEXT_DATA__) for the key.
  const key = String(source.config.jsonKey);
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1]!.trim();
    // Flight payloads carry the key escaped inside a string (\"items\").
    if (!body.includes(`"${key}"`) && !body.includes(`\\"${key}\\"`)) continue;
    const candidates = [body, body.replace(/^[^{[]*/, "").replace(/;?\s*$/, "")];
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(c);
        const found = findKey(parsed, key);
        if (found) return { [key]: found };
      } catch {
        // Next.js flight payloads: self.__next_f.push([1,"..."])
      }
    }
    const flight = /"((?:[^"\\]|\\.)*)"\]\)\s*$/.exec(body);
    if (flight) {
      try {
        const decoded = JSON.parse(`"${flight[1]}"`) as string;
        const idx = decoded.indexOf(`"${key}"`);
        if (idx >= 0) {
          const objStart = decoded.lastIndexOf("{", idx);
          const parsed = JSON.parse(decoded.slice(objStart, decoded.indexOf("]", idx) + 1) + "}");
          const found = findKey(parsed, key);
          if (found) return { [key]: found };
        }
      } catch {
        // keep scanning
      }
    }
  }
  throw new FetchError(`embedded key ${key} not found`);
}

export async function fetchJsonList(source: SourceRow): Promise<Candidate[]> {
  const c = source.config;
  const baseUrl = String(c.url ?? "");
  // Pagination is explicit and opt-in: without a documented page parameter the reader stays single-page,
  // so a source that does not support paging is never guessed at or looped forever.
  const pagination = c.pagination as { pageParam?: string; startPage?: number; maxPages?: number; itemsPath?: string } | undefined;
  const pages = pagination?.pageParam ? Math.max(1, Math.min(Number(pagination.maxPages ?? 1), 20)) : 1;
  const startPage = Number(pagination?.startPage ?? 1);

  const out: Candidate[] = [];
  const seenFromPriorPages = new Set<string>();
  let totalItems = 0;
  for (let i = 0; i < pages; i++) {
    const url = pageUrl(baseUrl, pagination?.pageParam, pages > 1 ? startPage + i : undefined);
    const data = await readJson(url, source);
    const itemsPath = pagination?.itemsPath ?? c.itemsPath;
    let items = itemsPath ? getPath(data, itemsPath) : c.jsonKey ? getPath(data, c.jsonKey) : data;
    if (c.itemsObjectValues && items && typeof items === "object" && !Array.isArray(items)) items = Object.values(items);
    if (!Array.isArray(items)) throw new FetchError("items path did not resolve to an array");
    if (items.length === 0) break; // 空页视为分页边界
    totalItems += items.length;

    // Keep duplicates within a page (the single-page behavior collect.ts relies on for `found`); only
    // drop entries a previous page already produced, so overlapping pages cannot double-charge detail.
    const pageOut: Candidate[] = [];
    for (const item of items) {
      if (c.requireBoolean && getPath(item, c.requireBoolean.path) !== c.requireBoolean.equals) continue;
      if (c.minNumeric && !(Number(getPath(item, c.minNumeric.path)) >= Number(c.minNumeric.min))) continue;
      // Identity assertion: an official-account listing only stores content by the expected author.
      // If the upstream starts returning anything else (keyword drift, hijacked search), every item is
      // dropped and the run maps to an error — the source degrades visibly instead of mixing voices.
      // Numbers compare as their text form (ids like B站 upMid arrive as JSON numbers).
      if (c.requireString) {
        const got = getPath(item, c.requireString.path);
        const expected: string[] = Array.isArray(c.requireString.equals) ? c.requireString.equals : [c.requireString.equals];
        if (got === null || got === undefined || !expected.includes(String(got))) continue;
      }
      const title = firstString(item, c.titlePaths);
      const url = (c.urlTemplate && renderTemplate(c.urlTemplate, item)) || (c.urlTemplateFallback && renderTemplate(c.urlTemplateFallback, item));
      if (!title || !url) continue;
      if (i > 0 && seenFromPriorPages.has(url)) continue;
      const externalId = c.externalIdPath ? getPath(item, c.externalIdPath) : null;
      const summary = firstString(item, c.summaryPaths);
      const summaryIsBody = c.summaryIsBody === true && !!summary;
      pageOut.push({
        url,
        title: collapseWhitespace(stripTags(title)),
        author: firstString(item, c.authorPaths),
        publishedAt: toDate(getPath(item, c.publishedAtPath), c.publishedAtUnit),
        excerpt: summary ? collapseWhitespace(stripTags(summary)).slice(0, 2000) : null,
        bodyText: summaryIsBody ? stripTags(summary!) : null,
        bodyStatus: summaryIsBody ? "ok" : "pending",
        raw: { externalId: externalId ?? null },
      });
    }
    for (const candidate of pageOut) seenFromPriorPages.add(candidate.url);
    out.push(...pageOut);
  }
  if (totalItems > 0 && out.length === 0 && !c.requireBoolean && !c.minNumeric) throw new FetchError("no items mapped (check title/url paths)");
  return out;
}

/** Adds the page parameter only when the config opted into pagination. */
function pageUrl(base: string, param: string | undefined, page: number | undefined): string {
  if (!param || page === undefined) return base;
  const u = new URL(base);
  u.searchParams.set(param, String(page));
  return u.toString();
}

/** One JSON page: same request shape and credential rules as before. */
async function readJson(url: string, source: SourceRow): Promise<unknown> {
  const c = source.config;
  const headers: Record<string, string> = { accept: "application/json, text/html;q=0.9", ...(c.headers ?? {}) };
  if (/^https:\/\/api\.github\.com\//.test(url)) {
    const token = credential("collectors", "GITHUB_TOKEN");
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const res = await guardedFetch(url, {
    redirectPolicy: "same-origin",
    method: c.method ?? "GET",
    headers: c.bodyJson ? { ...headers, "content-type": "application/json" } : headers,
    body: c.bodyJson ? JSON.stringify(c.bodyJson) : undefined,
    timeoutMs: 25_000,
  });
  if (res.status !== 200) throw new FetchError(`HTTP ${res.status}`, res.status);
  if (c.mode === "html_json_key" || c.mode === "html_window_var") return embeddedJson(res.text(), source);
  try {
    return JSON.parse(res.text());
  } catch {
    throw new FetchError("response is not JSON");
  }
}

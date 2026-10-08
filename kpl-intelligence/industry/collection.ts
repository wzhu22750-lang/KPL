// Content acquisition priorities. Applied to fresh seed entries and explicitly via the dry-run
// migration script, never silently over an operator's live source settings on worker startup.
export function collectionDefaults(source: { id: string; kind: string; config: Record<string, unknown> }) {
  if (source.kind === "mp_account" || (source.kind === "rss" && source.id.startsWith("mp-"))) {
    return { intervalMinutes: 1440, mode: "fixed" as const, reason: "公众号每日补充（含RSS桥接）" };
  }
  if (source.kind === "weibo") {
    const search = source.config.mode === "topic" || source.config.mode === "search" || !!source.config.query;
    return { intervalMinutes: search ? 60 : 30, mode: "fixed" as const, reason: search ? "微博关键词搜索，每小时" : "微博账号主通道，每半小时" };
  }
  return null;
}

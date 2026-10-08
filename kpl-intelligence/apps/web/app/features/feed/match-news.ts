export type MatchNewsFilter = 'all' | 'other' | number;

/** Exact stored association only: never infer a game's identity from a headline or a team name. */
export function selectMatchNews<T extends { id: string; gameNo: number | null; publishedAt: string | null }>(items: T[], filter: MatchNewsFilter): T[] {
  return items.filter(item => filter === 'all' || (filter === 'other' ? item.gameNo === null : item.gameNo === filter))
    .sort((a, b) => (Date.parse(b.publishedAt ?? '') || 0) - (Date.parse(a.publishedAt ?? '') || 0) || a.id.localeCompare(b.id));
}

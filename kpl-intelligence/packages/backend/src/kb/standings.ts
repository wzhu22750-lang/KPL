import type { StandingRow, TeamSummary } from '@aihot/contracts/kpl';

export interface StandingsMatch {
  id: string;
  home: TeamSummary;
  away: TeamSummary;
  scoreA: number;
  scoreB: number;
  winner: string | null; // slug
  status: string;
  bo: number | null;
}

/** Caller supplies chronological matches and an explicit roster, never inferred strength tiers. */
export function calculateStandings(
  matches: StandingsMatch[], roster: TeamSummary[], group: StandingRow['group'], stage: string,
): StandingRow[] {
  const rows = new Map(roster.map(team => [team.slug, {
    rank: 0, team, group, stageName: stage, matchesPlayed: 0, wins: 0, losses: 0,
    winRate: 0, gamesWon: 0, gamesLost: 0, gameDiff: 0, points: 0, streak: '-',
  } satisfies StandingRow]));
  const recent = new Map<string, boolean[]>();
  for (const m of matches) {
    if (!validStandingResult(m)) continue;
    for (const [slug, wonGames, lostGames] of [
      [m.home.slug, m.scoreA, m.scoreB], [m.away.slug, m.scoreB, m.scoreA],
    ] as const) {
      const row = rows.get(slug);
      if (!row) continue;
      const won = m.winner === slug;
      row.matchesPlayed++;
      if (won) row.wins++; else row.losses++;
      row.gamesWon += wonGames;
      row.gamesLost += lostGames;
      const results = recent.get(slug) ?? [];
      results.push(won);
      recent.set(slug, results);
    }
  }
  for (const row of rows.values()) {
    row.points = row.wins;
    row.gameDiff = row.gamesWon - row.gamesLost;
    row.winRate = row.matchesPlayed ? row.wins / row.matchesPlayed : 0;
    const results = recent.get(row.team.slug) ?? [];
    const last = results.at(-1);
    if (last !== undefined) {
      let n = 0;
      for (let i = results.length - 1; i >= 0 && results[i] === last; i--) n++;
      row.streak = `${n}${last ? '连胜' : '连败'}`;
    }
  }
  const sorted = [...rows.values()].sort((a,b) => b.points-a.points || b.gameDiff-a.gameDiff || a.team.slug.localeCompare(b.team.slug));
  // Equal points and differential stay tied: game wins/team names are not official tiebreakers.
  return sorted.map((row,i) => {
    const previous = sorted[i-1];
    row.rank = previous && previous.points === row.points && previous.gameDiff === row.gameDiff ? previous.rank : i+1;
    return row;
  });
}

export function validStandingResult(m: StandingsMatch): boolean {
  if (m.status !== 'finished' || m.home.slug === m.away.slug) return false;
  if (![m.scoreA,m.scoreB].every(n => Number.isInteger(n) && n >= 0) || m.scoreA === m.scoreB) return false;
  const winner = m.scoreA > m.scoreB ? m.home.slug : m.away.slug;
  if (m.winner !== winner) return false;
  if (m.bo !== null) {
    const target = Math.floor(m.bo/2)+1;
    if (Math.max(m.scoreA,m.scoreB) !== target || Math.min(m.scoreA,m.scoreB) >= target) return false;
  }
  return true;
}

// Match association is a parent relation, NOT a relaxation of same-fact/game identity.
import { extractTeamsFromText, extractDateKeysFromText } from '../lib/kpl-dedup.ts';
import { beijingDate } from '@aihot/contracts/time';

export interface RadarMatchCandidate { id: string; homeName: string; awayName: string; at: Date; stage: string | null; bo: number | null; status?: string }
export function associateMatch(text: string, publishedAt: Date | null, matches: RadarMatchCandidate[]) {
  const teams = extractTeamsFromText(text);
  if (!teams.length || teams.length > 2) return null;
  const eventAt = publishedAt && /昨日|昨天|昨晚/.test(text) ? new Date(publishedAt.getTime()-86400000) : publishedAt;
  const dates = extractDateKeysFromText(text, eventAt);
  if (!dates.dateKey) return null;
  const day = dates.dateKey;
  const candidates = matches.filter(m => {
    const pair = extractTeamsFromText(`${m.homeName} ${m.awayName}`);
    const crossMidnightLive = !dates.explicitDateKey && publishedAt && m.status === 'live'
      && publishedAt.getTime() >= m.at.getTime() && publishedAt.getTime()-m.at.getTime() <= 12*3600000;
    const sameDay = beijingDate(m.at).replaceAll('-','') === day || crossMidnightLive;
    const competitions = [/挑战者杯|挑杯/,/春季赛/,/夏季赛/,/年度总决赛|年总/,/世界冠军杯|世冠|KIC/i];
    const competition = competitions.every(pattern => !pattern.test(text) || pattern.test(m.stage ?? ''));
    return sameDay && competition && teams.every(t => pair.includes(t));
  });
  // Explicitly named other tournaments must not be guessed into this match. One team on one day
  // can associate only when there is a unique scheduled match and the text is match-specific.
  if (candidates.length !== 1 || !/第[一二三四五六七八九\d]+局|首局|比赛|战胜|击败|团灭|三杀|四杀|五杀|MVP|复盘|对阵|首发|比分/i.test(text)) return null;
  const match = candidates[0]!;
  const ordinal = text.match(/第([一二三四五六七八九\d]+)局/);
  const map: Record<string,number> = { 一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9 };
  const n = ordinal ? map[ordinal[1]!] ?? Number(ordinal[1]) : /首局/.test(text) ? 1 : null;
  const gameNo = n && Number.isInteger(n) && n >= 1 && n <= (match.bo ?? 9) ? n : null;
  return { matchId: match.id, gameNo, evidence: `${dates.explicitDateKey ? 'explicit event date' : 'publication day'} + ${teams.length} team(s) + unique scheduled match` };
}

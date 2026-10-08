import type { SourceGroupKey } from '@aihot/contracts/taxonomy';
import { SOURCE_GROUPS, CASTER_SOURCE_TAGS } from '@aihot/industry/source-groups';
import { sql } from '../db.ts';

/** One identity rule for filtering and display. Alias s always denotes the source, never article tags. */
export const sourceGroupExpression = sql`CASE
  WHEN s.owner_type = ANY(${[...SOURCE_GROUPS[0].owners]}::text[]) THEN 'official'
  WHEN s.owner_type = ANY(${[...SOURCE_GROUPS[1].owners]}::text[]) THEN 'club'
  WHEN s.owner_type = ANY(${[...SOURCE_GROUPS[2].owners]}::text[]) THEN 'participant'
  WHEN s.owner_type = 'media' AND s.tags && ${[...CASTER_SOURCE_TAGS]}::text[] THEN 'caster'
  WHEN s.owner_type = 'media' THEN 'media'
  WHEN s.owner_type = 'community' THEN 'community'
  ELSE NULL END`;

// Some timeline/count queries only join publications. Keep source scoping identical there as well.
export function sourceGroupCondition(group: SourceGroupKey | null | undefined) {
  return group ? sql`AND p.source_id IN (SELECT s.id FROM sources s WHERE ${sourceGroupExpression} = ${group})` : sql``;
}

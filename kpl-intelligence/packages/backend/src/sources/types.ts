import type { MaterialInput } from "../content/materials.ts";

export type SourceKind =
  | "rss"
  | "web_list"
  | "json_list"
  | "x_search"
  | "mp_account"
  | "external"
  | "esports_api"
  | "weibo";

export type SourceRole = "league_official" | "club_official" | "principal" | "caster" | "media" | "community";

export interface SourceRow {
  id: string;
  name: string;
  kind: SourceKind;
  config: Record<string, any>;
  tier: string;
  owner_type?: string | null;
  owner_entity_id?: string | null;
  tags?: string[];
  participation_mode: "editorial" | "hot_signal" | "isolated";
  first_party: boolean;
  interval_minutes: number;
  enabled: boolean;
  cursor: Record<string, any> | null;
  fail_count: number;
  /** 信源身份角色（P1 信源目录）；旧行默认为 'media'（见迁移 0065）。 */
  role?: SourceRole | null;
  /** 调度排序的显式权重，越大越优先。 */
  priority_weight?: number | null;
  /** false 时 adaptIntervals 跳过该源（公众号等敏感通道的降频保护）。 */
  auto_tune?: boolean | null;
  verified_evidence?: string | null;
  last_verified_at?: Date | null;
}

/**
 * What a fetcher found on a listing, before identity and timeline rules are applied. Whether the
 * article page is then fetched for a body is decided per source (jobs/content.ts route).
 */
export type Candidate = Omit<MaterialInput, "sourceId" | "via"> & {
  categories?: string[];
};

export class FetchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

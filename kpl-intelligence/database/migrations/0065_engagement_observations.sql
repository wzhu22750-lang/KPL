-- Independent, timestamped counters. Text revisions and legacy canonical snapshots stay intact.
-- No historical backfill: previously missing counters must not be turned into known zeroes.
CREATE TABLE engagement_observations (
  id bigserial PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  platform text NOT NULL,
  observed_at timestamptz NOT NULL,
  method text NOT NULL CHECK (method IN ('source_api', 'page_dom')),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  coverage text NOT NULL CHECK (coverage IN ('observed', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_id, source_id, platform, observed_at, method)
);
CREATE INDEX engagement_observations_latest_idx
  ON engagement_observations (article_id, source_id, platform, observed_at DESC, id DESC);
CREATE INDEX engagement_observations_time_idx ON engagement_observations (observed_at);

-- Records attempts to refresh community comments across platforms (Hupu, Weibo, Bilibili).
-- Captures request count, latency, fetched reply count, status, errors, and pagination cursors.
CREATE TABLE IF NOT EXISTS community_collection_runs (
  id bigserial PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  platform text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('ok', 'partial', 'unavailable', 'failed')),
  request_count integer NOT NULL DEFAULT 0,
  latency_ms integer,
  fetched_count integer NOT NULL DEFAULT 0,
  total_replies integer,
  extraction_fail boolean NOT NULL DEFAULT false,
  cursor_state jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS community_collection_runs_article_idx
  ON community_collection_runs (article_id, platform, attempted_at DESC);
CREATE INDEX IF NOT EXISTS community_collection_runs_source_idx
  ON community_collection_runs (source_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS community_collection_runs_time_idx
  ON community_collection_runs (attempted_at DESC);

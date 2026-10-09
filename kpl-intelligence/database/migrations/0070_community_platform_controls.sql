-- Shared across workers and sources; reservations commit BEFORE network I/O.
-- Defaults are conservative operational limits, not measured platform permissions.
CREATE TABLE community_platform_controls (
  platform text PRIMARY KEY CHECK (platform IN ('hupu','weibo','bilibili')),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  window_ms integer NOT NULL DEFAULT 3600000 CHECK (window_ms BETWEEN 1000 AND 86400000),
  request_limit integer NOT NULL DEFAULT 120 CHECK (request_limit BETWEEN 0 AND 10000),
  requests_reserved integer NOT NULL DEFAULT 0 CHECK (requests_reserved >= 0),
  min_interval_ms integer NOT NULL DEFAULT 1000 CHECK (min_interval_ms BETWEEN 0 AND 3600000),
  backoff_base_ms integer NOT NULL DEFAULT 60000 CHECK (backoff_base_ms BETWEEN 1000 AND 3600000),
  backoff_max_ms integer NOT NULL DEFAULT 86400000 CHECK (backoff_max_ms BETWEEN 1000 AND 86400000),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  next_allowed_at timestamptz NOT NULL DEFAULT now(),
  last_request_id uuid,
  lease_until timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

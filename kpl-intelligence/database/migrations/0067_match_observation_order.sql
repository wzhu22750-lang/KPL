-- Monotonic observation order, not monotonic scores: newer corrections may lower a score.
ALTER TABLE matches ADD COLUMN score_observed_at timestamptz;
ALTER TABLE matches DROP CONSTRAINT matches_status_check;
ALTER TABLE matches ADD CONSTRAINT matches_status_check CHECK (status IN ('scheduled','live','finished','cancelled','postponed'));

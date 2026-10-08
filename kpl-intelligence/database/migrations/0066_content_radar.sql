-- Additive content curation projection; existing analyses, facts and text licensing stay intact.
CREATE TABLE radar_topics (
  id bigserial PRIMARY KEY,
  topic_key text NOT NULL,
  title text NOT NULL,
  last_development_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX radar_topics_key_idx ON radar_topics(topic_key, last_development_at DESC);
CREATE TABLE radar_materials (
  article_id text PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  input_revision integer NOT NULL,
  state text NOT NULL CHECK (state IN ('accepted','rejected','review')),
  kind text NOT NULL CHECK (kind IN ('official','match','controversy','analysis','fun','activity')),
  title text NOT NULL,
  summary text NOT NULL,
  claim_status text NOT NULL CHECK (claim_status IN ('fact','opinion','rumor','joke')),
  stance text,
  evidence jsonb NOT NULL DEFAULT '[]',
  judgment jsonb NOT NULL,
  base_score integer NOT NULL,
  official_bonus integer NOT NULL,
  noise integer NOT NULL,
  score_version text NOT NULL,
  reason text NOT NULL,
  topic_id bigint REFERENCES radar_topics(id) ON DELETE SET NULL,
  match_id text REFERENCES matches(id) ON DELETE SET NULL,
  game_no integer CHECK (game_no BETWEEN 1 AND 9),
  association_evidence text,
  receipt_id bigint REFERENCES receipts(id),
  evaluated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX radar_materials_topic_idx ON radar_materials(topic_id, evaluated_at DESC);
CREATE INDEX radar_materials_match_idx ON radar_materials(match_id, game_no);
CREATE TABLE radar_failures (
  article_id text PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  input_revision integer NOT NULL,
  error text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

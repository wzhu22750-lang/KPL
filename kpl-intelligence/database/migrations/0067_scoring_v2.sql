-- P3 争议话题与新评分（v2）：stories 加话题类型/立场/争议状态；analyses/publications 加公式版本与分量。
-- 旧数据的 score_formula_version 默认为 'v1'；新评分写 'v2'。不重算旧分。

ALTER TABLE stories ADD COLUMN IF NOT EXISTS topic_kind text NOT NULL DEFAULT 'general'
  CHECK (topic_kind IN ('general', 'dispute', 'fun'));
ALTER TABLE stories ADD COLUMN IF NOT EXISTS positions jsonb;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS dispute_status text
  CHECK (dispute_status IN ('ongoing', 'responded', 'clarified', 'settled'));

ALTER TABLE analyses ADD COLUMN IF NOT EXISTS score_formula_version text NOT NULL DEFAULT 'v1';
ALTER TABLE analyses ADD COLUMN IF NOT EXISTS score_components jsonb;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS score_formula_version text NOT NULL DEFAULT 'v1';
ALTER TABLE publications ADD COLUMN IF NOT EXISTS score_components jsonb;

-- positions: NULL=尚未跑争议抽取；[]=已抽取但无争议（general）；非空=争议/趣评的立场结构。
-- [{stance, holders, evidence, source}]，见 packages/backend/src/events/dispute.ts
CREATE INDEX IF NOT EXISTS stories_topic_kind_idx ON stories (topic_kind) WHERE merged_into IS NULL;

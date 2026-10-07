-- 内容智能管道（Multi-source Content Intelligence Pipeline）：
-- 1) articles 增加 CanonicalContent 中间层的落点——content_kind / 质量分 / 完整度 /
--    抽取元数据（来源层级、extractor、版本、fallback、警告）/ canonical 结构化 JSON；
-- 2) body_text / body_html 继续保留：canonical 是真源之一，二者是它的派生产物（兼容旧读取方）；
-- 3) 质量评估输入带 contentKind + sourceFamily（不同来源不用同一把尺子）。

ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_kind text;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_quality_score int;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_completeness text
  CHECK (content_completeness IN ('full', 'partial', 'summary_only', 'failed'));
ALTER TABLE articles ADD COLUMN IF NOT EXISTS content_extraction_meta jsonb;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS canonical_content jsonb;

CREATE INDEX IF NOT EXISTS articles_content_kind_idx ON articles (content_kind)
  WHERE content_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS articles_content_completeness_idx ON articles (content_completeness)
  WHERE content_completeness IS NOT NULL;
CREATE INDEX IF NOT EXISTS articles_content_quality_idx ON articles (content_quality_score)
  WHERE content_quality_score IS NOT NULL;

-- Add input_evidence_hash to radar_materials to prevent stale safety judgments
-- when community comments refresh without incrementing article revision.
ALTER TABLE radar_materials ADD COLUMN input_evidence_hash text;

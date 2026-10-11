-- Backend-only operational state. Supabase defaults can grant new public tables to API roles.
-- No public policies: site readers use the publication API, never these tables directly.
ALTER TABLE community_collection_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_platform_controls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE community_collection_runs, community_platform_controls FROM PUBLIC;
REVOKE ALL ON SEQUENCE community_collection_runs_id_seq FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE community_collection_runs, community_platform_controls FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON SEQUENCE community_collection_runs_id_seq FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

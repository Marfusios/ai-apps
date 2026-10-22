-- Least-privilege grants. scripts/pg-setup.sql gives both runtime roles SELECT on
-- new tables and sequences by default; DML is granted here explicitly.
--
-- aviation_ingest loads generations: it inserts and (when pruning) deletes corpus
-- rows but never updates them, so section revisions and every other corpus row stay
-- immutable (amendment A6). It updates only the control tables (run status,
-- generation status, manifest activation). aviation_app reads everything and
-- writes nothing here.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "ingestion_runs", "dataset_generations", "dataset_manifests"
  TO aviation_ingest;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE
  "cases", "case_aircraft", "case_engines", "case_findings", "case_sequence",
  "case_sections", "case_section_sources", "code_dictionary", "quarantine"
  TO aviation_ingest;
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  "cases", "case_aircraft", "case_engines", "case_findings", "case_sequence",
  "case_sections", "case_section_sources", "code_dictionary", "quarantine"
  FROM aviation_ingest;
--> statement-breakpoint
-- MAINTAIN (PostgreSQL 17+) let the loader ANALYZE a generation right after loading
-- it. Migration 0003 revokes it again in favour of analyze_corpus(), which works on 16.
DO $$
BEGIN
  -- MAINTAIN exists from PostgreSQL 17 on; the shared server runs 16.
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'GRANT MAINTAIN ON TABLE "ingestion_runs", "dataset_generations", "dataset_manifests", "cases", "case_aircraft", "case_engines", "case_findings", "case_sequence", "case_sections", "case_section_sources", "code_dictionary", "quarantine" TO aviation_ingest';
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE "ingestion_runs_id_seq", "dataset_generations_id_seq" TO aviation_ingest;
--> statement-breakpoint
GRANT SELECT ON TABLE
  "ingestion_runs", "dataset_generations", "dataset_manifests",
  "cases", "case_aircraft", "case_engines", "case_findings", "case_sequence",
  "case_sections", "case_section_sources", "code_dictionary", "quarantine"
  TO aviation_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  "ingestion_runs", "dataset_generations", "dataset_manifests",
  "cases", "case_aircraft", "case_engines", "case_findings", "case_sequence",
  "case_sections", "case_section_sources", "code_dictionary", "quarantine"
  FROM aviation_app;
--> statement-breakpoint
DO $$
BEGIN
  -- MAINTAIN exists from PostgreSQL 17 on; the shared server runs 16.
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON TABLE "ingestion_runs", "dataset_generations", "dataset_manifests", "cases", "case_aircraft", "case_engines", "case_findings", "case_sequence", "case_sections", "case_section_sources", "code_dictionary", "quarantine" FROM aviation_app';
  END IF;
END $$;

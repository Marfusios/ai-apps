CREATE TABLE "report_links" (
	"ntsb_no" text NOT NULL,
	"aircraft_ntsb_no" text,
	"report_id" text NOT NULL,
	"source" text NOT NULL,
	"source_file_sha256" text NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_links_uq" UNIQUE NULLS NOT DISTINCT("ntsb_no","aircraft_ntsb_no","report_id"),
	CONSTRAINT "report_links_report_id_check" CHECK ("report_links"."report_id" ~ '^[0-9]{1,9}$'),
	CONSTRAINT "report_links_sha_check" CHECK ("report_links"."source_file_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "report_links_ntsb_no_idx" ON "report_links" USING btree ("ntsb_no");--> statement-breakpoint
-- External mapping data: ingest inserts and replaces rows, the app only reads.
GRANT SELECT, INSERT, DELETE ON TABLE "report_links" TO aviation_ingest;
--> statement-breakpoint
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "report_links" FROM aviation_ingest;
--> statement-breakpoint
GRANT SELECT ON TABLE "report_links" TO aviation_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE "report_links" FROM aviation_app;

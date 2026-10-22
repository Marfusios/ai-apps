-- Index builds and alias switches (Task 7, gate G3 fix round 2): see server/db/schema/search.ts.
CREATE TABLE "index_publications" (
	"index_name" text PRIMARY KEY NOT NULL,
	"alias" text NOT NULL,
	"build_id" text NOT NULL,
	"generation_id" bigint,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "index_publications_build_unique" UNIQUE("build_id"),
	CONSTRAINT "index_publications_status_check" CHECK ("index_publications"."status" in ('building', 'switching', 'committed', 'unknown', 'abandoned')),
	CONSTRAINT "index_publications_deleted_check" CHECK ("index_publications"."deleted_at" is null or "index_publications"."status" = 'abandoned'),
	CONSTRAINT "index_publications_names_check" CHECK ("index_publications"."index_name" ~ '^[a-z0-9][a-z0-9._-]{0,254}$' and "index_publications"."alias" ~ '^[a-z0-9][a-z0-9._-]{0,254}$')
);
--> statement-breakpoint
CREATE INDEX "index_publications_alias_idx" ON "index_publications" USING btree ("alias","status");--> statement-breakpoint
-- Workers record index builds and alias switches; rows are never deleted (audit
-- trail). The API role only reads (default privileges grant SELECT).
GRANT SELECT, INSERT, UPDATE ON TABLE "index_publications" TO aviation_ingest;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE "index_publications" FROM aviation_ingest;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE "index_publications" FROM aviation_app;

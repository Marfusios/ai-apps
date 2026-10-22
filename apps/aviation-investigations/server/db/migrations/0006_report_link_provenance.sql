ALTER TABLE "report_links" ADD COLUMN "source_label" text;--> statement-breakpoint
ALTER TABLE "report_links" ADD COLUMN "mapping" jsonb;--> statement-breakpoint
UPDATE "report_links" SET "source_label" = CASE WHEN "source" = 'seed' THEN 'manual verification 2026-10-16' ELSE 'aviation search export ' || left("source_file_sha256", 12) END;--> statement-breakpoint
ALTER TABLE "report_links" ALTER COLUMN "source_label" SET NOT NULL;

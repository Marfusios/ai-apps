-- Task 16, after the first paid end-to-end run: a withheld step keeps its rejected
-- composition, with what the validator and checker saw, for developers
-- (`pnpm worker brief-diagnose`). It is model output about public NTSB passages; the
-- question stays in `request`. No route selects it. It shares the step's row, so the
-- 0014 guard keeps it immutable once the step is finished, aviation_ingest cannot read
-- it, and `prune_controls()` deletes it with its brief after the 24-hour expiry.
ALTER TABLE "brief_steps" ADD COLUMN "diagnostics" jsonb;--> statement-breakpoint
-- Written once, together with the step's final state (`finishStep`).
GRANT UPDATE ("diagnostics") ON TABLE "brief_steps" TO aviation_app;

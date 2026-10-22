-- Task 16, gate G6: a brief step can end with the answer model's explicit abstention
-- (`no_match`, stage `done`). Only the two CHECK constraints change; grants, guards and
-- retention from 0014 are unaffected.
ALTER TABLE "brief_steps" DROP CONSTRAINT "brief_steps_status_check";--> statement-breakpoint
ALTER TABLE "brief_steps" DROP CONSTRAINT "brief_steps_state_check";--> statement-breakpoint
ALTER TABLE "brief_steps" ADD CONSTRAINT "brief_steps_status_check" CHECK ("brief_steps"."status" in ('running', 'answered', 'no_match', 'withheld', 'scope_reply', 'no_results', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "brief_steps" ADD CONSTRAINT "brief_steps_state_check" CHECK (("brief_steps"."status" = 'running') = ("brief_steps"."stage" in ('scope', 'retrieve', 'compose', 'validate'))
        and ("brief_steps"."stage" <> 'done' or "brief_steps"."status" in ('answered', 'no_match', 'withheld', 'scope_reply', 'no_results'))
        and ("brief_steps"."stage" <> 'failed' or "brief_steps"."status" in ('failed', 'cancelled'))
        and ("brief_steps"."status" = 'running') = ("brief_steps"."finished_at" is null)
        and ("brief_steps"."status" = 'running' or "brief_steps"."result" is not null));
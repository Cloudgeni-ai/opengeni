-- deployment-mode: rolling
-- Retain content-free evidence from the runner's latest update idle proof.
ALTER TABLE "enrollments" ADD COLUMN "agent_update_blockers" jsonb NOT NULL DEFAULT '[]'::jsonb;

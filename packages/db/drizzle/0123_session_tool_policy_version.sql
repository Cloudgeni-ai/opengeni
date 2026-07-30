-- deployment-mode: rolling

-- A durable policy mutation is fenced independently from the global event
-- sequence. The default keeps old writers safe during the rolling upgrade;
-- the policy update command advances this value with a locked SQL CAS.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "tool_policy_version" integer NOT NULL DEFAULT 1;

ALTER TABLE "sessions"
  DROP CONSTRAINT IF EXISTS "sessions_tool_policy_version_check";

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_tool_policy_version_check"
  CHECK ("tool_policy_version" >= 1) NOT VALID;
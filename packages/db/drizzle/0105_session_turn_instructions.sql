-- deployment-mode: rolling
-- Durable, invisible host context for one exact turn. This is intentionally
-- separate from the user prompt and session-wide persona instructions.

ALTER TABLE "session_turns"
  ADD COLUMN IF NOT EXISTS "turn_instructions" text;

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "initial_turn_instructions" text;

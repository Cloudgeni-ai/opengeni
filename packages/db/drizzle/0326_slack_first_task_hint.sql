-- deployment-mode: rolling
-- Slack first-task onboarding hint. The bot's acknowledgement used to repeat
-- the same how-to prose on every accepted task. The prose now appears exactly
-- once per Slack identity per installation, and this column is the durable
-- claim that makes "exactly once" survive retries, replicas, and restarts.
--
-- The claimed value is the exact `slack_interactions` id that won the hint, not
-- a boolean, so a replayed acknowledgement for that same interaction keeps
-- rendering the hint while every later interaction never does.
--
-- Rolling: one nullable column with no default and no backfill. Existing rows
-- are untouched (NULL means "not shown yet"), so an old image that never reads
-- or writes the column keeps working, and the FORCE-RLS posture of
-- `slack_bot_user_links` is unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "slack_bot_user_links"
  ADD COLUMN "first_task_hint_interaction_id" uuid;

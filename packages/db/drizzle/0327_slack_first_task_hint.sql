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
-- Rolling: two nullable columns, no defaults, no backfill. Existing rows are
-- untouched (NULL means "not shown yet" / "not resolved yet"), so an old image
-- that never reads or writes either column keeps working, and the FORCE-RLS
-- posture of `slack_bot_user_links` and `slack_interactions` is unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "slack_bot_user_links"
  ADD COLUMN "first_task_hint_interaction_id" uuid;

-- The rendered decision is frozen on the interaction itself, not recomputed per
-- delivery. `slack_bot_post_operations` binds one operation id to one request
-- digest that includes the message text, so an acknowledgement replayed after a
-- crash, a lost provider response, or a replica race must re-render byte for
-- byte. NULL means "not resolved yet"; once written the value never changes, so
-- rendering is a pure function of durable state even if the identity is later
-- unlinked and relinked.
ALTER TABLE "slack_interactions"
  ADD COLUMN "first_task_hint" boolean;

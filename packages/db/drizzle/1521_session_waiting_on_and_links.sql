-- deployment-mode: rolling
-- Who a chat waits on (set by the agent's set_waiting_on tool) and the things
-- it works on (its Linked panel). Both are nullable and default to NULL, so
-- adding them rewrites no rows and the previous release, which never reads
-- them, keeps working. NULL means "not waiting" and "no links".
-- slack_interactions.delivery_reopen_after_sequence marks a Slack thread
-- delivery that a wake asked to reopen while it was still open: a pass that
-- settles a run ending at or before that sequence stays open for the woken
-- answer. Nullable, so the previous release, which never sets or reads it,
-- is unaffected.
SET LOCAL lock_timeout = '5s';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS waiting_on jsonb;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS links jsonb;
ALTER TABLE slack_interactions ADD COLUMN IF NOT EXISTS delivery_reopen_after_sequence integer;

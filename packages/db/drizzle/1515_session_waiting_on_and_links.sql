-- deployment-mode: rolling
-- Who a chat waits on (set by the agent's set_waiting_on tool) and the things
-- it works on (its Linked panel). Both are nullable and default to NULL, so
-- adding them rewrites no rows and the previous release, which never reads
-- them, keeps working. NULL means "not waiting" and "no links".
SET LOCAL lock_timeout = '5s';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS waiting_on jsonb;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS links jsonb;

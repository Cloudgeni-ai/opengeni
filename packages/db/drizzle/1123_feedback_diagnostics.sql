-- deployment-mode: rolling
-- What the server knew when a feedback report arrived: its own version and,
-- when the report names the chat in view and the author can read it, that
-- chat's state and latest turn. Written once by the API with the report and
-- never shown to clients. The previous release never sets the column and
-- reads rows without it.
SET LOCAL lock_timeout = '5s';
ALTER TABLE feedback_submissions ADD COLUMN IF NOT EXISTS diagnostics jsonb;

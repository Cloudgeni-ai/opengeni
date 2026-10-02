-- deployment-mode: rolling
-- Slack acknowledgement "Using" line. A session started from Slack now takes
-- its connectors, repositories and Sandbox Environment from workspace defaults
-- rather than from the person's last website composer selection, and the
-- acknowledgement says in one line what the session started with.
--
-- The line is frozen on the interaction when the session binds, never looked
-- up at post time. `slack_bot_post_operations` binds one operation id to one
-- request digest over the rendered text, and a session's tools and resources
-- can change after creation, so an acknowledgement replayed after a crash, a
-- lost provider response, or a replica race must re-render byte for byte.
--
-- Rolling: one nullable column, no default, no backfill. Existing rows keep
-- NULL, which renders no line, so an older image that never reads or writes
-- the column keeps working and the FORCE-RLS posture of `slack_interactions`
-- is unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "slack_interactions"
  ADD COLUMN "session_defaults_line" text;

ALTER TABLE "slack_interactions"
  ADD CONSTRAINT "slack_interactions_session_defaults_line_check"
  CHECK (
    "session_defaults_line" IS NULL
    OR octet_length("session_defaults_line") BETWEEN 1 AND 1024
  ) NOT VALID;

ALTER TABLE "slack_interactions"
  VALIDATE CONSTRAINT "slack_interactions_session_defaults_line_check";

-- deployment-mode: rolling
-- Compact Slack task messages. A new Slack task's first message is one
-- sentence that links to the session ("OpenGeni started this task", plus the
-- routed workspace inline), carries a single Stop button while the task runs,
-- and no later message in the thread repeats the workspace.
--
-- The sentence is frozen on the interaction when the session binds, never
-- rendered at post time. `slack_bot_post_operations` and the `chat.update`
-- ledger bind one operation id to one request digest over the rendered bytes,
-- and the first message is re-rendered on every acknowledgement repair, on
-- every Stop or Resume click, and once more when the task settles, so each of
-- those must reproduce it byte for byte even if the web base URL or the
-- workspace name changes later.
--
-- The column is also the format discriminator: NULL means the interaction was
-- bound before this change (or by an older image during a rolling deploy) and
-- keeps rendering the previous messages exactly, including the Status button,
-- the task controls card, and the per-message workspace line.
--
-- Rolling: one nullable column, no default, no backfill. Existing rows keep
-- NULL, so an older image that never reads or writes the column keeps working
-- and the FORCE-RLS posture of `slack_interactions` is unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "slack_interactions"
  ADD COLUMN "start_message_line" text;

ALTER TABLE "slack_interactions"
  ADD CONSTRAINT "slack_interactions_start_message_line_check"
  CHECK (
    "start_message_line" IS NULL
    OR octet_length("start_message_line") BETWEEN 1 AND 2048
  ) NOT VALID;

ALTER TABLE "slack_interactions"
  VALIDATE CONSTRAINT "slack_interactions_start_message_line_check";

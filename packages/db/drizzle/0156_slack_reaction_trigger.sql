-- deployment-mode: rolling
-- Admit the optional Slack emoji-reaction summon source into the existing
-- durable interaction inbox. Older writers use only the existing subset, so
-- this CHECK expansion is mixed-version compatible.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "slack_interaction_inbox"
  DROP CONSTRAINT "slack_interaction_inbox_trigger_check";

ALTER TABLE "slack_interaction_inbox"
  ADD CONSTRAINT "slack_interaction_inbox_trigger_check"
  CHECK (
    "trigger_kind" IN (
      'app_mention',
      'dm',
      'reaction',
      'slash_command',
      'message_shortcut',
      'thread_reply'
    )
  ) NOT VALID;

ALTER TABLE "slack_interaction_inbox"
  VALIDATE CONSTRAINT "slack_interaction_inbox_trigger_check";

-- A rate-limited conversations.replies traversal must resume at the exact next
-- cursor instead of consuming the next one-request-per-minute allowance by
-- refetching page one. The payload is application-authenticated and bounded;
-- this database constraint additionally prevents terminal/non-reaction rows
-- from retaining checkpoint material.
ALTER TABLE "slack_interaction_inbox"
  ADD COLUMN "reaction_context_checkpoint" jsonb;

ALTER TABLE "slack_interaction_inbox"
  ADD CONSTRAINT "slack_interaction_inbox_reaction_checkpoint_check"
  CHECK (
    "reaction_context_checkpoint" IS NULL
    OR (
      "trigger_kind" = 'reaction'
      AND "status" IN ('pending', 'processing')
      AND jsonb_typeof("reaction_context_checkpoint") = 'object'
      AND octet_length("reaction_context_checkpoint"::text) <= 131072
    )
  ) NOT VALID;

ALTER TABLE "slack_interaction_inbox"
  VALIDATE CONSTRAINT "slack_interaction_inbox_reaction_checkpoint_check";

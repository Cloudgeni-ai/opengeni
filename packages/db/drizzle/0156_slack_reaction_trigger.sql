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
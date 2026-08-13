-- deployment-mode: rolling
-- Preserve the signed Slack event's bounded file-presence fact through the
-- durable inbox so mixed-text DMs and existing-thread replies fetch only their
-- exact provider message before importing authorized images.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "slack_interaction_inbox"
  ADD COLUMN "has_files" boolean NOT NULL DEFAULT false;

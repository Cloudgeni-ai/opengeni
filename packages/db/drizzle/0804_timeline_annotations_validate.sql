-- deployment-mode: rolling
-- Validate the widened annotation checks from 0803 in their own transaction:
-- VALIDATE scans under SHARE UPDATE EXCLUSIVE, so writers keep going. Every
-- row already satisfied the stricter 0190 checks, so this cannot fail.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '0';

ALTER TABLE "composer_drafts"
  VALIDATE CONSTRAINT "composer_drafts_annotations_check";

ALTER TABLE "session_turns"
  VALIDATE CONSTRAINT "session_turns_annotations_check";

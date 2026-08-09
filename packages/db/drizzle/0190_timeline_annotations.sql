-- deployment-mode: rolling
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "composer_drafts"
  ADD COLUMN "annotations" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "session_turns"
  ADD COLUMN "annotations" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "composer_drafts"
  ADD CONSTRAINT "composer_drafts_annotations_check"
  CHECK (
    jsonb_typeof("annotations") = 'array'
    AND jsonb_array_length("annotations") <= 12
    AND octet_length("annotations"::text) <= 65536
  ) NOT VALID;

ALTER TABLE "session_turns"
  ADD CONSTRAINT "session_turns_annotations_check"
  CHECK (
    jsonb_typeof("annotations") = 'array'
    AND jsonb_array_length("annotations") <= 12
    AND octet_length("annotations"::text) <= 65536
  ) NOT VALID;

ALTER TABLE "composer_drafts"
  VALIDATE CONSTRAINT "composer_drafts_annotations_check";

ALTER TABLE "session_turns"
  VALIDATE CONSTRAINT "session_turns_annotations_check";
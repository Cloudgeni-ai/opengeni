-- deployment-mode: rolling
-- A message may carry any number of timeline annotations. 0190 capped them at
-- 12 per message and 64 KiB in total; the count cap had no purpose beyond the
-- size bound, so it goes, and the total bound rises to 1 MiB, the same order
-- as a message's own text bound.
--
-- Both checks only widen: every existing row already satisfies them. The
-- previous release parses stored annotations with its old 12-item contract, so
-- it can only trip over a row with more than 12, which only the new composer
-- can write; such a row is possible solely during the rollout window.
--
-- Each migration file is one transaction, so the constraints are replaced NOT
-- VALID here (a catalog-only change under a brief lock) and validated in 0804,
-- whose scan holds only SHARE UPDATE EXCLUSIVE and does not block writers.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "composer_drafts"
  DROP CONSTRAINT IF EXISTS "composer_drafts_annotations_check";
ALTER TABLE "composer_drafts"
  ADD CONSTRAINT "composer_drafts_annotations_check"
  CHECK (
    jsonb_typeof("annotations") = 'array'
    AND octet_length("annotations"::text) <= 1048576
  ) NOT VALID;

ALTER TABLE "session_turns"
  DROP CONSTRAINT IF EXISTS "session_turns_annotations_check";
ALTER TABLE "session_turns"
  ADD CONSTRAINT "session_turns_annotations_check"
  CHECK (
    jsonb_typeof("annotations") = 'array'
    AND octet_length("annotations"::text) <= 1048576
  ) NOT VALID;

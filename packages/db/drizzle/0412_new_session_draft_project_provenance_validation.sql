-- deployment-mode: rolling
-- Validate in a fresh transaction after the separately committed backfill, so
-- the validation scan never inherits an ACCESS EXCLUSIVE lock from column,
-- constraint, trigger, or policy DDL.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

DO $validation$
BEGIN
  PERFORM pg_catalog.set_config(
    'opengeni.new_session_draft_project_provenance_backfill_v1',
    '1',
    true
  );
  IF EXISTS (
    SELECT 1
    FROM new_session_drafts draft
    WHERE draft.session_options ? 'selectedProjectChannelId'
    LIMIT 1
  ) THEN
    RAISE EXCEPTION
      'new-session draft project provenance validation found an unbackfilled legacy key'
      USING ERRCODE = '55000';
  END IF;
END
$validation$;

ALTER TABLE "new_session_drafts"
  VALIDATE CONSTRAINT "new_session_drafts_project_provenance_check";

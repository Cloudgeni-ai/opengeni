-- deployment-mode: rolling
-- Move new-session project provenance out of the public session_options JSONB
-- extension point. Old Drizzle binaries neither select nor overwrite the new
-- columns, while the trigger prevents a stale old write from reintroducing the
-- short-lived JSON key that breaks old exact-create comparisons.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "new_session_drafts"
  ADD COLUMN IF NOT EXISTS "selected_project_channel_id" uuid,
  ADD COLUMN IF NOT EXISTS "selected_project_compute_snapshot" jsonb;

-- The production migration identity owns this FORCE-RLS table but is neither a
-- superuser nor BYPASSRLS. Relax FORCE only for the owner backfill; ordinary
-- application roles remain policy-bound, and the migration transaction restores
-- the posture if any later statement fails.
ALTER TABLE "new_session_drafts" NO FORCE ROW LEVEL SECURITY;

UPDATE "new_session_drafts"
SET
  "selected_project_channel_id" = CASE
    WHEN jsonb_typeof("session_options" -> 'selectedProjectChannelId') = 'string'
      AND ("session_options" ->> 'selectedProjectChannelId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN ("session_options" ->> 'selectedProjectChannelId')::uuid
    ELSE NULL
  END,
  "selected_project_compute_snapshot" = CASE
    WHEN jsonb_typeof("session_options" -> 'selectedProjectChannelId') = 'null'
      OR (
        jsonb_typeof("session_options" -> 'selectedProjectChannelId') = 'string'
        AND ("session_options" ->> 'selectedProjectChannelId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
    THEN
      CASE WHEN "session_options" ? 'sandboxBackend'
        THEN jsonb_build_object('sandboxBackend', "session_options" -> 'sandboxBackend')
        ELSE '{}'::jsonb END
      || CASE WHEN "session_options" ? 'targetSandboxId'
        THEN jsonb_build_object('targetSandboxId', "session_options" -> 'targetSandboxId')
        ELSE '{}'::jsonb END
      || CASE WHEN "session_options" ? 'workingDir'
        THEN jsonb_build_object('workingDir', "session_options" -> 'workingDir')
        ELSE '{}'::jsonb END
    ELSE NULL
  END,
  "session_options" = "session_options" - 'selectedProjectChannelId'
WHERE "session_options" ? 'selectedProjectChannelId';

ALTER TABLE "new_session_drafts" FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION opengeni_private.strip_new_session_draft_project_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW."session_options" := NEW."session_options" - 'selectedProjectChannelId';
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS new_session_drafts_strip_project_provenance
  ON "new_session_drafts";
CREATE TRIGGER new_session_drafts_strip_project_provenance
BEFORE INSERT OR UPDATE OF "session_options" ON "new_session_drafts"
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.strip_new_session_draft_project_provenance();

ALTER TABLE "new_session_drafts"
  DROP CONSTRAINT IF EXISTS "new_session_drafts_project_provenance_check";
ALTER TABLE "new_session_drafts"
  ADD CONSTRAINT "new_session_drafts_project_provenance_check" CHECK (
    (
      "selected_project_compute_snapshot" IS NULL
      AND "selected_project_channel_id" IS NULL
    )
    OR jsonb_typeof("selected_project_compute_snapshot") = 'object'
  ) NOT VALID;
ALTER TABLE "new_session_drafts"
  VALIDATE CONSTRAINT "new_session_drafts_project_provenance_check";
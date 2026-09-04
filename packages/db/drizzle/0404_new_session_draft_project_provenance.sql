-- deployment-mode: rolling
-- Fence legacy draft provenance before the separately committed index and
-- batched backfill. Every operation in this phase is metadata-only: no draft
-- rows are scanned, updated, or constraint-validated while its short DDL locks
-- are held.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "new_session_drafts"
  ADD COLUMN IF NOT EXISTS "selected_project_channel_id" uuid,
  ADD COLUMN IF NOT EXISTS "selected_project_compute_snapshot" jsonb;

ALTER TABLE "new_session_drafts"
  ADD CONSTRAINT "new_session_drafts_project_provenance_check" CHECK (
    (
      "selected_project_compute_snapshot" IS NULL
      AND "selected_project_channel_id" IS NULL
    )
    OR jsonb_typeof("selected_project_compute_snapshot") = 'object'
  ) NOT VALID;

-- FORCE RLS binds the non-superuser table owner used by production migrations.
-- This persistent policy opens only an exact owner + transaction-local
-- capability seam for the bounded backfill and final empty probe. An
-- application role can set the custom GUC too, but can never satisfy the owner
-- half of either policy arm.
DROP POLICY IF EXISTS new_session_drafts_project_provenance_backfill_v1
  ON "new_session_drafts";
CREATE POLICY new_session_drafts_project_provenance_backfill_v1
ON "new_session_drafts"
FOR ALL
USING (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'new_session_drafts'::regclass
  )
  AND pg_catalog.current_setting(
    'opengeni.new_session_draft_project_provenance_backfill_v1',
    true
  ) = '1'
)
WITH CHECK (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'new_session_drafts'::regclass
  )
  AND pg_catalog.current_setting(
    'opengeni.new_session_draft_project_provenance_backfill_v1',
    true
  ) = '1'
);

CREATE OR REPLACE FUNCTION opengeni_private.fence_new_session_draft_project_provenance_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  project_channel_is_valid boolean;
  old_compute_snapshot jsonb;
  new_compute_snapshot jsonb;
  provenance_was_replaced boolean;
BEGIN
  IF NEW."session_options" ? 'selectedProjectChannelId' THEN
    project_channel_is_valid :=
      jsonb_typeof(NEW."session_options" -> 'selectedProjectChannelId') = 'string'
      AND (NEW."session_options" ->> 'selectedProjectChannelId')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

    NEW."selected_project_channel_id" := CASE
      WHEN project_channel_is_valid
      THEN (NEW."session_options" ->> 'selectedProjectChannelId')::uuid
      ELSE NULL
    END;
    NEW."selected_project_compute_snapshot" := CASE
      WHEN jsonb_typeof(NEW."session_options" -> 'selectedProjectChannelId') = 'null'
        OR project_channel_is_valid
      THEN
        CASE WHEN NEW."session_options" ? 'sandboxBackend'
          THEN jsonb_build_object('sandboxBackend', NEW."session_options" -> 'sandboxBackend')
          ELSE '{}'::jsonb END
        || CASE WHEN NEW."session_options" ? 'targetSandboxId'
          THEN jsonb_build_object('targetSandboxId', NEW."session_options" -> 'targetSandboxId')
          ELSE '{}'::jsonb END
        || CASE WHEN NEW."session_options" ? 'workingDir'
          THEN jsonb_build_object('workingDir', NEW."session_options" -> 'workingDir')
          ELSE '{}'::jsonb END
      ELSE NULL
    END;
    NEW."session_options" := NEW."session_options" - 'selectedProjectChannelId';
  ELSIF TG_OP = 'UPDATE' THEN
    old_compute_snapshot :=
      CASE WHEN OLD."session_options" ? 'sandboxBackend'
        THEN jsonb_build_object('sandboxBackend', OLD."session_options" -> 'sandboxBackend')
        ELSE '{}'::jsonb END
      || CASE WHEN OLD."session_options" ? 'targetSandboxId'
        THEN jsonb_build_object('targetSandboxId', OLD."session_options" -> 'targetSandboxId')
        ELSE '{}'::jsonb END
      || CASE WHEN OLD."session_options" ? 'workingDir'
        THEN jsonb_build_object('workingDir', OLD."session_options" -> 'workingDir')
        ELSE '{}'::jsonb END;
    new_compute_snapshot :=
      CASE WHEN NEW."session_options" ? 'sandboxBackend'
        THEN jsonb_build_object('sandboxBackend', NEW."session_options" -> 'sandboxBackend')
        ELSE '{}'::jsonb END
      || CASE WHEN NEW."session_options" ? 'targetSandboxId'
        THEN jsonb_build_object('targetSandboxId', NEW."session_options" -> 'targetSandboxId')
        ELSE '{}'::jsonb END
      || CASE WHEN NEW."session_options" ? 'workingDir'
        THEN jsonb_build_object('workingDir', NEW."session_options" -> 'workingDir')
        ELSE '{}'::jsonb END;

    IF old_compute_snapshot IS DISTINCT FROM new_compute_snapshot THEN
      -- An old binary cannot name either additive column, so both arrive here
      -- byte-identical to OLD. A new binary replaces the pair and stamps the
      -- incoming compute snapshot in the same UPDATE. Require both pieces of
      -- evidence before retaining provenance: merely changing one stale column
      -- must not make a later compute ABA capable of revalidating it.
      provenance_was_replaced :=
        (
          NEW."selected_project_channel_id"
            IS DISTINCT FROM OLD."selected_project_channel_id"
          OR NEW."selected_project_compute_snapshot"
            IS DISTINCT FROM OLD."selected_project_compute_snapshot"
        )
        AND (
          (
            NEW."selected_project_channel_id" IS NULL
            AND NEW."selected_project_compute_snapshot" IS NULL
          )
          OR NEW."selected_project_compute_snapshot"
            IS NOT DISTINCT FROM new_compute_snapshot
        );

      IF NOT provenance_was_replaced THEN
        NEW."selected_project_channel_id" := NULL;
        NEW."selected_project_compute_snapshot" := NULL;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS new_session_drafts_project_provenance_v1_fence
  ON "new_session_drafts";
CREATE TRIGGER new_session_drafts_project_provenance_v1_fence
BEFORE INSERT OR UPDATE ON "new_session_drafts"
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.fence_new_session_draft_project_provenance_v1();

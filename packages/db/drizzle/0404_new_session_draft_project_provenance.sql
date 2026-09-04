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

DO $constraint$
DECLARE
  target_schema_name text := pg_catalog.current_schema();
  target_schema_oid oid;
  target_table_oid oid;
  existing_constraint record;
  expected_constraint record;
BEGIN
  IF target_schema_name IS NULL THEN
    RAISE EXCEPTION
      'new_session_drafts_project_provenance_check cannot resolve the target schema'
      USING ERRCODE = '55000';
  END IF;

  SELECT namespace.oid
  INTO STRICT target_schema_oid
  FROM pg_catalog.pg_namespace namespace
  WHERE namespace.nspname = target_schema_name;

  SELECT relation.oid
  INTO STRICT target_table_oid
  FROM pg_catalog.pg_class relation
  WHERE relation.relnamespace = target_schema_oid
    AND relation.relname = 'new_session_drafts'
    AND relation.relkind IN ('r', 'p');

  -- ADD CONSTRAINT takes ACCESS EXCLUSIVE too. Taking that same lock before the
  -- catalog probe closes the check/create race without widening the rolling
  -- migration's lock mode or lifetime.
  EXECUTE pg_catalog.format(
    'LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE',
    target_schema_name,
    'new_session_drafts'
  );

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.connamespace = target_schema_oid
      AND constraint_row.conrelid = target_table_oid
      AND constraint_row.conname = 'new_session_drafts_project_provenance_check'
  ) THEN
    EXECUTE pg_catalog.format(
      $ddl$
        ALTER TABLE %I.%I
          ADD CONSTRAINT %I CHECK (
            (
              "selected_project_compute_snapshot" IS NULL
              AND "selected_project_channel_id" IS NULL
            )
            OR jsonb_typeof("selected_project_compute_snapshot") = 'object'
          ) NOT VALID
      $ddl$,
      target_schema_name,
      'new_session_drafts',
      'new_session_drafts_project_provenance_check'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.connamespace = target_schema_oid
      AND constraint_row.conrelid = target_table_oid
      AND constraint_row.conname = 'new_session_drafts_project_provenance_expected_v1'
  ) THEN
    RAISE EXCEPTION
      'new_session_drafts_project_provenance_expected_v1 already exists on the target table'
      USING ERRCODE = '55000';
  END IF;

  -- Build the reviewed expression through PostgreSQL's own parser on the same
  -- table, then compare the canonical catalog representation. This avoids a
  -- formatting-sensitive text guard while refusing a same-name CHECK with
  -- weaker or otherwise different semantics. Validation state is deliberately
  -- excluded: 0404 creates NOT VALID and 0407 may already have validated it.
  EXECUTE pg_catalog.format(
    $ddl$
      ALTER TABLE %I.%I
        ADD CONSTRAINT %I CHECK (
          (
            "selected_project_compute_snapshot" IS NULL
            AND "selected_project_channel_id" IS NULL
          )
          OR jsonb_typeof("selected_project_compute_snapshot") = 'object'
        ) NOT VALID
    $ddl$,
    target_schema_name,
    'new_session_drafts',
    'new_session_drafts_project_provenance_expected_v1'
  );

  SELECT
    constraint_row.oid,
    constraint_row.contype,
    constraint_row.condeferrable,
    constraint_row.condeferred,
    constraint_row.conislocal,
    constraint_row.coninhcount,
    constraint_row.connoinherit,
    constraint_row.conparentid,
    constraint_row.conkey,
    pg_catalog.pg_get_expr(
      constraint_row.conbin,
      constraint_row.conrelid,
      false
    ) AS expression,
    pg_catalog.regexp_replace(
      pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
      ' NOT VALID$',
      ''
    ) AS canonical_definition
  INTO STRICT existing_constraint
  FROM pg_catalog.pg_constraint constraint_row
  WHERE constraint_row.connamespace = target_schema_oid
    AND constraint_row.conrelid = target_table_oid
    AND constraint_row.conname = 'new_session_drafts_project_provenance_check';

  SELECT
    constraint_row.oid,
    constraint_row.contype,
    constraint_row.condeferrable,
    constraint_row.condeferred,
    constraint_row.conislocal,
    constraint_row.coninhcount,
    constraint_row.connoinherit,
    constraint_row.conparentid,
    constraint_row.conkey,
    pg_catalog.pg_get_expr(
      constraint_row.conbin,
      constraint_row.conrelid,
      false
    ) AS expression,
    pg_catalog.regexp_replace(
      pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
      ' NOT VALID$',
      ''
    ) AS canonical_definition
  INTO STRICT expected_constraint
  FROM pg_catalog.pg_constraint constraint_row
  WHERE constraint_row.connamespace = target_schema_oid
    AND constraint_row.conrelid = target_table_oid
    AND constraint_row.conname = 'new_session_drafts_project_provenance_expected_v1';

  IF existing_constraint.contype IS DISTINCT FROM expected_constraint.contype
    OR existing_constraint.condeferrable IS DISTINCT FROM expected_constraint.condeferrable
    OR existing_constraint.condeferred IS DISTINCT FROM expected_constraint.condeferred
    OR existing_constraint.conislocal IS DISTINCT FROM expected_constraint.conislocal
    OR existing_constraint.coninhcount IS DISTINCT FROM expected_constraint.coninhcount
    OR existing_constraint.connoinherit IS DISTINCT FROM expected_constraint.connoinherit
    OR existing_constraint.conparentid IS DISTINCT FROM expected_constraint.conparentid
    OR existing_constraint.conkey IS DISTINCT FROM expected_constraint.conkey
    OR existing_constraint.expression IS DISTINCT FROM expected_constraint.expression
    OR existing_constraint.canonical_definition
      IS DISTINCT FROM expected_constraint.canonical_definition
  THEN
    RAISE EXCEPTION
      'new_session_drafts_project_provenance_check has an incompatible definition'
      USING
        ERRCODE = '55000',
        DETAIL = pg_catalog.format(
          'expected %s; found %s',
          pg_catalog.pg_get_constraintdef(expected_constraint.oid, false),
          pg_catalog.pg_get_constraintdef(existing_constraint.oid, false)
        );
  END IF;

  EXECUTE pg_catalog.format(
    'ALTER TABLE %I.%I DROP CONSTRAINT %I',
    target_schema_name,
    'new_session_drafts',
    'new_session_drafts_project_provenance_expected_v1'
  );
END
$constraint$;

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

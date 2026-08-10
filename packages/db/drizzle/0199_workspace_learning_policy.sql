-- deployment-mode: rolling
-- Add the versioned workspace learning-policy domain and accepted-attempt
-- snapshot service. This migration does not add a learning router, evaluator,
-- activation controller, prompt composition, command/tool surface, UI, or
-- connector-specific behavior. Existing Memory and memory_save paths remain
-- unchanged.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE SEQUENCE "workspace_learning_policy_revision_seq" AS bigint;

CREATE OR REPLACE FUNCTION workspace_learning_policy_source_overrides_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  entry jsonb;
  canonical jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array'
    OR jsonb_array_length(value) > 256
    OR octet_length(convert_to(value::text, 'UTF8')) > 65536
  THEN
    RETURN false;
  END IF;

  FOR entry IN SELECT item FROM jsonb_array_elements(value) AS entries(item) LOOP
    IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(entry)) <> 3
      OR NOT (entry ? 'kind' AND entry ? 'id' AND entry ? 'mode')
      OR jsonb_typeof(entry->'kind') IS DISTINCT FROM 'string'
      OR jsonb_typeof(entry->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(entry->'mode') IS DISTINCT FROM 'string'
      OR entry->>'kind' IS DISTINCT FROM lower(btrim(entry->>'kind'))
      OR length(entry->>'kind') NOT BETWEEN 1 AND 96
      OR entry->>'kind' !~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
      OR entry->>'id' IS DISTINCT FROM btrim(entry->>'id')
      OR length(entry->>'id') NOT BETWEEN 1 AND 1024
      OR entry->>'mode' NOT IN ('off', 'suggest', 'automatic')
    THEN
      RETURN false;
    END IF;
  END LOOP;

  IF (
    SELECT count(*)
    FROM (
      SELECT DISTINCT candidate->>'kind', candidate->>'id'
      FROM jsonb_array_elements(value) AS candidates(candidate)
    ) distinct_entries
  ) <> jsonb_array_length(value)
  THEN
    RETURN false;
  END IF;

  SELECT coalesce(
    jsonb_agg(candidate ORDER BY candidate->>'kind' COLLATE "C", candidate->>'id' COLLATE "C"),
    '[]'::jsonb
  ) INTO canonical
  FROM jsonb_array_elements(value) AS candidates(candidate);

  RETURN value = canonical;
END;
$$;

REVOKE ALL ON FUNCTION workspace_learning_policy_source_overrides_valid(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION workspace_learning_policy_hash(
  p_workspace_mode text,
  p_source_overrides jsonb
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(
    sha256(convert_to(
      jsonb_build_array(
        'workspace_learning_policy',
        1,
        p_workspace_mode,
        p_source_overrides
      )::text,
      'UTF8'
    )),
    'hex'
  );
$$;

REVOKE ALL ON FUNCTION workspace_learning_policy_hash(text, jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION workspace_learning_policy_snapshot_hash(
  p_revision_id uuid,
  p_revision bigint,
  p_policy_hash text,
  p_activation_version bigint,
  p_activated_at timestamptz,
  p_workspace_mode text,
  p_source_overrides jsonb
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(
    sha256(convert_to(
      jsonb_build_array(
        'workspace_learning_policy_snapshot',
        1,
        p_revision_id,
        p_revision,
        p_policy_hash,
        p_activation_version,
        CASE WHEN p_activated_at IS NULL THEN NULL ELSE to_char(
          p_activated_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) END,
        p_workspace_mode,
        p_source_overrides
      )::text,
      'UTF8'
    )),
    'hex'
  );
$$;

REVOKE ALL ON FUNCTION workspace_learning_policy_snapshot_hash(
  uuid, bigint, text, bigint, timestamptz, text, jsonb
) FROM PUBLIC;

CREATE TABLE "workspace_learning_policy_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "operation_id" uuid NOT NULL,
  "request_fingerprint" text NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "revision" bigint NOT NULL DEFAULT nextval('workspace_learning_policy_revision_seq'),
  "workspace_mode" text NOT NULL,
  "source_overrides" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "policy_hash" text NOT NULL,
  "supersedes_revision_id" uuid REFERENCES "workspace_learning_policy_revisions"("id") ON DELETE RESTRICT,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_learning_policy_revisions_revision_chk" CHECK ("revision" > 0),
  CONSTRAINT "workspace_learning_policy_revisions_mode_chk" CHECK (
    "workspace_mode" IN ('off', 'suggest', 'automatic')
  ),
  CONSTRAINT "workspace_learning_policy_revisions_overrides_chk" CHECK (
    workspace_learning_policy_source_overrides_valid("source_overrides")
  ),
  CONSTRAINT "workspace_learning_policy_revisions_hash_chk" CHECK (
    "policy_hash" ~ '^[0-9a-f]{64}$'
    AND "policy_hash" = workspace_learning_policy_hash("workspace_mode", "source_overrides")
  ),
  CONSTRAINT "workspace_learning_policy_revisions_operation_chk" CHECK (
    "request_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "workspace_learning_policy_revisions_actor_chk" CHECK (
    length(btrim("created_by_subject_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "workspace_learning_policy_revisions_workspace_operation_uq"
    UNIQUE ("workspace_id", "operation_id"),
  CONSTRAINT "workspace_learning_policy_revisions_workspace_revision_uq"
    UNIQUE ("workspace_id", "revision"),
  CONSTRAINT "workspace_learning_policy_revisions_workspace_identity_uq"
    UNIQUE ("account_id", "workspace_id", "id")
);

CREATE INDEX "workspace_learning_policy_revisions_workspace_history_idx"
  ON "workspace_learning_policy_revisions" ("workspace_id", "revision" DESC);

CREATE TABLE "workspace_learning_policy_heads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "revision_id" uuid NOT NULL,
  "revision" bigint NOT NULL,
  "policy_hash" text NOT NULL,
  "activation_version" bigint NOT NULL,
  "activated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_learning_policy_heads_revision_fk"
    FOREIGN KEY ("account_id", "workspace_id", "revision_id")
    REFERENCES "workspace_learning_policy_revisions"("account_id", "workspace_id", "id")
    ON DELETE RESTRICT,
  CONSTRAINT "workspace_learning_policy_heads_workspace_uq" UNIQUE ("workspace_id"),
  CONSTRAINT "workspace_learning_policy_heads_version_chk" CHECK (
    "revision" > 0
    AND "activation_version" > 0
    AND "policy_hash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "workspace_learning_policy_activation_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "operation_id" uuid NOT NULL,
  "request_fingerprint" text NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "activation_version" bigint NOT NULL,
  "old_revision_id" uuid,
  "old_revision" bigint,
  "old_policy_hash" text,
  "new_revision_id" uuid NOT NULL,
  "new_revision" bigint NOT NULL,
  "new_policy_hash" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_learning_policy_events_type_chk" CHECK (
    "type" IN ('activate', 'rollback')
  ),
  CONSTRAINT "workspace_learning_policy_events_old_revision_chk" CHECK (
    ("old_revision_id" IS NULL AND "old_revision" IS NULL AND "old_policy_hash" IS NULL)
    OR (
      "old_revision_id" IS NOT NULL
      AND "old_revision" > 0
      AND "old_policy_hash" ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT "workspace_learning_policy_events_new_revision_chk" CHECK (
    "new_revision" > 0
    AND "new_policy_hash" ~ '^[0-9a-f]{64}$'
    AND "activation_version" > 0
  ),
  CONSTRAINT "workspace_learning_policy_events_operation_chk" CHECK (
    "request_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "workspace_learning_policy_events_audit_chk" CHECK (
    length(btrim("actor_subject_id")) BETWEEN 1 AND 1024
    AND length(btrim("reason")) BETWEEN 1 AND 4096
  ),
  CONSTRAINT "workspace_learning_policy_events_workspace_operation_uq"
    UNIQUE ("workspace_id", "operation_id"),
  CONSTRAINT "workspace_learning_policy_events_workspace_version_uq"
    UNIQUE ("workspace_id", "activation_version")
);

CREATE INDEX "workspace_learning_policy_events_workspace_time_idx"
  ON "workspace_learning_policy_activation_events" ("workspace_id", "created_at" DESC, "id");

CREATE TABLE "workspace_learning_policy_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "turn_id" uuid NOT NULL REFERENCES "session_turns"("id") ON DELETE CASCADE,
  "attempt_id" uuid NOT NULL REFERENCES "session_turn_attempts"("id") ON DELETE CASCADE,
  "execution_generation" integer NOT NULL,
  "revision_id" uuid,
  "revision" bigint,
  "policy_hash" text,
  "activation_version" bigint NOT NULL,
  "activated_at" timestamptz,
  "workspace_mode" text NOT NULL,
  "source_overrides" jsonb NOT NULL,
  "snapshot_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_learning_policy_snapshots_generation_chk" CHECK (
    "execution_generation" > 0
  ),
  CONSTRAINT "workspace_learning_policy_snapshots_identity_chk" CHECK (
    (
      "revision_id" IS NULL
      AND "revision" IS NULL
      AND "policy_hash" IS NULL
      AND "activation_version" = 0
      AND "activated_at" IS NULL
      AND "workspace_mode" = 'off'
      AND "source_overrides" = '[]'::jsonb
    )
    OR (
      "revision_id" IS NOT NULL
      AND "revision" > 0
      AND "policy_hash" ~ '^[0-9a-f]{64}$'
      AND "activation_version" > 0
      AND "activated_at" IS NOT NULL
    )
  ),
  CONSTRAINT "workspace_learning_policy_snapshots_mode_chk" CHECK (
    "workspace_mode" IN ('off', 'suggest', 'automatic')
  ),
  CONSTRAINT "workspace_learning_policy_snapshots_overrides_chk" CHECK (
    workspace_learning_policy_source_overrides_valid("source_overrides")
  ),
  CONSTRAINT "workspace_learning_policy_snapshots_hash_chk" CHECK (
    "snapshot_hash" ~ '^[0-9a-f]{64}$'
    AND "snapshot_hash" = workspace_learning_policy_snapshot_hash(
      "revision_id",
      "revision",
      "policy_hash",
      "activation_version",
      "activated_at",
      "workspace_mode",
      "source_overrides"
    )
  ),
  CONSTRAINT "workspace_learning_policy_snapshots_attempt_uq"
    UNIQUE ("account_id", "workspace_id", "attempt_id")
);

CREATE INDEX "workspace_learning_policy_snapshots_workspace_time_idx"
  ON "workspace_learning_policy_snapshots" ("workspace_id", "created_at" DESC, "id");

CREATE OR REPLACE FUNCTION workspace_learning_policy_validate_revision_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."supersedes_revision_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "workspace_learning_policy_revisions" previous
    WHERE previous."id" = NEW."supersedes_revision_id"
      AND previous."account_id" = NEW."account_id"
      AND previous."workspace_id" = NEW."workspace_id"
  ) THEN
    RAISE EXCEPTION 'superseded learning-policy revision must belong to the exact workspace'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_learning_policy_revisions_validate_link
  BEFORE INSERT OR UPDATE ON "workspace_learning_policy_revisions"
  FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_validate_revision_link();

CREATE OR REPLACE FUNCTION workspace_learning_policy_validate_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "workspace_learning_policy_revisions" revision
    WHERE revision."id" = NEW."revision_id"
      AND revision."account_id" = NEW."account_id"
      AND revision."workspace_id" = NEW."workspace_id"
      AND revision."revision" = NEW."revision"
      AND revision."policy_hash" = NEW."policy_hash"
  ) THEN
    RAISE EXCEPTION 'learning-policy head must identify an exact immutable revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_learning_policy_heads_validate_revision
  BEFORE INSERT OR UPDATE ON "workspace_learning_policy_heads"
  FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_validate_head();

CREATE OR REPLACE FUNCTION workspace_learning_policy_guard_head_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lifecycle_workspace_id text;
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND NOT EXISTS (
      SELECT 1 FROM "workspaces" workspace WHERE workspace."id" = OLD."workspace_id"
    )
  THEN
    RETURN OLD;
  END IF;
  lifecycle_workspace_id := current_setting(
    'opengeni.workspace_learning_policy_lifecycle_workspace_id',
    true
  );
  IF lifecycle_workspace_id IS DISTINCT FROM coalesce(NEW."workspace_id", OLD."workspace_id")::text THEN
    RAISE EXCEPTION 'learning-policy heads change only through the lifecycle function'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."account_id" IS DISTINCT FROM OLD."account_id"
      OR NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id"
      OR NEW."activation_version" IS DISTINCT FROM OLD."activation_version" + 1
    THEN
      RAISE EXCEPTION 'invalid learning-policy head transition'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'learning-policy heads cannot be deleted directly'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_learning_policy_heads_lifecycle_only
  BEFORE INSERT OR UPDATE OR DELETE ON "workspace_learning_policy_heads"
  FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_guard_head_mutation();

CREATE OR REPLACE FUNCTION workspace_learning_policy_validate_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "workspace_learning_policy_revisions" revision
    WHERE revision."id" = NEW."new_revision_id"
      AND revision."account_id" = NEW."account_id"
      AND revision."workspace_id" = NEW."workspace_id"
      AND revision."revision" = NEW."new_revision"
      AND revision."policy_hash" = NEW."new_policy_hash"
  ) THEN
    RAISE EXCEPTION 'learning-policy activation event has an invalid new revision'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."old_revision_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "workspace_learning_policy_revisions" revision
    WHERE revision."id" = NEW."old_revision_id"
      AND revision."account_id" = NEW."account_id"
      AND revision."workspace_id" = NEW."workspace_id"
      AND revision."revision" = NEW."old_revision"
      AND revision."policy_hash" = NEW."old_policy_hash"
  ) THEN
    RAISE EXCEPTION 'learning-policy activation event has an invalid old revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_learning_policy_events_validate_revisions
  BEFORE INSERT OR UPDATE ON "workspace_learning_policy_activation_events"
  FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_validate_event();

CREATE OR REPLACE FUNCTION workspace_learning_policy_reject_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND NOT EXISTS (
      SELECT 1 FROM "workspaces" workspace WHERE workspace."id" = OLD."workspace_id"
    )
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'workspace learning-policy history is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER workspace_learning_policy_revisions_immutable
  BEFORE UPDATE OR DELETE ON "workspace_learning_policy_revisions"
  FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_reject_history_mutation();

CREATE TRIGGER workspace_learning_policy_events_immutable
  BEFORE UPDATE OR DELETE ON "workspace_learning_policy_activation_events"
  FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_reject_history_mutation();

CREATE OR REPLACE FUNCTION workspace_learning_policy_reject_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Parent lifecycle deletion is the sole mutation exception. PostgreSQL's
  -- cascading constraint trigger runs only after its parent row is absent;
  -- require both nested trigger context and one missing ownership edge so
  -- direct or unrelated-trigger deletes remain fail-closed.
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM "managed_accounts" WHERE "id" = OLD."account_id")
      OR NOT EXISTS (SELECT 1 FROM "workspaces" WHERE "id" = OLD."workspace_id")
      OR NOT EXISTS (SELECT 1 FROM "sessions" WHERE "id" = OLD."session_id")
      OR NOT EXISTS (SELECT 1 FROM "session_turns" WHERE "id" = OLD."turn_id")
      OR NOT EXISTS (SELECT 1 FROM "session_turn_attempts" WHERE "id" = OLD."attempt_id")
    )
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'workspace learning-policy snapshots are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER workspace_learning_policy_snapshots_immutable
  BEFORE UPDATE OR DELETE ON "workspace_learning_policy_snapshots"
  FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_reject_snapshot_mutation();

CREATE OR REPLACE FUNCTION workspace_learning_policy_canonical_at(
  p_account_id uuid,
  p_workspace_id uuid,
  p_accepted_at timestamptz
) RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN active."id" IS NULL THEN
    jsonb_build_object(
      'revisionId', NULL,
      'revision', NULL,
      'policyHash', NULL,
      'activationVersion', 0,
      'activatedAt', NULL,
      'workspaceMode', 'off',
      'sourceOverrides', '[]'::jsonb
    )
  ELSE
    jsonb_build_object(
      'revisionId', revision."id"::text,
      'revision', revision."revision",
      'policyHash', revision."policy_hash",
      'activationVersion', active."activation_version",
      'activatedAt', to_char(
        active."created_at" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'workspaceMode', revision."workspace_mode",
      'sourceOverrides', revision."source_overrides"
    )
  END
  FROM (SELECT 1) singleton
  LEFT JOIN LATERAL (
    SELECT event.*
    FROM "workspace_learning_policy_activation_events" event
    WHERE event."account_id" = p_account_id
      AND event."workspace_id" = p_workspace_id
      AND event."created_at" <= p_accepted_at
    ORDER BY event."created_at" DESC, event."activation_version" DESC, event."id" DESC
    LIMIT 1
  ) active ON true
  LEFT JOIN "workspace_learning_policy_revisions" revision
    ON revision."account_id" = active."account_id"
    AND revision."workspace_id" = active."workspace_id"
    AND revision."id" = active."new_revision_id"
    AND revision."revision" = active."new_revision"
    AND revision."policy_hash" = active."new_policy_hash";
$$;

REVOKE ALL ON FUNCTION workspace_learning_policy_canonical_at(uuid, uuid, timestamptz)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION workspace_learning_policy_validate_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  accepted_at timestamptz;
  canonical jsonb;
BEGIN
  SELECT turn."created_at" INTO accepted_at
  FROM "session_turn_attempts" attempt
  JOIN "session_turns" turn
    ON turn."account_id" = attempt."account_id"
    AND turn."workspace_id" = attempt."workspace_id"
    AND turn."session_id" = attempt."session_id"
    AND turn."id" = attempt."turn_id"
  JOIN "sessions" session
    ON session."account_id" = attempt."account_id"
    AND session."workspace_id" = attempt."workspace_id"
    AND session."id" = attempt."session_id"
  WHERE attempt."id" = NEW."attempt_id"
    AND attempt."account_id" = NEW."account_id"
    AND attempt."workspace_id" = NEW."workspace_id"
    AND attempt."session_id" = NEW."session_id"
    AND attempt."turn_id" = NEW."turn_id"
    AND attempt."execution_generation" = NEW."execution_generation"
    AND turn."execution_generation" = NEW."execution_generation"
    AND attempt."state" IN ('claimed', 'running')
    AND turn."active_attempt_id" = attempt."id"
    AND session."active_turn_id" = turn."id"
    AND turn."status" IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
    AND NOT EXISTS (
      SELECT 1
      FROM "session_attempt_interruptions" interruption
      WHERE interruption."workspace_id" = NEW."workspace_id"
        AND interruption."attempt_id" = NEW."attempt_id"
        AND interruption."state" IN ('pending', 'delivered', 'acknowledged')
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'learning-policy snapshot requires an exact active attempt'
      USING ERRCODE = '23514';
  END IF;

  canonical := workspace_learning_policy_canonical_at(
    NEW."account_id",
    NEW."workspace_id",
    accepted_at
  );
  IF NEW."revision_id" IS DISTINCT FROM (canonical->>'revisionId')::uuid
    OR NEW."revision" IS DISTINCT FROM (canonical->>'revision')::bigint
    OR NEW."policy_hash" IS DISTINCT FROM canonical->>'policyHash'
    OR NEW."activation_version" IS DISTINCT FROM (canonical->>'activationVersion')::bigint
    OR NEW."activated_at" IS DISTINCT FROM (canonical->>'activatedAt')::timestamptz
    OR NEW."workspace_mode" IS DISTINCT FROM canonical->>'workspaceMode'
    OR NEW."source_overrides" IS DISTINCT FROM canonical->'sourceOverrides'
  THEN
    RAISE EXCEPTION 'learning-policy snapshot is not the canonical accepted policy'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspace_learning_policy_snapshots_validate
  BEFORE INSERT ON "workspace_learning_policy_snapshots"
  FOR EACH ROW EXECUTE FUNCTION workspace_learning_policy_validate_snapshot();

DO $activation_function$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.workspace_learning_policy_apply_activation(
      p_operation_id uuid,
      p_request_fingerprint text,
      p_account_id uuid,
      p_workspace_id uuid,
      p_target_revision_id uuid,
      p_expected_current_revision_id uuid,
      p_expected_activation_version bigint,
      p_type text,
      p_actor_subject_id text,
      p_reason text
    ) RETURNS TABLE (event_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_catalog
    AS $body$
    DECLARE
      target_revision record;
      current_head record;
      existing_event record;
      next_activation_version bigint;
      event_created_at timestamptz;
      context_account_id uuid;
      context_workspace_id uuid;
      context_subject_id text;
      context_principal_kind text;
    BEGIN
      context_account_id := NULLIF(current_setting('opengeni.account_id', true), '')::uuid;
      context_workspace_id := NULLIF(current_setting('opengeni.workspace_id', true), '')::uuid;
      context_subject_id := NULLIF(current_setting('opengeni.subject_id', true), '');
      context_principal_kind := NULLIF(current_setting('opengeni.principal_kind', true), '');
      IF context_account_id IS DISTINCT FROM p_account_id
        OR context_workspace_id IS DISTINCT FROM p_workspace_id
        OR context_subject_id IS DISTINCT FROM p_actor_subject_id
        OR context_principal_kind IS DISTINCT FROM 'human_session'
      THEN
        RAISE EXCEPTION 'learning-policy activation requires exact human workspace authority'
          USING ERRCODE = '42501';
      END IF;
      IF p_request_fingerprint !~ '^[0-9a-f]{64}$'
        OR p_expected_activation_version < 0
        OR p_type NOT IN ('activate', 'rollback')
        OR length(btrim(p_actor_subject_id)) NOT BETWEEN 1 AND 1024
        OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4096
      THEN
        RAISE EXCEPTION 'learning-policy activation input is invalid'
          USING ERRCODE = '22023';
      END IF;

      PERFORM 1
      FROM "workspaces" workspace
      WHERE workspace."id" = p_workspace_id AND workspace."account_id" = p_account_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'workspace was not found' USING ERRCODE = '42501';
      END IF;

      SELECT * INTO existing_event
      FROM "workspace_learning_policy_activation_events" event
      WHERE event."workspace_id" = p_workspace_id
        AND event."operation_id" = p_operation_id;
      IF FOUND THEN
        IF existing_event."request_fingerprint" IS DISTINCT FROM p_request_fingerprint THEN
          RAISE EXCEPTION 'learning-policy operation id was reused'
            USING ERRCODE = 'P1471';
        END IF;
        event_id := existing_event."id";
        RETURN NEXT;
        RETURN;
      END IF;
      IF EXISTS (
        SELECT 1 FROM "workspace_learning_policy_revisions" revision
        WHERE revision."workspace_id" = p_workspace_id
          AND revision."operation_id" = p_operation_id
      ) THEN
        RAISE EXCEPTION 'learning-policy operation id was reused'
          USING ERRCODE = 'P1471';
      END IF;

      SELECT * INTO target_revision
      FROM "workspace_learning_policy_revisions" revision
      WHERE revision."id" = p_target_revision_id
        AND revision."account_id" = p_account_id
        AND revision."workspace_id" = p_workspace_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'learning-policy revision was not found' USING ERRCODE = '23503';
      END IF;

      SELECT * INTO current_head
      FROM "workspace_learning_policy_heads" head
      WHERE head."account_id" = p_account_id
        AND head."workspace_id" = p_workspace_id
      FOR UPDATE;
      IF coalesce(current_head."activation_version", 0) IS DISTINCT FROM p_expected_activation_version
        OR current_head."revision_id" IS DISTINCT FROM p_expected_current_revision_id
      THEN
        RAISE EXCEPTION 'learning-policy active revision changed'
          USING ERRCODE = '40001';
      END IF;
      IF current_head."revision_id" IS NOT NULL
        AND current_head."revision_id" = target_revision."id"
      THEN
        RAISE EXCEPTION 'learning-policy revision is already active'
          USING ERRCODE = '23514';
      END IF;
      IF p_type = 'rollback' THEN
        IF current_head."revision_id" IS NULL OR NOT EXISTS (
          SELECT 1
          FROM "workspace_learning_policy_activation_events" event
          WHERE event."account_id" = p_account_id
            AND event."workspace_id" = p_workspace_id
            AND event."new_revision_id" = target_revision."id"
        ) THEN
          RAISE EXCEPTION 'learning-policy rollback target was not previously active'
            USING ERRCODE = '23514';
        END IF;
      END IF;

      -- The event timestamp is accepted-order evidence. Stamp it only after
      -- workspace/head serialization and successful CAS so a dependent
      -- activation that began earlier cannot sort before its predecessor.
      event_created_at := clock_timestamp();
      next_activation_version := coalesce(current_head."activation_version", 0) + 1;
      PERFORM set_config(
        'opengeni.workspace_learning_policy_lifecycle_workspace_id',
        p_workspace_id::text,
        true
      );
      IF current_head."id" IS NULL THEN
        INSERT INTO "workspace_learning_policy_heads" (
          "account_id", "workspace_id", "revision_id", "revision",
          "policy_hash", "activation_version", "activated_at"
        ) VALUES (
          p_account_id, p_workspace_id, target_revision."id", target_revision."revision",
          target_revision."policy_hash", next_activation_version, event_created_at
        );
      ELSE
        UPDATE "workspace_learning_policy_heads"
        SET "revision_id" = target_revision."id",
          "revision" = target_revision."revision",
          "policy_hash" = target_revision."policy_hash",
          "activation_version" = next_activation_version,
          "activated_at" = event_created_at
        WHERE "id" = current_head."id";
      END IF;
      PERFORM set_config('opengeni.workspace_learning_policy_lifecycle_workspace_id', '', true);

      INSERT INTO "workspace_learning_policy_activation_events" (
        "operation_id", "request_fingerprint", "account_id", "workspace_id",
        "type", "activation_version",
        "old_revision_id", "old_revision", "old_policy_hash",
        "new_revision_id", "new_revision", "new_policy_hash",
        "actor_subject_id", "reason", "created_at"
      ) VALUES (
        p_operation_id, p_request_fingerprint, p_account_id, p_workspace_id,
        p_type, next_activation_version,
        current_head."revision_id", current_head."revision", current_head."policy_hash",
        target_revision."id", target_revision."revision", target_revision."policy_hash",
        p_actor_subject_id, p_reason, event_created_at
      ) RETURNING "id" INTO event_id;
      RETURN NEXT;
    END
    $body$
  $ddl$, target_schema, target_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.workspace_learning_policy_apply_activation(uuid,text,uuid,uuid,uuid,uuid,bigint,text,text,text) FROM PUBLIC',
    target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.workspace_learning_policy_apply_activation(uuid, text, uuid, uuid, uuid, uuid, bigint, text, text, text) TO opengeni_app',
      target_schema
    );
  END IF;
END $activation_function$;

DO $snapshot_function$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.workspace_learning_policy_get_or_create_snapshot(
      p_account_id uuid,
      p_workspace_id uuid,
      p_session_id uuid,
      p_turn_id uuid,
      p_attempt_id uuid,
      p_execution_generation integer
    ) RETURNS TABLE (snapshot_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_catalog
    AS $body$
    DECLARE
      accepted_at timestamptz;
      canonical jsonb;
      existing_snapshot record;
      snapshot_revision_id uuid;
      snapshot_revision bigint;
      snapshot_policy_hash text;
      snapshot_activation_version bigint;
      snapshot_activated_at timestamptz;
      snapshot_workspace_mode text;
      snapshot_source_overrides jsonb;
    BEGIN
      IF NULLIF(current_setting('opengeni.account_id', true), '')::uuid IS DISTINCT FROM p_account_id
        OR NULLIF(current_setting('opengeni.workspace_id', true), '')::uuid IS DISTINCT FROM p_workspace_id
      THEN
        RAISE EXCEPTION 'learning-policy snapshot requires exact workspace authority'
          USING ERRCODE = '42501';
      END IF;

      SELECT * INTO existing_snapshot
      FROM "workspace_learning_policy_snapshots" snapshot
      WHERE snapshot."account_id" = p_account_id
        AND snapshot."workspace_id" = p_workspace_id
        AND snapshot."attempt_id" = p_attempt_id;
      IF FOUND THEN
        IF existing_snapshot."session_id" IS DISTINCT FROM p_session_id
          OR existing_snapshot."turn_id" IS DISTINCT FROM p_turn_id
          OR existing_snapshot."execution_generation" IS DISTINCT FROM p_execution_generation
        THEN
          RAISE EXCEPTION 'learning-policy snapshot attempt identity conflicted'
            USING ERRCODE = '23514';
        END IF;
        snapshot_id := existing_snapshot."id";
        RETURN NEXT;
        RETURN;
      END IF;

      SELECT turn."created_at" INTO accepted_at
      FROM "session_turn_attempts" attempt
      JOIN "session_turns" turn
        ON turn."account_id" = attempt."account_id"
        AND turn."workspace_id" = attempt."workspace_id"
        AND turn."session_id" = attempt."session_id"
        AND turn."id" = attempt."turn_id"
      JOIN "sessions" session
        ON session."account_id" = attempt."account_id"
        AND session."workspace_id" = attempt."workspace_id"
        AND session."id" = attempt."session_id"
      WHERE attempt."id" = p_attempt_id
        AND attempt."account_id" = p_account_id
        AND attempt."workspace_id" = p_workspace_id
        AND attempt."session_id" = p_session_id
        AND attempt."turn_id" = p_turn_id
        AND attempt."execution_generation" = p_execution_generation
        AND turn."execution_generation" = p_execution_generation
        AND attempt."state" IN ('claimed', 'running')
        AND turn."active_attempt_id" = attempt."id"
        AND session."active_turn_id" = turn."id"
        AND turn."status" IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
        AND NOT EXISTS (
          SELECT 1 FROM "session_attempt_interruptions" interruption
          WHERE interruption."workspace_id" = p_workspace_id
            AND interruption."attempt_id" = p_attempt_id
            AND interruption."state" IN ('pending', 'delivered', 'acknowledged')
        )
      FOR SHARE OF attempt, turn, session;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'learning-policy snapshot requires an exact active attempt'
          USING ERRCODE = '23514';
      END IF;

      canonical := workspace_learning_policy_canonical_at(
        p_account_id,
        p_workspace_id,
        accepted_at
      );
      snapshot_revision_id := (canonical->>'revisionId')::uuid;
      snapshot_revision := (canonical->>'revision')::bigint;
      snapshot_policy_hash := canonical->>'policyHash';
      snapshot_activation_version := (canonical->>'activationVersion')::bigint;
      snapshot_activated_at := (canonical->>'activatedAt')::timestamptz;
      snapshot_workspace_mode := canonical->>'workspaceMode';
      snapshot_source_overrides := canonical->'sourceOverrides';

      INSERT INTO "workspace_learning_policy_snapshots" (
        "account_id", "workspace_id", "session_id", "turn_id", "attempt_id",
        "execution_generation", "revision_id", "revision", "policy_hash",
        "activation_version", "activated_at", "workspace_mode", "source_overrides",
        "snapshot_hash"
      ) VALUES (
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
        p_execution_generation, snapshot_revision_id, snapshot_revision, snapshot_policy_hash,
        snapshot_activation_version, snapshot_activated_at, snapshot_workspace_mode,
        snapshot_source_overrides,
        workspace_learning_policy_snapshot_hash(
          snapshot_revision_id,
          snapshot_revision,
          snapshot_policy_hash,
          snapshot_activation_version,
          snapshot_activated_at,
          snapshot_workspace_mode,
          snapshot_source_overrides
        )
      )
      ON CONFLICT ("account_id", "workspace_id", "attempt_id") DO NOTHING
      RETURNING "id" INTO snapshot_id;

      IF snapshot_id IS NULL THEN
        SELECT snapshot."id" INTO snapshot_id
        FROM "workspace_learning_policy_snapshots" snapshot
        WHERE snapshot."account_id" = p_account_id
          AND snapshot."workspace_id" = p_workspace_id
          AND snapshot."attempt_id" = p_attempt_id
          AND snapshot."session_id" = p_session_id
          AND snapshot."turn_id" = p_turn_id
          AND snapshot."execution_generation" = p_execution_generation;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'learning-policy snapshot concurrent identity conflicted'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEXT;
    END
    $body$
  $ddl$, target_schema, target_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.workspace_learning_policy_get_or_create_snapshot(uuid,uuid,uuid,uuid,uuid,integer) FROM PUBLIC',
    target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.workspace_learning_policy_get_or_create_snapshot(uuid, uuid, uuid, uuid, uuid, integer) TO opengeni_app',
      target_schema
    );
  END IF;
END $snapshot_function$;

ALTER TABLE "workspace_learning_policy_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_learning_policy_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workspace_learning_policy_heads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_learning_policy_heads" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workspace_learning_policy_activation_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_learning_policy_activation_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "workspace_learning_policy_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_learning_policy_snapshots" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "workspace_learning_policy_revisions"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

CREATE POLICY workspace_isolation ON "workspace_learning_policy_heads"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

CREATE POLICY workspace_isolation ON "workspace_learning_policy_activation_events"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

CREATE POLICY workspace_isolation ON "workspace_learning_policy_snapshots"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

REVOKE ALL ON TABLE "workspace_learning_policy_revisions" FROM PUBLIC;
REVOKE ALL ON TABLE "workspace_learning_policy_heads" FROM PUBLIC;
REVOKE ALL ON TABLE "workspace_learning_policy_activation_events" FROM PUBLIC;
REVOKE ALL ON TABLE "workspace_learning_policy_snapshots" FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT ON TABLE "workspace_learning_policy_revisions" TO opengeni_app;
    GRANT SELECT ON TABLE "workspace_learning_policy_heads" TO opengeni_app;
    GRANT SELECT ON TABLE "workspace_learning_policy_activation_events" TO opengeni_app;
    GRANT SELECT ON TABLE "workspace_learning_policy_snapshots" TO opengeni_app;
    GRANT EXECUTE ON FUNCTION workspace_learning_policy_source_overrides_valid(jsonb)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION workspace_learning_policy_hash(text, jsonb)
      TO opengeni_app;
  END IF;
END $grants$;
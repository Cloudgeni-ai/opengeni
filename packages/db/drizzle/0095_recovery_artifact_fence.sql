-- deployment-mode: rolling
-- Recovery artifact: recovery history is precomputed without holding workspace, session,
-- event, or inference-control row locks.  A dedicated compatible writer
-- barrier and exact per-session revisions reduce the final critical section to
-- a revision-set comparison plus one append-only admission insert.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE TABLE "recovery_workspace_barriers" (
  "workspace_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "recovery_workspace_barriers_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "recovery_workspace_barriers_workspace_account_uq"
  ON "recovery_workspace_barriers" ("workspace_id", "account_id");

CREATE TABLE "recovery_session_revisions" (
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "root_session_id" uuid NOT NULL,
  "revision" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "session_id"),
  CONSTRAINT "recovery_session_revisions_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "recovery_session_revisions_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "recovery_session_revisions_workspace_root_fk"
    FOREIGN KEY ("workspace_id", "root_session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "recovery_session_revisions_revision_check" CHECK ("revision" > 0)
);
CREATE INDEX "recovery_session_revisions_root_session_idx"
  ON "recovery_session_revisions" ("workspace_id", "root_session_id", "session_id");

CREATE TABLE "recovery_history_artifacts" (
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "root_session_id" uuid NOT NULL,
  "artifact_hash" text NOT NULL,
  "format_version" integer NOT NULL,
  "workspace_control_revision" bigint NOT NULL,
  "session_count" integer NOT NULL,
  "event_count" bigint NOT NULL,
  "canonical_bytes" bigint NOT NULL,
  "manifest" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "artifact_hash"),
  CONSTRAINT "recovery_history_artifacts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "recovery_history_artifacts_hash_check"
    CHECK ("artifact_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "recovery_history_artifacts_shape_check" CHECK (
    "format_version" > 0
    AND "workspace_control_revision" >= 0
    AND "session_count" > 0
    AND "event_count" >= 0
    AND "canonical_bytes" >= 0
    AND jsonb_typeof("manifest") = 'object'
  )
);
CREATE INDEX "recovery_history_artifacts_root_created_idx"
  ON "recovery_history_artifacts" ("workspace_id", "root_session_id", "created_at" DESC);

CREATE TABLE "recovery_history_admissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "root_session_id" uuid NOT NULL,
  "artifact_hash" text NOT NULL,
  "workspace_control_revision" bigint NOT NULL,
  "idempotency_key" text NOT NULL,
  "admitted_at" timestamptz NOT NULL DEFAULT now(),
  -- The final admission phase already holds this barrier row FOR UPDATE. Keep
  -- its only FK dependency on that row: checking the workspace or artifact FK
  -- after taking the barrier can deadlock with a workspace-delete cascade
  -- which acquired the workspace row first and is waiting to delete barrier.
  CONSTRAINT "recovery_history_admissions_barrier_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "recovery_workspace_barriers"("workspace_id", "account_id")
    ON DELETE CASCADE,
  CONSTRAINT "recovery_history_admissions_control_revision_check"
    CHECK ("workspace_control_revision" >= 0),
  CONSTRAINT "recovery_history_admissions_idempotency_key_check"
    CHECK (length(btrim("idempotency_key")) > 0),
  CONSTRAINT "recovery_history_admissions_workspace_idempotency_uq"
    UNIQUE ("workspace_id", "idempotency_key")
);
CREATE INDEX "recovery_history_admissions_root_admitted_idx"
  ON "recovery_history_admissions" ("workspace_id", "root_session_id", "admitted_at" DESC);

INSERT INTO "recovery_workspace_barriers" ("workspace_id", "account_id")
SELECT control."workspace_id", control."account_id"
FROM "workspace_inference_controls" control;

-- 0063 made parent links structurally complete and declared them immutable.
-- Materialized roots require that declaration to be enforced at the database
-- boundary, not merely observed by the current TypeScript write surface.
CREATE FUNCTION opengeni_private.reject_session_parent_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'session parentage is immutable'
    USING ERRCODE = '23514';
END
$function$;

CREATE TRIGGER sessions_parent_immutable
BEFORE UPDATE OF "parent_session_id" ON "sessions"
FOR EACH ROW
WHEN (OLD."parent_session_id" IS DISTINCT FROM NEW."parent_session_id")
EXECUTE FUNCTION opengeni_private.reject_session_parent_change();

-- Seed one revision per existing session without reading event/history tables.
-- The 0063 cycle/completeness preflight guarantees every row is reached once.
WITH RECURSIVE tree AS (
  SELECT session."account_id", session."workspace_id", session."id" AS session_id,
         session."id" AS root_session_id, session."parent_session_id"
  FROM "sessions" session
  WHERE session."parent_session_id" IS NULL
  UNION ALL
  SELECT child."account_id", child."workspace_id", child."id",
         parent.root_session_id, child."parent_session_id"
  FROM tree parent
  JOIN "sessions" child
    ON child."workspace_id" = parent."workspace_id"
   AND child."parent_session_id" = parent.session_id
)
INSERT INTO "recovery_session_revisions" (
  "account_id", "workspace_id", "session_id", "root_session_id", "revision"
)
SELECT tree."account_id", tree."workspace_id", tree.session_id, tree.root_session_id, 1
FROM tree;

DO $backfill_verify$
BEGIN
  IF (SELECT count(*) FROM "recovery_session_revisions") <>
     (SELECT count(*) FROM "sessions") THEN
    RAISE EXCEPTION 'recovery artifact fence: incomplete session revision backfill';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "recovery_session_revisions" revision
    JOIN "sessions" root
      ON root."workspace_id" = revision."workspace_id"
     AND root."id" = revision."root_session_id"
    WHERE root."parent_session_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'recovery artifact fence: materialized root is not a root session';
  END IF;
END
$backfill_verify$;

-- Internal mutation tables may only be changed by their owning migration role.
-- Trigger functions below are SECURITY DEFINER and therefore retain that owner
-- while ordinary opengeni_app writes cannot forge or delete a revision/barrier.
CREATE FUNCTION opengeni_private.recovery_owner_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  relation_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(class.relowner)
    INTO relation_owner
  FROM pg_catalog.pg_class class
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = class.relnamespace
  WHERE namespace.nspname = TG_TABLE_SCHEMA
    AND class.relname = TG_TABLE_NAME;
  IF relation_owner IS NULL OR current_user <> relation_owner THEN
    RAISE EXCEPTION 'recovery fence state is internally maintained'
      USING ERRCODE = '42501';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$function$;

CREATE TRIGGER recovery_workspace_barriers_owner_only
BEFORE INSERT OR UPDATE OR DELETE ON "recovery_workspace_barriers"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.recovery_owner_only_mutation();
CREATE TRIGGER recovery_session_revisions_owner_only
BEFORE INSERT OR UPDATE OR DELETE ON "recovery_session_revisions"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.recovery_owner_only_mutation();

CREATE FUNCTION opengeni_private.lock_recovery_workspace_barrier(
  p_schema name,
  p_account_id uuid,
  p_workspace_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  locked_workspace uuid;
  live_workspace_account uuid;
BEGIN
  EXECUTE format(
    'SELECT workspace_id FROM %I.recovery_workspace_barriers WHERE workspace_id = $1 AND account_id = $2 FOR KEY SHARE',
    p_schema
  ) INTO locked_workspace USING p_workspace_id, p_account_id;
  IF locked_workspace IS NULL THEN
    -- Workspace deletion cascades the barrier before the control/session
    -- statement-level AFTER triggers run.  That teardown is already fenced by
    -- the workspace row deletion and must not try to resurrect a child row.
    -- A live workspace with the wrong account remains a hard integrity error.
    EXECUTE format(
      'SELECT account_id FROM %I.workspaces WHERE id = $1',
      p_schema
    ) INTO live_workspace_account USING p_workspace_id;
    IF live_workspace_account IS NULL THEN
      RETURN;
    END IF;
    IF live_workspace_account <> p_account_id THEN
      RAISE EXCEPTION 'recovery artifact fence: workspace/account barrier mismatch'
        USING ERRCODE = '23503';
    END IF;
    EXECUTE format(
      'INSERT INTO %I.recovery_workspace_barriers (workspace_id, account_id) VALUES ($1, $2) ON CONFLICT (workspace_id) DO NOTHING',
      p_schema
    ) USING p_workspace_id, p_account_id;
    EXECUTE format(
      'SELECT workspace_id FROM %I.recovery_workspace_barriers WHERE workspace_id = $1 AND account_id = $2 FOR KEY SHARE',
      p_schema
    ) INTO locked_workspace USING p_workspace_id, p_account_id;
  END IF;
  IF locked_workspace IS NULL THEN
    RAISE EXCEPTION 'recovery artifact fence: workspace/account barrier mismatch'
      USING ERRCODE = '23503';
  END IF;
END
$function$;

-- Build a deterministic DISTINCT mutation inventory from statement-level
-- transition tables. TG_ARGV[2] is a comma-separated set of session columns;
-- this covers ordinary session_id tables plus source/target outboxes without
-- row-by-row event-trigger overhead.
CREATE FUNCTION opengeni_private.bump_recovery_session_revisions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  transition_name text;
  session_column text;
  query_parts text[] := ARRAY[]::text[];
  mutation record;
  changed_rows bigint;
BEGIN
  FOREACH transition_name IN ARRAY ARRAY[TG_ARGV[0], TG_ARGV[1]] LOOP
    IF transition_name IS NULL OR transition_name = '' THEN
      CONTINUE;
    END IF;
    FOREACH session_column IN ARRAY pg_catalog.string_to_array(TG_ARGV[2], ',') LOOP
      query_parts := pg_catalog.array_append(
        query_parts,
        format(
          'SELECT account_id, workspace_id, %I AS session_id FROM %I WHERE %I IS NOT NULL',
          session_column,
          transition_name,
          session_column
        )
      );
    END LOOP;
  END LOOP;

  FOR mutation IN EXECUTE
    'SELECT account_id, workspace_id, session_id FROM (' ||
    pg_catalog.array_to_string(query_parts, ' UNION ALL ') ||
    ') mutation_rows GROUP BY account_id, workspace_id, session_id ORDER BY workspace_id, session_id'
  LOOP
    PERFORM opengeni_private.lock_recovery_workspace_barrier(
      TG_TABLE_SCHEMA,
      mutation.account_id,
      mutation.workspace_id
    );
    EXECUTE format(
      'UPDATE %I.recovery_session_revisions SET revision = revision + 1, updated_at = pg_catalog.now() WHERE workspace_id = $1 AND account_id = $2 AND session_id = $3',
      TG_TABLE_SCHEMA
    ) USING mutation.workspace_id, mutation.account_id, mutation.session_id;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows = 0 THEN
      -- A cascading session delete may already have removed the revision. Any
      -- live source row, however, must always have an exact revision fence.
      EXECUTE format(
        'SELECT count(*) FROM %I.sessions WHERE workspace_id = $1 AND account_id = $2 AND id = $3',
        TG_TABLE_SCHEMA
      ) INTO changed_rows USING mutation.workspace_id, mutation.account_id, mutation.session_id;
      IF changed_rows <> 0 THEN
        RAISE EXCEPTION 'recovery artifact fence: live session lacks revision'
          USING ERRCODE = '23503';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END
$function$;

CREATE FUNCTION opengeni_private.lock_recovery_workspace_mutations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  transition_name text;
  query_parts text[] := ARRAY[]::text[];
  mutation record;
BEGIN
  FOREACH transition_name IN ARRAY ARRAY[TG_ARGV[0], TG_ARGV[1]] LOOP
    IF transition_name IS NULL OR transition_name = '' THEN
      CONTINUE;
    END IF;
    query_parts := pg_catalog.array_append(
      query_parts,
      format('SELECT account_id, workspace_id FROM %I', transition_name)
    );
  END LOOP;
  FOR mutation IN EXECUTE
    'SELECT account_id, workspace_id FROM (' ||
    pg_catalog.array_to_string(query_parts, ' UNION ALL ') ||
    ') mutation_rows GROUP BY account_id, workspace_id ORDER BY workspace_id'
  LOOP
    PERFORM opengeni_private.lock_recovery_workspace_barrier(
      TG_TABLE_SCHEMA,
      mutation.account_id,
      mutation.workspace_id
    );
  END LOOP;
  RETURN NULL;
END
$function$;

CREATE FUNCTION opengeni_private.seed_recovery_session_revisions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  mutation record;
  root_id uuid;
  inserted_rows bigint;
BEGIN
  FOR mutation IN
    SELECT account_id, workspace_id, id AS session_id
    FROM recovery_new_sessions
    ORDER BY workspace_id, id
  LOOP
    PERFORM opengeni_private.lock_recovery_workspace_barrier(
      TG_TABLE_SCHEMA,
      mutation.account_id,
      mutation.workspace_id
    );
    EXECUTE format(
      'WITH RECURSIVE ancestry AS (
         SELECT session.id, session.parent_session_id, ARRAY[session.id]::uuid[] AS path
         FROM %1$I.sessions session
         WHERE session.workspace_id = $1 AND session.id = $2
         UNION ALL
         SELECT parent.id, parent.parent_session_id, ancestry.path || parent.id
         FROM ancestry
         JOIN %1$I.sessions parent
           ON parent.workspace_id = $1 AND parent.id = ancestry.parent_session_id
         WHERE ancestry.parent_session_id IS NOT NULL
           AND NOT parent.id = ANY(ancestry.path)
       )
       SELECT id FROM ancestry WHERE parent_session_id IS NULL LIMIT 1',
      TG_TABLE_SCHEMA
    ) INTO root_id USING mutation.workspace_id, mutation.session_id;
    IF root_id IS NULL THEN
      RAISE EXCEPTION 'recovery artifact fence: inserted session has incomplete or cyclic ancestry'
        USING ERRCODE = '23514';
    END IF;
    EXECUTE format(
      'INSERT INTO %I.recovery_session_revisions (
         account_id, workspace_id, session_id, root_session_id, revision
       ) VALUES ($1, $2, $3, $4, 1)',
      TG_TABLE_SCHEMA
    ) USING mutation.account_id, mutation.workspace_id, mutation.session_id, root_id;
    GET DIAGNOSTICS inserted_rows = ROW_COUNT;
    IF inserted_rows <> 1 THEN
      RAISE EXCEPTION 'recovery artifact fence: failed to seed inserted session revision';
    END IF;
  END LOOP;
  RETURN NULL;
END
$function$;

CREATE TRIGGER sessions_recovery_revision_insert
AFTER INSERT ON "sessions"
REFERENCING NEW TABLE AS recovery_new_sessions
FOR EACH STATEMENT
EXECUTE FUNCTION opengeni_private.seed_recovery_session_revisions();

CREATE TRIGGER sessions_recovery_revision_update
AFTER UPDATE ON "sessions"
REFERENCING OLD TABLE AS recovery_old_rows NEW TABLE AS recovery_new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION opengeni_private.bump_recovery_session_revisions(
  'recovery_old_rows', 'recovery_new_rows', 'id'
);

CREATE TRIGGER sessions_recovery_barrier_delete
AFTER DELETE ON "sessions"
REFERENCING OLD TABLE AS recovery_old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION opengeni_private.lock_recovery_workspace_mutations(
  'recovery_old_rows', ''
);

CREATE TRIGGER workspace_inference_controls_recovery_insert
AFTER INSERT ON "workspace_inference_controls"
REFERENCING NEW TABLE AS recovery_new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION opengeni_private.lock_recovery_workspace_mutations('', 'recovery_new_rows');
CREATE TRIGGER workspace_inference_controls_recovery_update
AFTER UPDATE ON "workspace_inference_controls"
REFERENCING OLD TABLE AS recovery_old_rows NEW TABLE AS recovery_new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION opengeni_private.lock_recovery_workspace_mutations(
  'recovery_old_rows', 'recovery_new_rows'
);
CREATE TRIGGER workspace_inference_controls_recovery_delete
AFTER DELETE ON "workspace_inference_controls"
REFERENCING OLD TABLE AS recovery_old_rows
FOR EACH STATEMENT
EXECUTE FUNCTION opengeni_private.lock_recovery_workspace_mutations('recovery_old_rows', '');

-- Recovery-relevant session truth. Each statement bumps each distinct session
-- once; unrelated sessions retain independent revision rows and all writers in
-- one workspace hold compatible FOR KEY SHARE barrier locks.
DO $install_revision_triggers$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('session_events', 'session_id'),
      ('session_history_items', 'session_id'),
      ('session_turns', 'session_id'),
      ('session_turn_attempts', 'session_id'),
      ('session_attempt_interruptions', 'session_id'),
      ('session_pending_tool_calls', 'session_id'),
      ('session_goals', 'session_id'),
      ('session_workflow_wake_outbox', 'session_id'),
      ('session_system_updates', 'session_id'),
      ('agent_run_states', 'session_id'),
      ('sandbox_session_envelopes', 'session_id'),
      ('codex_capacity_waiters', 'session_id'),
      ('session_mcp_servers', 'session_id'),
      ('composer_drafts', 'session_id'),
      ('session_command_receipts', 'target_session_id'),
      ('session_system_update_outbox', 'source_session_id,target_session_id')
    ) AS targets(table_name, session_columns)
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %1$I_recovery_revision_insert
       AFTER INSERT ON %1$I
       REFERENCING NEW TABLE AS recovery_new_rows
       FOR EACH STATEMENT
       EXECUTE FUNCTION opengeni_private.bump_recovery_session_revisions('''', ''recovery_new_rows'', %2$L)',
      target.table_name,
      target.session_columns
    );
    EXECUTE format(
      'CREATE TRIGGER %1$I_recovery_revision_update
       AFTER UPDATE ON %1$I
       REFERENCING OLD TABLE AS recovery_old_rows NEW TABLE AS recovery_new_rows
       FOR EACH STATEMENT
       EXECUTE FUNCTION opengeni_private.bump_recovery_session_revisions(''recovery_old_rows'', ''recovery_new_rows'', %2$L)',
      target.table_name,
      target.session_columns
    );
    EXECUTE format(
      'CREATE TRIGGER %1$I_recovery_revision_delete
       AFTER DELETE ON %1$I
       REFERENCING OLD TABLE AS recovery_old_rows
       FOR EACH STATEMENT
       EXECUTE FUNCTION opengeni_private.bump_recovery_session_revisions(''recovery_old_rows'', '''', %2$L)',
      target.table_name,
      target.session_columns
    );
  END LOOP;
END
$install_revision_triggers$;

-- Artifacts and admissions are append-only even if a broad/default schema grant
-- later gives the runtime role UPDATE/DELETE privileges.
CREATE FUNCTION opengeni_private.reject_recovery_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  -- Parent workspace teardown invokes this row trigger from inside PostgreSQL's
  -- FK cascade trigger.  Permit only that nested delete; direct DELETE and all
  -- UPDATE statements remain forbidden for every role, including the owner.
  IF TG_OP = 'DELETE' AND pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'recovery artifacts and admissions are immutable'
    USING ERRCODE = '55000';
END
$function$;
CREATE TRIGGER recovery_history_artifacts_immutable
BEFORE UPDATE OR DELETE ON "recovery_history_artifacts"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_recovery_immutable_mutation();
CREATE TRIGGER recovery_history_admissions_immutable
BEFORE UPDATE OR DELETE ON "recovery_history_admissions"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_recovery_immutable_mutation();
-- INSERT is a privileged operation too: the function below is the sole runtime
-- path and independently performs the exact final fence. This trigger remains
-- a defense if a future broad schema grant accidentally restores INSERT.
CREATE TRIGGER recovery_history_admissions_owner_only_insert
BEFORE INSERT ON "recovery_history_admissions"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.recovery_owner_only_mutation();

ALTER TABLE "recovery_workspace_barriers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recovery_workspace_barriers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "recovery_session_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recovery_session_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "recovery_history_artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recovery_history_artifacts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "recovery_history_admissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recovery_history_admissions" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "recovery_workspace_barriers"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "recovery_session_revisions"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "recovery_history_artifacts"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "recovery_history_admissions"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- Parse and index the persisted revision set before requesting the exclusive
-- barrier. Once the barrier is held, the function performs only bounded
-- metadata/idempotency reads, exact set comparison, and one append-only insert.
-- Its final phase never locks workspace, session, event, control, or artifact
-- rows, so AFTER-statement writer fences cannot form a reverse lock cycle.
CREATE FUNCTION opengeni_private.admit_recovery_history_artifact(
  p_schema name,
  p_account_id uuid,
  p_workspace_id uuid,
  p_root_session_id uuid,
  p_artifact_hash text,
  p_workspace_control_revision bigint,
  p_idempotency_key text
)
RETURNS TABLE (
  result_kind text,
  retry_reason text,
  result_admission_id uuid,
  result_reused boolean,
  result_lock_wait_seconds double precision,
  result_lock_hold_seconds double precision
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  stored record;
  expected_count bigint;
  root_count bigint;
  locked_workspace uuid;
  existing_id uuid;
  existing_root_session_id uuid;
  existing_artifact_hash text;
  existing_control_revision bigint;
  current_control_revision bigint;
  revision_set_changed boolean;
  lock_requested_at timestamptz;
  lock_acquired_at timestamptz;
BEGIN
  IF pg_catalog.current_setting('opengeni.account_id', true)
       IS DISTINCT FROM p_account_id::text
     OR pg_catalog.current_setting('opengeni.workspace_id', true)
       IS DISTINCT FROM p_workspace_id::text THEN
    RAISE EXCEPTION 'recovery admission RLS context mismatch'
      USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR pg_catalog.length(pg_catalog.btrim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'recovery admission idempotency key is required'
      USING ERRCODE = '22023';
  END IF;

  -- This SELECT and all JSON expansion/index work are intentionally before the
  -- final lock. The artifact is immutable, so it remains valid input while a
  -- later exact revision fence decides whether it may be admitted.
  EXECUTE format(
    'SELECT root_session_id, workspace_control_revision, session_count, manifest
       FROM %I.recovery_history_artifacts
      WHERE workspace_id = $1 AND account_id = $2 AND artifact_hash = $3',
    p_schema
  ) INTO stored USING p_workspace_id, p_account_id, p_artifact_hash;
  IF stored IS NULL
     OR stored.root_session_id IS DISTINCT FROM p_root_session_id
     OR stored.workspace_control_revision IS DISTINCT FROM p_workspace_control_revision THEN
    RAISE EXCEPTION 'persisted recovery artifact metadata is unavailable'
      USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(stored.manifest -> 'sessions') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'persisted recovery artifact session set is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.to_regclass('pg_temp.recovery_expected_revisions') IS NOT NULL THEN
    DROP TABLE pg_temp.recovery_expected_revisions;
  END IF;
  CREATE TEMP TABLE recovery_expected_revisions (
    session_id uuid PRIMARY KEY,
    revision bigint NOT NULL CHECK (revision > 0)
  ) ON COMMIT DROP;
  INSERT INTO pg_temp.recovery_expected_revisions (session_id, revision)
  SELECT (entry ->> 'sessionId')::uuid,
         (entry ->> 'recoveryRevision')::bigint
  FROM pg_catalog.jsonb_array_elements(stored.manifest -> 'sessions') entry;
  SELECT pg_catalog.count(*),
         pg_catalog.count(*) FILTER (WHERE session_id = p_root_session_id)
    INTO expected_count, root_count
  FROM pg_temp.recovery_expected_revisions;
  IF expected_count <> stored.session_count OR root_count <> 1 THEN
    RAISE EXCEPTION 'persisted recovery artifact revision set is invalid'
      USING ERRCODE = '22023';
  END IF;

  lock_requested_at := pg_catalog.clock_timestamp();
  EXECUTE format(
    'SELECT workspace_id FROM %I.recovery_workspace_barriers
      WHERE workspace_id = $1 AND account_id = $2 FOR UPDATE',
    p_schema
  ) INTO locked_workspace USING p_workspace_id, p_account_id;
  lock_acquired_at := pg_catalog.clock_timestamp();
  result_lock_wait_seconds := EXTRACT(
    epoch FROM lock_acquired_at - lock_requested_at
  );
  IF locked_workspace IS NULL THEN
    RAISE EXCEPTION 'recovery workspace barrier is unavailable'
      USING ERRCODE = '23503';
  END IF;

  EXECUTE format(
    'SELECT id, root_session_id, artifact_hash, workspace_control_revision
       FROM %I.recovery_history_admissions
      WHERE workspace_id = $1 AND idempotency_key = $2',
    p_schema
  ) INTO existing_id, existing_root_session_id, existing_artifact_hash,
         existing_control_revision
    USING p_workspace_id, p_idempotency_key;
  IF existing_id IS NOT NULL THEN
    IF existing_root_session_id IS DISTINCT FROM p_root_session_id
       OR existing_artifact_hash IS DISTINCT FROM p_artifact_hash
       OR existing_control_revision IS DISTINCT FROM p_workspace_control_revision THEN
      result_kind := 'conflict';
      retry_reason := 'idempotency_conflict';
      result_admission_id := existing_id;
      result_reused := false;
    ELSE
      result_kind := 'admitted';
      retry_reason := NULL;
      result_admission_id := existing_id;
      result_reused := true;
    END IF;
    result_lock_hold_seconds := EXTRACT(
      epoch FROM pg_catalog.clock_timestamp() - lock_acquired_at
    );
    RETURN NEXT;
    RETURN;
  END IF;

  EXECUTE format(
    'SELECT revision FROM %I.workspace_inference_controls
      WHERE workspace_id = $1 AND account_id = $2',
    p_schema
  ) INTO current_control_revision USING p_workspace_id, p_account_id;
  IF current_control_revision IS DISTINCT FROM p_workspace_control_revision THEN
    result_kind := 'retry';
    retry_reason := 'workspace_control_changed';
    result_admission_id := NULL;
    result_reused := false;
    result_lock_hold_seconds := EXTRACT(
      epoch FROM pg_catalog.clock_timestamp() - lock_acquired_at
    );
    RETURN NEXT;
    RETURN;
  END IF;

  EXECUTE format(
    'SELECT EXISTS (
       (SELECT expected.session_id, expected.revision
          FROM pg_temp.recovery_expected_revisions expected
        EXCEPT
        SELECT revision.session_id, revision.revision
          FROM %1$I.recovery_session_revisions revision
         WHERE revision.workspace_id = $1 AND revision.account_id = $2
           AND revision.root_session_id = $3)
       UNION ALL
       (SELECT revision.session_id, revision.revision
          FROM %1$I.recovery_session_revisions revision
         WHERE revision.workspace_id = $1 AND revision.account_id = $2
           AND revision.root_session_id = $3
        EXCEPT
        SELECT expected.session_id, expected.revision
          FROM pg_temp.recovery_expected_revisions expected)
     )',
    p_schema
  ) INTO revision_set_changed USING p_workspace_id, p_account_id, p_root_session_id;
  IF revision_set_changed IS DISTINCT FROM false THEN
    result_kind := 'retry';
    retry_reason := 'session_tree_changed';
    result_admission_id := NULL;
    result_reused := false;
    result_lock_hold_seconds := EXTRACT(
      epoch FROM pg_catalog.clock_timestamp() - lock_acquired_at
    );
    RETURN NEXT;
    RETURN;
  END IF;

  EXECUTE format(
    'INSERT INTO %I.recovery_history_admissions (
       workspace_id, account_id, root_session_id, artifact_hash,
       workspace_control_revision, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    p_schema
  ) INTO result_admission_id
    USING p_workspace_id, p_account_id, p_root_session_id, p_artifact_hash,
          p_workspace_control_revision, p_idempotency_key;
  result_kind := 'admitted';
  retry_reason := NULL;
  result_reused := false;
  result_lock_hold_seconds := EXTRACT(
    epoch FROM pg_catalog.clock_timestamp() - lock_acquired_at
  );
  RETURN NEXT;
END
$function$;

REVOKE ALL ON FUNCTION opengeni_private.reject_session_parent_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.recovery_owner_only_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.lock_recovery_workspace_barrier(name, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.bump_recovery_session_revisions() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.lock_recovery_workspace_mutations() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.seed_recovery_session_revisions() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.reject_recovery_immutable_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.admit_recovery_history_artifact(
  name, uuid, uuid, uuid, text, bigint, text
) FROM PUBLIC;

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO opengeni_app',
      target_schema
    );
    -- SELECT FOR UPDATE on the barrier requires some UPDATE privilege. The
    -- owner-only trigger still rejects actual runtime mutations.
    EXECUTE format(
      'GRANT UPDATE (updated_at) ON TABLE %I.recovery_workspace_barriers TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'REVOKE INSERT ON TABLE %I.recovery_history_admissions FROM opengeni_app',
      target_schema
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.admit_recovery_history_artifact(
      name, uuid, uuid, uuid, text, bigint, text
    ) TO opengeni_app;
  END IF;
END
$grants$;

RESET statement_timeout;
RESET lock_timeout;
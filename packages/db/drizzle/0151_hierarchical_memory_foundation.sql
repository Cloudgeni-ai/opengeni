-- deployment-mode: maintenance
-- First slice: typed/composable memory scope, namespace/labels, typed
-- relationships, and immutable apply/revert evidence. Old memory readers and
-- writers must not overlap this cutover because they ignore typed selectors and
-- recognize only the V1 workspace-wide dedup constraint.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

DO $maintenance_preflight_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'hierarchical memory activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_preflight_guard$;

LOCK TABLE knowledge_memories IN ACCESS EXCLUSIVE MODE;
LOCK TABLE sessions IN SHARE MODE;
LOCK TABLE session_turns IN SHARE MODE;
LOCK TABLE session_turn_attempts IN SHARE MODE;
LOCK TABLE session_attempt_interruptions IN SHARE MODE;

DO $maintenance_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'hierarchical memory activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_guard$;

ALTER TABLE knowledge_memories ADD COLUMN IF NOT EXISTS scope_type text;
ALTER TABLE knowledge_memories ADD COLUMN IF NOT EXISTS scope_subject_id text;
ALTER TABLE knowledge_memories ADD COLUMN IF NOT EXISTS scope_role_key text;
ALTER TABLE knowledge_memories ADD COLUMN IF NOT EXISTS scope_session_id uuid;
ALTER TABLE knowledge_memories ADD COLUMN IF NOT EXISTS namespace_key text NOT NULL DEFAULT 'general';
ALTER TABLE knowledge_memories ADD COLUMN IF NOT EXISTS labels text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE knowledge_memories ADD COLUMN IF NOT EXISTS memory_version integer NOT NULL DEFAULT 1;
ALTER TABLE knowledge_memories ADD COLUMN IF NOT EXISTS created_by_kind text NOT NULL DEFAULT 'service';
ALTER TABLE knowledge_memories
  ADD COLUMN IF NOT EXISTS created_by_subject_id text NOT NULL DEFAULT 'unattributed-legacy';
ALTER TABLE knowledge_memories
  ADD COLUMN IF NOT EXISTS created_by_context jsonb NOT NULL DEFAULT '{"backfill":true}'::jsonb;

-- Existing `workspace` rows retain their behavior. Every unknown historical
-- convention becomes audit-only `legacy`; it is never widened into workspace
-- visibility by inference.
UPDATE knowledge_memories
SET scope_type = CASE WHEN scope = 'workspace' THEN 'workspace' ELSE 'legacy' END
WHERE scope_type IS NULL;
ALTER TABLE knowledge_memories ALTER COLUMN scope_type SET DEFAULT 'workspace';
ALTER TABLE knowledge_memories ALTER COLUMN scope_type SET NOT NULL;

-- Migration 0041 installed a global creator FK. Replace it with a workspace-
-- qualified provenance fence; never attach a valid foreign-workspace session.
DO $creator_fk$
DECLARE legacy_constraint_name text;
BEGIN
  FOR legacy_constraint_name IN
    SELECT constraint_row.conname
    FROM pg_constraint AS constraint_row
    JOIN pg_attribute AS local_column
      ON local_column.attrelid = constraint_row.conrelid
     AND local_column.attnum = constraint_row.conkey[1]
    WHERE constraint_row.conrelid = 'knowledge_memories'::regclass
      AND constraint_row.contype = 'f'
      AND cardinality(constraint_row.conkey) = 1
      AND local_column.attname = 'created_by_session_id'
  LOOP
    EXECUTE format('ALTER TABLE knowledge_memories DROP CONSTRAINT %I', legacy_constraint_name);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_memories_created_by_workspace_session_fk'
      AND conrelid = 'knowledge_memories'::regclass
  ) THEN
    ALTER TABLE knowledge_memories
      ADD CONSTRAINT knowledge_memories_created_by_workspace_session_fk
      FOREIGN KEY (workspace_id, created_by_session_id)
      REFERENCES sessions(workspace_id, id)
      ON DELETE SET NULL (created_by_session_id);
  END IF;
END
$creator_fk$;

CREATE OR REPLACE FUNCTION opengeni_private.memory_labels_valid(value text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(cardinality(value), 0) <= 16
    AND NOT EXISTS (
      SELECT 1 FROM unnest(value) AS label
      WHERE label IS NULL
        OR length(label) > 64
        OR label !~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$'
    )
    AND value = ARRAY(SELECT label FROM unnest(value) AS label ORDER BY label)
    AND cardinality(value) = cardinality(ARRAY(SELECT DISTINCT label FROM unnest(value) AS label));
$$;

DO $memory_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_memories_scope_selector_chk'
      AND conrelid = 'knowledge_memories'::regclass
  ) THEN
    ALTER TABLE knowledge_memories ADD CONSTRAINT knowledge_memories_scope_selector_chk CHECK (
      (scope_type = 'workspace'
        AND scope_subject_id IS NULL AND scope_role_key IS NULL AND scope_session_id IS NULL)
      OR (scope_type = 'user'
        AND length(btrim(scope_subject_id)) BETWEEN 1 AND 1024
        AND scope_role_key IS NULL AND scope_session_id IS NULL)
      OR (scope_type = 'role'
        AND scope_subject_id IS NULL
        AND scope_role_key ~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$'
        AND scope_session_id IS NULL)
      OR (scope_type = 'session'
        AND scope_subject_id IS NULL AND scope_role_key IS NULL AND scope_session_id IS NOT NULL)
      OR (scope_type = 'ephemeral'
        AND scope_subject_id IS NULL AND scope_role_key IS NULL
        AND scope_session_id IS NOT NULL AND valid_until IS NOT NULL)
      OR (scope_type = 'legacy'
        AND scope_subject_id IS NULL AND scope_role_key IS NULL AND scope_session_id IS NULL)
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_memories_valid_window_chk'
      AND conrelid = 'knowledge_memories'::regclass
  ) THEN
    ALTER TABLE knowledge_memories ADD CONSTRAINT knowledge_memories_valid_window_chk
      CHECK (valid_until IS NULL OR valid_from <= valid_until);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_memories_namespace_chk'
      AND conrelid = 'knowledge_memories'::regclass
  ) THEN
    ALTER TABLE knowledge_memories ADD CONSTRAINT knowledge_memories_namespace_chk CHECK (
      length(namespace_key) BETWEEN 1 AND 128
      AND namespace_key ~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?(?:/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)*$'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_memories_labels_chk'
      AND conrelid = 'knowledge_memories'::regclass
  ) THEN
    ALTER TABLE knowledge_memories ADD CONSTRAINT knowledge_memories_labels_chk
      CHECK (opengeni_private.memory_labels_valid(labels));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_memories_version_chk'
      AND conrelid = 'knowledge_memories'::regclass
  ) THEN
    ALTER TABLE knowledge_memories ADD CONSTRAINT knowledge_memories_version_chk
      CHECK (memory_version > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_memories_creator_chk'
      AND conrelid = 'knowledge_memories'::regclass
  ) THEN
    ALTER TABLE knowledge_memories ADD CONSTRAINT knowledge_memories_creator_chk CHECK (
      created_by_kind IN ('subject', 'service')
      AND length(btrim(created_by_subject_id)) BETWEEN 1 AND 1024
      AND jsonb_typeof(created_by_context) = 'object'
      AND created_by_context - ARRAY[
        'backfill', 'legacyWriter', 'sessionId', 'turnId', 'attemptId',
        'executionGeneration'
      ]::text[] = '{}'::jsonb
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'knowledge_memories_scope_session_fk'
      AND conrelid = 'knowledge_memories'::regclass
  ) THEN
    ALTER TABLE knowledge_memories
      ADD CONSTRAINT knowledge_memories_scope_session_fk
      FOREIGN KEY (workspace_id, scope_session_id)
      REFERENCES sessions(workspace_id, id) ON DELETE CASCADE;
  END IF;
END
$memory_constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_memories_workspace_id_uq
  ON knowledge_memories(workspace_id, id);
CREATE INDEX IF NOT EXISTS knowledge_memories_workspace_typed_scope_idx
  ON knowledge_memories(workspace_id, scope_type, scope_subject_id, scope_role_key, scope_session_id);
CREATE INDEX IF NOT EXISTS knowledge_memories_workspace_namespace_idx
  ON knowledge_memories(workspace_id, namespace_key, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS knowledge_memories_labels_idx
  ON knowledge_memories USING gin(labels);

-- Exact dedup is local to the complete typed target. A user's private fact must
-- not collide with a different user, role, or session carrying the same text.
DROP INDEX IF EXISTS knowledge_memories_workspace_visible_text_hash_uq;
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_memories_scope_visible_text_hash_uq
  ON knowledge_memories(
    workspace_id, scope_type, scope_subject_id, scope_role_key, scope_session_id,
    namespace_key, text_hash
  ) NULLS NOT DISTINCT
  WHERE status IN ('active', 'approved') AND text_hash IS NOT NULL;

CREATE OR REPLACE FUNCTION opengeni_private.knowledge_memory_row_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE typed_change boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.scope_type IS NULL
      OR (NEW.scope_type = 'workspace' AND NEW.scope <> 'workspace'
        AND NEW.scope_subject_id IS NULL AND NEW.scope_role_key IS NULL
        AND NEW.scope_session_id IS NULL)
    THEN
      NEW.scope_type := CASE WHEN NEW.scope = 'workspace' THEN 'workspace' ELSE 'legacy' END;
      NEW.scope_subject_id := NULL;
      NEW.scope_role_key := NULL;
      NEW.scope_session_id := NULL;
    END IF;
    IF opengeni_private.current_memory_actor_kind() IN ('subject', 'service')
      AND length(btrim(opengeni_private.current_memory_actor_id())) BETWEEN 1 AND 1024
    THEN
      NEW.created_by_kind := opengeni_private.current_memory_actor_kind();
      NEW.created_by_subject_id := opengeni_private.current_memory_actor_id();
      NEW.created_by_context := jsonb_strip_nulls(jsonb_build_object(
        'sessionId', opengeni_private.current_memory_session_id()
      ));
    ELSE
      NEW.created_by_kind := 'service';
      NEW.created_by_subject_id := 'unattributed-legacy';
      NEW.created_by_context := '{"legacyWriter":true}'::jsonb;
    END IF;
    NEW.memory_version := 1;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.created_by_kind, NEW.created_by_subject_id, NEW.created_by_context, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.created_by_kind, OLD.created_by_subject_id, OLD.created_by_context, OLD.created_at
  )
    OR (NEW.created_by_session_id IS DISTINCT FROM OLD.created_by_session_id
      AND (NEW.created_by_session_id IS NOT NULL OR pg_trigger_depth() <= 1))
  THEN
    RAISE EXCEPTION 'knowledge memory creator authority is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.scope IS DISTINCT FROM OLD.scope
    AND ROW(NEW.scope_type, NEW.scope_subject_id, NEW.scope_role_key, NEW.scope_session_id)
      IS NOT DISTINCT FROM ROW(OLD.scope_type, OLD.scope_subject_id, OLD.scope_role_key, OLD.scope_session_id)
    AND nullif(current_setting('opengeni.memory_lifecycle_operation', true), '') IS DISTINCT FROM '1'
  THEN
    NEW.scope_type := CASE WHEN NEW.scope = 'workspace' THEN 'workspace' ELSE 'legacy' END;
    NEW.scope_subject_id := NULL;
    NEW.scope_role_key := NULL;
    NEW.scope_session_id := NULL;
  END IF;

  IF ROW(
    NEW.scope_type, NEW.scope_subject_id, NEW.scope_role_key,
    NEW.scope_session_id, NEW.namespace_key, NEW.labels
  ) IS DISTINCT FROM ROW(
    OLD.scope_type, OLD.scope_subject_id, OLD.scope_role_key,
    OLD.scope_session_id, OLD.namespace_key, OLD.labels
  ) AND nullif(current_setting('opengeni.memory_lifecycle_operation', true), '')
    IS DISTINCT FROM '1'
  THEN
    RAISE EXCEPTION 'typed memory governance fields mutate only through lifecycle operations'
      USING ERRCODE = '55000';
  END IF;

  typed_change := ROW(
    NEW.status, NEW.scope_type, NEW.scope_subject_id, NEW.scope_role_key,
    NEW.scope_session_id, NEW.namespace_key, NEW.labels, NEW.valid_from,
    NEW.valid_until, NEW.supersedes_id, NEW.superseded_by_id
  ) IS DISTINCT FROM ROW(
    OLD.status, OLD.scope_type, OLD.scope_subject_id, OLD.scope_role_key,
    OLD.scope_session_id, OLD.namespace_key, OLD.labels, OLD.valid_from,
    OLD.valid_until, OLD.supersedes_id, OLD.superseded_by_id
  );
  NEW.memory_version := OLD.memory_version + CASE WHEN typed_change THEN 1 ELSE 0 END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS knowledge_memories_row_guard ON knowledge_memories;
CREATE TRIGGER knowledge_memories_row_guard
BEFORE INSERT OR UPDATE ON knowledge_memories
FOR EACH ROW EXECUTE FUNCTION opengeni_private.knowledge_memory_row_guard();

CREATE TABLE knowledge_memory_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  action text NOT NULL,
  operation_type text NOT NULL,
  target_memory_id uuid NOT NULL,
  related_memory_id uuid,
  relationship_id uuid,
  relationship_type text,
  actor_kind text NOT NULL,
  actor_subject_id text NOT NULL,
  actor_session_id uuid,
  actor_turn_id uuid,
  actor_attempt_id uuid,
  actor_execution_generation integer,
  plan_hash text NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  reverts_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT knowledge_memory_lifecycle_events_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_memory_lifecycle_events_target_fk
    FOREIGN KEY (workspace_id, target_memory_id)
    REFERENCES knowledge_memories(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_memory_lifecycle_events_related_fk
    FOREIGN KEY (workspace_id, related_memory_id)
    REFERENCES knowledge_memories(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_memory_lifecycle_events_actor_session_fk
    FOREIGN KEY (workspace_id, actor_session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_memory_lifecycle_events_actor_turn_fk
    FOREIGN KEY (workspace_id, actor_turn_id)
    REFERENCES session_turns(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_memory_lifecycle_events_actor_attempt_fk
    FOREIGN KEY (workspace_id, actor_attempt_id)
    REFERENCES session_turn_attempts(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_memory_lifecycle_events_reverts_fk
    FOREIGN KEY (workspace_id, reverts_event_id)
    REFERENCES knowledge_memory_lifecycle_events(workspace_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT knowledge_memory_lifecycle_events_action_chk
    CHECK (action IN ('apply', 'revert')),
  CONSTRAINT knowledge_memory_lifecycle_events_operation_chk
    CHECK (operation_type IN (
      'reclassify', 'archive', 'relationship_add', 'relationship_remove',
      'supersede', 'correct'
    )),
  CONSTRAINT knowledge_memory_lifecycle_events_relationship_chk CHECK (
    (operation_type IN ('relationship_add', 'relationship_remove', 'supersede', 'correct')
      AND related_memory_id IS NOT NULL AND relationship_id IS NOT NULL
      AND relationship_type IS NOT NULL)
    OR (operation_type IN ('reclassify', 'archive')
      AND related_memory_id IS NULL AND relationship_id IS NULL
      AND relationship_type IS NULL)
  ),
  CONSTRAINT knowledge_memory_lifecycle_events_actor_chk CHECK (
    actor_kind IN ('subject', 'service')
    AND length(btrim(actor_subject_id)) BETWEEN 1 AND 1024
  ),
  CONSTRAINT knowledge_memory_lifecycle_events_attempt_shape_chk CHECK (
    (actor_session_id IS NULL AND actor_turn_id IS NULL AND actor_attempt_id IS NULL
      AND actor_execution_generation IS NULL)
    OR (actor_session_id IS NOT NULL AND actor_turn_id IS NOT NULL AND actor_attempt_id IS NOT NULL
      AND actor_execution_generation > 0)
  ),
  CONSTRAINT knowledge_memory_lifecycle_events_plan_hash_chk
    CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT knowledge_memory_lifecycle_events_state_chk CHECK (
    jsonb_typeof(before_state) = 'object' AND jsonb_typeof(after_state) = 'object'
    AND NOT (before_state ?| ARRAY['text', 'sourceRefs', 'source_refs', 'metadata', 'embedding'])
    AND NOT (after_state ?| ARRAY['text', 'sourceRefs', 'source_refs', 'metadata', 'embedding'])
  ),
  CONSTRAINT knowledge_memory_lifecycle_events_revert_shape_chk CHECK (
    (action = 'apply' AND reverts_event_id IS NULL)
    OR (action = 'revert' AND reverts_event_id IS NOT NULL)
  ),
  CONSTRAINT knowledge_memory_lifecycle_events_operation_action_uq
    UNIQUE (workspace_id, operation_id, action),
  CONSTRAINT knowledge_memory_lifecycle_events_workspace_id_uq
    UNIQUE (workspace_id, id)
);

CREATE UNIQUE INDEX knowledge_memory_lifecycle_events_one_revert_uq
  ON knowledge_memory_lifecycle_events(reverts_event_id)
  WHERE reverts_event_id IS NOT NULL;
CREATE INDEX knowledge_memory_lifecycle_events_target_timeline_idx
  ON knowledge_memory_lifecycle_events(workspace_id, target_memory_id, created_at DESC, id);
CREATE INDEX knowledge_memory_lifecycle_events_actor_timeline_idx
  ON knowledge_memory_lifecycle_events(
    workspace_id, actor_kind, actor_subject_id, created_at DESC, id
  );

CREATE TABLE knowledge_memory_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source_memory_id uuid NOT NULL,
  target_memory_id uuid NOT NULL,
  relationship_type text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by_event_id uuid NOT NULL,
  removed_by_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  removed_at timestamptz,
  CONSTRAINT knowledge_memory_relationships_workspace_account_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_memory_relationships_source_fk
    FOREIGN KEY (workspace_id, source_memory_id)
    REFERENCES knowledge_memories(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_memory_relationships_target_fk
    FOREIGN KEY (workspace_id, target_memory_id)
    REFERENCES knowledge_memories(workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_memory_relationships_created_event_fk
    FOREIGN KEY (workspace_id, created_by_event_id)
    REFERENCES knowledge_memory_lifecycle_events(workspace_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT knowledge_memory_relationships_removed_event_fk
    FOREIGN KEY (workspace_id, removed_by_event_id)
    REFERENCES knowledge_memory_lifecycle_events(workspace_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT knowledge_memory_relationships_type_chk CHECK (
    relationship_type IN (
      'derived_from', 'supersedes', 'corrects', 'conflicts_with',
      'related_to', 'depends_on', 'applies_to'
    )
  ),
  CONSTRAINT knowledge_memory_relationships_distinct_chk
    CHECK (source_memory_id <> target_memory_id),
  CONSTRAINT knowledge_memory_relationships_version_chk CHECK (version > 0),
  CONSTRAINT knowledge_memory_relationships_removed_shape_chk CHECK (
    (removed_by_event_id IS NULL AND removed_at IS NULL)
    OR (removed_by_event_id IS NOT NULL AND removed_at IS NOT NULL)
  ),
  CONSTRAINT knowledge_memory_relationships_workspace_id_uq
    UNIQUE (workspace_id, id)
);

ALTER TABLE knowledge_memory_lifecycle_events
  ADD CONSTRAINT knowledge_memory_lifecycle_events_relationship_fk
  FOREIGN KEY (workspace_id, relationship_id)
  REFERENCES knowledge_memory_relationships(workspace_id, id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX knowledge_memory_relationships_active_edge_uq
  ON knowledge_memory_relationships(
    workspace_id, source_memory_id, target_memory_id, relationship_type
  ) WHERE removed_by_event_id IS NULL;
CREATE UNIQUE INDEX knowledge_memory_relationships_active_symmetric_edge_uq
  ON knowledge_memory_relationships(
    workspace_id, relationship_type,
    LEAST(source_memory_id, target_memory_id),
    GREATEST(source_memory_id, target_memory_id)
  ) WHERE removed_by_event_id IS NULL
    AND relationship_type IN ('conflicts_with', 'related_to');
CREATE INDEX knowledge_memory_relationships_source_idx
  ON knowledge_memory_relationships(workspace_id, source_memory_id, created_at DESC, id);
CREATE INDEX knowledge_memory_relationships_target_idx
  ON knowledge_memory_relationships(workspace_id, target_memory_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION opengeni_private.immutable_memory_lifecycle_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'knowledge memory lifecycle events are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER knowledge_memory_lifecycle_events_immutable
BEFORE UPDATE OR DELETE ON knowledge_memory_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION opengeni_private.immutable_memory_lifecycle_event();

CREATE OR REPLACE FUNCTION opengeni_private.knowledge_memory_relationship_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF nullif(current_setting('opengeni.memory_lifecycle_operation', true), '') IS DISTINCT FROM '1'
  THEN
    RAISE EXCEPTION 'knowledge memory relationships mutate only through lifecycle operations'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge memory relationships are retained and retired, never deleted'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW.id, NEW.account_id, NEW.workspace_id, NEW.source_memory_id,
    NEW.target_memory_id, NEW.relationship_type, NEW.created_by_event_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.account_id, OLD.workspace_id, OLD.source_memory_id,
    OLD.target_memory_id, OLD.relationship_type, OLD.created_by_event_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'knowledge memory relationship identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_memory_relationships_guard
BEFORE UPDATE OR DELETE ON knowledge_memory_relationships
FOR EACH ROW EXECUTE FUNCTION opengeni_private.knowledge_memory_relationship_guard();

CREATE OR REPLACE FUNCTION opengeni_private.current_memory_role_key()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('opengeni.memory_role_key', true), '');
$$;

CREATE OR REPLACE FUNCTION opengeni_private.current_memory_session_id()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('opengeni.memory_session_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION opengeni_private.current_memory_actor_kind()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('opengeni.memory_actor_kind', true), '');
$$;

CREATE OR REPLACE FUNCTION opengeni_private.current_memory_actor_id()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('opengeni.memory_actor_id', true), '');
$$;

-- Stable JSON bytes must match packages/contracts stableJson(): recursively
-- sort object keys, preserve array order, and emit compact JSON. Recompute plan
-- hashes inside PostgreSQL so the runtime role cannot forge audit identity.
DO $plan_hash_functions$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.knowledge_memory_stable_jsonb(p_value jsonb)
    RETURNS text
    LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog
    AS $body$
    DECLARE rendered text;
    BEGIN
      CASE jsonb_typeof(p_value)
        WHEN 'object' THEN
          SELECT '{' || coalesce(string_agg(
            to_jsonb(entry.key)::text || ':' || %1$I.knowledge_memory_stable_jsonb(entry.value),
            ',' ORDER BY entry.key COLLATE "C"
          ), '') || '}'
          INTO rendered
          FROM jsonb_each(p_value) AS entry;
        WHEN 'array' THEN
          SELECT '[' || coalesce(string_agg(
            %1$I.knowledge_memory_stable_jsonb(entry.value),
            ',' ORDER BY entry.ordinality
          ), '') || ']'
          INTO rendered
          FROM jsonb_array_elements(p_value) WITH ORDINALITY AS entry(value, ordinality);
        ELSE
          rendered := p_value::text;
      END CASE;
      RETURN rendered;
    END;
    $body$;

    CREATE OR REPLACE FUNCTION %1$I.knowledge_memory_plan_hash(p_value jsonb)
    RETURNS text
    LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog
    AS $body$
      SELECT encode(sha256(convert_to(
        %1$I.knowledge_memory_stable_jsonb(p_value), 'UTF8'
      )), 'hex');
    $body$;
  $ddl$, target_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.knowledge_memory_stable_jsonb(jsonb) FROM PUBLIC',
    target_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.knowledge_memory_plan_hash(jsonb) FROM PUBLIC',
    target_schema
  );
END
$plan_hash_functions$;

CREATE OR REPLACE FUNCTION opengeni_private.memory_scope_authorized(
  row_scope_type text,
  row_subject_id text,
  row_role_key text,
  row_session_id uuid
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(CASE row_scope_type
    WHEN 'workspace' THEN true
    WHEN 'user' THEN row_subject_id = opengeni_private.current_subject_id()
    WHEN 'role' THEN row_role_key = opengeni_private.current_memory_role_key()
    WHEN 'session' THEN row_session_id = opengeni_private.current_memory_session_id()
    WHEN 'ephemeral' THEN row_session_id = opengeni_private.current_memory_session_id()
    WHEN 'legacy' THEN false
    ELSE false
  END, false);
$$;

CREATE OR REPLACE FUNCTION opengeni_private.memory_scope_visible(
  row_scope_type text,
  row_subject_id text,
  row_role_key text,
  row_session_id uuid,
  row_valid_from timestamptz,
  row_valid_until timestamptz
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT opengeni_private.memory_scope_authorized(
    row_scope_type, row_subject_id, row_role_key, row_session_id
  ) AND (
    row_scope_type <> 'ephemeral'
    OR (
      row_valid_from <= transaction_timestamp()
      AND row_valid_until > transaction_timestamp()
    )
  );
$$;

DROP POLICY IF EXISTS workspace_isolation ON knowledge_memories;
CREATE POLICY workspace_isolation ON knowledge_memories
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND opengeni_private.memory_scope_visible(
      scope_type, scope_subject_id, scope_role_key, scope_session_id, valid_from, valid_until
    )
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND opengeni_private.memory_scope_visible(
      scope_type, scope_subject_id, scope_role_key, scope_session_id, valid_from, valid_until
    )
  );

ALTER TABLE knowledge_memory_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_memory_relationships FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON knowledge_memory_relationships
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND EXISTS (
      SELECT 1 FROM knowledge_memories source
      WHERE source.workspace_id = knowledge_memory_relationships.workspace_id
        AND source.id = knowledge_memory_relationships.source_memory_id
    )
    AND EXISTS (
      SELECT 1 FROM knowledge_memories target
      WHERE target.workspace_id = knowledge_memory_relationships.workspace_id
        AND target.id = knowledge_memory_relationships.target_memory_id
    )
  );

ALTER TABLE knowledge_memory_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_memory_lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON knowledge_memory_lifecycle_events
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND actor_kind = opengeni_private.current_memory_actor_kind()
    AND actor_subject_id = opengeni_private.current_memory_actor_id()
  );

DO $apply_function$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.knowledge_memory_apply_operation(
      p_plan jsonb,
      p_plan_hash text,
      p_actor_kind text,
      p_actor_subject_id text,
      p_actor_session_id uuid,
      p_actor_turn_id uuid,
      p_actor_attempt_id uuid,
      p_actor_execution_generation integer
    ) RETURNS TABLE (event_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_catalog
    AS $body$
    DECLARE
      context_account_id uuid := nullif(current_setting('opengeni.account_id', true), '')::uuid;
      context_workspace_id uuid := nullif(current_setting('opengeni.workspace_id', true), '')::uuid;
      v_operation_id uuid;
      operation_type text;
      target_id uuid;
      related_id uuid;
      expected_target_version integer;
      expected_related_version integer;
      v_relationship_type text;
      relationship_id uuid;
      new_scope jsonb;
      new_scope_type text;
      new_scope_subject_id text;
      new_scope_role_key text;
      new_scope_session_id uuid;
      new_valid_until timestamptz;
      new_namespace text;
      new_labels text[];
      target record;
      related record;
      relationship record;
      before_state jsonb;
      after_state jsonb;
      new_event_id uuid := gen_random_uuid();
      authority_role_key text;
      existing_event record;
    BEGIN
      IF jsonb_typeof(p_plan) IS DISTINCT FROM 'object'
        OR p_plan_hash !~ '^[a-f0-9]{64}$'
        OR p_plan_hash IS DISTINCT FROM knowledge_memory_plan_hash(p_plan)
        OR p_actor_kind NOT IN ('subject', 'service')
        OR length(btrim(p_actor_subject_id)) NOT BETWEEN 1 AND 1024
      THEN
        RAISE EXCEPTION 'memory operation plan or actor is invalid' USING ERRCODE = '22023';
      END IF;
      IF context_account_id IS NULL OR context_workspace_id IS NULL
        OR opengeni_private.current_memory_actor_kind() IS DISTINCT FROM p_actor_kind
        OR opengeni_private.current_memory_actor_id() IS DISTINCT FROM p_actor_subject_id
        OR (p_actor_kind = 'subject'
          AND opengeni_private.current_subject_id() IS DISTINCT FROM p_actor_subject_id)
        OR (p_actor_kind = 'service' AND opengeni_private.current_subject_id() IS NOT NULL)
      THEN
        RAISE EXCEPTION 'memory operation requires exact transaction-local actor authority'
          USING ERRCODE = '42501';
      END IF;

      IF (p_actor_session_id IS NULL) <> (p_actor_turn_id IS NULL)
        OR (p_actor_session_id IS NULL) <> (p_actor_attempt_id IS NULL)
        OR (p_actor_session_id IS NULL) <> (p_actor_execution_generation IS NULL)
      THEN
        RAISE EXCEPTION 'memory operation attempt provenance is partial' USING ERRCODE = '22023';
      END IF;
      IF p_actor_session_id IS NOT NULL THEN
        SELECT session.metadata ->> 'memoryRoleKey' INTO authority_role_key
        FROM workspaces workspace
        JOIN sessions session
          ON session.account_id = workspace.account_id
         AND session.workspace_id = workspace.id
        JOIN session_turns turn
          ON turn.account_id = session.account_id
         AND turn.workspace_id = session.workspace_id
         AND turn.session_id = session.id
        JOIN session_turn_attempts attempt
          ON attempt.account_id = turn.account_id
         AND attempt.workspace_id = turn.workspace_id
         AND attempt.session_id = turn.session_id
         AND attempt.turn_id = turn.id
        WHERE workspace.account_id = context_account_id
          AND workspace.id = context_workspace_id
          AND session.id = p_actor_session_id
          AND session.active_turn_id = p_actor_turn_id
          AND turn.id = p_actor_turn_id
          AND turn.active_attempt_id = p_actor_attempt_id
          AND turn.execution_generation = p_actor_execution_generation
          AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
          AND turn.initiator_kind = p_actor_kind
          AND turn.initiator_subject_id = p_actor_subject_id
          AND attempt.id = p_actor_attempt_id
          AND attempt.execution_generation = p_actor_execution_generation
          AND attempt.state IN ('claimed', 'running')
          AND NOT EXISTS (
            SELECT 1 FROM session_attempt_interruptions interruption
            WHERE interruption.workspace_id = attempt.workspace_id
              AND interruption.attempt_id = attempt.id
              AND interruption.state IN ('pending', 'delivered', 'acknowledged')
          )
        FOR KEY SHARE OF workspace
        FOR SHARE OF session, turn
        FOR UPDATE OF attempt;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'memory operation attempt authority is stale or invalid'
            USING ERRCODE = '42501';
        END IF;
        IF authority_role_key IS NOT NULL AND (
          authority_role_key IS DISTINCT FROM lower(btrim(authority_role_key))
          OR length(authority_role_key) NOT BETWEEN 1 AND 64
          OR authority_role_key !~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$'
        ) THEN
          RAISE EXCEPTION 'persisted memory role authority is invalid' USING ERRCODE = '42501';
        END IF;
        IF opengeni_private.current_memory_session_id() IS DISTINCT FROM p_actor_session_id
          OR opengeni_private.current_memory_role_key() IS DISTINCT FROM authority_role_key
        THEN
          RAISE EXCEPTION 'memory operation session or role context is not exact'
            USING ERRCODE = '42501';
        END IF;
      ELSIF opengeni_private.current_memory_session_id() IS NOT NULL
        OR opengeni_private.current_memory_role_key() IS NOT NULL
      THEN
        RAISE EXCEPTION 'direct memory authority cannot carry session or role context'
          USING ERRCODE = '42501';
      END IF;
      IF p_actor_session_id IS NOT NULL AND p_actor_execution_generation < 1 THEN
        RAISE EXCEPTION 'memory operation attempt generation is invalid' USING ERRCODE = '22023';
      END IF;
      IF p_actor_session_id IS NULL AND (
        p_actor_turn_id IS NOT NULL OR p_actor_attempt_id IS NOT NULL
        OR p_actor_execution_generation IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'memory operation direct authority has attempt provenance'
          USING ERRCODE = '22023';
      END IF;
      IF p_actor_session_id IS NULL AND p_actor_kind = 'service'
        AND opengeni_private.current_subject_id() IS NOT NULL
      THEN
        RAISE EXCEPTION 'service memory authority cannot carry human subject context'
          USING ERRCODE = '42501';
      END IF;
      IF p_actor_session_id IS NULL AND p_actor_kind = 'subject'
        AND opengeni_private.current_subject_id() IS DISTINCT FROM p_actor_subject_id
      THEN
        RAISE EXCEPTION 'subject memory authority is not exact' USING ERRCODE = '42501';
      END IF;

      v_operation_id := (p_plan->>'operationId')::uuid;
      operation_type := p_plan->>'operationType';
      target_id := (p_plan->>'targetMemoryId')::uuid;
      expected_target_version := (p_plan->>'expectedTargetVersion')::integer;
      IF operation_type NOT IN (
        'reclassify', 'archive', 'relationship_add', 'relationship_remove',
        'supersede', 'correct'
      ) OR expected_target_version < 1 THEN
        RAISE EXCEPTION 'memory operation type or target version is invalid'
          USING ERRCODE = '22023';
      END IF;

      SELECT event.* INTO existing_event
      FROM knowledge_memory_lifecycle_events event
      WHERE event.workspace_id = context_workspace_id
        AND event.operation_id = v_operation_id
        AND event.action = 'apply';
      IF FOUND THEN
        IF existing_event.plan_hash IS DISTINCT FROM p_plan_hash
          OR existing_event.actor_kind IS DISTINCT FROM p_actor_kind
          OR existing_event.actor_subject_id IS DISTINCT FROM p_actor_subject_id
          OR existing_event.actor_session_id IS DISTINCT FROM p_actor_session_id
          OR existing_event.actor_turn_id IS DISTINCT FROM p_actor_turn_id
          OR existing_event.actor_attempt_id IS DISTINCT FROM p_actor_attempt_id
          OR existing_event.actor_execution_generation
            IS DISTINCT FROM p_actor_execution_generation
        THEN
          RAISE EXCEPTION 'memory operation id already identifies different immutable evidence'
            USING ERRCODE = '23505';
        END IF;
        RETURN QUERY SELECT existing_event.id;
        RETURN;
      END IF;

      IF operation_type IN ('relationship_add', 'relationship_remove', 'supersede', 'correct') THEN
        related_id := (p_plan->>'relatedMemoryId')::uuid;
        expected_related_version := (p_plan->>'expectedRelatedVersion')::integer;
        IF related_id IS NULL OR related_id = target_id OR expected_related_version < 1 THEN
          RAISE EXCEPTION 'memory relationship operation requires a distinct related memory'
            USING ERRCODE = '22023';
        END IF;
        PERFORM 1 FROM knowledge_memories candidate
        WHERE candidate.id IN (target_id, related_id)
          AND candidate.account_id = context_account_id
          AND candidate.workspace_id = context_workspace_id
        ORDER BY candidate.id FOR UPDATE;
      ELSE
        PERFORM 1 FROM knowledge_memories candidate
        WHERE candidate.id = target_id
          AND candidate.account_id = context_account_id
          AND candidate.workspace_id = context_workspace_id
        FOR UPDATE;
      END IF;

      SELECT * INTO target FROM knowledge_memories
      WHERE account_id = context_account_id AND workspace_id = context_workspace_id AND id = target_id;
      IF NOT FOUND OR NOT opengeni_private.memory_scope_visible(
        target.scope_type, target.scope_subject_id, target.scope_role_key, target.scope_session_id,
        target.valid_from, target.valid_until
      ) THEN
        RAISE EXCEPTION 'target memory is not visible to this authority' USING ERRCODE = '42501';
      END IF;
      IF target.memory_version <> expected_target_version THEN
        RAISE EXCEPTION 'target memory version changed' USING ERRCODE = '40001';
      END IF;

      IF related_id IS NOT NULL THEN
        SELECT * INTO related FROM knowledge_memories
        WHERE account_id = context_account_id AND workspace_id = context_workspace_id AND id = related_id;
        IF NOT FOUND OR NOT opengeni_private.memory_scope_visible(
          related.scope_type, related.scope_subject_id, related.scope_role_key,
          related.scope_session_id, related.valid_from, related.valid_until
        ) THEN
          RAISE EXCEPTION 'related memory is not visible to this authority' USING ERRCODE = '42501';
        END IF;
        IF related.memory_version <> expected_related_version THEN
          RAISE EXCEPTION 'related memory version changed' USING ERRCODE = '40001';
        END IF;
      END IF;

      before_state := jsonb_build_object(
        'memoryVersion', target.memory_version,
        'status', target.status,
        'scopeType', target.scope_type,
        'scopeSubjectId', target.scope_subject_id,
        'scopeRoleKey', target.scope_role_key,
        'scopeSessionId', target.scope_session_id,
        'namespace', target.namespace_key,
        'labels', to_jsonb(target.labels),
        'validUntil', target.valid_until,
        'supersedesId', target.supersedes_id,
        'supersededById', target.superseded_by_id
      );

      PERFORM set_config('opengeni.memory_lifecycle_operation', '1', true);

      IF operation_type = 'reclassify' THEN
        new_scope := p_plan->'scope';
        new_scope_type := new_scope->>'type';
        new_scope_subject_id := nullif(new_scope->>'subjectId', '');
        new_scope_role_key := nullif(new_scope->>'roleKey', '');
        new_scope_session_id := nullif(new_scope->>'sessionId', '')::uuid;
        new_valid_until := nullif(new_scope->>'validUntil', '')::timestamptz;
        new_namespace := p_plan->>'namespace';
        SELECT coalesce(array_agg(label ORDER BY label), '{}'::text[]) INTO new_labels
        FROM jsonb_array_elements_text(coalesce(p_plan->'labels', '[]'::jsonb)) AS label;
        IF new_scope_type = 'legacy' OR NOT coalesce((CASE new_scope_type
          WHEN 'workspace' THEN true
          WHEN 'user' THEN new_scope_subject_id = opengeni_private.current_subject_id()
          WHEN 'role' THEN new_scope_role_key = opengeni_private.current_memory_role_key()
          WHEN 'session' THEN new_scope_session_id = opengeni_private.current_memory_session_id()
          WHEN 'ephemeral' THEN
            new_scope_session_id = opengeni_private.current_memory_session_id()
            AND new_valid_until > transaction_timestamp()
          ELSE false
        END), false)
        THEN
          RAISE EXCEPTION 'new memory scope is not writable by this authority'
            USING ERRCODE = '42501';
        END IF;
        UPDATE knowledge_memories SET
          scope = new_scope_type,
          scope_type = new_scope_type,
          scope_subject_id = new_scope_subject_id,
          scope_role_key = new_scope_role_key,
          scope_session_id = new_scope_session_id,
          namespace_key = new_namespace,
          labels = new_labels,
          valid_until = CASE WHEN new_scope_type = 'ephemeral' THEN new_valid_until ELSE NULL END,
          updated_at = transaction_timestamp()
        WHERE id = target_id;
      ELSIF operation_type = 'archive' THEN
        IF target.status NOT IN ('proposed', 'approved', 'active') THEN
          RAISE EXCEPTION 'only a live memory may be archived' USING ERRCODE = '22023';
        END IF;
        UPDATE knowledge_memories SET
          status = 'archived',
          valid_until = coalesce(valid_until, transaction_timestamp()),
          updated_at = transaction_timestamp()
        WHERE id = target_id;
      ELSIF operation_type IN ('relationship_add', 'relationship_remove') THEN
        v_relationship_type := p_plan->>'relationshipType';
        IF v_relationship_type NOT IN (
          'derived_from', 'supersedes', 'corrects', 'conflicts_with',
          'related_to', 'depends_on', 'applies_to'
        ) THEN
          RAISE EXCEPTION 'memory relationship type is invalid' USING ERRCODE = '22023';
        END IF;
        IF v_relationship_type IN ('conflicts_with', 'related_to') AND related_id < target_id THEN
          RAISE EXCEPTION 'symmetric memory relationship endpoints are not canonical'
            USING ERRCODE = '22023';
        END IF;
        IF operation_type = 'relationship_add' THEN
          relationship_id := gen_random_uuid();
          INSERT INTO knowledge_memory_relationships (
            id, account_id, workspace_id, source_memory_id, target_memory_id,
            relationship_type, created_by_event_id
          ) VALUES (
            relationship_id, context_account_id, context_workspace_id, target_id, related_id,
            v_relationship_type, new_event_id
          );
          before_state := jsonb_build_object('active', false, 'relationshipId', relationship_id);
          after_state := jsonb_build_object(
            'active', true, 'relationshipId', relationship_id, 'relationshipVersion', 1
          );
        ELSE
          SELECT * INTO relationship
          FROM knowledge_memory_relationships edge
          WHERE edge.workspace_id = context_workspace_id
            AND edge.source_memory_id = target_id
            AND edge.target_memory_id = related_id
            AND edge.relationship_type = v_relationship_type
            AND edge.removed_by_event_id IS NULL
          FOR UPDATE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'active memory relationship was not found' USING ERRCODE = '02000';
          END IF;
          relationship_id := relationship.id;
          before_state := jsonb_build_object(
            'active', true, 'relationshipId', relationship.id,
            'relationshipVersion', relationship.version
          );
          UPDATE knowledge_memory_relationships SET
            removed_by_event_id = new_event_id,
            removed_at = transaction_timestamp()
          WHERE id = relationship.id
          RETURNING * INTO relationship;
          after_state := jsonb_build_object(
            'active', false, 'relationshipId', relationship.id,
            'relationshipVersion', relationship.version
          );
        END IF;
      ELSE
        v_relationship_type := CASE
          WHEN operation_type = 'correct' THEN 'corrects'
          ELSE 'supersedes'
        END;
        IF target.status NOT IN ('proposed', 'approved', 'active')
          OR related.status NOT IN ('approved', 'active')
        THEN
          RAISE EXCEPTION 'supersession requires a live source and visible replacement'
            USING ERRCODE = '22023';
        END IF;
        IF ROW(target.scope_type, target.scope_subject_id, target.scope_role_key, target.scope_session_id)
          IS DISTINCT FROM ROW(
            related.scope_type, related.scope_subject_id, related.scope_role_key, related.scope_session_id
          )
        THEN
          RAISE EXCEPTION 'supersession cannot widen or change memory scope'
            USING ERRCODE = '42501';
        END IF;
        before_state := jsonb_build_object(
          'target', before_state,
          'related', jsonb_build_object(
            'memoryVersion', related.memory_version,
            'status', related.status,
            'scopeType', related.scope_type,
            'scopeSubjectId', related.scope_subject_id,
            'scopeRoleKey', related.scope_role_key,
            'scopeSessionId', related.scope_session_id,
            'namespace', related.namespace_key,
            'labels', to_jsonb(related.labels),
            'validUntil', related.valid_until,
            'supersedesId', related.supersedes_id,
            'supersededById', related.superseded_by_id
          )
        );
        UPDATE knowledge_memories SET
          status = 'superseded',
          superseded_by_id = related_id,
          valid_until = coalesce(valid_until, transaction_timestamp()),
          updated_at = transaction_timestamp()
        WHERE id = target_id;
        UPDATE knowledge_memories SET
          supersedes_id = target_id,
          updated_at = transaction_timestamp()
        WHERE id = related_id;
        relationship_id := gen_random_uuid();
        INSERT INTO knowledge_memory_relationships (
          id, account_id, workspace_id, source_memory_id, target_memory_id,
          relationship_type, created_by_event_id
        ) VALUES (
          relationship_id, context_account_id, context_workspace_id, related_id, target_id,
          v_relationship_type, new_event_id
        );
      END IF;

      IF operation_type NOT IN ('relationship_add', 'relationship_remove') THEN
        SELECT * INTO target FROM knowledge_memories WHERE id = target_id;
        after_state := jsonb_build_object(
          'memoryVersion', target.memory_version,
          'status', target.status,
          'scopeType', target.scope_type,
          'scopeSubjectId', target.scope_subject_id,
          'scopeRoleKey', target.scope_role_key,
          'scopeSessionId', target.scope_session_id,
          'namespace', target.namespace_key,
          'labels', to_jsonb(target.labels),
          'validUntil', target.valid_until,
          'supersedesId', target.supersedes_id,
          'supersededById', target.superseded_by_id
        );
        IF operation_type IN ('supersede', 'correct') THEN
          SELECT * INTO related FROM knowledge_memories WHERE id = related_id;
          after_state := jsonb_build_object(
            'target', after_state,
            'related', jsonb_build_object(
              'memoryVersion', related.memory_version,
              'status', related.status,
              'scopeType', related.scope_type,
              'scopeSubjectId', related.scope_subject_id,
              'scopeRoleKey', related.scope_role_key,
              'scopeSessionId', related.scope_session_id,
              'namespace', related.namespace_key,
              'labels', to_jsonb(related.labels),
              'validUntil', related.valid_until,
              'supersedesId', related.supersedes_id,
              'supersededById', related.superseded_by_id
            ),
            'relationship', jsonb_build_object(
              'active', true, 'relationshipId', relationship_id, 'relationshipVersion', 1
            )
          );
          before_state := before_state || jsonb_build_object('relationship', NULL);
        END IF;
      END IF;

      INSERT INTO knowledge_memory_lifecycle_events (
        id, account_id, workspace_id, operation_id, action, operation_type,
        target_memory_id, related_memory_id, relationship_id, relationship_type,
        actor_kind, actor_subject_id, actor_session_id, actor_turn_id,
        actor_attempt_id, actor_execution_generation, plan_hash, before_state, after_state
      ) VALUES (
        new_event_id, context_account_id, context_workspace_id, v_operation_id, 'apply', operation_type,
        target_id, related_id, relationship_id, v_relationship_type,
        p_actor_kind, p_actor_subject_id, p_actor_session_id, p_actor_turn_id,
        p_actor_attempt_id, p_actor_execution_generation, p_plan_hash, before_state, after_state
      );

      RETURN QUERY SELECT new_event_id;
    END;
    $body$;
  $ddl$, target_schema, target_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.knowledge_memory_apply_operation(jsonb, text, text, text, uuid, uuid, uuid, integer) FROM PUBLIC',
    target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.knowledge_memory_apply_operation(jsonb, text, text, text, uuid, uuid, uuid, integer) TO opengeni_app',
      target_schema
    );
  END IF;
END
$apply_function$;

DO $revert_function$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.knowledge_memory_revert_operation(
      p_operation_id uuid,
      p_applied_operation_id uuid,
      p_plan_hash text,
      p_actor_kind text,
      p_actor_subject_id text,
      p_actor_session_id uuid,
      p_actor_turn_id uuid,
      p_actor_attempt_id uuid,
      p_actor_execution_generation integer
    ) RETURNS TABLE (event_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_catalog
    AS $body$
    DECLARE
      context_account_id uuid := nullif(current_setting('opengeni.account_id', true), '')::uuid;
      context_workspace_id uuid := nullif(current_setting('opengeni.workspace_id', true), '')::uuid;
      applied record;
      existing_event record;
      target record;
      related record;
      relationship record;
      restored jsonb;
      revert_before jsonb;
      revert_after jsonb;
      new_event_id uuid := gen_random_uuid();
      authority_role_key text;
    BEGIN
      IF p_operation_id IS NULL OR p_applied_operation_id IS NULL
        OR p_plan_hash !~ '^[a-f0-9]{64}$'
        OR p_plan_hash IS DISTINCT FROM knowledge_memory_plan_hash(jsonb_build_object(
          'operationId', p_operation_id,
          'appliedOperationId', p_applied_operation_id
        ))
      THEN
        RAISE EXCEPTION 'memory revert plan or hash is invalid' USING ERRCODE = '22023';
      END IF;
      IF context_account_id IS NULL OR context_workspace_id IS NULL
        OR p_actor_kind NOT IN ('subject', 'service')
        OR length(btrim(p_actor_subject_id)) NOT BETWEEN 1 AND 1024
        OR opengeni_private.current_memory_actor_kind() IS DISTINCT FROM p_actor_kind
        OR opengeni_private.current_memory_actor_id() IS DISTINCT FROM p_actor_subject_id
        OR (p_actor_kind = 'subject'
          AND opengeni_private.current_subject_id() IS DISTINCT FROM p_actor_subject_id)
        OR (p_actor_kind = 'service' AND opengeni_private.current_subject_id() IS NOT NULL)
      THEN
        RAISE EXCEPTION 'memory revert requires exact transaction-local actor authority'
          USING ERRCODE = '42501';
      END IF;

      IF (p_actor_session_id IS NULL) <> (p_actor_turn_id IS NULL)
        OR (p_actor_session_id IS NULL) <> (p_actor_attempt_id IS NULL)
        OR (p_actor_session_id IS NULL) <> (p_actor_execution_generation IS NULL)
      THEN
        RAISE EXCEPTION 'memory revert attempt provenance is partial' USING ERRCODE = '22023';
      END IF;
      IF p_actor_session_id IS NOT NULL THEN
        SELECT session.metadata ->> 'memoryRoleKey' INTO authority_role_key
        FROM workspaces workspace
        JOIN sessions session
          ON session.account_id = workspace.account_id
         AND session.workspace_id = workspace.id
        JOIN session_turns turn
          ON turn.account_id = session.account_id
         AND turn.workspace_id = session.workspace_id
         AND turn.session_id = session.id
        JOIN session_turn_attempts attempt
          ON attempt.account_id = turn.account_id
         AND attempt.workspace_id = turn.workspace_id
         AND attempt.session_id = turn.session_id
         AND attempt.turn_id = turn.id
        WHERE workspace.account_id = context_account_id
          AND workspace.id = context_workspace_id
          AND session.id = p_actor_session_id
          AND session.active_turn_id = p_actor_turn_id
          AND turn.id = p_actor_turn_id
          AND turn.active_attempt_id = p_actor_attempt_id
          AND turn.execution_generation = p_actor_execution_generation
          AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
          AND turn.initiator_kind = p_actor_kind
          AND turn.initiator_subject_id = p_actor_subject_id
          AND attempt.id = p_actor_attempt_id
          AND attempt.execution_generation = p_actor_execution_generation
          AND attempt.state IN ('claimed', 'running')
          AND NOT EXISTS (
            SELECT 1 FROM session_attempt_interruptions interruption
            WHERE interruption.workspace_id = attempt.workspace_id
              AND interruption.attempt_id = attempt.id
              AND interruption.state IN ('pending', 'delivered', 'acknowledged')
          )
        FOR KEY SHARE OF workspace
        FOR SHARE OF session, turn
        FOR UPDATE OF attempt;
        IF NOT FOUND OR p_actor_execution_generation < 1 THEN
          RAISE EXCEPTION 'memory revert attempt authority is stale or invalid'
            USING ERRCODE = '42501';
        END IF;
        IF authority_role_key IS NOT NULL AND (
          authority_role_key IS DISTINCT FROM lower(btrim(authority_role_key))
          OR length(authority_role_key) NOT BETWEEN 1 AND 64
          OR authority_role_key !~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$'
        ) THEN
          RAISE EXCEPTION 'persisted memory role authority is invalid' USING ERRCODE = '42501';
        END IF;
        IF opengeni_private.current_memory_session_id() IS DISTINCT FROM p_actor_session_id
          OR opengeni_private.current_memory_role_key() IS DISTINCT FROM authority_role_key
        THEN
          RAISE EXCEPTION 'memory revert session or role context is not exact'
            USING ERRCODE = '42501';
        END IF;
      ELSIF opengeni_private.current_memory_session_id() IS NOT NULL
        OR opengeni_private.current_memory_role_key() IS NOT NULL
      THEN
        RAISE EXCEPTION 'direct memory revert authority cannot carry session or role context'
          USING ERRCODE = '42501';
      END IF;

      SELECT event.* INTO existing_event
      FROM knowledge_memory_lifecycle_events event
      WHERE event.workspace_id = context_workspace_id
        AND event.operation_id = p_operation_id
        AND event.action = 'revert';
      IF FOUND THEN
        IF existing_event.plan_hash IS DISTINCT FROM p_plan_hash
          OR existing_event.actor_kind IS DISTINCT FROM p_actor_kind
          OR existing_event.actor_subject_id IS DISTINCT FROM p_actor_subject_id
          OR existing_event.actor_session_id IS DISTINCT FROM p_actor_session_id
          OR existing_event.actor_turn_id IS DISTINCT FROM p_actor_turn_id
          OR existing_event.actor_attempt_id IS DISTINCT FROM p_actor_attempt_id
          OR existing_event.actor_execution_generation
            IS DISTINCT FROM p_actor_execution_generation
          OR existing_event.reverts_event_id IS DISTINCT FROM (
            SELECT event.id FROM knowledge_memory_lifecycle_events event
            WHERE event.workspace_id = context_workspace_id
              AND event.operation_id = p_applied_operation_id
              AND event.action = 'apply'
          )
        THEN
          RAISE EXCEPTION 'memory revert id already identifies different immutable evidence'
            USING ERRCODE = '23505';
        END IF;
        RETURN QUERY SELECT existing_event.id;
        RETURN;
      END IF;

      SELECT event.* INTO applied
      FROM knowledge_memory_lifecycle_events event
      WHERE event.account_id = context_account_id
        AND event.workspace_id = context_workspace_id
        AND event.operation_id = p_applied_operation_id
        AND event.action = 'apply'
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'applied memory operation was not found' USING ERRCODE = '02000';
      END IF;
      IF applied.actor_kind IS DISTINCT FROM p_actor_kind
        OR applied.actor_subject_id IS DISTINCT FROM p_actor_subject_id
      THEN
        RAISE EXCEPTION 'memory revert requires the same immutable actor authority'
          USING ERRCODE = '42501';
      END IF;
      IF EXISTS (
        SELECT 1 FROM knowledge_memory_lifecycle_events event
        WHERE event.reverts_event_id = applied.id
      ) THEN
        RAISE EXCEPTION 'memory operation was already reverted' USING ERRCODE = '23505';
      END IF;

      SELECT * INTO target FROM knowledge_memories
      WHERE id = applied.target_memory_id
        AND account_id = context_account_id
        AND workspace_id = context_workspace_id;
      IF NOT FOUND OR NOT opengeni_private.memory_scope_authorized(
        target.scope_type, target.scope_subject_id, target.scope_role_key, target.scope_session_id
      ) THEN
        RAISE EXCEPTION 'reverted target memory is not authorized for this actor'
          USING ERRCODE = '42501';
      END IF;
      IF applied.related_memory_id IS NOT NULL THEN
        SELECT * INTO related FROM knowledge_memories
        WHERE id = applied.related_memory_id
          AND account_id = context_account_id
          AND workspace_id = context_workspace_id;
        IF NOT FOUND OR NOT opengeni_private.memory_scope_authorized(
          related.scope_type, related.scope_subject_id,
          related.scope_role_key, related.scope_session_id
        ) THEN
          RAISE EXCEPTION 'reverted related memory is not authorized for this actor'
            USING ERRCODE = '42501';
        END IF;
      END IF;

      PERFORM set_config('opengeni.memory_lifecycle_operation', '1', true);

      IF applied.operation_type IN ('reclassify', 'archive') THEN
        SELECT * INTO target FROM knowledge_memories
        WHERE id = applied.target_memory_id AND account_id = context_account_id
          AND workspace_id = context_workspace_id FOR UPDATE;
        IF target.memory_version <> (applied.after_state->>'memoryVersion')::integer THEN
          RAISE EXCEPTION 'memory changed after the applied operation' USING ERRCODE = '40001';
        END IF;
        revert_before := applied.after_state;
        restored := applied.before_state;
        UPDATE knowledge_memories SET
          status = restored->>'status',
          scope = restored->>'scopeType',
          scope_type = restored->>'scopeType',
          scope_subject_id = nullif(restored->>'scopeSubjectId', ''),
          scope_role_key = nullif(restored->>'scopeRoleKey', ''),
          scope_session_id = nullif(restored->>'scopeSessionId', '')::uuid,
          namespace_key = restored->>'namespace',
          labels = ARRAY(SELECT jsonb_array_elements_text(restored->'labels')),
          valid_until = nullif(restored->>'validUntil', '')::timestamptz,
          supersedes_id = nullif(restored->>'supersedesId', '')::uuid,
          superseded_by_id = nullif(restored->>'supersededById', '')::uuid,
          updated_at = transaction_timestamp()
        WHERE id = target.id
        RETURNING * INTO target;
        revert_after := jsonb_build_object(
          'memoryVersion', target.memory_version,
          'status', target.status,
          'scopeType', target.scope_type,
          'scopeSubjectId', target.scope_subject_id,
          'scopeRoleKey', target.scope_role_key,
          'scopeSessionId', target.scope_session_id,
          'namespace', target.namespace_key,
          'labels', to_jsonb(target.labels),
          'validUntil', target.valid_until,
          'supersedesId', target.supersedes_id,
          'supersededById', target.superseded_by_id
        );
      ELSIF applied.operation_type IN ('relationship_add', 'relationship_remove') THEN
        SELECT * INTO relationship FROM knowledge_memory_relationships
        WHERE id = applied.relationship_id AND workspace_id = context_workspace_id FOR UPDATE;
        revert_before := jsonb_build_object(
          'active', relationship.removed_by_event_id IS NULL,
          'relationshipId', relationship.id,
          'relationshipVersion', relationship.version
        );
        IF applied.operation_type = 'relationship_add' THEN
          IF relationship.created_by_event_id <> applied.id
            OR relationship.removed_by_event_id IS NOT NULL
            OR relationship.version <> (applied.after_state->>'relationshipVersion')::integer
          THEN
            RAISE EXCEPTION 'relationship add can no longer be reverted' USING ERRCODE = '40001';
          END IF;
          UPDATE knowledge_memory_relationships SET
            removed_by_event_id = new_event_id,
            removed_at = transaction_timestamp()
          WHERE id = relationship.id RETURNING * INTO relationship;
        ELSE
          IF relationship.removed_by_event_id <> applied.id
            OR relationship.version <> (applied.after_state->>'relationshipVersion')::integer
          THEN
            RAISE EXCEPTION 'relationship removal can no longer be reverted' USING ERRCODE = '40001';
          END IF;
          UPDATE knowledge_memory_relationships SET
            removed_by_event_id = NULL,
            removed_at = NULL
          WHERE id = relationship.id RETURNING * INTO relationship;
        END IF;
        revert_after := jsonb_build_object(
          'active', relationship.removed_by_event_id IS NULL,
          'relationshipId', relationship.id,
          'relationshipVersion', relationship.version
        );
      ELSE
        PERFORM 1 FROM knowledge_memories candidate
        WHERE candidate.id IN (applied.target_memory_id, applied.related_memory_id)
          AND candidate.account_id = context_account_id
          AND candidate.workspace_id = context_workspace_id
        ORDER BY candidate.id FOR UPDATE;
        SELECT * INTO target FROM knowledge_memories WHERE id = applied.target_memory_id;
        SELECT * INTO related FROM knowledge_memories WHERE id = applied.related_memory_id;
        IF target.memory_version <> (applied.after_state#>>'{target,memoryVersion}')::integer
          OR related.memory_version <> (applied.after_state#>>'{related,memoryVersion}')::integer
        THEN
          RAISE EXCEPTION 'supersession participants changed after apply' USING ERRCODE = '40001';
        END IF;
        revert_before := applied.after_state;
        restored := applied.before_state->'target';
        UPDATE knowledge_memories SET
          status = restored->>'status',
          valid_until = nullif(restored->>'validUntil', '')::timestamptz,
          supersedes_id = nullif(restored->>'supersedesId', '')::uuid,
          superseded_by_id = nullif(restored->>'supersededById', '')::uuid,
          updated_at = transaction_timestamp()
        WHERE id = target.id RETURNING * INTO target;
        restored := applied.before_state->'related';
        UPDATE knowledge_memories SET
          status = restored->>'status',
          valid_until = nullif(restored->>'validUntil', '')::timestamptz,
          supersedes_id = nullif(restored->>'supersedesId', '')::uuid,
          superseded_by_id = nullif(restored->>'supersededById', '')::uuid,
          updated_at = transaction_timestamp()
        WHERE id = related.id RETURNING * INTO related;
        SELECT * INTO relationship FROM knowledge_memory_relationships
        WHERE id = applied.relationship_id AND removed_by_event_id IS NULL FOR UPDATE;
        IF NOT FOUND OR relationship.version <>
          (applied.after_state#>>'{relationship,relationshipVersion}')::integer
        THEN
          RAISE EXCEPTION 'supersession relationship changed after apply' USING ERRCODE = '40001';
        END IF;
        UPDATE knowledge_memory_relationships SET
          removed_by_event_id = new_event_id,
          removed_at = transaction_timestamp()
        WHERE id = relationship.id RETURNING * INTO relationship;
        revert_after := jsonb_build_object(
          'target', jsonb_build_object(
            'memoryVersion', target.memory_version, 'status', target.status,
            'scopeType', target.scope_type, 'scopeSubjectId', target.scope_subject_id,
            'scopeRoleKey', target.scope_role_key, 'scopeSessionId', target.scope_session_id,
            'namespace', target.namespace_key, 'labels', to_jsonb(target.labels),
            'validUntil', target.valid_until, 'supersedesId', target.supersedes_id,
            'supersededById', target.superseded_by_id
          ),
          'related', jsonb_build_object(
            'memoryVersion', related.memory_version, 'status', related.status,
            'scopeType', related.scope_type, 'scopeSubjectId', related.scope_subject_id,
            'scopeRoleKey', related.scope_role_key, 'scopeSessionId', related.scope_session_id,
            'namespace', related.namespace_key, 'labels', to_jsonb(related.labels),
            'validUntil', related.valid_until, 'supersedesId', related.supersedes_id,
            'supersededById', related.superseded_by_id
          ),
          'relationship', jsonb_build_object(
            'active', false, 'relationshipId', relationship.id,
            'relationshipVersion', relationship.version
          )
        );
      END IF;

      INSERT INTO knowledge_memory_lifecycle_events (
        id, account_id, workspace_id, operation_id, action, operation_type,
        target_memory_id, related_memory_id, relationship_id, relationship_type,
        actor_kind, actor_subject_id, actor_session_id, actor_turn_id,
        actor_attempt_id, actor_execution_generation, plan_hash,
        before_state, after_state, reverts_event_id
      ) VALUES (
        new_event_id, context_account_id, context_workspace_id, p_operation_id, 'revert',
        applied.operation_type, applied.target_memory_id, applied.related_memory_id,
        applied.relationship_id, applied.relationship_type, p_actor_kind, p_actor_subject_id,
        p_actor_session_id, p_actor_turn_id, p_actor_attempt_id,
        p_actor_execution_generation, p_plan_hash, revert_before, revert_after, applied.id
      );
      RETURN QUERY SELECT new_event_id;
    END;
    $body$;
  $ddl$, target_schema, target_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.knowledge_memory_revert_operation(uuid, uuid, text, text, text, uuid, uuid, uuid, integer) FROM PUBLIC',
    target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.knowledge_memory_revert_operation(uuid, uuid, text, text, text, uuid, uuid, uuid, integer) TO opengeni_app',
      target_schema
    );
  END IF;
END
$revert_function$;

REVOKE ALL ON TABLE knowledge_memory_relationships FROM PUBLIC;
REVOKE ALL ON TABLE knowledge_memory_lifecycle_events FROM PUBLIC;

DO $runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT ON TABLE %I.knowledge_memory_relationships, %I.knowledge_memory_lifecycle_events TO opengeni_app',
      current_schema(), current_schema()
    );
  END IF;
END
$runtime_grants$;
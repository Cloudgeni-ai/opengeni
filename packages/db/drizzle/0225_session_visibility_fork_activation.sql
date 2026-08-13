-- deployment-mode: rolling
-- Activate an atomic, server-authoritative visibility transition. Independent
-- fork activation is added by the same numbered slice after this checkpoint.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "session_attempt_interruptions"
  DROP CONSTRAINT "session_attempt_interruptions_kind_check";
ALTER TABLE "session_attempt_interruptions"
  ADD CONSTRAINT "session_attempt_interruptions_kind_check"
  CHECK ("kind" IN (
    'session_pause', 'workspace_pause', 'steer', 'maintenance', 'authority_change'
  )) NOT VALID;
ALTER TABLE "session_attempt_interruptions"
  VALIDATE CONSTRAINT "session_attempt_interruptions_kind_check";

ALTER TABLE "sessions"
  ADD COLUMN "owner_subject_id" text;

UPDATE "sessions" session_row
SET "owner_subject_id" = membership."subject_id"
FROM "organization_memberships" membership
WHERE session_row."owner_organization_membership_id" = membership."id"
  AND session_row."account_id" = membership."account_id"
  AND session_row."owner_subject_id" IS NULL;

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_owner_subject_pair_check" CHECK (
    ("owner_organization_membership_id" IS NULL) = ("owner_subject_id" IS NULL)
  ) NOT VALID,
  ADD CONSTRAINT "sessions_owner_subject_account_fk"
    FOREIGN KEY ("account_id", "owner_subject_id")
    REFERENCES "organization_memberships" ("account_id", "subject_id")
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE "sessions"
  VALIDATE CONSTRAINT "sessions_owner_subject_pair_check",
  VALIDATE CONSTRAINT "sessions_owner_subject_account_fk";

DROP POLICY IF EXISTS organization_tenancy_lifecycle ON "organization_memberships";
CREATE POLICY organization_tenancy_lifecycle ON "organization_memberships"
  USING (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      IN ('managed_human_provisioning', 'session_visibility_activation')
  )
  WITH CHECK (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      IN ('managed_human_provisioning', 'session_visibility_activation')
  );

DROP POLICY IF EXISTS organization_tenancy_lifecycle ON "organization_user_resource_grants";
CREATE POLICY organization_tenancy_lifecycle ON "organization_user_resource_grants"
  USING (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      IN ('managed_human_provisioning', 'session_visibility_activation')
  )
  WITH CHECK (
    current_setting('opengeni.organization_tenancy_lifecycle', true)
      IN ('managed_human_provisioning', 'session_visibility_activation')
  );

DO $session_visibility_write_fence$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I.session_visibility_write_capabilities ('
      || 'backend_pid integer NOT NULL, '
      || 'transaction_id xid8 NOT NULL, '
      || 'capability_id uuid NOT NULL, '
      || 'PRIMARY KEY (backend_pid, transaction_id, capability_id)'
      || ')',
    data_schema
  );
  EXECUTE format(
    'ALTER TABLE %I.session_visibility_write_capabilities '
      || 'ENABLE ROW LEVEL SECURITY',
    data_schema
  );
  EXECUTE format(
    'ALTER TABLE %I.session_visibility_write_capabilities '
      || 'FORCE ROW LEVEL SECURITY',
    data_schema
  );
  EXECUTE format(
    'DROP POLICY IF EXISTS session_visibility_capability_owner '
      || 'ON %I.session_visibility_write_capabilities',
    data_schema
  );
  EXECUTE format(
    'CREATE POLICY session_visibility_capability_owner '
      || 'ON %I.session_visibility_write_capabilities '
      || 'FOR ALL USING (current_user = %L) WITH CHECK (current_user = %L)',
    data_schema,
    migration_owner,
    migration_owner
  );
  EXECUTE format(
    'REVOKE ALL ON %I.session_visibility_write_capabilities FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL ON %I.session_visibility_write_capabilities FROM opengeni_app',
      data_schema
    );
  END IF;

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.guard_session_authority_write()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      resolved_owner_id uuid;
      resolved_owner_subject_id text;
      owner_provenance_supplied boolean :=
        NEW.owner_organization_membership_id IS NOT NULL
        OR NEW.owner_subject_id IS NOT NULL;
      previous_lifecycle_marker text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
    BEGIN
      IF TG_OP = 'INSERT'
        AND NEW.owner_organization_membership_id IS NULL
        AND NEW.owner_subject_id IS NULL
      THEN
        IF NEW.parent_session_id IS NOT NULL THEN
          SELECT parent.owner_organization_membership_id, parent.owner_subject_id
          INTO resolved_owner_id, resolved_owner_subject_id
          FROM sessions parent
          WHERE parent.account_id = NEW.account_id
            AND parent.workspace_id = NEW.workspace_id
            AND parent.id = NEW.parent_session_id;
        ELSIF NEW.created_by_kind = 'subject'
          AND NEW.created_by_subject_id IS NOT NULL
        THEN
          PERFORM pg_catalog.set_config(
            'opengeni.organization_tenancy_lifecycle',
            'session_visibility_activation',
            true
          );
          SELECT membership.id, membership.subject_id
          INTO resolved_owner_id, resolved_owner_subject_id
          FROM organization_memberships membership
          WHERE membership.account_id = NEW.account_id
            AND membership.subject_id = NEW.created_by_subject_id
            AND membership.status = 'active'
            AND EXISTS (
              SELECT 1
              FROM workspace_memberships workspace_membership
              WHERE workspace_membership.account_id = NEW.account_id
                AND workspace_membership.workspace_id = NEW.workspace_id
                AND workspace_membership.subject_id = membership.subject_id
            );
        END IF;
        NEW.owner_organization_membership_id := resolved_owner_id;
        NEW.owner_subject_id := resolved_owner_subject_id;
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle',
          CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
          true
        );
      END IF;

      IF (NEW.owner_organization_membership_id IS NULL)
          <> (NEW.owner_subject_id IS NULL)
        OR (NEW.visibility = 'user_private'
          AND NEW.owner_organization_membership_id IS NULL)
      THEN
        RAISE EXCEPTION 'session authority owner provenance is incomplete'
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'UPDATE'
        AND (
          NEW.visibility IS DISTINCT FROM OLD.visibility
          OR NEW.owner_organization_membership_id
            IS DISTINCT FROM OLD.owner_organization_membership_id
          OR NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id
          OR NEW.authority_epoch IS DISTINCT FROM OLD.authority_epoch
          OR NEW.forked_from_session_id IS DISTINCT FROM OLD.forked_from_session_id
          OR NEW.forked_from_authority_epoch
            IS DISTINCT FROM OLD.forked_from_authority_epoch
          OR NEW.forked_from_visibility IS DISTINCT FROM OLD.forked_from_visibility
          OR NEW.forked_at IS DISTINCT FROM OLD.forked_at
          OR NEW.forked_by_organization_membership_id
            IS DISTINCT FROM OLD.forked_by_organization_membership_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM session_visibility_write_capabilities capability
          WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
            AND capability.transaction_id = pg_catalog.pg_current_xact_id()
            AND capability.capability_id = nullif(
              pg_catalog.current_setting(
                'opengeni.session_visibility_write_capability', true
              ),
              ''
            )::uuid
        )
      THEN
        RAISE EXCEPTION 'session authority changes require the lifecycle capability'
          USING ERRCODE = '42501';
      END IF;

      IF TG_OP = 'INSERT'
        AND (
          NEW.visibility <> 'workspace_shared'
          OR NEW.authority_epoch <> 1
          OR NEW.forked_from_session_id IS NOT NULL
          OR NEW.forked_from_authority_epoch IS NOT NULL
          OR NEW.forked_from_visibility IS NOT NULL
          OR NEW.forked_at IS NOT NULL
          OR NEW.forked_by_organization_membership_id IS NOT NULL
          OR owner_provenance_supplied
        )
        AND NOT EXISTS (
          SELECT 1
          FROM session_visibility_write_capabilities capability
          WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
            AND capability.transaction_id = pg_catalog.pg_current_xact_id()
            AND capability.capability_id = nullif(
              pg_catalog.current_setting(
                'opengeni.session_visibility_write_capability', true
              ),
              ''
            )::uuid
        )
      THEN
        RAISE EXCEPTION 'non-default session authority requires the lifecycle capability'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);
  EXECUTE format(
    'DROP TRIGGER IF EXISTS sessions_authority_write_fence ON %I.sessions',
    data_schema
  );
  EXECUTE format(
    'CREATE TRIGGER sessions_authority_write_fence '
      || 'BEFORE INSERT OR UPDATE ON %I.sessions '
      || 'FOR EACH ROW EXECUTE FUNCTION %I.guard_session_authority_write()',
    data_schema,
    data_schema
  );
END
$session_visibility_write_fence$;

DO $session_visibility_rls$
DECLARE
  data_schema text := current_schema();
  target record;
  policy_expression text;
  manual_table text;
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.session_private_actor_visible(
      p_account_id uuid,
      p_workspace_id uuid,
      p_owner_organization_membership_id uuid,
      p_owner_subject_id text
    ) RETURNS boolean
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      actor_subject_id text := nullif(
        pg_catalog.current_setting('opengeni.subject_id', true), ''
      );
      initiating_human_subject_id text := nullif(
        pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''
      );
      previous_lifecycle_marker text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
      visible boolean := false;
    BEGIN
      IF p_account_id IS NULL
        OR p_workspace_id IS NULL
        OR p_owner_organization_membership_id IS NULL
        OR p_owner_subject_id IS NULL
        OR (
          actor_subject_id IS DISTINCT FROM p_owner_subject_id
          AND initiating_human_subject_id IS DISTINCT FROM p_owner_subject_id
        )
      THEN
        RETURN false;
      END IF;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'session_visibility_activation',
        true
      );
      SELECT EXISTS (
        SELECT 1
        FROM organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.id = p_owner_organization_membership_id
          AND membership.subject_id = p_owner_subject_id
          AND membership.status = 'active'
          AND EXISTS (
            SELECT 1
            FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = p_account_id
              AND workspace_membership.workspace_id = p_workspace_id
              AND workspace_membership.subject_id = p_owner_subject_id
          )
      ) INTO visible;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      RETURN visible;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.session_private_actor_visible(uuid,uuid,uuid,text) FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.session_private_actor_visible(uuid,uuid,uuid,text) TO opengeni_app',
      data_schema
    );
  END IF;

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.session_reference_visible(
      p_account_id uuid,
      p_workspace_id uuid,
      p_session_id uuid
    ) RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY INVOKER
    SET search_path = %1$I, pg_catalog
    AS $body$
      SELECT p_session_id IS NULL OR EXISTS (
        SELECT 1
        FROM sessions session_row
        WHERE session_row.account_id = p_account_id
          AND session_row.workspace_id = p_workspace_id
          AND session_row.id = p_session_id
      )
    $body$;
  $ddl$, data_schema);

  EXECUTE format('DROP POLICY IF EXISTS session_visibility_isolation ON %I.sessions', data_schema);
  EXECUTE format(
    'CREATE POLICY session_visibility_isolation ON %1$I.sessions AS RESTRICTIVE '
      || 'FOR ALL USING ('
      || 'nullif(pg_catalog.current_setting(''opengeni.subject_id'', true), '''') IS NULL '
      || 'OR visibility = ''workspace_shared'' '
      || 'OR %1$I.session_private_actor_visible('
      || 'account_id, workspace_id, owner_organization_membership_id, owner_subject_id)'
      || ') WITH CHECK ('
      || 'nullif(pg_catalog.current_setting(''opengeni.subject_id'', true), '''') IS NULL '
      || 'OR visibility = ''workspace_shared'' '
      || 'OR %1$I.session_private_actor_visible('
      || 'account_id, workspace_id, owner_organization_membership_id, owner_subject_id)'
      || ')',
    data_schema
  );

  FOR target IN
    SELECT
      relation.relname AS table_name,
      pg_catalog.string_agg(
        pg_catalog.format(
          '%1$I.session_reference_visible(account_id, workspace_id, %2$I)',
          data_schema,
          attribute.attname
        ),
        ' AND ' ORDER BY attribute.attname
      ) AS expression
    FROM pg_catalog.pg_constraint constraint_row
    JOIN pg_catalog.pg_class relation
      ON relation.oid = constraint_row.conrelid
    JOIN pg_catalog.pg_namespace relation_namespace
      ON relation_namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_class referenced_relation
      ON referenced_relation.oid = constraint_row.confrelid
    JOIN pg_catalog.pg_namespace referenced_namespace
      ON referenced_namespace.oid = referenced_relation.relnamespace
    JOIN LATERAL pg_catalog.unnest(constraint_row.conkey)
      WITH ORDINALITY source_key(attnum, ordinality) ON true
    JOIN LATERAL pg_catalog.unnest(constraint_row.confkey)
      WITH ORDINALITY referenced_key(attnum, ordinality)
      ON referenced_key.ordinality = source_key.ordinality
    JOIN pg_catalog.pg_attribute attribute
      ON attribute.attrelid = relation.oid
      AND attribute.attnum = source_key.attnum
    JOIN pg_catalog.pg_attribute referenced_attribute
      ON referenced_attribute.attrelid = referenced_relation.oid
      AND referenced_attribute.attnum = referenced_key.attnum
    WHERE constraint_row.contype = 'f'
      AND relation_namespace.nspname = data_schema
      AND referenced_namespace.nspname = data_schema
      AND referenced_relation.relname = 'sessions'
      AND referenced_attribute.attname = 'id'
      AND relation.relname <> 'sessions'
      AND relation.relrowsecurity
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute account_column
        WHERE account_column.attrelid = relation.oid
          AND account_column.attname = 'account_id'
          AND NOT account_column.attisdropped
      )
      AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute workspace_column
        WHERE workspace_column.attrelid = relation.oid
          AND workspace_column.attname = 'workspace_id'
          AND NOT workspace_column.attisdropped
      )
    GROUP BY relation.relname
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS session_visibility_isolation ON %I.%I',
      data_schema,
      target.table_name
    );
    EXECUTE format(
      'CREATE POLICY session_visibility_isolation ON %I.%I AS RESTRICTIVE '
        || 'FOR ALL USING (%s) WITH CHECK (%s)',
      data_schema,
      target.table_name,
      target.expression,
      target.expression
    );
  END LOOP;

  FOREACH manual_table IN ARRAY ARRAY[
    'connector_action_requests',
    'memory_slack_publications',
    'model_call_facts',
    'session_attempt_codemode_calls',
    'session_attempt_tool_catalogs',
    'session_human_input_requests',
    'usage_events'
  ]
  LOOP
    IF pg_catalog.to_regclass(pg_catalog.format('%I.%I', data_schema, manual_table)) IS NULL THEN
      CONTINUE;
    END IF;
    policy_expression := format(
      '%I.session_reference_visible(account_id, workspace_id, session_id)',
      data_schema
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS session_visibility_isolation ON %I.%I',
      data_schema,
      manual_table
    );
    EXECUTE format(
      'CREATE POLICY session_visibility_isolation ON %I.%I AS RESTRICTIVE '
        || 'FOR ALL USING (%s) WITH CHECK (%s)',
      data_schema,
      manual_table,
      policy_expression,
      policy_expression
    );
  END LOOP;
END
$session_visibility_rls$;

DO $session_visibility_activation$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.transition_session_visibility(
      p_account_id uuid,
      p_workspace_id uuid,
      p_session_id uuid,
      p_actor_subject_id text,
      p_target_visibility text,
      p_expected_authority_epoch integer,
      p_operation_key text,
      p_canonical_request_hash text
    )
    RETURNS TABLE (
      operation_id uuid,
      visibility text,
      authority_epoch integer,
      owner_organization_membership_id uuid,
      changed boolean,
      replay boolean,
      interrupted_attempt_count integer,
      cancelled_turn_count integer,
      cancelled_update_count integer,
      paused_goal_count integer,
      revoked_grant_count integer
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      actor_membership organization_memberships%%ROWTYPE;
      session_row sessions%%ROWTYPE;
      receipt_row session_command_receipts%%ROWTYPE;
      new_owner_id uuid;
      new_epoch integer;
      event_sequence integer;
      interruption_count integer := 0;
      turn_count integer := 0;
      update_count integer := 0;
      goal_count integer := 0;
      grant_count integer := 0;
      result_payload jsonb;
      visibility_write_capability_id uuid := pg_catalog.gen_random_uuid();
      previous_visibility_write_capability text := pg_catalog.current_setting(
        'opengeni.session_visibility_write_capability', true
      );
      previous_lifecycle_marker text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
    BEGIN
      IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_session_id IS NULL
        OR p_actor_subject_id IS NULL OR p_expected_authority_epoch IS NULL
        OR p_operation_key IS NULL OR p_canonical_request_hash IS NULL
      THEN
        RAISE EXCEPTION 'session visibility transition requires complete authority'
          USING ERRCODE = '42501';
      END IF;
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
        OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
      THEN
        RAISE EXCEPTION 'session visibility transition authority is invalid'
          USING ERRCODE = '42501';
      END IF;
      IF p_target_visibility NOT IN ('user_private', 'workspace_shared')
        OR p_expected_authority_epoch < 1
        OR p_actor_subject_id <> pg_catalog.btrim(p_actor_subject_id)
        OR pg_catalog.length(p_actor_subject_id) NOT BETWEEN 1 AND 1024
        OR p_operation_key <> pg_catalog.btrim(p_operation_key)
        OR pg_catalog.length(p_operation_key) NOT BETWEEN 1 AND 1024
        OR p_canonical_request_hash !~ '^[0-9a-f]{64}$'
      THEN
        RAISE EXCEPTION 'session visibility transition request is invalid'
          USING ERRCODE = '22023';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'session_visibility_activation',
        true
      );

      PERFORM 1 FROM workspaces workspace_row
      WHERE workspace_row.id = p_workspace_id
        AND workspace_row.account_id = p_account_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session visibility transition workspace is unavailable'
          USING ERRCODE = '42501';
      END IF;

      SELECT membership.* INTO actor_membership
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = p_actor_subject_id
        AND membership.status = 'active'
      FOR UPDATE;
      IF NOT FOUND OR NOT EXISTS (
        SELECT 1 FROM workspace_memberships workspace_membership
        WHERE workspace_membership.account_id = p_account_id
          AND workspace_membership.workspace_id = p_workspace_id
          AND workspace_membership.subject_id = p_actor_subject_id
      ) THEN
        RAISE EXCEPTION 'session visibility transition requires active membership'
          USING ERRCODE = '42501';
      END IF;

      SELECT session.* INTO session_row
      FROM sessions session
      WHERE session.account_id = p_account_id
        AND session.workspace_id = p_workspace_id
        AND session.id = p_session_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session visibility transition session is unavailable'
          USING ERRCODE = 'P0002';
      END IF;
      IF session_row.owner_organization_membership_id IS NOT NULL
        AND session_row.owner_organization_membership_id <> actor_membership.id
      THEN
        RAISE EXCEPTION 'session visibility transition is owner-only'
          USING ERRCODE = '42501';
      END IF;
      IF session_row.owner_organization_membership_id IS NULL
        OR session_row.owner_subject_id IS NULL
      THEN
        RAISE EXCEPTION 'legacy workspace session has no transferable owner authority'
          USING ERRCODE = '42501';
      END IF;

      INSERT INTO session_command_receipts (
        account_id, workspace_id, actor_type, actor_subject_id, action,
        target_session_id, operation_key, canonical_request_hash
      ) VALUES (
        p_account_id, p_workspace_id, 'human', p_actor_subject_id,
        'session.visibility.change', p_session_id, p_operation_key,
        p_canonical_request_hash
      ) ON CONFLICT DO NOTHING;

      SELECT receipt.* INTO receipt_row
      FROM session_command_receipts receipt
      WHERE receipt.workspace_id = p_workspace_id
        AND receipt.actor_type = 'human'
        AND receipt.actor_subject_id = p_actor_subject_id
        AND receipt.actor_attempt_id IS NULL
        AND receipt.action = 'session.visibility.change'
        AND receipt.target_session_id = p_session_id
        AND receipt.target_turn_id IS NULL
        AND receipt.operation_key = p_operation_key
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session visibility transition receipt is unavailable'
          USING ERRCODE = 'P0002';
      END IF;
      IF receipt_row.canonical_request_hash <> p_canonical_request_hash THEN
        RAISE EXCEPTION 'session visibility transition idempotency conflict'
          USING ERRCODE = '23505';
      END IF;
      IF receipt_row.result ->> 'status' = 'applied' THEN
        operation_id := receipt_row.id;
        visibility := receipt_row.result ->> 'visibility';
        authority_epoch := (receipt_row.result ->> 'authorityEpoch')::integer;
        owner_organization_membership_id := session_row.owner_organization_membership_id;
        changed := (receipt_row.result ->> 'changed')::boolean;
        replay := true;
        interrupted_attempt_count := (receipt_row.result ->> 'interruptedAttemptCount')::integer;
        cancelled_turn_count := (receipt_row.result ->> 'cancelledTurnCount')::integer;
        cancelled_update_count := (receipt_row.result ->> 'cancelledUpdateCount')::integer;
        paused_goal_count := (receipt_row.result ->> 'pausedGoalCount')::integer;
        revoked_grant_count := (receipt_row.result ->> 'revokedGrantCount')::integer;
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle',
          CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
          true
        );
        RETURN NEXT;
        RETURN;
      END IF;
      IF session_row.authority_epoch <> p_expected_authority_epoch THEN
        RAISE EXCEPTION 'session visibility transition authority epoch conflict'
          USING ERRCODE = '40001';
      END IF;

      new_owner_id := session_row.owner_organization_membership_id;
      IF session_row.visibility = p_target_visibility THEN
        new_epoch := session_row.authority_epoch;
      ELSE
        new_epoch := session_row.authority_epoch + 1;
        IF new_epoch < 2 THEN
          RAISE EXCEPTION 'session visibility transition authority epoch exhausted'
            USING ERRCODE = '22003';
        END IF;

        INSERT INTO session_attempt_interruptions (
          account_id, workspace_id, session_id, operation_id, attempt_id,
          kind, control_revision
        )
        SELECT attempt.account_id, attempt.workspace_id, attempt.session_id,
               receipt_row.id, attempt.id, 'authority_change', new_epoch
        FROM session_turn_attempts attempt
        WHERE attempt.workspace_id = p_workspace_id
          AND attempt.session_id = p_session_id
          AND attempt.state IN ('claimed', 'running')
        ON CONFLICT ON CONSTRAINT session_attempt_interruptions_operation_attempt_uq
        DO NOTHING;
        GET DIAGNOSTICS interruption_count = ROW_COUNT;

        UPDATE session_turns turn_row
        SET status = 'cancelled', cancelled_by = p_actor_subject_id,
            cancel_reason = 'authority_changed', finished_at = pg_catalog.clock_timestamp(),
            updated_at = pg_catalog.clock_timestamp(), version = turn_row.version + 1
        WHERE turn_row.workspace_id = p_workspace_id
          AND turn_row.session_id = p_session_id
          AND turn_row.status = 'queued';
        GET DIAGNOSTICS turn_count = ROW_COUNT;

        UPDATE session_system_updates update_row
        SET state = 'cancelled'
        WHERE update_row.workspace_id = p_workspace_id
          AND update_row.session_id = p_session_id
          AND update_row.state = 'pending';
        GET DIAGNOSTICS update_count = ROW_COUNT;

        UPDATE session_goals goal_row
        SET status = 'paused', paused_reason = 'api',
            rationale = 'Session authority changed; explicit resume is required.',
            version = goal_row.version + 1, updated_at = pg_catalog.clock_timestamp()
        WHERE goal_row.workspace_id = p_workspace_id
          AND goal_row.session_id = p_session_id
          AND goal_row.status = 'active';
        GET DIAGNOSTICS goal_count = ROW_COUNT;

        UPDATE organization_user_resource_grants grant_row
        SET status = 'revoked', revoked_at = pg_catalog.clock_timestamp(),
            generation = grant_row.generation + 1, updated_at = pg_catalog.clock_timestamp()
        WHERE grant_row.account_id = p_account_id
          AND grant_row.workspace_id = p_workspace_id
          AND grant_row.session_id = p_session_id
          AND grant_row.authority_epoch = session_row.authority_epoch
          AND grant_row.status = 'active';
        GET DIAGNOSTICS grant_count = ROW_COUNT;

        event_sequence := session_row.last_sequence + 1;
        INSERT INTO session_visibility_write_capabilities (
          backend_pid, transaction_id, capability_id
        ) VALUES (
          pg_catalog.pg_backend_pid(),
          pg_catalog.pg_current_xact_id(),
          visibility_write_capability_id
        );
        PERFORM pg_catalog.set_config(
          'opengeni.session_visibility_write_capability',
          visibility_write_capability_id::text,
          true
        );
        UPDATE sessions transition_target
        SET visibility = p_target_visibility,
            owner_organization_membership_id = new_owner_id,
            owner_subject_id = session_row.owner_subject_id,
            authority_epoch = new_epoch,
            initial_personal_connection_delegations = '[]'::jsonb,
            last_sequence = event_sequence,
            updated_at = pg_catalog.clock_timestamp()
        WHERE transition_target.id = p_session_id
          AND transition_target.authority_epoch = session_row.authority_epoch;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'session visibility transition lost authority epoch CAS'
            USING ERRCODE = '40001';
        END IF;
        DELETE FROM session_visibility_write_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id()
          AND capability.capability_id = visibility_write_capability_id;
        PERFORM pg_catalog.set_config(
          'opengeni.session_visibility_write_capability',
          CASE WHEN previous_visibility_write_capability IS NULL
            THEN '' ELSE previous_visibility_write_capability END,
          true
        );

        INSERT INTO session_events (
          account_id, workspace_id, session_id, sequence, type, payload, occurred_at
        ) VALUES (
          p_account_id, p_workspace_id, p_session_id, event_sequence,
          'session.visibility.changed',
          pg_catalog.jsonb_build_object(
            'operationId', receipt_row.id,
            'fromVisibility', CASE session_row.visibility
              WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
            'toVisibility', CASE p_target_visibility
              WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
            'previousAuthorityEpoch', session_row.authority_epoch,
            'authorityEpoch', new_epoch,
            'interruptedAttemptCount', interruption_count,
            'cancelledTurnCount', turn_count,
            'cancelledUpdateCount', update_count,
            'pausedGoalCount', goal_count,
            'revokedGrantCount', grant_count
          ),
          pg_catalog.clock_timestamp()
        );
      END IF;

      result_payload := pg_catalog.jsonb_build_object(
        'status', 'applied',
        'visibility', p_target_visibility,
        'authorityEpoch', new_epoch,
        'changed', session_row.visibility <> p_target_visibility,
        'interruptedAttemptCount', interruption_count,
        'cancelledTurnCount', turn_count,
        'cancelledUpdateCount', update_count,
        'pausedGoalCount', goal_count,
        'revokedGrantCount', grant_count
      );
      UPDATE session_command_receipts
      SET result = result_payload, updated_at = pg_catalog.clock_timestamp()
      WHERE id = receipt_row.id;

      operation_id := receipt_row.id;
      visibility := p_target_visibility;
      authority_epoch := new_epoch;
      owner_organization_membership_id := new_owner_id;
      changed := session_row.visibility <> p_target_visibility;
      replay := false;
      interrupted_attempt_count := interruption_count;
      cancelled_turn_count := turn_count;
      cancelled_update_count := update_count;
      paused_goal_count := goal_count;
      revoked_grant_count := grant_count;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.session_visibility_write_capability',
        CASE WHEN previous_visibility_write_capability IS NULL
          THEN '' ELSE previous_visibility_write_capability END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.transition_session_visibility(uuid,uuid,uuid,text,text,integer,text,text) FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.transition_session_visibility(uuid,uuid,uuid,text,text,integer,text,text) TO opengeni_app',
      data_schema
    );
  END IF;
END
$session_visibility_activation$;

COMMENT ON FUNCTION transition_session_visibility(uuid, uuid, uuid, text, text, integer, text, text) IS
  'Atomic owner-authorized visibility transition with authority-epoch CAS, stale-work fencing, grant revocation, and idempotent secret-safe receipt/event.';

DO $session_fork_activation$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.fork_session_content(
      p_account_id uuid,
      p_source_workspace_id uuid,
      p_source_session_id uuid,
      p_actor_subject_id text,
      p_destination_workspace_id uuid,
      p_destination_visibility text,
      p_operation_key text,
      p_canonical_request_hash text
    )
    RETURNS TABLE (
      operation_id uuid,
      session_id uuid,
      workspace_id uuid,
      visibility text,
      authority_epoch integer,
      copied_history_item_count integer,
      replay boolean
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      actor_membership organization_memberships%%ROWTYPE;
      source_session sessions%%ROWTYPE;
      destination_workspace workspaces%%ROWTYPE;
      receipt_row session_command_receipts%%ROWTYPE;
      destination_session_id uuid;
      destination_owner_id uuid;
      history_count integer := 0;
      destination_activity_revision bigint;
      destination_depth integer;
      destination_depth_source text;
      destination_resources jsonb := '[]'::jsonb;
      previous_workspace_id text := pg_catalog.current_setting('opengeni.workspace_id', true);
      previous_lifecycle_marker text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
      previous_gate_state text := pg_catalog.current_setting(
        'opengeni.session_activity_gate_state', true
      );
      previous_gate_workspace_id text := pg_catalog.current_setting(
        'opengeni.session_activity_gate_workspace_id', true
      );
      previous_visibility_marker text := pg_catalog.current_setting(
        'opengeni.session_visibility_write_capability', true
      );
      visibility_write_capability_id uuid := pg_catalog.gen_random_uuid();
    BEGIN
      IF p_account_id IS NULL OR p_source_workspace_id IS NULL
        OR p_source_session_id IS NULL OR p_actor_subject_id IS NULL
        OR p_destination_workspace_id IS NULL OR p_destination_visibility IS NULL
        OR p_operation_key IS NULL OR p_canonical_request_hash IS NULL
      THEN
        RAISE EXCEPTION 'session fork requires complete authority'
          USING ERRCODE = '42501';
      END IF;
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR p_source_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
        OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
      THEN
        RAISE EXCEPTION 'session fork authority is invalid'
          USING ERRCODE = '42501';
      END IF;
      IF p_destination_visibility NOT IN ('user_private', 'workspace_shared')
        OR p_actor_subject_id <> pg_catalog.btrim(p_actor_subject_id)
        OR pg_catalog.length(p_actor_subject_id) NOT BETWEEN 1 AND 1024
        OR p_operation_key <> pg_catalog.btrim(p_operation_key)
        OR pg_catalog.length(p_operation_key) NOT BETWEEN 1 AND 1024
        OR p_canonical_request_hash !~ '^[0-9a-f]{64}$'
      THEN
        RAISE EXCEPTION 'session fork request is invalid'
          USING ERRCODE = '22023';
      END IF;
      IF nullif(previous_gate_state, '') IS NOT NULL
        OR nullif(previous_gate_workspace_id, '') IS NOT NULL
      THEN
        RAISE EXCEPTION 'session fork requires ownership of the activity gate'
          USING ERRCODE = '55000';
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext(
          'session-fork-workspace:' || ordered_workspaces.lock_workspace_id::text
        )
      )
      FROM (
        SELECT DISTINCT requested.lock_workspace_id
        FROM (VALUES (p_source_workspace_id), (p_destination_workspace_id))
          AS requested(lock_workspace_id)
        ORDER BY requested.lock_workspace_id
      ) AS ordered_workspaces;

      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', p_source_workspace_id::text, true
      );
      PERFORM 1 FROM workspaces workspace_row
      WHERE workspace_row.account_id = p_account_id
        AND workspace_row.id = p_source_workspace_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session fork source workspace is unavailable'
          USING ERRCODE = '42501';
      END IF;
      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', p_destination_workspace_id::text, true
      );
      PERFORM 1 FROM workspaces workspace_row
      WHERE workspace_row.account_id = p_account_id
        AND workspace_row.id = p_destination_workspace_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session fork destination workspace is unavailable'
          USING ERRCODE = '42501';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'session_visibility_activation',
        true
      );
      SELECT membership.* INTO actor_membership
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = p_actor_subject_id
        AND membership.status = 'active'
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session fork requires active organization membership'
          USING ERRCODE = '42501';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', p_source_workspace_id::text, true
      );
      IF NOT EXISTS (
        SELECT 1 FROM workspace_memberships source_access
        WHERE source_access.account_id = p_account_id
          AND source_access.workspace_id = p_source_workspace_id
          AND source_access.subject_id = p_actor_subject_id
      ) THEN
        RAISE EXCEPTION 'session fork source workspace access is unavailable'
          USING ERRCODE = '42501';
      END IF;
      SELECT session.* INTO source_session
      FROM sessions session
      WHERE session.account_id = p_account_id
        AND session.workspace_id = p_source_workspace_id
        AND session.id = p_source_session_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session fork source session is unavailable'
          USING ERRCODE = 'P0002';
      END IF;
      IF source_session.visibility = 'user_private'
        AND source_session.owner_organization_membership_id <> actor_membership.id
      THEN
        RAISE EXCEPTION 'session fork source session is private'
          USING ERRCODE = '42501';
      END IF;

      SELECT coalesce(
        pg_catalog.jsonb_agg(
          CASE WHEN resource.value ->> 'kind' = 'repository'
            THEN resource.value
              - 'credentialBindingId'
              - 'connectionId'
              - 'installationId'
              - 'projectId'
              - 'githubInstallationId'
            ELSE resource.value
          END
          ORDER BY resource.ordinality
        ),
        '[]'::jsonb
      ) INTO destination_resources
      FROM pg_catalog.jsonb_array_elements(source_session.resources)
        WITH ORDINALITY AS resource(value, ordinality);

      DROP TABLE IF EXISTS pg_temp.opengeni_session_fork_history_spool;
      CREATE TEMP TABLE opengeni_session_fork_history_spool (
        position numeric NOT NULL,
        item jsonb NOT NULL,
        item_codec_version integer,
        active boolean NOT NULL,
        created_at timestamptz NOT NULL
      ) ON COMMIT DROP;
      INSERT INTO opengeni_session_fork_history_spool (
        position, item, item_codec_version, active, created_at
      )
      SELECT source_item.position, source_item.item,
        source_item.item_codec_version, source_item.active, source_item.created_at
      FROM session_history_items source_item
      WHERE source_item.account_id = p_account_id
        AND source_item.workspace_id = p_source_workspace_id
        AND source_item.session_id = p_source_session_id
      ORDER BY source_item.position;
      GET DIAGNOSTICS history_count = ROW_COUNT;

      INSERT INTO session_command_receipts (
        account_id, workspace_id, actor_type, actor_subject_id, action,
        target_session_id, operation_key, canonical_request_hash
      ) VALUES (
        p_account_id, p_source_workspace_id, 'human', p_actor_subject_id,
        'session.fork', p_source_session_id, p_operation_key,
        p_canonical_request_hash
      ) ON CONFLICT DO NOTHING;
      SELECT receipt.* INTO receipt_row
      FROM session_command_receipts receipt
      WHERE receipt.workspace_id = p_source_workspace_id
        AND receipt.actor_type = 'human'
        AND receipt.actor_subject_id = p_actor_subject_id
        AND receipt.actor_attempt_id IS NULL
        AND receipt.action = 'session.fork'
        AND receipt.target_session_id = p_source_session_id
        AND receipt.target_turn_id IS NULL
        AND receipt.operation_key = p_operation_key
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session fork receipt is unavailable'
          USING ERRCODE = 'P0002';
      END IF;
      IF receipt_row.canonical_request_hash <> p_canonical_request_hash THEN
        RAISE EXCEPTION 'session fork idempotency conflict'
          USING ERRCODE = '23505';
      END IF;
      IF receipt_row.result ->> 'status' = 'applied' THEN
        operation_id := receipt_row.id;
        session_id := (receipt_row.result ->> 'sessionId')::uuid;
        workspace_id := (receipt_row.result ->> 'workspaceId')::uuid;
        visibility := receipt_row.result ->> 'visibility';
        authority_epoch := 1;
        copied_history_item_count :=
          (receipt_row.result ->> 'copiedHistoryItemCount')::integer;
        replay := true;
        PERFORM pg_catalog.set_config(
          'opengeni.workspace_id',
          CASE WHEN previous_workspace_id IS NULL THEN '' ELSE previous_workspace_id END,
          true
        );
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle',
          CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
          true
        );
        RETURN NEXT;
        RETURN;
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', p_destination_workspace_id::text, true
      );
      IF NOT EXISTS (
        SELECT 1 FROM workspace_memberships destination_access
        WHERE destination_access.account_id = p_account_id
          AND destination_access.workspace_id = p_destination_workspace_id
          AND destination_access.subject_id = p_actor_subject_id
      ) THEN
        RAISE EXCEPTION 'session fork destination workspace access is unavailable'
          USING ERRCODE = '42501';
      END IF;
      SELECT * INTO destination_workspace
      FROM workspaces workspace_row
      WHERE workspace_row.account_id = p_account_id
        AND workspace_row.id = p_destination_workspace_id;

      SELECT
        coalesce(
          CASE WHEN (destination_workspace.settings ->> 'maxNestedAgentDepth') ~ '^\d+$'
            THEN (destination_workspace.settings ->> 'maxNestedAgentDepth')::integer END,
          configuration.max_nested_agent_depth
        ),
        CASE WHEN (destination_workspace.settings ->> 'maxNestedAgentDepth') ~ '^\d+$'
          THEN 'workspace' ELSE configuration.policy_source END
      INTO destination_depth, destination_depth_source
      FROM nested_agent_depth_configuration configuration
      WHERE configuration.singleton = true;
      IF destination_depth IS NULL OR destination_depth_source IS NULL THEN
        RAISE EXCEPTION 'session fork destination depth policy is unavailable'
          USING ERRCODE = '55000';
      END IF;

      destination_session_id := pg_catalog.gen_random_uuid();
      destination_owner_id := CASE WHEN p_destination_visibility = 'user_private'
        THEN actor_membership.id ELSE actor_membership.id END;
      INSERT INTO session_visibility_write_capabilities (
        backend_pid, transaction_id, capability_id
      ) VALUES (
        pg_catalog.pg_backend_pid(),
        pg_catalog.pg_current_xact_id(),
        visibility_write_capability_id
      );
      PERFORM pg_catalog.set_config(
        'opengeni.session_visibility_write_capability',
        visibility_write_capability_id::text,
        true
      );
      PERFORM pg_catalog.set_config('opengeni.session_activity_gate_state', 'open', true);
      PERFORM pg_catalog.set_config(
        'opengeni.session_activity_gate_workspace_id',
        p_destination_workspace_id::text,
        true
      );

      INSERT INTO sessions (
        id, account_id, workspace_id, status,
        initial_message, initial_message_codec_version,
        title, title_source, instructions, policy_role,
        resources, skills, tools, metadata,
        created_by_kind, created_by_subject_id, created_by_context,
        owner_organization_membership_id, owner_subject_id,
        visibility, authority_epoch,
        forked_from_session_id, forked_from_authority_epoch,
        forked_from_visibility, forked_at,
        forked_by_organization_membership_id,
        model, sandbox_backend, sandbox_os, sandbox_group_id,
        first_party_mcp_permissions, first_party_mcp_tools,
        initial_personal_connection_delegations, tool_policy,
        root_session_id, nested_agent_depth,
        max_nested_agent_depth_override, effective_max_nested_agent_depth,
        nested_agent_depth_policy_source, nested_agent_depth_policy_session_id,
        temporal_workflow_id, active_turn_id, variable_set_id,
        rig_id, rig_version_id, active_sandbox_id, active_epoch,
        working_dir, codex_pinned_credential_id, codex_last_credential_id,
        codex_pin_source, codex_compaction_mode,
        queue_version, queue_head_position, queue_tail_position,
        last_sequence
      ) VALUES (
        destination_session_id, p_account_id, p_destination_workspace_id, 'idle',
        source_session.initial_message, source_session.initial_message_codec_version,
        source_session.title, source_session.title_source,
        source_session.instructions, source_session.policy_role,
        destination_resources, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
        'subject', p_actor_subject_id, '{"fork":true}'::jsonb,
        destination_owner_id, actor_membership.subject_id,
        p_destination_visibility, 1,
        p_source_session_id, source_session.authority_epoch,
        source_session.visibility, pg_catalog.clock_timestamp(), actor_membership.id,
        source_session.model, source_session.sandbox_backend,
        source_session.sandbox_os, destination_session_id,
        NULL, '[]'::jsonb, '[]'::jsonb,
        '{"mode":"explicit","inheritedFromSessionId":null}'::jsonb,
        destination_session_id, 0, NULL, destination_depth,
        destination_depth_source, NULL,
        NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL,
        source_session.codex_compaction_mode,
        0, 0, 0, 1
      );

      INSERT INTO session_history_items (
        account_id, workspace_id, session_id, turn_id,
        position, item, item_codec_version, active,
        provider_artifact_invalidated_at,
        provider_artifact_invalidation_reason,
        provider_artifact_invalidated_by_attempt_id,
        created_at
      )
      SELECT p_account_id, p_destination_workspace_id, destination_session_id, NULL,
        source_item.position, source_item.item, source_item.item_codec_version,
        source_item.active, NULL, NULL, NULL, source_item.created_at
      FROM opengeni_session_fork_history_spool source_item
      ORDER BY source_item.position;

      INSERT INTO session_events (
        account_id, workspace_id, session_id, sequence, type, payload, occurred_at
      ) VALUES (
        p_account_id, p_destination_workspace_id, destination_session_id, 1,
        'session.created',
        pg_catalog.jsonb_build_object(
          'forked', true,
          'sourceSessionId', p_source_session_id,
          'sourceAuthorityEpoch', source_session.authority_epoch,
          'sourceVisibility', CASE source_session.visibility
            WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
          'visibility', CASE p_destination_visibility
            WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
          'copiedHistoryItemCount', history_count
        ),
        pg_catalog.clock_timestamp()
      );

      PERFORM pg_catalog.set_config('opengeni.session_activity_gate_state', 'preparing', true);
      SET CONSTRAINTS ALL IMMEDIATE;
      SET CONSTRAINTS sessions_activity_insert_commit_guard,
        sessions_activity_update_commit_guard DEFERRED;
      PERFORM pg_catalog.set_config('opengeni.session_activity_gate_state', 'finalizing', true);
      UPDATE workspace_session_activity_revisions counter
      SET revision = counter.revision + 1
      WHERE counter.workspace_id = p_destination_workspace_id
      RETURNING counter.revision INTO destination_activity_revision;
      IF destination_activity_revision IS NULL THEN
        RAISE EXCEPTION 'session fork destination activity counter is unavailable'
          USING ERRCODE = '55000';
      END IF;
      UPDATE sessions destination_session
      SET activity_revision = destination_activity_revision,
          activity_revision_pending_xid = NULL
      WHERE destination_session.id = destination_session_id
        AND destination_session.activity_revision_pending_xid
          = pg_catalog.pg_current_xact_id()::text::bigint;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'session fork destination activity was not finalized'
          USING ERRCODE = '55000';
      END IF;
      SET CONSTRAINTS sessions_activity_insert_commit_guard,
        sessions_activity_update_commit_guard IMMEDIATE;
      PERFORM pg_catalog.set_config('opengeni.session_activity_gate_state', '', true);
      PERFORM pg_catalog.set_config('opengeni.session_activity_gate_workspace_id', '', true);
      PERFORM pg_catalog.set_config(
        'opengeni.session_visibility_write_capability',
        CASE WHEN previous_visibility_marker IS NULL THEN '' ELSE previous_visibility_marker END,
        true
      );
      DELETE FROM session_visibility_write_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id()
        AND capability.capability_id = visibility_write_capability_id;

      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id', p_source_workspace_id::text, true
      );
      UPDATE session_command_receipts
      SET result = pg_catalog.jsonb_build_object(
            'status', 'applied',
            'sessionId', destination_session_id,
            'workspaceId', p_destination_workspace_id,
            'visibility', p_destination_visibility,
            'authorityEpoch', 1,
            'copiedHistoryItemCount', history_count
          ),
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = receipt_row.id;

      operation_id := receipt_row.id;
      session_id := destination_session_id;
      workspace_id := p_destination_workspace_id;
      visibility := p_destination_visibility;
      authority_epoch := 1;
      copied_history_item_count := history_count;
      replay := false;
      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id',
        CASE WHEN previous_workspace_id IS NULL THEN '' ELSE previous_workspace_id END,
        true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.workspace_id',
        CASE WHEN previous_workspace_id IS NULL THEN '' ELSE previous_workspace_id END,
        true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.session_activity_gate_state',
        CASE WHEN previous_gate_state IS NULL THEN '' ELSE previous_gate_state END,
        true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.session_activity_gate_workspace_id',
        CASE WHEN previous_gate_workspace_id IS NULL THEN '' ELSE previous_gate_workspace_id END,
        true
      );
      PERFORM pg_catalog.set_config(
        'opengeni.session_visibility_write_capability',
        CASE WHEN previous_visibility_marker IS NULL THEN '' ELSE previous_visibility_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.fork_session_content(uuid,uuid,uuid,text,uuid,text,text,text) FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.fork_session_content(uuid,uuid,uuid,text,uuid,text,text,text) TO opengeni_app',
      data_schema
    );
  END IF;
END
$session_fork_activation$;

COMMENT ON FUNCTION fork_session_content(uuid, uuid, uuid, text, uuid, text, text, text) IS
  'Creates an independent idle session from an explicit durable-content allowlist; copies no live runtime, provider authority, credentials, grants, delegations, pins, variables, rigs, turns, attempts, queues, goals, or pending work.';

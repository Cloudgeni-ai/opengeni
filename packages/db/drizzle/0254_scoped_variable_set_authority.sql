-- deployment-mode: rolling
-- Activate explicit organization, workspace, and organization+user ownership
-- for Variable Sets. Existing rows remain workspace-owned. User ownership is
-- derived only from the authenticated active organization member.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "workspace_variable_sets"
  ADD COLUMN "generation" bigint NOT NULL DEFAULT 1,
  ADD COLUMN "status" text NOT NULL DEFAULT 'active',
  ADD COLUMN "revoked_at" timestamptz;

ALTER TABLE "workspace_variable_sets"
  DROP CONSTRAINT "workspace_variable_sets_authority_scope_check",
  DROP CONSTRAINT "workspace_variable_sets_authority_shape_check";

ALTER TABLE "workspace_variable_sets"
  ADD CONSTRAINT "workspace_variable_sets_authority_scope_check"
    CHECK ("authority_scope" IN ('organization', 'workspace', 'user')) NOT VALID,
  ADD CONSTRAINT "workspace_variable_sets_authority_shape_check" CHECK (
    (
      "authority_scope" IN ('organization', 'workspace')
      AND "authority_id" IS NULL
      AND "owner_organization_membership_id" IS NULL
    ) OR (
      "authority_scope" = 'user'
      AND "authority_id" IS NOT NULL
      AND "owner_organization_membership_id" IS NOT NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT "workspace_variable_sets_generation_check"
    CHECK ("generation" > 0) NOT VALID,
  ADD CONSTRAINT "workspace_variable_sets_status_check"
    CHECK ("status" IN ('active', 'revoked')) NOT VALID,
  ADD CONSTRAINT "workspace_variable_sets_revocation_check" CHECK (
    ("status" = 'active' AND "revoked_at" IS NULL)
    OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "workspace_variable_sets"
  VALIDATE CONSTRAINT "workspace_variable_sets_authority_scope_check",
  VALIDATE CONSTRAINT "workspace_variable_sets_authority_shape_check",
  VALIDATE CONSTRAINT "workspace_variable_sets_generation_check",
  VALIDATE CONSTRAINT "workspace_variable_sets_status_check",
  VALIDATE CONSTRAINT "workspace_variable_sets_revocation_check";

DROP INDEX "workspace_variable_sets_workspace_name_idx";
CREATE UNIQUE INDEX "workspace_variable_sets_workspace_name_active_idx"
  ON "workspace_variable_sets" ("workspace_id", "name")
  WHERE "authority_scope" = 'workspace' AND "status" = 'active';
CREATE UNIQUE INDEX "workspace_variable_sets_organization_name_active_idx"
  ON "workspace_variable_sets" ("account_id", "name")
  WHERE "authority_scope" = 'organization' AND "status" = 'active';
CREATE UNIQUE INDEX "workspace_variable_sets_user_name_active_idx"
  ON "workspace_variable_sets" (
    "account_id", "owner_organization_membership_id", "name"
  ) WHERE "authority_scope" = 'user' AND "status" = 'active';
CREATE INDEX "workspace_variable_sets_account_scope_created_idx"
  ON "workspace_variable_sets" ("account_id", "authority_scope", "created_at", "id")
  WHERE "status" = 'active';

CREATE TABLE opengeni_private.variable_set_authority_capabilities (
  "backend_pid" integer NOT NULL,
  "transaction_id" xid8 NOT NULL,
  "capability_kind" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "variable_set_authority_capabilities_kind_chk" CHECK (
    "capability_kind" IN ('read', 'write', 'materialize')
  ),
  CONSTRAINT "variable_set_authority_capabilities_pk" PRIMARY KEY (
    "backend_pid", "transaction_id", "capability_kind"
  )
);
REVOKE ALL ON TABLE opengeni_private.variable_set_authority_capabilities FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.variable_set_authority_capability_active(
  p_capability_kind text DEFAULT NULL
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $capability_active$
  SELECT EXISTS (
    SELECT 1
    FROM opengeni_private.variable_set_authority_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND (
        p_capability_kind IS NULL
        OR capability.capability_kind = p_capability_kind
      )
  )
$capability_active$;
REVOKE ALL ON FUNCTION
  opengeni_private.variable_set_authority_capability_active(text) FROM PUBLIC;

DO $variable_set_capability_policies$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspace_variable_sets',
    'workspace_variable_set_variables',
    'organization_memberships',
    'workspace_memberships',
    'organization_user_resource_authorities',
    'organization_user_resource_grants',
    'sessions',
    'scheduled_tasks',
    'session_turns',
    'session_turn_attempts',
    'session_attempt_interruptions',
    'rig_versions'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY variable_set_authority_capability_read ON %I.%I '
        || 'FOR SELECT USING (current_user = %L AND '
        || 'opengeni_private.variable_set_authority_capability_active())',
      data_schema,
      table_name,
      migration_owner
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'workspace_variable_sets',
    'workspace_variable_set_variables',
    'organization_user_resource_authorities',
    'organization_user_resource_grants'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY variable_set_authority_capability_insert ON %I.%I '
        || 'FOR INSERT WITH CHECK (current_user = %L AND '
        || 'opengeni_private.variable_set_authority_capability_active(''write''))',
      data_schema,
      table_name,
      migration_owner
    );
    EXECUTE format(
      'CREATE POLICY variable_set_authority_capability_update ON %I.%I '
        || 'FOR UPDATE USING (current_user = %L AND '
        || 'opengeni_private.variable_set_authority_capability_active(''write'')) '
        || 'WITH CHECK (current_user = %L AND '
        || 'opengeni_private.variable_set_authority_capability_active(''write''))',
      data_schema,
      table_name,
      migration_owner,
      migration_owner
    );
    EXECUTE format(
      'CREATE POLICY variable_set_authority_capability_delete ON %I.%I '
        || 'FOR DELETE USING (current_user = %L AND '
        || 'opengeni_private.variable_set_authority_capability_active(''write''))',
      data_schema,
      table_name,
      migration_owner
    );
  END LOOP;
END
$variable_set_capability_policies$;

DO $scoped_variable_set_authority$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.create_scoped_variable_set(
      p_account_id uuid,
      p_workspace_id uuid,
      p_scope text,
      p_name text,
      p_description text,
      p_variables jsonb DEFAULT '[]'::jsonb,
      p_allow_organization boolean DEFAULT false
    ) RETURNS TABLE (
      variable_set_id uuid,
      authority_scope text,
      generation bigint,
      status text
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      caller_subject text := nullif(pg_catalog.current_setting('opengeni.subject_id', true), '');
      owner_membership organization_memberships%%ROWTYPE;
      created_id uuid := pg_catalog.gen_random_uuid();
      created_authority_id uuid;
      variable_count integer;
    BEGIN
      INSERT INTO opengeni_private.variable_set_authority_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'write')
      ON CONFLICT DO NOTHING;

      IF p_account_id IS DISTINCT FROM nullif(
          pg_catalog.current_setting('opengeni.account_id', true), ''
        )::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(
          pg_catalog.current_setting('opengeni.workspace_id', true), ''
        )::uuid
      THEN
        RAISE EXCEPTION 'variable-set creation scope mismatch' USING ERRCODE = '42501';
      END IF;
      IF p_scope NOT IN ('organization', 'workspace', 'user')
        OR nullif(btrim(p_name), '') IS NULL
        OR length(p_name) > 120
        OR p_description IS NOT NULL AND length(p_description) > 2000
        OR pg_catalog.jsonb_typeof(p_variables) IS DISTINCT FROM 'array'
      THEN
        RAISE EXCEPTION 'invalid scoped variable-set creation request' USING ERRCODE = '22023';
      END IF;

      PERFORM 1 FROM workspaces workspace_value
      WHERE workspace_value.id = p_workspace_id
        AND workspace_value.account_id = p_account_id
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'variable-set workspace is outside the organization'
          USING ERRCODE = '42501';
      END IF;

      IF p_scope = 'organization' AND NOT p_allow_organization THEN
        RAISE EXCEPTION 'organization variable-set creation requires account authority'
          USING ERRCODE = '42501';
      ELSIF p_scope = 'user' THEN
        IF caller_subject IS NULL THEN
          RAISE EXCEPTION 'user variable-set creation requires an authenticated subject'
            USING ERRCODE = '42501';
        END IF;
        SELECT membership.* INTO STRICT owner_membership
        FROM organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.subject_id = caller_subject
          AND membership.status = 'active'
          AND membership.revoked_at IS NULL
        FOR SHARE;
        IF owner_membership.personal_workspace_id IS DISTINCT FROM p_workspace_id THEN
          PERFORM 1 FROM workspace_memberships workspace_membership
          WHERE workspace_membership.account_id = p_account_id
            AND workspace_membership.workspace_id = p_workspace_id
            AND workspace_membership.subject_id = caller_subject
          FOR KEY SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'user variable-set owner lacks current workspace access'
              USING ERRCODE = '42501';
          END IF;
        END IF;
        created_authority_id := pg_catalog.gen_random_uuid();
        INSERT INTO organization_user_resource_authorities (
          id, account_id, organization_membership_id, resource_kind,
          resource_id, origin_workspace_id, generation, status
        ) VALUES (
          created_authority_id, p_account_id, owner_membership.id, 'variable_set',
          created_id, p_workspace_id, 1, 'active'
        );
      END IF;

      SELECT count(*)::integer INTO variable_count
      FROM pg_catalog.jsonb_array_elements(p_variables) item
      WHERE pg_catalog.jsonb_typeof(item) = 'object'
        AND item ? 'name' AND item ? 'valueEncrypted'
        AND pg_catalog.jsonb_typeof(item -> 'name') = 'string'
        AND pg_catalog.jsonb_typeof(item -> 'valueEncrypted') = 'string';
      IF variable_count <> pg_catalog.jsonb_array_length(p_variables) THEN
        RAISE EXCEPTION 'invalid encrypted variable-set values' USING ERRCODE = '22023';
      END IF;

      INSERT INTO workspace_variable_sets (
        id, account_id, workspace_id, name, description, authority_scope,
        authority_id, owner_organization_membership_id, origin_workspace_id,
        generation, status
      ) VALUES (
        created_id, p_account_id, p_workspace_id, p_name, p_description, p_scope,
        created_authority_id,
        CASE WHEN p_scope = 'user' THEN owner_membership.id ELSE NULL END,
        p_workspace_id, 1, 'active'
      );

      INSERT INTO workspace_variable_set_variables (
        account_id, workspace_id, variable_set_id, name, value_encrypted
      )
      SELECT p_account_id, p_workspace_id, created_id,
        item ->> 'name', item ->> 'valueEncrypted'
      FROM pg_catalog.jsonb_array_elements(p_variables) item;

      variable_set_id := created_id;
      authority_scope := p_scope;
      generation := 1;
      status := 'active';
      RETURN NEXT;
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'write';
      RETURN;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'write';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);
END
$scoped_variable_set_authority$;

REVOKE ALL ON FUNCTION create_scoped_variable_set(
  uuid, uuid, text, text, text, jsonb, boolean
) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION create_scoped_variable_set(
      uuid, uuid, text, text, text, jsonb, boolean
    ) TO opengeni_app;
    REVOKE ALL ON TABLE organization_user_resource_authorities FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_resource_grants FROM opengeni_app;
  END IF;
END
$grants$;

COMMENT ON COLUMN "workspace_variable_sets"."authority_scope" IS
  'Explicit owner scope: organization, workspace, or organization+user. Omitted legacy creation remains workspace-owned.';
COMMENT ON COLUMN "workspace_variable_sets"."generation" IS
  'Monotonic resource generation revalidated immediately before plaintext read or runtime materialization.';

DO $scoped_variable_set_functions$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.scoped_variable_set_actor_membership(
      p_account_id uuid,
      p_workspace_id uuid
    ) RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      caller_subject text := nullif(pg_catalog.current_setting('opengeni.subject_id', true), '');
      membership_id uuid;
      personal_workspace_id uuid;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(
          pg_catalog.current_setting('opengeni.account_id', true), ''
        )::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(
          pg_catalog.current_setting('opengeni.workspace_id', true), ''
        )::uuid
      THEN
        RAISE EXCEPTION 'variable-set actor scope mismatch' USING ERRCODE = '42501';
      END IF;

      SELECT membership.id, membership.personal_workspace_id
        INTO membership_id, personal_workspace_id
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = caller_subject
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
      FOR SHARE;

      -- Configured-key, delegated API-grant, and legacy internal callers may
      -- predate organization memberships. They may operate on organization or
      -- workspace sets only: a NULL membership id can never match a user-owned
      -- set. Exact runtime materialization separately validates its canonical
      -- session, turn, attempt, generation, and selected variable set.
      IF membership_id IS NULL THEN
        RETURN NULL;
      END IF;

      IF personal_workspace_id IS DISTINCT FROM p_workspace_id THEN
        PERFORM 1
        FROM workspace_memberships workspace_membership
        WHERE workspace_membership.account_id = p_account_id
          AND workspace_membership.workspace_id = p_workspace_id
          AND workspace_membership.subject_id = caller_subject
        FOR KEY SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'variable-set actor lacks current workspace access'
            USING ERRCODE = '42501';
        END IF;
      END IF;
      RETURN membership_id;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.scoped_variable_set_json(
      p_variable_set_id uuid
    ) RETURNS jsonb
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
      SELECT pg_catalog.jsonb_build_object(
        'id', variable_set.id,
        'accountId', variable_set.account_id,
        'workspaceId', variable_set.workspace_id,
        'scope', variable_set.authority_scope,
        'generation', variable_set.generation,
        'status', variable_set.status,
        'name', variable_set.name,
        'description', variable_set.description,
        'variables', coalesce((
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'name', variable.name,
              'version', variable.version,
              'createdAt', variable.created_at,
              'updatedAt', variable.updated_at
            ) ORDER BY variable.name
          )
          FROM workspace_variable_set_variables variable
          WHERE variable.variable_set_id = variable_set.id
            AND variable.account_id = variable_set.account_id
        ), '[]'::jsonb),
        'createdAt', variable_set.created_at,
        'updatedAt', variable_set.updated_at
      )
      FROM workspace_variable_sets variable_set
      WHERE variable_set.id = p_variable_set_id
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.list_scoped_variable_sets(
      p_account_id uuid,
      p_workspace_id uuid,
      p_variable_set_id uuid DEFAULT NULL,
      p_name text DEFAULT NULL,
      p_scope text DEFAULT NULL
    ) RETURNS SETOF jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      actor_membership_id uuid;
      variable_set_row record;
    BEGIN
      INSERT INTO opengeni_private.variable_set_authority_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
      ON CONFLICT DO NOTHING;
      actor_membership_id := scoped_variable_set_actor_membership(
        p_account_id, p_workspace_id
      );
      IF p_scope IS NOT NULL AND p_scope NOT IN ('organization', 'workspace', 'user') THEN
        RAISE EXCEPTION 'invalid variable-set scope' USING ERRCODE = '22023';
      END IF;

      FOR variable_set_row IN
        SELECT variable_set.id
        FROM workspace_variable_sets variable_set
        WHERE variable_set.account_id = p_account_id
          AND variable_set.status = 'active'
          AND (p_variable_set_id IS NULL OR variable_set.id = p_variable_set_id)
          AND (p_name IS NULL OR variable_set.name = p_name)
          AND (p_scope IS NULL OR variable_set.authority_scope = p_scope)
          AND (
            variable_set.authority_scope = 'organization'
            OR (
              variable_set.authority_scope = 'workspace'
              AND variable_set.workspace_id = p_workspace_id
            )
            OR (
              variable_set.authority_scope = 'user'
              AND variable_set.owner_organization_membership_id = actor_membership_id
            )
          )
        ORDER BY
          CASE variable_set.authority_scope
            WHEN 'user' THEN 1 WHEN 'workspace' THEN 2 ELSE 3
          END,
          variable_set.created_at,
          variable_set.id
      LOOP
        RETURN NEXT scoped_variable_set_json(variable_set_row.id);
      END LOOP;

      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'read';
      RETURN;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'read';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.count_scoped_variable_sets(
      p_account_id uuid,
      p_workspace_id uuid,
      p_scope text
    ) RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      actor_membership_id uuid;
      result_count integer;
    BEGIN
      INSERT INTO opengeni_private.variable_set_authority_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
      ON CONFLICT DO NOTHING;
      actor_membership_id := scoped_variable_set_actor_membership(
        p_account_id, p_workspace_id
      );
      IF p_scope NOT IN ('organization', 'workspace', 'user') THEN
        RAISE EXCEPTION 'invalid variable-set scope' USING ERRCODE = '22023';
      END IF;
      SELECT count(*)::integer INTO result_count
      FROM workspace_variable_sets variable_set
      WHERE variable_set.account_id = p_account_id
        AND variable_set.authority_scope = p_scope
        AND variable_set.status = 'active'
        AND (
          p_scope = 'organization'
          OR (p_scope = 'workspace' AND variable_set.workspace_id = p_workspace_id)
          OR (
            p_scope = 'user'
            AND variable_set.owner_organization_membership_id = actor_membership_id
          )
        );
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'read';
      RETURN result_count;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'read';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.mutate_scoped_variable_set(
      p_account_id uuid,
      p_workspace_id uuid,
      p_variable_set_id uuid,
      p_operation text,
      p_name text DEFAULT NULL,
      p_name_present boolean DEFAULT false,
      p_description text DEFAULT NULL,
      p_description_present boolean DEFAULT false,
      p_variable_name text DEFAULT NULL,
      p_value_encrypted text DEFAULT NULL,
      p_allow_organization boolean DEFAULT false
    ) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      actor_membership_id uuid;
      variable_set_row workspace_variable_sets%%ROWTYPE;
      deleted_variable boolean := false;
      attached_sessions integer;
      attached_tasks integer;
      mutation_result jsonb;
    BEGIN
      INSERT INTO opengeni_private.variable_set_authority_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'write')
      ON CONFLICT DO NOTHING;
      actor_membership_id := scoped_variable_set_actor_membership(
        p_account_id, p_workspace_id
      );
      IF p_operation NOT IN ('update', 'set_variable', 'delete_variable', 'revoke') THEN
        RAISE EXCEPTION 'invalid variable-set mutation' USING ERRCODE = '22023';
      END IF;

      SELECT variable_set.* INTO STRICT variable_set_row
      FROM workspace_variable_sets variable_set
      WHERE variable_set.id = p_variable_set_id
        AND variable_set.account_id = p_account_id
        AND variable_set.status = 'active'
        AND (
          (
            variable_set.authority_scope = 'organization'
            AND p_allow_organization
          )
          OR (
            variable_set.authority_scope = 'workspace'
            AND variable_set.workspace_id = p_workspace_id
          )
          OR (
            variable_set.authority_scope = 'user'
            AND variable_set.owner_organization_membership_id = actor_membership_id
          )
        )
      FOR UPDATE;

      IF variable_set_row.authority_scope = 'organization' AND NOT p_allow_organization THEN
        RAISE EXCEPTION 'organization variable-set mutation requires account authority'
          USING ERRCODE = '42501';
      END IF;

      IF p_operation = 'update' THEN
        IF p_name_present AND (nullif(btrim(p_name), '') IS NULL OR length(p_name) > 120) THEN
          RAISE EXCEPTION 'invalid variable-set name' USING ERRCODE = '22023';
        END IF;
        IF p_description_present AND p_description IS NOT NULL
          AND length(p_description) > 2000
        THEN
          RAISE EXCEPTION 'invalid variable-set description' USING ERRCODE = '22023';
        END IF;
        UPDATE workspace_variable_sets
        SET name = CASE WHEN p_name_present THEN p_name ELSE name END,
            description = CASE
              WHEN p_description_present THEN p_description ELSE description
            END,
            updated_at = clock_timestamp()
        WHERE id = variable_set_row.id;
      ELSIF p_operation = 'set_variable' THEN
        IF p_variable_name IS NULL OR p_value_encrypted IS NULL THEN
          RAISE EXCEPTION 'variable name and encrypted value are required'
            USING ERRCODE = '22023';
        END IF;
        INSERT INTO workspace_variable_set_variables (
          account_id, workspace_id, variable_set_id, name, value_encrypted
        ) VALUES (
          p_account_id, variable_set_row.workspace_id, variable_set_row.id,
          p_variable_name, p_value_encrypted
        )
        ON CONFLICT (workspace_id, variable_set_id, name)
        DO UPDATE SET value_encrypted = excluded.value_encrypted,
          version = workspace_variable_set_variables.version + 1,
          updated_at = clock_timestamp();
        UPDATE workspace_variable_sets
        SET generation = generation + 1, updated_at = clock_timestamp()
        WHERE id = variable_set_row.id;
        IF variable_set_row.authority_scope = 'user' THEN
          UPDATE organization_user_resource_authorities
          SET generation = generation + 1, updated_at = clock_timestamp()
          WHERE id = variable_set_row.authority_id
            AND account_id = p_account_id
            AND status = 'active';
        END IF;
      ELSIF p_operation = 'delete_variable' THEN
        DELETE FROM workspace_variable_set_variables
        WHERE account_id = p_account_id
          AND variable_set_id = variable_set_row.id
          AND name = p_variable_name;
        GET DIAGNOSTICS attached_sessions = ROW_COUNT;
        deleted_variable := attached_sessions = 1;
        IF deleted_variable THEN
          UPDATE workspace_variable_sets
          SET generation = generation + 1, updated_at = clock_timestamp()
          WHERE id = variable_set_row.id;
          IF variable_set_row.authority_scope = 'user' THEN
            UPDATE organization_user_resource_authorities
            SET generation = generation + 1, updated_at = clock_timestamp()
            WHERE id = variable_set_row.authority_id
              AND account_id = p_account_id
              AND status = 'active';
          END IF;
        END IF;
      ELSE
        SELECT count(*)::integer INTO attached_tasks
        FROM scheduled_tasks task
        WHERE task.account_id = p_account_id
          AND task.variable_set_id = variable_set_row.id;
        SELECT count(*)::integer INTO attached_sessions
        FROM sessions session_value
        WHERE session_value.account_id = p_account_id
          AND session_value.variable_set_id = variable_set_row.id
          AND session_value.status IN (
            'queued', 'running', 'requires_action', 'recovering', 'waiting_capacity'
          );
        IF attached_tasks > 0 OR attached_sessions > 0 THEN
          RAISE EXCEPTION 'variable set remains attached to %% scheduled tasks and %% sessions',
            attached_tasks, attached_sessions USING ERRCODE = '23503';
        END IF;
        IF variable_set_row.authority_scope = 'user' THEN
          UPDATE organization_user_resource_authorities
          SET status = 'revoked', revoked_at = clock_timestamp(),
              generation = generation + 1, updated_at = clock_timestamp()
          WHERE id = variable_set_row.authority_id
            AND account_id = p_account_id
            AND status = 'active';
          UPDATE organization_user_resource_grants
          SET status = 'revoked', revoked_at = clock_timestamp(),
              generation = generation + 1, updated_at = clock_timestamp()
          WHERE account_id = p_account_id
            AND authority_id = variable_set_row.authority_id
            AND status = 'active';
        END IF;
        DELETE FROM workspace_variable_sets
        WHERE id = variable_set_row.id;
      END IF;

      variable_set_row.id := p_variable_set_id;
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'write';
      INSERT INTO opengeni_private.variable_set_authority_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'read')
      ON CONFLICT DO NOTHING;
      mutation_result := pg_catalog.jsonb_build_object(
        'variableSet', scoped_variable_set_json(variable_set_row.id),
        'deletedVariable', deleted_variable
      );
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'read';
      RETURN mutation_result;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind IN ('write', 'read');
      RAISE;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.assert_scoped_variable_set_attempt(
      p_account_id uuid,
      p_workspace_id uuid,
      p_session_id uuid,
      p_turn_id uuid,
      p_attempt_id uuid,
      p_execution_generation integer
    ) RETURNS text
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      initiating_subject text;
      caller_subject text := coalesce(
        nullif(pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''),
        nullif(pg_catalog.current_setting('opengeni.subject_id', true), '')
      );
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(
          pg_catalog.current_setting('opengeni.account_id', true), ''
        )::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(
          pg_catalog.current_setting('opengeni.workspace_id', true), ''
        )::uuid
        OR p_execution_generation <= 0
      THEN
        RAISE EXCEPTION 'variable-set attempt scope mismatch' USING ERRCODE = '42501';
      END IF;
      SELECT coalesce(
          nullif(btrim(turn_value.initiating_human_subject_id), ''),
          CASE WHEN turn_value.initiator_kind = 'subject'
            THEN nullif(btrim(turn_value.initiator_subject_id), '') END
        )
        INTO STRICT initiating_subject
      FROM sessions session_value
      JOIN session_turns turn_value
        ON turn_value.id = p_turn_id
       AND turn_value.account_id = session_value.account_id
       AND turn_value.workspace_id = session_value.workspace_id
       AND turn_value.session_id = session_value.id
      JOIN session_turn_attempts attempt
        ON attempt.id = p_attempt_id
       AND attempt.account_id = turn_value.account_id
       AND attempt.workspace_id = turn_value.workspace_id
       AND attempt.session_id = turn_value.session_id
       AND attempt.turn_id = turn_value.id
      WHERE session_value.id = p_session_id
        AND session_value.account_id = p_account_id
        AND session_value.workspace_id = p_workspace_id
        AND session_value.active_turn_id = p_turn_id
        AND turn_value.active_attempt_id = p_attempt_id
        AND turn_value.execution_generation = p_execution_generation
        AND turn_value.status = 'running'
        AND attempt.execution_generation = p_execution_generation
        AND attempt.state IN ('claimed', 'running')
        AND attempt.closed_at IS NULL
        AND attempt.quiesced_at IS NULL
        AND attempt.authority_epoch = session_value.authority_epoch
        AND attempt.authority_visibility = session_value.visibility
        AND attempt.authority_owner_organization_membership_id
          IS NOT DISTINCT FROM session_value.owner_organization_membership_id
        AND NOT EXISTS (
          SELECT 1 FROM session_attempt_interruptions interruption
          WHERE interruption.account_id = p_account_id
            AND interruption.workspace_id = p_workspace_id
            AND interruption.session_id = p_session_id
            AND interruption.attempt_id = p_attempt_id
            AND interruption.state IN ('pending', 'delivered', 'acknowledged')
        )
      FOR SHARE OF session_value, turn_value
      FOR UPDATE OF attempt;
      IF initiating_subject IS NULL OR caller_subject IS DISTINCT FROM initiating_subject THEN
        RAISE EXCEPTION 'variable-set attempt initiating human mismatch'
          USING ERRCODE = '42501';
      END IF;
      RETURN initiating_subject;
    EXCEPTION WHEN NO_DATA_FOUND THEN
      RAISE EXCEPTION 'variable-set read requires the exact current uninterrupted attempt'
        USING ERRCODE = '42501';
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.read_scoped_variable_set_secret(
      p_account_id uuid,
      p_workspace_id uuid,
      p_variable_set_id uuid,
      p_variable_set_name text,
      p_variable_name text,
      p_actor_kind text,
      p_session_id uuid DEFAULT NULL,
      p_turn_id uuid DEFAULT NULL,
      p_attempt_id uuid DEFAULT NULL,
      p_execution_generation integer DEFAULT NULL
    ) RETURNS TABLE (
      variable_set_id uuid,
      variable_name text,
      variable_version integer,
      value_encrypted text,
      authority_scope text,
      variable_set_generation bigint
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      actor_membership_id uuid;
      variable_set_row workspace_variable_sets%%ROWTYPE;
      resolved_count integer;
      audit_subject text := coalesce(
        nullif(pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''),
        nullif(pg_catalog.current_setting('opengeni.subject_id', true), '')
      );
    BEGIN
      IF (p_variable_set_id IS NULL) = (p_variable_set_name IS NULL)
        OR p_actor_kind NOT IN ('subject', 'agent_attempt')
      THEN
        RAISE EXCEPTION 'invalid exact variable-set read request' USING ERRCODE = '22023';
      END IF;
      INSERT INTO opengeni_private.variable_set_authority_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'materialize')
      ON CONFLICT DO NOTHING;

      IF p_actor_kind = 'subject' THEN
        actor_membership_id := scoped_variable_set_actor_membership(
          p_account_id, p_workspace_id
        );
      ELSE
        audit_subject := assert_scoped_variable_set_attempt(
          p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
          p_execution_generation
        );
      END IF;

      SELECT variable_set.* INTO STRICT variable_set_row
      FROM workspace_variable_sets variable_set
      WHERE variable_set.account_id = p_account_id
        AND variable_set.status = 'active'
        AND (
          (p_variable_set_id IS NOT NULL AND variable_set.id = p_variable_set_id)
          OR (p_variable_set_name IS NOT NULL AND variable_set.name = p_variable_set_name)
        )
        AND (
          variable_set.authority_scope = 'organization'
          OR (
            variable_set.authority_scope = 'workspace'
            AND variable_set.workspace_id = p_workspace_id
          )
          OR (
            variable_set.authority_scope = 'user'
            AND (
              (p_actor_kind = 'subject'
                AND variable_set.owner_organization_membership_id = actor_membership_id)
              OR p_actor_kind = 'agent_attempt'
            )
          )
        )
      ORDER BY CASE variable_set.authority_scope
        WHEN 'user' THEN 1 WHEN 'workspace' THEN 2 ELSE 3 END
      LIMIT 1
      FOR SHARE;

      IF p_actor_kind = 'agent_attempt' THEN
        PERFORM 1 FROM sessions session_value
        LEFT JOIN rig_versions rig_version
          ON rig_version.id = session_value.rig_version_id
         AND rig_version.rig_id = session_value.rig_id
         AND rig_version.account_id = session_value.account_id
        WHERE session_value.id = p_session_id
          AND session_value.account_id = p_account_id
          AND session_value.workspace_id = p_workspace_id
          AND (
            session_value.variable_set_id = variable_set_row.id
            OR coalesce(rig_version.default_variable_set_ids, '[]'::jsonb)
              ? variable_set_row.id::text
          );
        IF NOT FOUND THEN
          RAISE EXCEPTION 'exact variable-set resource was not admitted for this attempt'
            USING ERRCODE = '42501';
        END IF;
        IF variable_set_row.authority_scope = 'user' THEN
          SELECT count(*)::integer INTO resolved_count
          FROM resolve_session_attempt_personal_resources(
            p_account_id, p_workspace_id, p_attempt_id
          ) resolved
          WHERE resolved.resource_kind = 'variable_set'
            AND resolved.resource_id = variable_set_row.id
            AND resolved.authority_id = variable_set_row.authority_id
            AND resolved.authority_generation = variable_set_row.generation;
          IF resolved_count <> 1 THEN
            RAISE EXCEPTION 'personal variable-set grant is not exact or current'
              USING ERRCODE = '42501';
          END IF;
        END IF;
      END IF;

      RETURN QUERY
      SELECT variable_set_row.id, variable.name, variable.version,
        variable.value_encrypted, variable_set_row.authority_scope,
        variable_set_row.generation
      FROM workspace_variable_set_variables variable
      WHERE variable.account_id = p_account_id
        AND variable.variable_set_id = variable_set_row.id
        AND variable.name = p_variable_name;
      IF FOUND THEN
        INSERT INTO audit_events (
          account_id, workspace_id, subject_id, action, target_type, target_id,
          metadata, metadata_codec_version
        ) VALUES (
          p_account_id, p_workspace_id, audit_subject,
          'variable_set.variable.read', 'workspace_variable_set',
          variable_set_row.id::text,
          pg_catalog.jsonb_build_object(
            'variableSetId', variable_set_row.id,
            'name', p_variable_name,
            'actorKind', p_actor_kind,
            'scope', variable_set_row.authority_scope,
            'generation', variable_set_row.generation,
            'sessionId', p_session_id,
            'turnId', p_turn_id,
            'attemptId', p_attempt_id,
            'executionGeneration', p_execution_generation
          ),
          1
        );
      END IF;
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'materialize';
      RETURN;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'materialize';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.materialize_scoped_variable_set_for_attempt(
      p_account_id uuid,
      p_workspace_id uuid,
      p_session_id uuid,
      p_turn_id uuid,
      p_attempt_id uuid,
      p_execution_generation integer,
      p_variable_set_id uuid
    ) RETURNS TABLE (
      variable_set_id uuid,
      variable_set_name text,
      variable_set_description text,
      authority_scope text,
      variable_set_generation bigint,
      variable_name text,
      value_encrypted text
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      initiating_subject text;
      variable_set_row workspace_variable_sets%%ROWTYPE;
      resolved_count integer;
    BEGIN
      INSERT INTO opengeni_private.variable_set_authority_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'materialize')
      ON CONFLICT DO NOTHING;
      initiating_subject := assert_scoped_variable_set_attempt(
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
        p_execution_generation
      );

      SELECT variable_set.* INTO STRICT variable_set_row
      FROM workspace_variable_sets variable_set
      WHERE variable_set.id = p_variable_set_id
        AND variable_set.account_id = p_account_id
        AND variable_set.status = 'active'
      FOR SHARE;
      PERFORM 1 FROM sessions session_value
      LEFT JOIN rig_versions rig_version
        ON rig_version.id = session_value.rig_version_id
       AND rig_version.rig_id = session_value.rig_id
       AND rig_version.account_id = session_value.account_id
      WHERE session_value.id = p_session_id
        AND session_value.account_id = p_account_id
        AND session_value.workspace_id = p_workspace_id
        AND (
          session_value.variable_set_id = variable_set_row.id
          OR coalesce(rig_version.default_variable_set_ids, '[]'::jsonb)
            ? variable_set_row.id::text
        );
      IF NOT FOUND THEN
        RAISE EXCEPTION 'runtime variable set was not selected by the exact session'
          USING ERRCODE = '42501';
      END IF;
      IF variable_set_row.authority_scope = 'workspace'
        AND variable_set_row.workspace_id IS DISTINCT FROM p_workspace_id
      THEN
        RAISE EXCEPTION 'workspace variable set is outside the runtime workspace'
          USING ERRCODE = '42501';
      ELSIF variable_set_row.authority_scope = 'user' THEN
        SELECT count(*)::integer INTO resolved_count
        FROM resolve_session_attempt_personal_resources(
          p_account_id, p_workspace_id, p_attempt_id
        ) resolved
        WHERE resolved.resource_kind = 'variable_set'
          AND resolved.resource_id = variable_set_row.id
          AND resolved.authority_id = variable_set_row.authority_id
          AND resolved.authority_generation = variable_set_row.generation;
        IF resolved_count <> 1 THEN
          RAISE EXCEPTION 'personal variable-set grant is not exact or current'
            USING ERRCODE = '42501';
        END IF;
      END IF;

      INSERT INTO audit_events (
        account_id, workspace_id, subject_id, action, target_type, target_id,
        metadata, metadata_codec_version
      ) VALUES (
        p_account_id, p_workspace_id, initiating_subject,
        'variable_set.materialized', 'workspace_variable_set',
        variable_set_row.id::text,
        pg_catalog.jsonb_build_object(
          'variableSetId', variable_set_row.id,
          'scope', variable_set_row.authority_scope,
          'generation', variable_set_row.generation,
          'sessionId', p_session_id,
          'turnId', p_turn_id,
          'attemptId', p_attempt_id,
          'executionGeneration', p_execution_generation
        ),
        1
      );
      RETURN QUERY
      SELECT selected.id, selected.name, selected.description,
        selected.authority_scope, selected.generation,
        variable.name, variable.value_encrypted
      FROM workspace_variable_sets selected
      LEFT JOIN workspace_variable_set_variables variable
        ON variable.account_id = selected.account_id
       AND variable.variable_set_id = selected.id
      WHERE selected.id = variable_set_row.id
      ORDER BY variable.name;
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'materialize';
      RETURN;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'materialize';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.materialize_scoped_variable_set_for_session(
      p_account_id uuid,
      p_workspace_id uuid,
      p_session_id uuid,
      p_variable_set_id uuid
    ) RETURNS TABLE (
      variable_set_id uuid,
      variable_set_name text,
      variable_set_description text,
      authority_scope text,
      variable_set_generation bigint,
      variable_name text,
      value_encrypted text
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      variable_set_row workspace_variable_sets%%ROWTYPE;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(
          pg_catalog.current_setting('opengeni.account_id', true), ''
        )::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(
          pg_catalog.current_setting('opengeni.workspace_id', true), ''
        )::uuid
      THEN
        RAISE EXCEPTION 'variable-set session materialization scope mismatch'
          USING ERRCODE = '42501';
      END IF;
      INSERT INTO opengeni_private.variable_set_authority_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'materialize')
      ON CONFLICT DO NOTHING;
      SELECT variable_set.* INTO STRICT variable_set_row
      FROM sessions session_value
      JOIN workspace_variable_sets variable_set
        ON variable_set.id = p_variable_set_id
       AND variable_set.account_id = session_value.account_id
      WHERE session_value.id = p_session_id
        AND session_value.account_id = p_account_id
        AND session_value.workspace_id = p_workspace_id
        AND session_value.variable_set_id = p_variable_set_id
        AND session_value.status IN (
          'queued', 'running', 'idle', 'requires_action', 'recovering', 'waiting_capacity'
        )
        AND variable_set.status = 'active'
        AND (
          variable_set.authority_scope = 'organization'
          OR (
            variable_set.authority_scope = 'workspace'
            AND variable_set.workspace_id = p_workspace_id
          )
        )
      FOR SHARE OF session_value, variable_set;
      RETURN QUERY
      SELECT selected.id, selected.name, selected.description,
        selected.authority_scope, selected.generation,
        variable.name, variable.value_encrypted
      FROM workspace_variable_sets selected
      LEFT JOIN workspace_variable_set_variables variable
        ON variable.account_id = selected.account_id
       AND variable.variable_set_id = selected.id
      WHERE selected.id = variable_set_row.id
      ORDER BY variable.name;
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'materialize';
      RETURN;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.variable_set_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'materialize';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);
END
$scoped_variable_set_functions$;

REVOKE ALL ON FUNCTION scoped_variable_set_actor_membership(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION scoped_variable_set_json(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_scoped_variable_sets(uuid, uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION count_scoped_variable_sets(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION mutate_scoped_variable_set(
  uuid, uuid, uuid, text, text, boolean, text, boolean, text, text, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION assert_scoped_variable_set_attempt(
  uuid, uuid, uuid, uuid, uuid, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_scoped_variable_set_secret(
  uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION materialize_scoped_variable_set_for_attempt(
  uuid, uuid, uuid, uuid, uuid, integer, uuid
) FROM PUBLIC;
REVOKE ALL ON FUNCTION materialize_scoped_variable_set_for_session(
  uuid, uuid, uuid, uuid
) FROM PUBLIC;

DO $scoped_variable_set_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION list_scoped_variable_sets(uuid, uuid, uuid, text, text)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION count_scoped_variable_sets(uuid, uuid, text)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION mutate_scoped_variable_set(
      uuid, uuid, uuid, text, text, boolean, text, boolean, text, text, boolean
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION read_scoped_variable_set_secret(
      uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, integer
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION materialize_scoped_variable_set_for_attempt(
      uuid, uuid, uuid, uuid, uuid, integer, uuid
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION materialize_scoped_variable_set_for_session(
      uuid, uuid, uuid, uuid
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.variable_set_authority_capability_active(text)
      TO opengeni_app;
    REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE workspace_variable_sets
      FROM opengeni_app;
    REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE workspace_variable_set_variables
      FROM opengeni_app;
    REVOKE ALL ON TABLE opengeni_private.variable_set_authority_capabilities
      FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_resource_authorities FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_resource_grants FROM opengeni_app;
  END IF;
END
$scoped_variable_set_grants$;

COMMENT ON FUNCTION materialize_scoped_variable_set_for_attempt(
  uuid, uuid, uuid, uuid, uuid, integer, uuid
) IS 'Only ciphertext egress for runtime injection; revalidates the exact live attempt and personal grant immediately before returning encrypted values.';
COMMENT ON FUNCTION read_scoped_variable_set_secret(
  uuid, uuid, uuid, text, text, text, uuid, uuid, uuid, integer
) IS 'Only ciphertext egress for exact plaintext reads; commits value-free audit metadata before application decryption.';

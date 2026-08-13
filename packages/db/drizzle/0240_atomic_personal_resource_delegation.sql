-- deployment-mode: rolling
-- Admit personal Variable Set and Rig selections at the exact accepted session
-- attempt. This slice stores immutable authority snapshots and atomically
-- consumes once grants. It does not load secrets, materialize resources,
-- activate scheduled tasks, or expose Variable Set/Rig CRUD.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE opengeni_private.personal_resource_delegation_capabilities (
  "backend_pid" integer NOT NULL,
  "transaction_id" xid8 NOT NULL,
  "capability_kind" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "personal_resource_delegation_capabilities_kind_chk" CHECK (
    "capability_kind" IN ('admit', 'resolve')
  ),
  CONSTRAINT "personal_resource_delegation_capabilities_pk" PRIMARY KEY (
    "backend_pid", "transaction_id", "capability_kind"
  )
);
REVOKE ALL ON TABLE opengeni_private.personal_resource_delegation_capabilities FROM PUBLIC;

DO $personal_resource_capability_revoke$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON TABLE opengeni_private.personal_resource_delegation_capabilities
      FROM opengeni_app;
  END IF;
END
$personal_resource_capability_revoke$;

CREATE TABLE "session_attempt_personal_resource_admissions" (
  "attempt_id" uuid PRIMARY KEY REFERENCES "session_turn_attempts"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "initiating_human_subject_id" text NOT NULL,
  "owner_organization_membership_id" uuid NOT NULL,
  "membership_authorization_revision" bigint NOT NULL,
  "session_visibility" text NOT NULL,
  "session_authority_epoch" integer NOT NULL,
  "resource_count" integer NOT NULL,
  "admitted_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "session_attempt_personal_resource_admissions_attempt_fk"
    FOREIGN KEY (
      "account_id", "workspace_id", "session_id", "turn_id", "attempt_id"
    ) REFERENCES "session_turn_attempts"(
      "account_id", "workspace_id", "session_id", "turn_id", "id"
    ) ON DELETE CASCADE,
  CONSTRAINT "session_attempt_personal_resource_admissions_owner_fk"
    FOREIGN KEY ("owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "session_attempt_personal_resource_admissions_generation_chk" CHECK (
    "execution_generation" > 0
    AND "membership_authorization_revision" > 0
    AND "session_authority_epoch" > 0
    AND "resource_count" > 0
  ),
  CONSTRAINT "session_attempt_personal_resource_admissions_visibility_chk" CHECK (
    "session_visibility" IN ('user_private', 'workspace_shared')
  ),
  CONSTRAINT "session_attempt_personal_resource_admissions_subject_chk" CHECK (
    length(btrim("initiating_human_subject_id")) BETWEEN 1 AND 1024
  )
);

CREATE UNIQUE INDEX "session_attempt_personal_resource_admissions_identity_uq"
  ON "session_attempt_personal_resource_admissions" (
    "account_id", "workspace_id", "session_id", "turn_id", "attempt_id",
    "execution_generation"
  );

CREATE TABLE "session_attempt_personal_resource_snapshots" (
  "attempt_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "resource_kind" text NOT NULL,
  "resource_id" uuid NOT NULL,
  "resource_version_id" uuid,
  "selection_sources" text[] NOT NULL,
  "action" text NOT NULL,
  "origin_workspace_id" uuid NOT NULL,
  "owner_organization_membership_id" uuid NOT NULL,
  "membership_authorization_revision" bigint NOT NULL,
  "authority_id" uuid NOT NULL,
  "authority_generation" bigint NOT NULL,
  "target_workspace_id" uuid NOT NULL,
  "session_visibility" text NOT NULL,
  "session_authority_epoch" integer NOT NULL,
  "grant_id" uuid NOT NULL,
  "grant_generation" bigint NOT NULL,
  "grant_mode" text NOT NULL,
  "grant_context" text NOT NULL,
  "grant_session_id" uuid,
  "grant_authority_epoch" integer,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "session_attempt_personal_resource_snapshots_pk" PRIMARY KEY (
    "attempt_id", "resource_kind", "resource_id"
  ),
  CONSTRAINT "session_attempt_personal_resource_snapshots_admission_fk"
    FOREIGN KEY (
      "account_id", "workspace_id", "session_id", "turn_id", "attempt_id",
      "execution_generation"
    ) REFERENCES "session_attempt_personal_resource_admissions"(
      "account_id", "workspace_id", "session_id", "turn_id", "attempt_id",
      "execution_generation"
    ) ON DELETE CASCADE,
  CONSTRAINT "session_attempt_personal_resource_snapshots_authority_fk"
    FOREIGN KEY (
      "authority_id", "account_id", "owner_organization_membership_id"
    ) REFERENCES "organization_user_resource_authorities"(
      "id", "account_id", "organization_membership_id"
    ) ON DELETE RESTRICT,
  CONSTRAINT "session_attempt_personal_resource_snapshots_grant_fk"
    FOREIGN KEY ("grant_id", "account_id")
    REFERENCES "organization_user_resource_grants"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "session_attempt_personal_resource_snapshots_kind_chk" CHECK (
    ("resource_kind" = 'variable_set' AND "resource_version_id" IS NULL)
    OR ("resource_kind" = 'rig' AND "resource_version_id" IS NOT NULL)
  ),
  CONSTRAINT "session_attempt_personal_resource_snapshots_action_chk" CHECK (
    ("resource_kind" = 'variable_set' AND "action" = 'variable_set.use')
    OR ("resource_kind" = 'rig' AND "action" = 'rig.use')
  ),
  CONSTRAINT "session_attempt_personal_resource_snapshots_sources_chk" CHECK (
    cardinality("selection_sources") > 0
  ),
  CONSTRAINT "session_attempt_personal_resource_snapshots_generation_chk" CHECK (
    "execution_generation" > 0
    AND "membership_authorization_revision" > 0
    AND "authority_generation" > 0
    AND "session_authority_epoch" > 0
    AND "grant_generation" > 0
  ),
  CONSTRAINT "session_attempt_personal_resource_snapshots_visibility_chk" CHECK (
    "session_visibility" IN ('user_private', 'workspace_shared')
    AND "grant_context" = "session_visibility"
  ),
  CONSTRAINT "session_attempt_personal_resource_snapshots_workspace_chk" CHECK (
    "target_workspace_id" = "workspace_id"
  ),
  CONSTRAINT "session_attempt_personal_resource_snapshots_grant_fence_chk" CHECK (
    (
      "grant_mode" = 'always'
      AND "grant_session_id" IS NULL
      AND "grant_authority_epoch" IS NULL
    ) OR (
      "grant_mode" IN ('once', 'session')
      AND "grant_session_id" = "session_id"
      AND "grant_authority_epoch" = "session_authority_epoch"
    )
  )
);

CREATE INDEX "session_attempt_personal_resource_snapshots_authority_idx"
  ON "session_attempt_personal_resource_snapshots" (
    "account_id", "authority_id", "authority_generation"
  );
CREATE INDEX "session_attempt_personal_resource_snapshots_grant_idx"
  ON "session_attempt_personal_resource_snapshots" (
    "account_id", "grant_id", "grant_generation"
  );

CREATE TABLE "personal_resource_once_consumption_receipts" (
  "grant_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "authority_id" uuid NOT NULL,
  "authority_generation" bigint NOT NULL,
  "grant_generation" bigint NOT NULL,
  "consumed_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "personal_resource_once_consumption_receipts_grant_fk"
    FOREIGN KEY ("grant_id", "account_id")
    REFERENCES "organization_user_resource_grants"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "personal_resource_once_consumption_receipts_attempt_fk"
    FOREIGN KEY (
      "account_id", "workspace_id", "session_id", "turn_id", "attempt_id",
      "execution_generation"
    ) REFERENCES "session_attempt_personal_resource_admissions"(
      "account_id", "workspace_id", "session_id", "turn_id", "attempt_id",
      "execution_generation"
    ) ON DELETE CASCADE,
  CONSTRAINT "personal_resource_once_consumption_receipts_generation_chk" CHECK (
    "execution_generation" > 0
    AND "authority_generation" > 0
    AND "grant_generation" > 0
  )
);

ALTER TABLE "session_attempt_personal_resource_admissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_attempt_personal_resource_admissions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_attempt_personal_resource_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_attempt_personal_resource_snapshots" FORCE ROW LEVEL SECURITY;
ALTER TABLE "personal_resource_once_consumption_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "personal_resource_once_consumption_receipts" FORCE ROW LEVEL SECURITY;

DO $personal_resource_capability_policies$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'session_attempt_personal_resource_admissions',
    'session_attempt_personal_resource_snapshots',
    'personal_resource_once_consumption_receipts'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY personal_resource_delegation_capability_read ON %I.%I '
        || 'FOR SELECT USING ('
        || 'current_user = %L AND EXISTS ('
        || 'SELECT 1 FROM opengeni_private.personal_resource_delegation_capabilities capability '
        || 'WHERE capability.backend_pid = pg_catalog.pg_backend_pid() '
        || 'AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()'
        || '))',
      data_schema,
      table_name,
      migration_owner
    );
    EXECUTE format(
      'CREATE POLICY personal_resource_delegation_capability_insert ON %I.%I '
        || 'FOR INSERT WITH CHECK ('
        || 'current_user = %L AND EXISTS ('
        || 'SELECT 1 FROM opengeni_private.personal_resource_delegation_capabilities capability '
        || 'WHERE capability.backend_pid = pg_catalog.pg_backend_pid() '
        || 'AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned() '
        || 'AND capability.capability_kind = ''admit'''
        || '))',
      data_schema,
      table_name,
      migration_owner
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'organization_memberships',
    'organization_user_resource_authorities',
    'workspace_variable_sets',
    'rigs',
    'rig_versions'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY personal_resource_delegation_read ON %I.%I '
        || 'FOR SELECT USING ('
        || 'current_user = %L AND EXISTS ('
        || 'SELECT 1 FROM opengeni_private.personal_resource_delegation_capabilities capability '
        || 'WHERE capability.backend_pid = pg_catalog.pg_backend_pid() '
        || 'AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()'
        || '))',
      data_schema,
      table_name,
      migration_owner
    );
  END LOOP;

  EXECUTE format(
    'CREATE POLICY personal_resource_delegation_grant_read '
      || 'ON %I.organization_user_resource_grants FOR SELECT USING ('
      || 'current_user = %L AND EXISTS ('
      || 'SELECT 1 FROM opengeni_private.personal_resource_delegation_capabilities capability '
      || 'WHERE capability.backend_pid = pg_catalog.pg_backend_pid() '
      || 'AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()'
      || '))',
    data_schema,
    migration_owner
  );
  EXECUTE format(
    'CREATE POLICY personal_resource_delegation_grant_update '
      || 'ON %I.organization_user_resource_grants FOR UPDATE USING ('
      || 'current_user = %L AND EXISTS ('
      || 'SELECT 1 FROM opengeni_private.personal_resource_delegation_capabilities capability '
      || 'WHERE capability.backend_pid = pg_catalog.pg_backend_pid() '
      || 'AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned() '
      || 'AND capability.capability_kind = ''admit'''
      || ')) WITH CHECK ('
      || 'current_user = %L AND EXISTS ('
      || 'SELECT 1 FROM opengeni_private.personal_resource_delegation_capabilities capability '
      || 'WHERE capability.backend_pid = pg_catalog.pg_backend_pid() '
      || 'AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned() '
      || 'AND capability.capability_kind = ''admit'''
      || '))',
    data_schema,
    migration_owner,
    migration_owner
  );
END
$personal_resource_capability_policies$;

DO $personal_resource_delegation_functions$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.admit_session_attempt_personal_resources()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      session_row sessions%%ROWTYPE;
      turn_row session_turns%%ROWTYPE;
      member_row organization_memberships%%ROWTYPE;
      resource_row record;
      grant_row organization_user_resource_grants%%ROWTYPE;
      resource_total integer := 0;
      snapshot_total integer := 0;
      initiating_subject text;
      affected integer;
    BEGIN
      INSERT INTO opengeni_private.personal_resource_delegation_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'admit')
      ON CONFLICT DO NOTHING;

      SELECT session_value.* INTO STRICT session_row
      FROM sessions session_value
      WHERE session_value.id = NEW.session_id
        AND session_value.account_id = NEW.account_id
        AND session_value.workspace_id = NEW.workspace_id
      FOR SHARE;

      SELECT turn_value.* INTO STRICT turn_row
      FROM session_turns turn_value
      WHERE turn_value.id = NEW.turn_id
        AND turn_value.account_id = NEW.account_id
        AND turn_value.workspace_id = NEW.workspace_id
        AND turn_value.session_id = NEW.session_id
      FOR SHARE;

      IF NEW.execution_generation <= 0
        OR NEW.authority_visibility IS DISTINCT FROM session_row.visibility
        OR NEW.authority_epoch IS DISTINCT FROM session_row.authority_epoch
        OR NEW.authority_owner_organization_membership_id
          IS DISTINCT FROM session_row.owner_organization_membership_id
      THEN
        RAISE EXCEPTION 'personal-resource admission requires the exact session authority'
          USING ERRCODE = '42501';
      END IF;

      SELECT count(*)::integer INTO resource_total
      FROM (
        SELECT DISTINCT selected.resource_kind, selected.resource_id
        FROM (
        SELECT 'variable_set'::text AS resource_kind, variable_set.id AS resource_id
        FROM workspace_variable_sets variable_set
        WHERE variable_set.id = session_row.variable_set_id
          AND variable_set.account_id = NEW.account_id
          AND variable_set.authority_scope = 'user'
        UNION ALL
        SELECT 'rig'::text, rig.id
        FROM rigs rig
        WHERE rig.id = session_row.rig_id
          AND rig.account_id = NEW.account_id
          AND rig.authority_scope = 'user'
        UNION ALL
        SELECT 'variable_set'::text, default_variable_set.id
        FROM rig_versions rig_version
        CROSS JOIN LATERAL jsonb_array_elements_text(
          rig_version.default_variable_set_ids
        ) default_id(value)
        JOIN workspace_variable_sets default_variable_set
          ON default_variable_set.id = default_id.value::uuid
         AND default_variable_set.account_id = NEW.account_id
         AND default_variable_set.authority_scope = 'user'
        WHERE rig_version.id = session_row.rig_version_id
          AND rig_version.rig_id = session_row.rig_id
          AND rig_version.account_id = NEW.account_id
        ) selected
      ) selected_personal_resources;

      IF resource_total = 0 THEN
        DELETE FROM opengeni_private.personal_resource_delegation_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'admit';
        RETURN NEW;
      END IF;

      initiating_subject := coalesce(
        nullif(btrim(turn_row.initiating_human_subject_id), ''),
        CASE WHEN turn_row.initiator_kind = 'subject'
          THEN nullif(btrim(turn_row.initiator_subject_id), '') END
      );
      IF initiating_subject IS NULL THEN
        RAISE EXCEPTION 'personal-resource admission requires an initiating human subject'
          USING ERRCODE = '42501';
      END IF;

      SELECT membership.* INTO STRICT member_row
      FROM organization_memberships membership
      WHERE membership.account_id = NEW.account_id
        AND membership.subject_id = initiating_subject
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
        AND membership.personal_workspace_id IS NOT NULL
      FOR SHARE;

      PERFORM 1
      FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = NEW.account_id
        AND workspace_membership.workspace_id = NEW.workspace_id
        AND workspace_membership.subject_id = initiating_subject
      FOR KEY SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'initiating human lacks target-workspace membership'
          USING ERRCODE = '42501';
      END IF;

      INSERT INTO session_attempt_personal_resource_admissions (
        attempt_id, account_id, workspace_id, session_id, turn_id,
        execution_generation, initiating_human_subject_id,
        owner_organization_membership_id, membership_authorization_revision,
        session_visibility, session_authority_epoch, resource_count
      ) VALUES (
        NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id,
        NEW.execution_generation, initiating_subject, member_row.id,
        member_row.authorization_revision, session_row.visibility,
        session_row.authority_epoch, resource_total
      );

      FOR resource_row IN
        WITH selected AS (
          SELECT
            'variable_set'::text AS resource_kind,
            variable_set.id AS resource_id,
            NULL::uuid AS resource_version_id,
            'variable_set.use'::text AS action,
            'session_variable_set'::text AS selection_source,
            variable_set.workspace_id AS resource_workspace_id,
            variable_set.authority_id,
            variable_set.owner_organization_membership_id,
            variable_set.origin_workspace_id
          FROM workspace_variable_sets variable_set
          WHERE variable_set.id = session_row.variable_set_id
            AND variable_set.account_id = NEW.account_id
            AND variable_set.authority_scope = 'user'
          UNION ALL
          SELECT
            'rig'::text, rig.id, session_row.rig_version_id, 'rig.use'::text,
            'session_rig'::text, rig.workspace_id, rig.authority_id,
            rig.owner_organization_membership_id, rig.origin_workspace_id
          FROM rigs rig
          WHERE rig.id = session_row.rig_id
            AND rig.account_id = NEW.account_id
            AND rig.authority_scope = 'user'
          UNION ALL
          SELECT
            'variable_set'::text, default_variable_set.id, NULL::uuid,
            'variable_set.use'::text,
            ('rig_default_variable_set:' || default_id.ordinality::text)::text,
            default_variable_set.workspace_id, default_variable_set.authority_id,
            default_variable_set.owner_organization_membership_id,
            default_variable_set.origin_workspace_id
          FROM rig_versions rig_version
          CROSS JOIN LATERAL jsonb_array_elements_text(
            rig_version.default_variable_set_ids
          ) WITH ORDINALITY default_id(value, ordinality)
          JOIN workspace_variable_sets default_variable_set
            ON default_variable_set.id = default_id.value::uuid
           AND default_variable_set.account_id = NEW.account_id
           AND default_variable_set.authority_scope = 'user'
          WHERE rig_version.id = session_row.rig_version_id
            AND rig_version.rig_id = session_row.rig_id
            AND rig_version.account_id = NEW.account_id
        )
        SELECT resource_kind, resource_id,
          min(resource_version_id::text)::uuid AS resource_version_id,
          action, array_agg(selection_source ORDER BY selection_source) AS selection_sources,
          min(resource_workspace_id::text)::uuid AS resource_workspace_id,
          min(authority_id::text)::uuid AS authority_id,
          min(owner_organization_membership_id::text)::uuid
            AS owner_organization_membership_id,
          min(origin_workspace_id::text)::uuid AS origin_workspace_id
        FROM selected
        GROUP BY resource_kind, resource_id, action
        ORDER BY resource_kind, resource_id
      LOOP
        IF resource_row.owner_organization_membership_id IS DISTINCT FROM member_row.id
          OR resource_row.resource_workspace_id IS DISTINCT FROM member_row.personal_workspace_id
          OR resource_row.origin_workspace_id IS DISTINCT FROM member_row.personal_workspace_id
        THEN
          RAISE EXCEPTION 'personal resource owner/origin does not match initiating membership'
            USING ERRCODE = '42501';
        END IF;

        IF resource_row.resource_kind = 'variable_set' THEN
          PERFORM 1 FROM workspace_variable_sets variable_set
          WHERE variable_set.id = resource_row.resource_id
            AND variable_set.account_id = NEW.account_id
            AND variable_set.workspace_id = member_row.personal_workspace_id
            AND variable_set.authority_scope = 'user'
            AND variable_set.authority_id = resource_row.authority_id
            AND variable_set.owner_organization_membership_id = member_row.id
            AND variable_set.origin_workspace_id = member_row.personal_workspace_id
          FOR SHARE;
        ELSE
          PERFORM 1 FROM rigs rig
          WHERE rig.id = resource_row.resource_id
            AND rig.account_id = NEW.account_id
            AND rig.workspace_id = member_row.personal_workspace_id
            AND rig.authority_scope = 'user'
            AND rig.authority_id = resource_row.authority_id
            AND rig.owner_organization_membership_id = member_row.id
            AND rig.origin_workspace_id = member_row.personal_workspace_id
          FOR SHARE;
          IF FOUND THEN
            PERFORM 1 FROM rig_versions rig_version
            WHERE rig_version.id = resource_row.resource_version_id
              AND rig_version.account_id = NEW.account_id
              AND rig_version.rig_id = resource_row.resource_id
            FOR SHARE;
          END IF;
        END IF;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'personal resource identity changed during admission'
            USING ERRCODE = '42501';
        END IF;

        PERFORM 1
        FROM organization_user_resource_authorities authority
        WHERE authority.id = resource_row.authority_id
          AND authority.account_id = NEW.account_id
          AND authority.organization_membership_id = member_row.id
          AND authority.resource_kind = resource_row.resource_kind
          AND authority.resource_id = resource_row.resource_id
          AND authority.origin_workspace_id = member_row.personal_workspace_id
          AND authority.status = 'active'
          AND authority.revoked_at IS NULL
        FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'personal resource authority is not live'
            USING ERRCODE = '42501';
        END IF;

        SELECT grant_value.* INTO grant_row
        FROM organization_user_resource_grants grant_value
        WHERE grant_value.account_id = NEW.account_id
          AND grant_value.authority_id = resource_row.authority_id
          AND grant_value.owner_organization_membership_id = member_row.id
          AND grant_value.workspace_id = NEW.workspace_id
          AND grant_value.action = resource_row.action
          AND grant_value.context = session_row.visibility
          AND grant_value.status = 'active'
          AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
          AND (
            (
              grant_value.mode IN ('once', 'session')
              AND grant_value.session_id = NEW.session_id
              AND grant_value.authority_epoch = session_row.authority_epoch
            ) OR (
              grant_value.mode = 'always'
              AND grant_value.session_id IS NULL
              AND grant_value.authority_epoch IS NULL
            )
          )
        ORDER BY
          CASE grant_value.mode WHEN 'once' THEN 1 WHEN 'session' THEN 2 ELSE 3 END,
          grant_value.generation DESC,
          grant_value.id
        LIMIT 1
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'matching personal-resource grant required'
            USING ERRCODE = '42501';
        END IF;

        INSERT INTO session_attempt_personal_resource_snapshots (
          attempt_id, account_id, workspace_id, session_id, turn_id,
          execution_generation, resource_kind, resource_id, resource_version_id,
          selection_sources, action, origin_workspace_id,
          owner_organization_membership_id, membership_authorization_revision,
          authority_id, authority_generation, target_workspace_id,
          session_visibility, session_authority_epoch, grant_id, grant_generation,
          grant_mode, grant_context, grant_session_id, grant_authority_epoch
        )
        SELECT
          NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id,
          NEW.execution_generation, resource_row.resource_kind, resource_row.resource_id,
          resource_row.resource_version_id, resource_row.selection_sources,
          resource_row.action, member_row.personal_workspace_id, member_row.id,
          member_row.authorization_revision, authority.id, authority.generation,
          NEW.workspace_id, session_row.visibility, session_row.authority_epoch,
          grant_row.id, grant_row.generation, grant_row.mode, grant_row.context,
          grant_row.session_id, grant_row.authority_epoch
        FROM organization_user_resource_authorities authority
        WHERE authority.id = resource_row.authority_id
          AND authority.account_id = NEW.account_id;

        IF grant_row.mode = 'once' THEN
          UPDATE organization_user_resource_grants
          SET status = 'consumed', updated_at = clock_timestamp()
          WHERE id = grant_row.id
            AND account_id = NEW.account_id
            AND generation = grant_row.generation
            AND status = 'active';
          GET DIAGNOSTICS affected = ROW_COUNT;
          IF affected <> 1 THEN
            RAISE EXCEPTION 'once grant lost its first-use race'
              USING ERRCODE = '40001';
          END IF;
          INSERT INTO personal_resource_once_consumption_receipts (
            grant_id, account_id, attempt_id, workspace_id, session_id, turn_id,
            execution_generation, authority_id, authority_generation, grant_generation
          ) SELECT
            grant_row.id, NEW.account_id, NEW.id, NEW.workspace_id, NEW.session_id,
            NEW.turn_id, NEW.execution_generation, authority.id, authority.generation,
            grant_row.generation
          FROM organization_user_resource_authorities authority
          WHERE authority.id = resource_row.authority_id
            AND authority.account_id = NEW.account_id;
        END IF;
        snapshot_total := snapshot_total + 1;
      END LOOP;

      IF snapshot_total <> resource_total THEN
        RAISE EXCEPTION 'personal-resource snapshot collection is not exact'
          USING ERRCODE = '23514';
      END IF;

      DELETE FROM opengeni_private.personal_resource_delegation_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'admit';
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.personal_resource_delegation_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'admit';
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.resolve_session_attempt_personal_resources(
      p_account_id uuid,
      p_workspace_id uuid,
      p_attempt_id uuid
    ) RETURNS TABLE (
      resource_kind text,
      resource_id uuid,
      resource_version_id uuid,
      selection_sources text[],
      action text,
      authority_id uuid,
      authority_generation bigint,
      grant_id uuid,
      grant_generation bigint,
      grant_mode text
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      admission_row session_attempt_personal_resource_admissions%%ROWTYPE;
      invalid_count integer;
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
      THEN
        RAISE EXCEPTION 'personal-resource resolve scope mismatch'
          USING ERRCODE = '42501';
      END IF;

      INSERT INTO opengeni_private.personal_resource_delegation_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'resolve')
      ON CONFLICT DO NOTHING;

      SELECT admission.* INTO STRICT admission_row
      FROM session_attempt_personal_resource_admissions admission
      WHERE admission.attempt_id = p_attempt_id
        AND admission.account_id = p_account_id
        AND admission.workspace_id = p_workspace_id;

      IF caller_subject IS DISTINCT FROM admission_row.initiating_human_subject_id THEN
        RAISE EXCEPTION 'personal-resource resolve initiating human mismatch'
          USING ERRCODE = '42501';
      END IF;

      SELECT count(*)::integer INTO invalid_count
      FROM session_attempt_personal_resource_snapshots snapshot
      WHERE snapshot.attempt_id = admission_row.attempt_id
        AND NOT (
          EXISTS (
            SELECT 1
            FROM session_turn_attempts attempt
            JOIN sessions session_value
              ON session_value.id = attempt.session_id
             AND session_value.account_id = attempt.account_id
             AND session_value.workspace_id = attempt.workspace_id
            JOIN session_turns turn_value
              ON turn_value.id = attempt.turn_id
             AND turn_value.account_id = attempt.account_id
             AND turn_value.workspace_id = attempt.workspace_id
             AND turn_value.session_id = attempt.session_id
            WHERE attempt.id = snapshot.attempt_id
              AND attempt.account_id = snapshot.account_id
              AND attempt.workspace_id = snapshot.workspace_id
              AND attempt.session_id = snapshot.session_id
              AND attempt.turn_id = snapshot.turn_id
              AND attempt.execution_generation = snapshot.execution_generation
              AND attempt.state IN ('claimed', 'running')
              AND attempt.quiesced_at IS NULL
              AND attempt.authority_visibility = snapshot.session_visibility
              AND attempt.authority_epoch = snapshot.session_authority_epoch
              AND session_value.visibility = snapshot.session_visibility
              AND session_value.authority_epoch = snapshot.session_authority_epoch
              AND coalesce(
                nullif(btrim(turn_value.initiating_human_subject_id), ''),
                CASE WHEN turn_value.initiator_kind = 'subject'
                  THEN nullif(btrim(turn_value.initiator_subject_id), '') END
              ) = admission_row.initiating_human_subject_id
          )
          AND EXISTS (
            SELECT 1
            FROM organization_memberships membership
            JOIN workspace_memberships workspace_membership
              ON workspace_membership.account_id = membership.account_id
             AND workspace_membership.workspace_id = snapshot.workspace_id
             AND workspace_membership.subject_id = membership.subject_id
            WHERE membership.id = snapshot.owner_organization_membership_id
              AND membership.account_id = snapshot.account_id
              AND membership.subject_id = admission_row.initiating_human_subject_id
              AND membership.status = 'active'
              AND membership.revoked_at IS NULL
              AND membership.personal_workspace_id = snapshot.origin_workspace_id
              AND membership.authorization_revision
                = snapshot.membership_authorization_revision
          )
          AND EXISTS (
            SELECT 1
            FROM organization_user_resource_authorities authority
            WHERE authority.id = snapshot.authority_id
              AND authority.account_id = snapshot.account_id
              AND authority.organization_membership_id
                = snapshot.owner_organization_membership_id
              AND authority.resource_kind = snapshot.resource_kind
              AND authority.resource_id = snapshot.resource_id
              AND authority.origin_workspace_id = snapshot.origin_workspace_id
              AND authority.generation = snapshot.authority_generation
              AND authority.status = 'active'
              AND authority.revoked_at IS NULL
          )
          AND (
            (
              snapshot.resource_kind = 'variable_set'
              AND EXISTS (
                SELECT 1 FROM workspace_variable_sets variable_set
                WHERE variable_set.id = snapshot.resource_id
                  AND variable_set.account_id = snapshot.account_id
                  AND variable_set.workspace_id = snapshot.origin_workspace_id
                  AND variable_set.authority_scope = 'user'
                  AND variable_set.authority_id = snapshot.authority_id
                  AND variable_set.owner_organization_membership_id
                    = snapshot.owner_organization_membership_id
                  AND variable_set.origin_workspace_id = snapshot.origin_workspace_id
              )
            ) OR (
              snapshot.resource_kind = 'rig'
              AND EXISTS (
                SELECT 1 FROM rigs rig
                JOIN rig_versions rig_version
                  ON rig_version.id = snapshot.resource_version_id
                 AND rig_version.rig_id = rig.id
                 AND rig_version.account_id = rig.account_id
                WHERE rig.id = snapshot.resource_id
                  AND rig.account_id = snapshot.account_id
                  AND rig.workspace_id = snapshot.origin_workspace_id
                  AND rig.authority_scope = 'user'
                  AND rig.authority_id = snapshot.authority_id
                  AND rig.owner_organization_membership_id
                    = snapshot.owner_organization_membership_id
                  AND rig.origin_workspace_id = snapshot.origin_workspace_id
              )
            )
          )
          AND EXISTS (
            SELECT 1
            FROM organization_user_resource_grants grant_value
            WHERE grant_value.id = snapshot.grant_id
              AND grant_value.account_id = snapshot.account_id
              AND grant_value.authority_id = snapshot.authority_id
              AND grant_value.owner_organization_membership_id
                = snapshot.owner_organization_membership_id
              AND grant_value.workspace_id = snapshot.target_workspace_id
              AND grant_value.action = snapshot.action
              AND grant_value.mode = snapshot.grant_mode
              AND grant_value.context = snapshot.grant_context
              AND grant_value.generation = snapshot.grant_generation
              AND grant_value.session_id IS NOT DISTINCT FROM snapshot.grant_session_id
              AND grant_value.authority_epoch
                IS NOT DISTINCT FROM snapshot.grant_authority_epoch
              AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
              AND (
                (
                  snapshot.grant_mode = 'once'
                  AND grant_value.status = 'consumed'
                  AND EXISTS (
                    SELECT 1 FROM personal_resource_once_consumption_receipts receipt
                    WHERE receipt.grant_id = snapshot.grant_id
                      AND receipt.account_id = snapshot.account_id
                      AND receipt.attempt_id = snapshot.attempt_id
                      AND receipt.authority_id = snapshot.authority_id
                      AND receipt.authority_generation = snapshot.authority_generation
                      AND receipt.grant_generation = snapshot.grant_generation
                  )
                ) OR (
                  snapshot.grant_mode IN ('session', 'always')
                  AND grant_value.status = 'active'
                )
              )
          )
        );

      IF invalid_count <> 0 THEN
        RAISE EXCEPTION 'personal-resource authority snapshot is no longer live'
          USING ERRCODE = '42501';
      END IF;

      SELECT count(*)::integer INTO invalid_count
      FROM session_attempt_personal_resource_snapshots snapshot
      WHERE snapshot.attempt_id = admission_row.attempt_id;
      IF invalid_count <> admission_row.resource_count THEN
        RAISE EXCEPTION 'personal-resource snapshot collection is incomplete'
          USING ERRCODE = '42501';
      END IF;

      RETURN QUERY
      SELECT snapshot.resource_kind, snapshot.resource_id,
        snapshot.resource_version_id, snapshot.selection_sources, snapshot.action,
        snapshot.authority_id, snapshot.authority_generation, snapshot.grant_id,
        snapshot.grant_generation, snapshot.grant_mode
      FROM session_attempt_personal_resource_snapshots snapshot
      WHERE snapshot.attempt_id = admission_row.attempt_id
      ORDER BY snapshot.resource_kind, snapshot.resource_id;

      DELETE FROM opengeni_private.personal_resource_delegation_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'resolve';
      RETURN;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.personal_resource_delegation_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'resolve';
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'DROP TRIGGER IF EXISTS session_attempt_personal_resource_admission '
      || 'ON %I.session_turn_attempts',
    data_schema
  );
  EXECUTE format(
    'CREATE TRIGGER session_attempt_personal_resource_admission '
      || 'AFTER INSERT ON %I.session_turn_attempts FOR EACH ROW '
      || 'EXECUTE FUNCTION %I.admit_session_attempt_personal_resources()',
    data_schema,
    data_schema
  );
END
$personal_resource_delegation_functions$;

REVOKE ALL ON FUNCTION resolve_session_attempt_personal_resources(uuid, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION admit_session_attempt_personal_resources() FROM PUBLIC;

DO $personal_resource_runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION resolve_session_attempt_personal_resources(uuid, uuid, uuid)
      TO opengeni_app;
    REVOKE ALL ON TABLE "session_attempt_personal_resource_admissions" FROM opengeni_app;
    REVOKE ALL ON TABLE "session_attempt_personal_resource_snapshots" FROM opengeni_app;
    REVOKE ALL ON TABLE "personal_resource_once_consumption_receipts" FROM opengeni_app;
  END IF;
END
$personal_resource_runtime_grants$;

COMMENT ON TABLE "session_attempt_personal_resource_admissions" IS
  'Exact accepted-attempt personal-resource authority receipt; no secrets or runtime materialization.';
COMMENT ON TABLE "session_attempt_personal_resource_snapshots" IS
  'Normalized immutable direct/transitive personal-resource delegation collection for one accepted attempt.';
COMMENT ON TABLE "personal_resource_once_consumption_receipts" IS
  'Unique first-use receipt binding one consumed once grant to its exact accepted attempt.';
COMMENT ON FUNCTION resolve_session_attempt_personal_resources(uuid, uuid, uuid) IS
  'Fail-closed exact-attempt authority revalidation and identifier-only personal-resource collection read.';
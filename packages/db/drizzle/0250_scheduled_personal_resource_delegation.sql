-- deployment-mode: rolling
-- Freeze personal Variable Set/Rig authority at scheduled-task write, admit the
-- exact immutable task snapshot for each occurrence, and bind that occurrence
-- to the causal scheduled turn before direct attempt admission. This migration
-- stores identifiers and authority generations only; it does not materialize
-- secrets, mutate Variable Set/Rig CRUD, or load worker credentials.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "scheduled_tasks"
  ADD COLUMN "authority_revision" bigint NOT NULL DEFAULT 1;

ALTER TABLE "scheduled_tasks"
  ADD CONSTRAINT "scheduled_tasks_authority_revision_chk"
    CHECK ("authority_revision" > 0);

ALTER TABLE "session_system_updates"
  ADD COLUMN "scheduled_task_run_id" uuid;

CREATE TABLE opengeni_private.scheduled_personal_resource_capabilities (
  "backend_pid" integer NOT NULL,
  "transaction_id" xid8 NOT NULL,
  "capability_kind" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "scheduled_personal_resource_capabilities_kind_chk" CHECK (
    "capability_kind" IN ('task_write', 'run_admit', 'attempt_match')
  ),
  CONSTRAINT "scheduled_personal_resource_capabilities_pk" PRIMARY KEY (
    "backend_pid", "transaction_id", "capability_kind"
  )
);
REVOKE ALL ON TABLE opengeni_private.scheduled_personal_resource_capabilities FROM PUBLIC;

DO $scheduled_capability_revoke$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON TABLE opengeni_private.scheduled_personal_resource_capabilities
      FROM opengeni_app;
  END IF;
END
$scheduled_capability_revoke$;

CREATE OR REPLACE FUNCTION opengeni_private.scheduled_personal_resource_capability_active(
  p_capability_kind text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $scheduled_personal_resource_capability_active$
  SELECT EXISTS (
    SELECT 1
    FROM opengeni_private.scheduled_personal_resource_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND (
        p_capability_kind IS NULL
        OR capability.capability_kind = p_capability_kind
      )
  )
$scheduled_personal_resource_capability_active$;

REVOKE ALL ON FUNCTION
  opengeni_private.scheduled_personal_resource_capability_active(text)
  FROM PUBLIC;

CREATE TABLE "scheduled_task_personal_resource_authorities" (
  "task_id" uuid NOT NULL REFERENCES "scheduled_tasks"("id") ON DELETE CASCADE,
  "task_authority_revision" bigint NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "initiating_human_subject_id" text NOT NULL,
  "owner_organization_membership_id" uuid NOT NULL,
  "membership_authorization_revision" bigint NOT NULL,
  "target_session_id" uuid,
  "session_visibility" text NOT NULL,
  "session_authority_epoch" integer,
  "resource_count" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "scheduled_task_personal_resource_authorities_pk" PRIMARY KEY (
    "task_id", "task_authority_revision"
  ),
  CONSTRAINT "scheduled_task_personal_resource_authorities_owner_fk"
    FOREIGN KEY ("owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "scheduled_task_personal_resource_authorities_revision_chk" CHECK (
    "task_authority_revision" > 0
    AND "membership_authorization_revision" > 0
    AND "resource_count" > 0
  ),
  CONSTRAINT "scheduled_task_personal_resource_authorities_visibility_chk" CHECK (
    "session_visibility" IN ('user_private', 'workspace_shared')
  ),
  CONSTRAINT "scheduled_task_personal_resource_authorities_session_chk" CHECK (
    ("target_session_id" IS NULL AND "session_authority_epoch" IS NULL)
    OR ("target_session_id" IS NOT NULL AND "session_authority_epoch" > 0)
  ),
  CONSTRAINT "scheduled_task_personal_resource_authorities_subject_chk" CHECK (
    length(btrim("initiating_human_subject_id")) BETWEEN 1 AND 1024
  )
);

CREATE TABLE "scheduled_task_personal_resource_snapshots" (
  "task_id" uuid NOT NULL,
  "task_authority_revision" bigint NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
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
  "session_authority_epoch" integer,
  "grant_id" uuid NOT NULL,
  "grant_generation" bigint NOT NULL,
  "grant_mode" text NOT NULL,
  "grant_context" text NOT NULL,
  "grant_session_id" uuid,
  "grant_authority_epoch" integer,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "scheduled_task_personal_resource_snapshots_pk" PRIMARY KEY (
    "task_id", "task_authority_revision", "resource_kind", "resource_id"
  ),
  CONSTRAINT "scheduled_task_personal_resource_snapshots_authority_header_fk"
    FOREIGN KEY ("task_id", "task_authority_revision")
    REFERENCES "scheduled_task_personal_resource_authorities"(
      "task_id", "task_authority_revision"
    ) ON DELETE CASCADE,
  CONSTRAINT "scheduled_task_personal_resource_snapshots_authority_fk"
    FOREIGN KEY ("authority_id", "account_id", "owner_organization_membership_id")
    REFERENCES "organization_user_resource_authorities"(
      "id", "account_id", "organization_membership_id"
    ) ON DELETE RESTRICT,
  CONSTRAINT "scheduled_task_personal_resource_snapshots_grant_fk"
    FOREIGN KEY ("grant_id", "account_id")
    REFERENCES "organization_user_resource_grants"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "scheduled_task_personal_resource_snapshots_kind_chk" CHECK (
    ("resource_kind" = 'variable_set' AND "resource_version_id" IS NULL)
    OR ("resource_kind" = 'rig' AND "resource_version_id" IS NOT NULL)
  ),
  CONSTRAINT "scheduled_task_personal_resource_snapshots_action_chk" CHECK (
    ("resource_kind" = 'variable_set' AND "action" = 'variable_set.use')
    OR ("resource_kind" = 'rig' AND "action" = 'rig.use')
  ),
  CONSTRAINT "scheduled_task_personal_resource_snapshots_generation_chk" CHECK (
    "task_authority_revision" > 0
    AND "membership_authorization_revision" > 0
    AND "authority_generation" > 0
    AND "grant_generation" > 0
  ),
  CONSTRAINT "scheduled_task_personal_resource_snapshots_sources_chk" CHECK (
    cardinality("selection_sources") > 0
  ),
  CONSTRAINT "scheduled_task_personal_resource_snapshots_grant_fence_chk" CHECK (
    (
      "grant_mode" = 'always'
      AND "grant_session_id" IS NULL
      AND "grant_authority_epoch" IS NULL
      AND "session_authority_epoch" IS NULL
    ) OR (
      "grant_mode" IN ('once', 'session')
      AND "grant_session_id" IS NOT NULL
      AND "grant_authority_epoch" = "session_authority_epoch"
    )
  )
);

CREATE TABLE "scheduled_task_run_personal_resource_admissions" (
  "run_id" uuid PRIMARY KEY REFERENCES "scheduled_task_runs"("id") ON DELETE CASCADE,
  "task_id" uuid NOT NULL,
  "task_authority_revision" bigint NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "initiating_human_subject_id" text NOT NULL,
  "owner_organization_membership_id" uuid NOT NULL,
  "membership_authorization_revision" bigint NOT NULL,
  "target_session_id" uuid,
  "session_visibility" text NOT NULL,
  "session_authority_epoch" integer,
  "resource_count" integer NOT NULL,
  "admitted_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "scheduled_task_run_personal_resource_admissions_task_fk"
    FOREIGN KEY ("task_id", "task_authority_revision")
    REFERENCES "scheduled_task_personal_resource_authorities"(
      "task_id", "task_authority_revision"
    ) ON DELETE RESTRICT,
  CONSTRAINT "scheduled_task_run_personal_resource_admissions_owner_fk"
    FOREIGN KEY ("owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "scheduled_task_run_personal_resource_admissions_revision_chk" CHECK (
    "task_authority_revision" > 0
    AND "membership_authorization_revision" > 0
    AND "resource_count" > 0
  )
);

CREATE TABLE "scheduled_task_run_personal_resource_snapshots" (
  "run_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "task_authority_revision" bigint NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
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
  "session_authority_epoch" integer,
  "grant_id" uuid NOT NULL,
  "grant_generation" bigint NOT NULL,
  "grant_mode" text NOT NULL,
  "grant_context" text NOT NULL,
  "grant_session_id" uuid,
  "grant_authority_epoch" integer,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "scheduled_task_run_personal_resource_snapshots_pk" PRIMARY KEY (
    "run_id", "resource_kind", "resource_id"
  ),
  CONSTRAINT "scheduled_task_run_personal_resource_snapshots_admission_fk"
    FOREIGN KEY ("run_id")
    REFERENCES "scheduled_task_run_personal_resource_admissions"("run_id") ON DELETE CASCADE,
  CONSTRAINT "scheduled_task_run_personal_resource_snapshots_task_fk"
    FOREIGN KEY (
      "task_id", "task_authority_revision", "resource_kind", "resource_id"
    ) REFERENCES "scheduled_task_personal_resource_snapshots"(
      "task_id", "task_authority_revision", "resource_kind", "resource_id"
    ) ON DELETE RESTRICT
);

CREATE TABLE "scheduled_task_run_personal_resource_once_receipts" (
  "grant_id" uuid PRIMARY KEY,
  "run_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "authority_id" uuid NOT NULL,
  "authority_generation" bigint NOT NULL,
  "grant_generation" bigint NOT NULL,
  "consumed_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "scheduled_task_run_personal_resource_once_receipts_run_fk"
    FOREIGN KEY ("run_id")
    REFERENCES "scheduled_task_run_personal_resource_admissions"("run_id") ON DELETE CASCADE,
  CONSTRAINT "scheduled_task_run_personal_resource_once_receipts_grant_fk"
    FOREIGN KEY ("grant_id", "account_id")
    REFERENCES "organization_user_resource_grants"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "scheduled_run_once_receipts_generation_chk" CHECK (
    "authority_generation" > 0 AND "grant_generation" > 0
  )
);

-- Existing tasks were accepted by writers that could not create this migration's
-- authority ledger. Pause every such personal-resource task deterministically;
-- a current writer's explicit resume creates a new, fully frozen revision.
UPDATE "scheduled_tasks" task
SET "status" = 'paused', "updated_at" = clock_timestamp()
WHERE task."status" = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM "scheduled_task_personal_resource_authorities" authority
    WHERE authority."task_id" = task."id"
      AND authority."task_authority_revision" = task."authority_revision"
  )
  AND (
    EXISTS (
      SELECT 1
      FROM "workspace_variable_sets" variable_set
      WHERE variable_set."id" = task."variable_set_id"
        AND variable_set."account_id" = task."account_id"
        AND variable_set."authority_scope" = 'user'
    )
    OR EXISTS (
      SELECT 1
      FROM "rigs" rig
      WHERE rig."id" = task."rig_id"
        AND rig."account_id" = task."account_id"
        AND rig."authority_scope" = 'user'
    )
    OR EXISTS (
      SELECT 1
      FROM "rigs" rig
      JOIN "rig_versions" rig_version
        ON rig_version."rig_id" = rig."id"
       AND rig_version."account_id" = rig."account_id"
       AND rig_version."active"
      CROSS JOIN LATERAL jsonb_array_elements_text(
        rig_version."default_variable_set_ids"
      ) default_id(value)
      JOIN "workspace_variable_sets" default_variable_set
        ON default_variable_set."id" = default_id.value::uuid
       AND default_variable_set."account_id" = task."account_id"
       AND default_variable_set."authority_scope" = 'user'
      WHERE rig."id" = task."rig_id"
        AND rig."account_id" = task."account_id"
    )
  );

CREATE INDEX "scheduled_task_personal_resource_snapshots_authority_idx"
  ON "scheduled_task_personal_resource_snapshots"(
    "account_id", "authority_id", "authority_generation"
  );
CREATE INDEX "scheduled_task_personal_resource_snapshots_grant_idx"
  ON "scheduled_task_personal_resource_snapshots"(
    "account_id", "grant_id", "grant_generation"
  );
CREATE INDEX "scheduled_task_run_personal_resource_snapshots_authority_idx"
  ON "scheduled_task_run_personal_resource_snapshots"(
    "account_id", "authority_id", "authority_generation"
  );

ALTER TABLE "scheduled_task_personal_resource_authorities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_personal_resource_authorities" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_personal_resource_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_personal_resource_snapshots" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_run_personal_resource_admissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_run_personal_resource_admissions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_run_personal_resource_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_run_personal_resource_snapshots" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_run_personal_resource_once_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_task_run_personal_resource_once_receipts" FORCE ROW LEVEL SECURITY;

DO $scheduled_personal_resource_policies$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'scheduled_task_personal_resource_authorities',
    'scheduled_task_personal_resource_snapshots',
    'scheduled_task_run_personal_resource_admissions',
    'scheduled_task_run_personal_resource_snapshots',
    'scheduled_task_run_personal_resource_once_receipts'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY scheduled_personal_resource_capability_read ON %I.%I '
        || 'FOR SELECT USING (current_user = %L AND '
        || 'opengeni_private.scheduled_personal_resource_capability_active())',
      data_schema, table_name, migration_owner
    );
    EXECUTE format(
      'CREATE POLICY scheduled_personal_resource_capability_insert ON %I.%I '
        || 'FOR INSERT WITH CHECK (current_user = %L AND '
        || 'opengeni_private.scheduled_personal_resource_capability_active())',
      data_schema, table_name, migration_owner
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'organization_memberships',
    'organization_user_resource_authorities',
    'organization_user_resource_grants',
    'workspace_variable_sets',
    'rigs',
    'rig_versions'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY scheduled_personal_resource_read ON %I.%I '
        || 'FOR SELECT USING (current_user = %L AND '
        || 'opengeni_private.scheduled_personal_resource_capability_active())',
      data_schema, table_name, migration_owner
    );
  END LOOP;

  EXECUTE format(
    'CREATE POLICY scheduled_personal_resource_grant_update '
      || 'ON %I.organization_user_resource_grants FOR UPDATE USING ('
      || 'current_user = %L AND '
      || 'opengeni_private.scheduled_personal_resource_capability_active()) '
      || 'WITH CHECK (current_user = %L AND '
      || 'opengeni_private.scheduled_personal_resource_capability_active())',
    data_schema, migration_owner, migration_owner
  );
  EXECUTE format(
    'CREATE POLICY scheduled_personal_resource_attempt_receipt_read '
      || 'ON %I.personal_resource_once_consumption_receipts FOR SELECT USING ('
      || 'current_user = %L AND '
      || 'opengeni_private.scheduled_personal_resource_capability_active(''attempt_match''))',
    data_schema, migration_owner
  );
  EXECUTE format(
    'CREATE POLICY scheduled_personal_resource_attempt_receipt_delete '
      || 'ON %I.personal_resource_once_consumption_receipts FOR DELETE USING ('
      || 'current_user = %L AND '
      || 'opengeni_private.scheduled_personal_resource_capability_active(''attempt_match''))',
    data_schema, migration_owner
  );
END
$scheduled_personal_resource_policies$;

CREATE OR REPLACE FUNCTION freeze_scheduled_task_personal_resources(
  p_account_id uuid,
  p_workspace_id uuid,
  p_task_id uuid,
  p_task_authority_revision bigint
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $freeze_scheduled_task_personal_resources$
DECLARE
  task_row scheduled_tasks%ROWTYPE;
  member_row organization_memberships%ROWTYPE;
  session_row sessions%ROWTYPE;
  resource_row record;
  grant_row organization_user_resource_grants%ROWTYPE;
  initiating_subject text := coalesce(
    nullif(btrim(current_setting('opengeni.initiating_human_subject_id', true)), ''),
    nullif(btrim(current_setting('opengeni.subject_id', true)), '')
  );
  target_session uuid;
  target_visibility text := 'workspace_shared';
  target_epoch integer;
  resource_total integer := 0;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'scheduled personal-resource task scope mismatch' USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'task_write')
  ON CONFLICT DO NOTHING;

  SELECT task.* INTO STRICT task_row
  FROM scheduled_tasks task
  WHERE task.id = p_task_id
    AND task.account_id = p_account_id
    AND task.workspace_id = p_workspace_id
    AND task.authority_revision = p_task_authority_revision
  FOR UPDATE;

  SELECT count(*)::integer INTO resource_total
  FROM (
    SELECT variable_set.id
    FROM workspace_variable_sets variable_set
    WHERE variable_set.id = task_row.variable_set_id
      AND variable_set.account_id = p_account_id
      AND variable_set.authority_scope = 'user'
    UNION
    SELECT rig.id
    FROM rigs rig
    WHERE rig.id = task_row.rig_id
      AND rig.account_id = p_account_id
      AND rig.authority_scope = 'user'
    UNION
    SELECT default_variable_set.id
    FROM rigs rig
    JOIN rig_versions rig_version
      ON rig_version.rig_id = rig.id
     AND rig_version.account_id = rig.account_id
     AND rig_version.active
    CROSS JOIN LATERAL jsonb_array_elements_text(
      rig_version.default_variable_set_ids
    ) default_id(value)
    JOIN workspace_variable_sets default_variable_set
      ON default_variable_set.id = default_id.value::uuid
     AND default_variable_set.account_id = p_account_id
     AND default_variable_set.authority_scope = 'user'
    WHERE rig.id = task_row.rig_id
      AND rig.account_id = p_account_id
  ) selected;

  IF resource_total = 0 THEN
    DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
    WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned()
      AND capability_kind = 'task_write';
    RETURN 0;
  END IF;

  IF initiating_subject IS NULL THEN
    RAISE EXCEPTION 'scheduled personal resources require a causal human'
      USING ERRCODE = '42501';
  END IF;

  SELECT membership.* INTO STRICT member_row
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = initiating_subject
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
    AND membership.personal_workspace_id IS NOT NULL
  FOR SHARE;

  IF member_row.personal_workspace_id IS DISTINCT FROM p_workspace_id THEN
    PERFORM 1 FROM workspace_memberships workspace_membership
    WHERE workspace_membership.account_id = p_account_id
      AND workspace_membership.workspace_id = p_workspace_id
      AND workspace_membership.subject_id = initiating_subject
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'scheduled personal-resource owner lacks workspace access'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF task_row.run_mode = 'existing_session'
    OR (task_row.run_mode = 'reusable_session' AND task_row.reusable_session_id IS NOT NULL)
  THEN
    target_session := task_row.reusable_session_id;
    SELECT session_value.* INTO STRICT session_row
    FROM sessions session_value
    WHERE session_value.id = target_session
      AND session_value.account_id = p_account_id
      AND session_value.workspace_id = p_workspace_id
      AND session_value.status <> 'cancelled'
    FOR SHARE;
    target_visibility := session_row.visibility;
    target_epoch := session_row.authority_epoch;
  END IF;

  INSERT INTO scheduled_task_personal_resource_authorities (
    task_id, task_authority_revision, account_id, workspace_id,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, target_session_id, session_visibility,
    session_authority_epoch, resource_count
  ) VALUES (
    p_task_id, p_task_authority_revision, p_account_id, p_workspace_id,
    initiating_subject, member_row.id, member_row.authorization_revision,
    target_session, target_visibility, target_epoch, resource_total
  );

  FOR resource_row IN
    WITH selected AS (
      SELECT 'variable_set'::text AS resource_kind, variable_set.id AS resource_id,
        NULL::uuid AS resource_version_id, 'variable_set.use'::text AS action,
        'session_variable_set'::text AS selection_source,
        variable_set.workspace_id AS resource_workspace_id, variable_set.authority_id,
        variable_set.owner_organization_membership_id, variable_set.origin_workspace_id
      FROM workspace_variable_sets variable_set
      WHERE variable_set.id = task_row.variable_set_id
        AND variable_set.account_id = p_account_id
        AND variable_set.authority_scope = 'user'
      UNION ALL
      SELECT 'rig'::text, rig.id, rig_version.id, 'rig.use'::text,
        'session_rig'::text, rig.workspace_id, rig.authority_id,
        rig.owner_organization_membership_id, rig.origin_workspace_id
      FROM rigs rig
      JOIN rig_versions rig_version
        ON rig_version.rig_id = rig.id
       AND rig_version.account_id = rig.account_id
       AND rig_version.active
      WHERE rig.id = task_row.rig_id
        AND rig.account_id = p_account_id
        AND rig.authority_scope = 'user'
      UNION ALL
      SELECT 'variable_set'::text, default_variable_set.id, NULL::uuid,
        'variable_set.use'::text,
        ('rig_default_variable_set:' || default_id.ordinality::text)::text,
        default_variable_set.workspace_id, default_variable_set.authority_id,
        default_variable_set.owner_organization_membership_id,
        default_variable_set.origin_workspace_id
      FROM rigs rig
      JOIN rig_versions rig_version
        ON rig_version.rig_id = rig.id
       AND rig_version.account_id = rig.account_id
       AND rig_version.active
      CROSS JOIN LATERAL jsonb_array_elements_text(
        rig_version.default_variable_set_ids
      ) WITH ORDINALITY default_id(value, ordinality)
      JOIN workspace_variable_sets default_variable_set
        ON default_variable_set.id = default_id.value::uuid
       AND default_variable_set.account_id = p_account_id
       AND default_variable_set.authority_scope = 'user'
      WHERE rig.id = task_row.rig_id
        AND rig.account_id = p_account_id
    )
    SELECT resource_kind, resource_id, min(resource_version_id::text)::uuid resource_version_id,
      action, array_agg(selection_source ORDER BY selection_source) selection_sources,
      min(resource_workspace_id::text)::uuid resource_workspace_id,
      min(authority_id::text)::uuid authority_id,
      min(owner_organization_membership_id::text)::uuid owner_organization_membership_id,
      min(origin_workspace_id::text)::uuid origin_workspace_id
    FROM selected
    GROUP BY resource_kind, resource_id, action
    ORDER BY resource_kind, resource_id
  LOOP
    IF resource_row.owner_organization_membership_id IS DISTINCT FROM member_row.id
      OR resource_row.resource_workspace_id IS DISTINCT FROM member_row.personal_workspace_id
      OR resource_row.origin_workspace_id IS DISTINCT FROM member_row.personal_workspace_id
    THEN
      RAISE EXCEPTION 'scheduled personal resource belongs to another human or organization'
        USING ERRCODE = '42501';
    END IF;

    SELECT grant_value.* INTO grant_row
    FROM organization_user_resource_grants grant_value
    JOIN organization_user_resource_authorities authority
      ON authority.id = grant_value.authority_id
     AND authority.account_id = grant_value.account_id
    WHERE authority.id = resource_row.authority_id
      AND authority.account_id = p_account_id
      AND authority.organization_membership_id = member_row.id
      AND authority.resource_kind = resource_row.resource_kind
      AND authority.resource_id = resource_row.resource_id
      AND authority.origin_workspace_id = member_row.personal_workspace_id
      AND authority.status = 'active'
      AND authority.revoked_at IS NULL
      AND grant_value.owner_organization_membership_id = member_row.id
      AND grant_value.workspace_id = p_workspace_id
      AND grant_value.action = resource_row.action
      AND grant_value.context = target_visibility
      AND grant_value.status = 'active'
      AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
      AND (
        (target_session IS NULL AND grant_value.mode = 'always'
          AND grant_value.session_id IS NULL AND grant_value.authority_epoch IS NULL)
        OR (target_session IS NOT NULL AND (
          (grant_value.mode IN ('once', 'session')
            AND grant_value.session_id = target_session
            AND grant_value.authority_epoch = target_epoch)
          OR (grant_value.mode = 'always'
            AND grant_value.session_id IS NULL AND grant_value.authority_epoch IS NULL)
        ))
      )
    ORDER BY CASE grant_value.mode WHEN 'once' THEN 1 WHEN 'session' THEN 2 ELSE 3 END,
      grant_value.generation DESC, grant_value.id
    LIMIT 1
    FOR SHARE OF authority, grant_value;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'matching scheduled personal-resource grant required'
        USING ERRCODE = '42501';
    END IF;

    INSERT INTO scheduled_task_personal_resource_snapshots (
      task_id, task_authority_revision, account_id, workspace_id,
      resource_kind, resource_id, resource_version_id, selection_sources, action,
      origin_workspace_id, owner_organization_membership_id,
      membership_authorization_revision, authority_id, authority_generation,
      target_workspace_id, session_visibility, session_authority_epoch,
      grant_id, grant_generation, grant_mode, grant_context,
      grant_session_id, grant_authority_epoch
    )
    SELECT p_task_id, p_task_authority_revision, p_account_id, p_workspace_id,
      resource_row.resource_kind, resource_row.resource_id,
      resource_row.resource_version_id, resource_row.selection_sources, resource_row.action,
      member_row.personal_workspace_id, member_row.id, member_row.authorization_revision,
      authority.id, authority.generation, p_workspace_id, target_visibility, target_epoch,
      grant_row.id, grant_row.generation, grant_row.mode, grant_row.context,
      grant_row.session_id, grant_row.authority_epoch
    FROM organization_user_resource_authorities authority
    WHERE authority.id = resource_row.authority_id
      AND authority.account_id = p_account_id;
  END LOOP;

  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'task_write';
  RETURN resource_total;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'task_write';
  RAISE;
END
$freeze_scheduled_task_personal_resources$;

CREATE OR REPLACE FUNCTION clone_scheduled_task_personal_resource_authority(
  p_account_id uuid,
  p_workspace_id uuid,
  p_task_id uuid,
  p_source_task_authority_revision bigint,
  p_target_task_authority_revision bigint
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $clone_scheduled_task_personal_resource_authority$
DECLARE
  source_authority scheduled_task_personal_resource_authorities%ROWTYPE;
  copied_count integer;
BEGIN
  IF p_source_task_authority_revision <= 0
    OR p_target_task_authority_revision <= p_source_task_authority_revision
  THEN
    RAISE EXCEPTION 'scheduled personal-resource authority clone revision is invalid'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'task_write')
  ON CONFLICT DO NOTHING;

  PERFORM 1
  FROM scheduled_tasks task
  WHERE task.id = p_task_id
    AND task.account_id = p_account_id
    AND task.workspace_id = p_workspace_id
    AND task.authority_revision = p_target_task_authority_revision
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled personal-resource clone target is not current'
      USING ERRCODE = '40001';
  END IF;

  SELECT authority.* INTO source_authority
  FROM scheduled_task_personal_resource_authorities authority
  WHERE authority.task_id = p_task_id
    AND authority.task_authority_revision = p_source_task_authority_revision
    AND authority.account_id = p_account_id
    AND authority.workspace_id = p_workspace_id;
  IF NOT FOUND THEN
    DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
    WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned()
      AND capability_kind = 'task_write';
    RETURN 0;
  END IF;

  INSERT INTO scheduled_task_personal_resource_authorities (
    task_id, task_authority_revision, account_id, workspace_id,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, target_session_id, session_visibility,
    session_authority_epoch, resource_count
  ) VALUES (
    source_authority.task_id, p_target_task_authority_revision,
    source_authority.account_id, source_authority.workspace_id,
    source_authority.initiating_human_subject_id,
    source_authority.owner_organization_membership_id,
    source_authority.membership_authorization_revision,
    source_authority.target_session_id, source_authority.session_visibility,
    source_authority.session_authority_epoch, source_authority.resource_count
  );

  INSERT INTO scheduled_task_personal_resource_snapshots (
    task_id, task_authority_revision, account_id, workspace_id,
    resource_kind, resource_id, resource_version_id, selection_sources, action,
    origin_workspace_id, owner_organization_membership_id,
    membership_authorization_revision, authority_id, authority_generation,
    target_workspace_id, session_visibility, session_authority_epoch,
    grant_id, grant_generation, grant_mode, grant_context,
    grant_session_id, grant_authority_epoch
  )
  SELECT snapshot.task_id, p_target_task_authority_revision,
    snapshot.account_id, snapshot.workspace_id, snapshot.resource_kind,
    snapshot.resource_id, snapshot.resource_version_id, snapshot.selection_sources,
    snapshot.action, snapshot.origin_workspace_id,
    snapshot.owner_organization_membership_id,
    snapshot.membership_authorization_revision, snapshot.authority_id,
    snapshot.authority_generation, snapshot.target_workspace_id,
    snapshot.session_visibility, snapshot.session_authority_epoch,
    snapshot.grant_id, snapshot.grant_generation, snapshot.grant_mode,
    snapshot.grant_context, snapshot.grant_session_id, snapshot.grant_authority_epoch
  FROM scheduled_task_personal_resource_snapshots snapshot
  WHERE snapshot.task_id = p_task_id
    AND snapshot.task_authority_revision = p_source_task_authority_revision;
  GET DIAGNOSTICS copied_count = ROW_COUNT;
  IF copied_count <> source_authority.resource_count THEN
    RAISE EXCEPTION 'scheduled personal-resource authority clone is incomplete'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'task_write';
  RETURN copied_count;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'task_write';
  RAISE;
END
$clone_scheduled_task_personal_resource_authority$;

CREATE OR REPLACE FUNCTION admit_scheduled_task_run_personal_resources()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $admit_scheduled_task_run_personal_resources$
DECLARE
  task_row scheduled_tasks%ROWTYPE;
  authority_row scheduled_task_personal_resource_authorities%ROWTYPE;
  once_snapshot record;
  selected_personal_count integer;
  invalid_count integer;
  affected integer;
BEGIN
  SELECT task.* INTO STRICT task_row
  FROM scheduled_tasks task
  WHERE task.id = NEW.task_id
    AND task.account_id = NEW.account_id
    AND task.workspace_id = NEW.workspace_id
  FOR SHARE;

  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'run_admit')
  ON CONFLICT DO NOTHING;

  SELECT authority.* INTO authority_row
  FROM scheduled_task_personal_resource_authorities authority
  WHERE authority.task_id = NEW.task_id
    AND authority.task_authority_revision = task_row.authority_revision;
  IF NOT FOUND THEN
    SELECT count(*)::integer INTO selected_personal_count
    FROM (
      SELECT variable_set.id
      FROM workspace_variable_sets variable_set
      WHERE variable_set.id = task_row.variable_set_id
        AND variable_set.account_id = task_row.account_id
        AND variable_set.authority_scope = 'user'
      UNION
      SELECT rig.id
      FROM rigs rig
      WHERE rig.id = task_row.rig_id
        AND rig.account_id = task_row.account_id
        AND rig.authority_scope = 'user'
      UNION
      SELECT default_variable_set.id
      FROM rigs rig
      JOIN rig_versions rig_version
        ON rig_version.rig_id = rig.id
       AND rig_version.account_id = rig.account_id
       AND rig_version.active
      CROSS JOIN LATERAL jsonb_array_elements_text(
        rig_version.default_variable_set_ids
      ) default_id(value)
      JOIN workspace_variable_sets default_variable_set
        ON default_variable_set.id = default_id.value::uuid
       AND default_variable_set.account_id = task_row.account_id
       AND default_variable_set.authority_scope = 'user'
      WHERE rig.id = task_row.rig_id
        AND rig.account_id = task_row.account_id
    ) selected;
    IF selected_personal_count <> 0 THEN
      RAISE EXCEPTION 'scheduled personal-resource task has no authority snapshot'
        USING ERRCODE = '42501';
    END IF;
    DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
    WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned()
      AND capability_kind = 'run_admit';
    RETURN NEW;
  END IF;

  SELECT count(*)::integer INTO invalid_count
  FROM scheduled_task_personal_resource_snapshots snapshot
  WHERE snapshot.task_id = authority_row.task_id
    AND snapshot.task_authority_revision = authority_row.task_authority_revision
    AND NOT (
      EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = snapshot.owner_organization_membership_id
          AND membership.account_id = snapshot.account_id
          AND membership.subject_id = authority_row.initiating_human_subject_id
          AND membership.status = 'active'
          AND membership.revoked_at IS NULL
          AND membership.personal_workspace_id = snapshot.origin_workspace_id
          AND membership.authorization_revision = snapshot.membership_authorization_revision
          AND (membership.personal_workspace_id = snapshot.workspace_id OR EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = membership.account_id
              AND workspace_membership.workspace_id = snapshot.workspace_id
              AND workspace_membership.subject_id = membership.subject_id
          ))
      )
      AND EXISTS (
        SELECT 1 FROM organization_user_resource_authorities authority
        WHERE authority.id = snapshot.authority_id
          AND authority.account_id = snapshot.account_id
          AND authority.organization_membership_id = snapshot.owner_organization_membership_id
          AND authority.resource_kind = snapshot.resource_kind
          AND authority.resource_id = snapshot.resource_id
          AND authority.origin_workspace_id = snapshot.origin_workspace_id
          AND authority.generation = snapshot.authority_generation
          AND authority.status = 'active'
          AND authority.revoked_at IS NULL
      )
      AND (
        (snapshot.resource_kind = 'variable_set' AND EXISTS (
          SELECT 1 FROM workspace_variable_sets variable_set
          WHERE variable_set.id = snapshot.resource_id
            AND variable_set.account_id = snapshot.account_id
            AND variable_set.workspace_id = snapshot.origin_workspace_id
            AND variable_set.authority_scope = 'user'
            AND variable_set.authority_id = snapshot.authority_id
            AND variable_set.owner_organization_membership_id =
              snapshot.owner_organization_membership_id
            AND variable_set.origin_workspace_id = snapshot.origin_workspace_id
        )) OR (snapshot.resource_kind = 'rig' AND EXISTS (
          SELECT 1 FROM rigs rig
          JOIN rig_versions rig_version
            ON rig_version.id = snapshot.resource_version_id
           AND rig_version.rig_id = rig.id
           AND rig_version.account_id = rig.account_id
           AND rig_version.workspace_id = snapshot.origin_workspace_id
          WHERE rig.id = snapshot.resource_id
            AND rig.account_id = snapshot.account_id
            AND rig.workspace_id = snapshot.origin_workspace_id
            AND rig.authority_scope = 'user'
            AND rig.authority_id = snapshot.authority_id
            AND rig.owner_organization_membership_id =
              snapshot.owner_organization_membership_id
            AND rig.origin_workspace_id = snapshot.origin_workspace_id
        ))
      )
      AND EXISTS (
        SELECT 1 FROM organization_user_resource_grants grant_value
        WHERE grant_value.id = snapshot.grant_id
          AND grant_value.account_id = snapshot.account_id
          AND grant_value.authority_id = snapshot.authority_id
          AND grant_value.owner_organization_membership_id =
            snapshot.owner_organization_membership_id
          AND grant_value.workspace_id = snapshot.target_workspace_id
          AND grant_value.action = snapshot.action
          AND grant_value.mode = snapshot.grant_mode
          AND grant_value.context = snapshot.grant_context
          AND grant_value.generation = snapshot.grant_generation
          AND grant_value.session_id IS NOT DISTINCT FROM snapshot.grant_session_id
          AND grant_value.authority_epoch IS NOT DISTINCT FROM snapshot.grant_authority_epoch
          AND grant_value.status = 'active'
          AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
      )
      AND (
        authority_row.target_session_id IS NULL
        OR EXISTS (
          SELECT 1 FROM sessions session_value
          WHERE session_value.id = authority_row.target_session_id
            AND session_value.account_id = authority_row.account_id
            AND session_value.workspace_id = authority_row.workspace_id
            AND session_value.status <> 'cancelled'
            AND session_value.visibility = authority_row.session_visibility
            AND session_value.authority_epoch = authority_row.session_authority_epoch
        )
      )
    );
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'scheduled personal-resource authority snapshot is no longer live'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO scheduled_task_run_personal_resource_admissions (
    run_id, task_id, task_authority_revision, account_id, workspace_id,
    initiating_human_subject_id, owner_organization_membership_id,
    membership_authorization_revision, target_session_id, session_visibility,
    session_authority_epoch, resource_count
  ) VALUES (
    NEW.id, authority_row.task_id, authority_row.task_authority_revision,
    authority_row.account_id, authority_row.workspace_id,
    authority_row.initiating_human_subject_id,
    authority_row.owner_organization_membership_id,
    authority_row.membership_authorization_revision, authority_row.target_session_id,
    authority_row.session_visibility, authority_row.session_authority_epoch,
    authority_row.resource_count
  );

  INSERT INTO scheduled_task_run_personal_resource_snapshots (
    run_id, task_id, task_authority_revision, account_id, workspace_id,
    resource_kind, resource_id, resource_version_id, selection_sources, action,
    origin_workspace_id, owner_organization_membership_id,
    membership_authorization_revision, authority_id, authority_generation,
    target_workspace_id, session_visibility, session_authority_epoch,
    grant_id, grant_generation, grant_mode, grant_context,
    grant_session_id, grant_authority_epoch
  )
  SELECT NEW.id, snapshot.task_id, snapshot.task_authority_revision,
    snapshot.account_id, snapshot.workspace_id, snapshot.resource_kind,
    snapshot.resource_id, snapshot.resource_version_id, snapshot.selection_sources,
    snapshot.action, snapshot.origin_workspace_id,
    snapshot.owner_organization_membership_id,
    snapshot.membership_authorization_revision, snapshot.authority_id,
    snapshot.authority_generation, snapshot.target_workspace_id,
    snapshot.session_visibility, snapshot.session_authority_epoch,
    snapshot.grant_id, snapshot.grant_generation, snapshot.grant_mode,
    snapshot.grant_context, snapshot.grant_session_id, snapshot.grant_authority_epoch
  FROM scheduled_task_personal_resource_snapshots snapshot
  WHERE snapshot.task_id = authority_row.task_id
    AND snapshot.task_authority_revision = authority_row.task_authority_revision;

  FOR once_snapshot IN
    SELECT snapshot.*
    FROM scheduled_task_run_personal_resource_snapshots snapshot
    WHERE snapshot.run_id = NEW.id
      AND snapshot.grant_mode = 'once'
    ORDER BY snapshot.grant_id
  LOOP
    UPDATE organization_user_resource_grants grant_value
    SET status = 'consumed', updated_at = clock_timestamp()
    WHERE grant_value.id = once_snapshot.grant_id
      AND grant_value.account_id = once_snapshot.account_id
      AND grant_value.authority_id = once_snapshot.authority_id
      AND grant_value.generation = once_snapshot.grant_generation
      AND grant_value.status = 'active';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'scheduled occurrence once grant lost its first-use race'
        USING ERRCODE = '40001';
    END IF;
    INSERT INTO scheduled_task_run_personal_resource_once_receipts (
      grant_id, run_id, account_id, workspace_id, authority_id,
      authority_generation, grant_generation
    ) VALUES (
      once_snapshot.grant_id, NEW.id, once_snapshot.account_id,
      once_snapshot.workspace_id, once_snapshot.authority_id,
      once_snapshot.authority_generation, once_snapshot.grant_generation
    );
  END LOOP;

  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'run_admit';
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'run_admit';
  RAISE;
END
$admit_scheduled_task_run_personal_resources$;

CREATE OR REPLACE FUNCTION prepare_scheduled_task_attempt_once_grants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $prepare_scheduled_task_attempt_once_grants$
DECLARE
  scheduled_run_id uuid;
  run_count integer;
  receipt_row scheduled_task_run_personal_resource_once_receipts%ROWTYPE;
  prior_attempt_run_id uuid;
  affected integer;
BEGIN
  SELECT count(DISTINCT update_row.scheduled_task_run_id)::integer,
    min(update_row.scheduled_task_run_id::text)::uuid
  INTO run_count, scheduled_run_id
  FROM session_system_updates update_row
  WHERE update_row.workspace_id = NEW.workspace_id
    AND update_row.session_id = NEW.session_id
    AND update_row.delivered_turn_id = NEW.turn_id
    AND update_row.kind = 'scheduled_occurrence'
    AND update_row.scheduled_task_run_id IS NOT NULL;
  IF run_count = 0 THEN RETURN NEW; END IF;
  IF run_count <> 1 THEN
    RAISE EXCEPTION 'scheduled once-grant attempt requires one occurrence snapshot'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'attempt_match')
  ON CONFLICT DO NOTHING;

  FOR receipt_row IN
    SELECT receipt.*
    FROM scheduled_task_run_personal_resource_once_receipts receipt
    WHERE receipt.run_id = scheduled_run_id
    ORDER BY receipt.grant_id
    FOR UPDATE
  LOOP
    SELECT update_row.scheduled_task_run_id INTO prior_attempt_run_id
    FROM personal_resource_once_consumption_receipts attempt_receipt
    JOIN session_system_updates update_row
      ON update_row.workspace_id = attempt_receipt.workspace_id
     AND update_row.session_id = attempt_receipt.session_id
     AND update_row.delivered_turn_id = attempt_receipt.turn_id
     AND update_row.kind = 'scheduled_occurrence'
     AND update_row.scheduled_task_run_id IS NOT NULL
    WHERE attempt_receipt.grant_id = receipt_row.grant_id
      AND attempt_receipt.account_id = receipt_row.account_id
    LIMIT 1;
    IF FOUND AND prior_attempt_run_id IS DISTINCT FROM scheduled_run_id THEN
      RAISE EXCEPTION 'once grant is owned by another scheduled occurrence'
        USING ERRCODE = '42501';
    END IF;
    IF FOUND THEN
      DELETE FROM personal_resource_once_consumption_receipts
      WHERE grant_id = receipt_row.grant_id
        AND account_id = receipt_row.account_id;
    END IF;

    UPDATE organization_user_resource_grants grant_value
    SET status = 'active', updated_at = clock_timestamp()
    WHERE grant_value.id = receipt_row.grant_id
      AND grant_value.account_id = receipt_row.account_id
      AND grant_value.authority_id = receipt_row.authority_id
      AND grant_value.generation = receipt_row.grant_generation
      AND grant_value.status = 'consumed';
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
      RAISE EXCEPTION 'scheduled occurrence once grant is no longer owned'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'attempt_match';
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'attempt_match';
  RAISE;
END
$prepare_scheduled_task_attempt_once_grants$;

CREATE OR REPLACE FUNCTION validate_scheduled_task_attempt_personal_resources()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $validate_scheduled_task_attempt_personal_resources$
DECLARE
  scheduled_run_id uuid;
  run_count integer;
  admission_row scheduled_task_run_personal_resource_admissions%ROWTYPE;
  turn_subject text;
  mismatch_count integer;
BEGIN
  SELECT count(DISTINCT update_row.scheduled_task_run_id)::integer,
    min(update_row.scheduled_task_run_id::text)::uuid
  INTO run_count, scheduled_run_id
  FROM session_system_updates update_row
  WHERE update_row.workspace_id = NEW.workspace_id
    AND update_row.session_id = NEW.session_id
    AND update_row.delivered_turn_id = NEW.turn_id
    AND update_row.kind = 'scheduled_occurrence'
    AND update_row.scheduled_task_run_id IS NOT NULL;
  IF run_count = 0 THEN RETURN NEW; END IF;
  IF run_count <> 1 THEN
    RAISE EXCEPTION 'scheduled personal-resource attempt requires one occurrence snapshot'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'attempt_match')
  ON CONFLICT DO NOTHING;

  SELECT admission.* INTO admission_row
  FROM scheduled_task_run_personal_resource_admissions admission
  WHERE admission.run_id = scheduled_run_id;
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM session_attempt_personal_resource_snapshots snapshot
      WHERE snapshot.attempt_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'scheduled occurrence has no admitted personal-resource snapshot'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  SELECT coalesce(
    nullif(btrim(turn_value.initiating_human_subject_id), ''),
    CASE WHEN turn_value.initiator_kind = 'subject'
      THEN nullif(btrim(turn_value.initiator_subject_id), '') END
  ) INTO turn_subject
  FROM session_turns turn_value
  WHERE turn_value.id = NEW.turn_id
    AND turn_value.account_id = NEW.account_id
    AND turn_value.workspace_id = NEW.workspace_id
    AND turn_value.session_id = NEW.session_id;
  IF turn_subject IS DISTINCT FROM admission_row.initiating_human_subject_id THEN
    RAISE EXCEPTION 'scheduled occurrence causal human mismatch' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM scheduled_tasks task
  WHERE task.id = admission_row.task_id
    AND task.account_id = admission_row.account_id
    AND task.workspace_id = admission_row.workspace_id
    AND task.status = 'active'
    AND task.authority_revision = admission_row.task_authority_revision
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled task authority revision changed before attempt admission'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer INTO mismatch_count
  FROM scheduled_task_run_personal_resource_snapshots run_snapshot
  FULL JOIN session_attempt_personal_resource_snapshots attempt_snapshot
    ON attempt_snapshot.attempt_id = NEW.id
   AND attempt_snapshot.resource_kind = run_snapshot.resource_kind
   AND attempt_snapshot.resource_id = run_snapshot.resource_id
  WHERE run_snapshot.run_id = scheduled_run_id
    AND (
      attempt_snapshot.attempt_id IS NULL
      OR attempt_snapshot.resource_version_id IS DISTINCT FROM run_snapshot.resource_version_id
      OR attempt_snapshot.selection_sources IS DISTINCT FROM run_snapshot.selection_sources
      OR attempt_snapshot.authority_id IS DISTINCT FROM run_snapshot.authority_id
      OR attempt_snapshot.authority_generation IS DISTINCT FROM run_snapshot.authority_generation
      OR attempt_snapshot.grant_id IS DISTINCT FROM run_snapshot.grant_id
      OR attempt_snapshot.grant_generation IS DISTINCT FROM run_snapshot.grant_generation
      OR attempt_snapshot.grant_mode IS DISTINCT FROM run_snapshot.grant_mode
    );
  IF mismatch_count <> 0 OR (
    SELECT count(*) FROM session_attempt_personal_resource_snapshots snapshot
    WHERE snapshot.attempt_id = NEW.id
  ) <> admission_row.resource_count THEN
    RAISE EXCEPTION 'scheduled occurrence personal-resource snapshot widened or changed'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'attempt_match';
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'attempt_match';
  RAISE;
END
$validate_scheduled_task_attempt_personal_resources$;

CREATE TRIGGER scheduled_task_run_personal_resource_admission
AFTER INSERT ON "scheduled_task_runs"
FOR EACH ROW EXECUTE FUNCTION admit_scheduled_task_run_personal_resources();

CREATE TRIGGER scheduled_task_attempt_once_retry_prepare
BEFORE INSERT ON "session_turn_attempts"
FOR EACH ROW EXECUTE FUNCTION prepare_scheduled_task_attempt_once_grants();

CREATE TRIGGER zz_scheduled_task_attempt_personal_resource_match
AFTER INSERT ON "session_turn_attempts"
FOR EACH ROW EXECUTE FUNCTION validate_scheduled_task_attempt_personal_resources();

CREATE OR REPLACE FUNCTION scheduled_task_run_personal_resource_authority(
  p_account_id uuid,
  p_workspace_id uuid,
  p_run_id uuid
)
RETURNS TABLE (
  task_id uuid,
  task_authority_revision bigint,
  initiating_human_subject_id text,
  resource_kind text,
  resource_id uuid,
  resource_version_id uuid,
  selection_sources text[],
  authority_id uuid,
  authority_generation bigint,
  grant_id uuid,
  grant_generation bigint,
  grant_mode text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $scheduled_task_run_personal_resource_authority$
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'scheduled run personal-resource scope mismatch' USING ERRCODE = '42501';
  END IF;
  INSERT INTO opengeni_private.scheduled_personal_resource_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'run_admit')
  ON CONFLICT DO NOTHING;
  RETURN QUERY
  SELECT admission.task_id, admission.task_authority_revision,
    admission.initiating_human_subject_id, snapshot.resource_kind,
    snapshot.resource_id, snapshot.resource_version_id, snapshot.selection_sources,
    snapshot.authority_id, snapshot.authority_generation, snapshot.grant_id,
    snapshot.grant_generation, snapshot.grant_mode
  FROM scheduled_task_run_personal_resource_admissions admission
  JOIN scheduled_task_run_personal_resource_snapshots snapshot
    ON snapshot.run_id = admission.run_id
  WHERE admission.run_id = p_run_id
    AND admission.account_id = p_account_id
    AND admission.workspace_id = p_workspace_id
  ORDER BY snapshot.resource_kind, snapshot.resource_id;
  DELETE FROM opengeni_private.scheduled_personal_resource_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'run_admit';
END
$scheduled_task_run_personal_resource_authority$;

REVOKE ALL ON FUNCTION freeze_scheduled_task_personal_resources(uuid, uuid, uuid, bigint)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION clone_scheduled_task_personal_resource_authority(
  uuid, uuid, uuid, bigint, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION scheduled_task_run_personal_resource_authority(uuid, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION admit_scheduled_task_run_personal_resources() FROM PUBLIC;
REVOKE ALL ON FUNCTION prepare_scheduled_task_attempt_once_grants() FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_scheduled_task_attempt_personal_resources() FROM PUBLIC;

DO $scheduled_personal_resource_runtime_grants$
DECLARE
  table_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.scheduled_personal_resource_capability_active(text)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      freeze_scheduled_task_personal_resources(uuid, uuid, uuid, bigint)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      clone_scheduled_task_personal_resource_authority(uuid, uuid, uuid, bigint, bigint)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      scheduled_task_run_personal_resource_authority(uuid, uuid, uuid)
      TO opengeni_app;
    FOREACH table_name IN ARRAY ARRAY[
      'scheduled_task_personal_resource_authorities',
      'scheduled_task_personal_resource_snapshots',
      'scheduled_task_run_personal_resource_admissions',
      'scheduled_task_run_personal_resource_snapshots',
      'scheduled_task_run_personal_resource_once_receipts'
    ] LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM opengeni_app', table_name);
    END LOOP;
  END IF;
END
$scheduled_personal_resource_runtime_grants$;

COMMENT ON TABLE "scheduled_task_personal_resource_authorities" IS
  'Immutable causal-human and membership header for one scheduled-task authority revision.';
COMMENT ON TABLE "scheduled_task_personal_resource_snapshots" IS
  'Server-derived exact personal Variable Set/Rig authority frozen at scheduled-task write.';
COMMENT ON TABLE "scheduled_task_run_personal_resource_admissions" IS
  'Accepted occurrence binding to one immutable task authority revision before dispatch.';
COMMENT ON TABLE "scheduled_task_run_personal_resource_snapshots" IS
  'Exact occurrence copy used to fence queued/recovering scheduled work against widening.';
COMMENT ON TABLE "scheduled_task_run_personal_resource_once_receipts" IS
  'Unique once-grant ownership for one admitted scheduled occurrence across attempt retries.';
-- deployment-mode: rolling
-- This migration activates organization-user ownership for personal Documents. Existing
-- personal rows remain fail-closed to their original workspace; new personal
-- rows may carry the common user-resource authority and follow their owner
-- across workspaces in the same organization. Agent reads require an exact
-- attempt snapshot backed by an explicit once/session/always grant.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "documents"
  ADD COLUMN "authority_id" uuid,
  ADD COLUMN "owner_organization_membership_id" uuid,
  ADD COLUMN "origin_workspace_id" uuid;

ALTER TABLE "document_chunks"
  ADD COLUMN "authority_id" uuid,
  ADD COLUMN "owner_organization_membership_id" uuid;

UPDATE "documents" SET "origin_workspace_id" = "workspace_id";
ALTER TABLE "documents" ADD CONSTRAINT "documents_origin_workspace_not_null_chk"
  CHECK ("origin_workspace_id" IS NOT NULL) NOT VALID;
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_origin_workspace_not_null_chk";
ALTER TABLE "documents" ALTER COLUMN "origin_workspace_id" SET NOT NULL;
ALTER TABLE "documents" DROP CONSTRAINT "documents_origin_workspace_not_null_chk";
ALTER TABLE "documents" ADD CONSTRAINT "documents_origin_workspace_chk"
  CHECK ("origin_workspace_id" = "workspace_id") NOT VALID;
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_origin_workspace_chk";

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_user_authority_fk"
    FOREIGN KEY ("authority_id", "account_id", "owner_organization_membership_id")
    REFERENCES "organization_user_resource_authorities"(
      "id", "account_id", "organization_membership_id"
    ) ON DELETE RESTRICT NOT VALID;
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_user_authority_fk";

ALTER TABLE "document_chunks"
  ADD CONSTRAINT "document_chunks_user_authority_fk"
    FOREIGN KEY ("authority_id", "account_id", "owner_organization_membership_id")
    REFERENCES "organization_user_resource_authorities"(
      "id", "account_id", "organization_membership_id"
    ) ON DELETE RESTRICT NOT VALID;
ALTER TABLE "document_chunks" VALIDATE CONSTRAINT "document_chunks_user_authority_fk";

ALTER TABLE "documents" DROP CONSTRAINT "documents_authority_chk";
ALTER TABLE "documents" ADD CONSTRAINT "documents_authority_chk" CHECK (
  (
    "authority_kind" = 'organization'
    AND "authority_workspace_id" IS NULL
    AND "authority_subject_id" IS NULL
    AND "authority_id" IS NULL
    AND "owner_organization_membership_id" IS NULL
  ) OR (
    "authority_kind" = 'workspace'
    AND "authority_workspace_id" = "workspace_id"
    AND "authority_subject_id" IS NULL
    AND "authority_id" IS NULL
    AND "owner_organization_membership_id" IS NULL
  ) OR (
    "authority_kind" = 'personal'
    AND NULLIF(btrim("authority_subject_id"), '') IS NOT NULL
    AND octet_length(convert_to("authority_subject_id", 'UTF8')) <= 1024
    AND "authority_subject_id" = "created_by"
    AND (
      (
        "authority_workspace_id" = "workspace_id"
        AND "authority_id" IS NULL
        AND "owner_organization_membership_id" IS NULL
      ) OR (
        "authority_workspace_id" IS NULL
        AND "authority_id" IS NOT NULL
        AND "owner_organization_membership_id" IS NOT NULL
      )
    )
  )
) NOT VALID;
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_authority_chk";

ALTER TABLE "document_chunks" DROP CONSTRAINT "document_chunks_authority_chk";
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_authority_chk" CHECK (
  (
    "authority_kind" = 'organization'
    AND "authority_workspace_id" IS NULL
    AND "authority_subject_id" IS NULL
    AND "authority_id" IS NULL
    AND "owner_organization_membership_id" IS NULL
  ) OR (
    "authority_kind" = 'workspace'
    AND "authority_workspace_id" = "workspace_id"
    AND "authority_subject_id" IS NULL
    AND "authority_id" IS NULL
    AND "owner_organization_membership_id" IS NULL
  ) OR (
    "authority_kind" = 'personal'
    AND NULLIF(btrim("authority_subject_id"), '') IS NOT NULL
    AND octet_length(convert_to("authority_subject_id", 'UTF8')) <= 1024
    AND (
      (
        "authority_workspace_id" = "workspace_id"
        AND "authority_id" IS NULL
        AND "owner_organization_membership_id" IS NULL
      ) OR (
        "authority_workspace_id" IS NULL
        AND "authority_id" IS NOT NULL
        AND "owner_organization_membership_id" IS NOT NULL
      )
    )
  )
) NOT VALID;
ALTER TABLE "document_chunks" VALIDATE CONSTRAINT "document_chunks_authority_chk";

CREATE INDEX "documents_user_authority_idx"
  ON "documents" ("account_id", "owner_organization_membership_id", "status", "id")
  WHERE "authority_kind" = 'personal' AND "authority_id" IS NOT NULL;

CREATE TABLE opengeni_private.personal_document_authority_capabilities (
  "backend_pid" integer NOT NULL,
  "transaction_id" xid8 NOT NULL,
  "capability_kind" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "personal_document_authority_capabilities_kind_chk" CHECK (
    "capability_kind" IN ('write', 'admit', 'resolve')
  ),
  CONSTRAINT "personal_document_authority_capabilities_pk" PRIMARY KEY (
    "backend_pid", "transaction_id", "capability_kind"
  )
);
REVOKE ALL ON TABLE opengeni_private.personal_document_authority_capabilities FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.personal_document_authority_capability_active(
  p_capability_kind text DEFAULT NULL
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $capability_active$
  SELECT EXISTS (
    SELECT 1
    FROM opengeni_private.personal_document_authority_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND (
        p_capability_kind IS NULL
        OR capability.capability_kind = p_capability_kind
      )
  )
$capability_active$;
REVOKE ALL ON FUNCTION
  opengeni_private.personal_document_authority_capability_active(text) FROM PUBLIC;

CREATE TABLE "session_attempt_personal_document_admissions" (
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
  "document_count" integer NOT NULL,
  "admitted_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "session_attempt_personal_document_admissions_attempt_fk"
    FOREIGN KEY ("account_id", "workspace_id", "session_id", "turn_id", "attempt_id")
    REFERENCES "session_turn_attempts"(
      "account_id", "workspace_id", "session_id", "turn_id", "id"
    ) ON DELETE CASCADE,
  CONSTRAINT "session_attempt_personal_document_admissions_owner_fk"
    FOREIGN KEY ("owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "session_attempt_personal_document_admissions_shape_chk" CHECK (
    "execution_generation" > 0
    AND "membership_authorization_revision" > 0
    AND "session_authority_epoch" > 0
    AND "document_count" >= 0
    AND "session_visibility" IN ('user_private', 'workspace_shared')
    AND length(btrim("initiating_human_subject_id")) BETWEEN 1 AND 1024
  )
);

CREATE TABLE "session_attempt_personal_document_snapshots" (
  "attempt_id" uuid NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
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
  CONSTRAINT "session_attempt_personal_document_snapshots_pk"
    PRIMARY KEY ("attempt_id", "document_id"),
  CONSTRAINT "session_attempt_personal_document_snapshots_admission_fk"
    FOREIGN KEY ("attempt_id")
    REFERENCES "session_attempt_personal_document_admissions"("attempt_id") ON DELETE CASCADE,
  CONSTRAINT "session_attempt_personal_document_snapshots_authority_fk"
    FOREIGN KEY ("authority_id", "account_id", "owner_organization_membership_id")
    REFERENCES "organization_user_resource_authorities"(
      "id", "account_id", "organization_membership_id"
    ) ON DELETE RESTRICT,
  CONSTRAINT "session_attempt_personal_document_snapshots_grant_fk"
    FOREIGN KEY ("grant_id", "account_id")
    REFERENCES "organization_user_resource_grants"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "session_attempt_personal_document_snapshots_shape_chk" CHECK (
    "execution_generation" > 0
    AND "membership_authorization_revision" > 0
    AND "authority_generation" > 0
    AND "target_workspace_id" = "workspace_id"
    AND "session_authority_epoch" > 0
    AND "grant_generation" > 0
    AND "session_visibility" IN ('user_private', 'workspace_shared')
    AND "grant_context" = "session_visibility"
    AND (
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
  )
);

CREATE TABLE "personal_document_once_consumption_receipts" (
  "grant_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "authority_id" uuid NOT NULL,
  "authority_generation" bigint NOT NULL,
  "grant_generation" bigint NOT NULL,
  "consumed_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "personal_document_once_consumption_receipts_grant_fk"
    FOREIGN KEY ("grant_id", "account_id")
    REFERENCES "organization_user_resource_grants"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "personal_document_once_consumption_receipts_snapshot_fk"
    FOREIGN KEY ("attempt_id", "document_id")
    REFERENCES "session_attempt_personal_document_snapshots"(
      "attempt_id", "document_id"
    ) ON DELETE CASCADE,
  CONSTRAINT "personal_document_once_consumption_receipts_generation_chk" CHECK (
    "authority_generation" > 0 AND "grant_generation" > 0
  )
);

ALTER TABLE "session_attempt_personal_document_admissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_attempt_personal_document_admissions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_attempt_personal_document_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_attempt_personal_document_snapshots" FORCE ROW LEVEL SECURITY;
ALTER TABLE "personal_document_once_consumption_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "personal_document_once_consumption_receipts" FORCE ROW LEVEL SECURITY;

DO $personal_document_capability_policies$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'documents', 'organization_memberships', 'workspace_memberships',
    'organization_user_resource_authorities', 'organization_user_resource_grants',
    'sessions', 'session_turns', 'session_turn_attempts', 'session_attempt_interruptions',
    'session_attempt_personal_document_admissions',
    'session_attempt_personal_document_snapshots',
    'personal_document_once_consumption_receipts'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY personal_document_authority_capability_read ON %I.%I '
        || 'FOR SELECT USING (current_user = %L AND '
        || 'opengeni_private.personal_document_authority_capability_active())',
      data_schema, table_name, migration_owner
    );
  END LOOP;

  EXECUTE format(
    'CREATE POLICY personal_document_authority_capability_insert '
      || 'ON %I.organization_user_resource_authorities FOR INSERT WITH CHECK ('
      || 'current_user = %L AND '
      || 'opengeni_private.personal_document_authority_capability_active(''write''))',
    data_schema, migration_owner
  );
  EXECUTE format(
    'CREATE POLICY personal_document_authority_capability_update '
      || 'ON %I.organization_user_resource_authorities FOR UPDATE USING ('
      || 'current_user = %L AND '
      || 'opengeni_private.personal_document_authority_capability_active(''write'')) '
      || 'WITH CHECK (current_user = %L AND '
      || 'opengeni_private.personal_document_authority_capability_active(''write''))',
    data_schema, migration_owner, migration_owner
  );
  EXECUTE format(
    'CREATE POLICY personal_document_grant_capability_update '
      || 'ON %I.organization_user_resource_grants FOR UPDATE USING ('
      || 'current_user = %L AND '
      || 'opengeni_private.personal_document_authority_capability_active()) '
      || 'WITH CHECK (current_user = %L AND '
      || 'opengeni_private.personal_document_authority_capability_active())',
    data_schema, migration_owner, migration_owner
  );

  FOREACH table_name IN ARRAY ARRAY[
    'session_attempt_personal_document_admissions',
    'session_attempt_personal_document_snapshots',
    'personal_document_once_consumption_receipts'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY personal_document_authority_capability_insert ON %I.%I '
        || 'FOR INSERT WITH CHECK (current_user = %L AND '
        || 'opengeni_private.personal_document_authority_capability_active(''admit''))',
      data_schema, table_name, migration_owner
    );
  END LOOP;
  EXECUTE format(
    'CREATE POLICY personal_document_authority_capability_update '
      || 'ON %I.session_attempt_personal_document_admissions FOR UPDATE USING ('
      || 'current_user = %L AND '
      || 'opengeni_private.personal_document_authority_capability_active(''admit'')) '
      || 'WITH CHECK (current_user = %L AND '
      || 'opengeni_private.personal_document_authority_capability_active(''admit''))',
    data_schema, migration_owner, migration_owner
  );
END
$personal_document_capability_policies$;

DO $personal_document_functions$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.create_personal_document_authority(
      p_account_id uuid,
      p_workspace_id uuid,
      p_document_id uuid
    ) RETURNS TABLE (
      authority_id uuid,
      owner_organization_membership_id uuid,
      authority_generation bigint
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      caller_subject text := nullif(pg_catalog.current_setting('opengeni.subject_id', true), '');
      member_row organization_memberships%%ROWTYPE;
      created_authority_id uuid := pg_catalog.gen_random_uuid();
    BEGIN
      INSERT INTO opengeni_private.personal_document_authority_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'write')
      ON CONFLICT DO NOTHING;

      IF p_account_id IS DISTINCT FROM nullif(
          pg_catalog.current_setting('opengeni.account_id', true), ''
        )::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(
          pg_catalog.current_setting('opengeni.workspace_id', true), ''
        )::uuid
        OR caller_subject IS NULL
      THEN
        RAISE EXCEPTION 'personal document creation scope mismatch' USING ERRCODE = '42501';
      END IF;

      SELECT membership.* INTO member_row
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = caller_subject
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
      FOR SHARE;

      -- Configured/local and rolling-legacy subjects may legitimately use the
      -- pre-organization personal Document lane. Only create the portable
      -- organization-user authority when there is one deterministic active
      -- organization membership; otherwise the caller inserts the existing
      -- workspace-anchored personal tuple in the same transaction.
      IF NOT FOUND THEN
        DELETE FROM opengeni_private.personal_document_authority_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'write';
        RETURN;
      END IF;

      IF member_row.personal_workspace_id IS DISTINCT FROM p_workspace_id THEN
        PERFORM 1 FROM workspace_memberships workspace_membership
        WHERE workspace_membership.account_id = p_account_id
          AND workspace_membership.workspace_id = p_workspace_id
          AND workspace_membership.subject_id = caller_subject
        FOR KEY SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'personal document owner lacks current workspace access'
            USING ERRCODE = '42501';
        END IF;
      END IF;

      INSERT INTO organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind,
        resource_id, origin_workspace_id, generation, status
      ) VALUES (
        created_authority_id, p_account_id, member_row.id, 'document',
        p_document_id, p_workspace_id, 1, 'active'
      );

      authority_id := created_authority_id;
      owner_organization_membership_id := member_row.id;
      authority_generation := 1;
      RETURN NEXT;
      DELETE FROM opengeni_private.personal_document_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'write';
      RETURN;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.personal_document_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'write';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.prepare_session_attempt_personal_document_reads(
      p_account_id uuid,
      p_workspace_id uuid,
      p_session_id uuid,
      p_attempt_id uuid
    ) RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      session_row sessions%%ROWTYPE;
      turn_row session_turns%%ROWTYPE;
      attempt_row session_turn_attempts%%ROWTYPE;
      member_row organization_memberships%%ROWTYPE;
      document_row record;
      grant_row organization_user_resource_grants%%ROWTYPE;
      existing_count integer;
      admitted_count integer := 0;
      initiating_subject text;
      affected integer;
    BEGIN
      INSERT INTO opengeni_private.personal_document_authority_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'admit')
      ON CONFLICT DO NOTHING;

      SELECT attempt.* INTO STRICT attempt_row
      FROM session_turn_attempts attempt
      WHERE attempt.id = p_attempt_id
        AND attempt.account_id = p_account_id
        AND attempt.workspace_id = p_workspace_id
        AND attempt.session_id = p_session_id
      FOR UPDATE;
      SELECT session_value.* INTO STRICT session_row
      FROM sessions session_value
      WHERE session_value.id = attempt_row.session_id
        AND session_value.account_id = attempt_row.account_id
        AND session_value.workspace_id = attempt_row.workspace_id
      FOR SHARE;
      SELECT turn_value.* INTO STRICT turn_row
      FROM session_turns turn_value
      WHERE turn_value.id = attempt_row.turn_id
        AND turn_value.account_id = attempt_row.account_id
        AND turn_value.workspace_id = attempt_row.workspace_id
        AND turn_value.session_id = attempt_row.session_id
      FOR SHARE;

      IF attempt_row.execution_generation <= 0
        OR attempt_row.state NOT IN ('claimed', 'running')
        OR attempt_row.closed_at IS NOT NULL
        OR attempt_row.quiesced_at IS NOT NULL
        OR session_row.active_turn_id IS DISTINCT FROM attempt_row.turn_id
        OR turn_row.active_attempt_id IS DISTINCT FROM attempt_row.id
        OR turn_row.execution_generation IS DISTINCT FROM attempt_row.execution_generation
        OR turn_row.status <> 'running'
        OR attempt_row.authority_visibility IS DISTINCT FROM session_row.visibility
        OR attempt_row.authority_epoch IS DISTINCT FROM session_row.authority_epoch
        OR EXISTS (
          SELECT 1 FROM session_attempt_interruptions interruption
          WHERE interruption.account_id = p_account_id
            AND interruption.workspace_id = p_workspace_id
            AND interruption.session_id = p_session_id
            AND interruption.attempt_id = p_attempt_id
            AND interruption.state IN ('pending', 'delivered', 'acknowledged')
        )
      THEN
        RAISE EXCEPTION 'personal document admission requires the exact current uninterrupted attempt'
          USING ERRCODE = '42501';
      END IF;

      initiating_subject := coalesce(
        nullif(btrim(turn_row.initiating_human_subject_id), ''),
        CASE WHEN turn_row.initiator_kind = 'subject'
          THEN nullif(btrim(turn_row.initiator_subject_id), '') END
      );
      IF initiating_subject IS NULL THEN
        DELETE FROM opengeni_private.personal_document_authority_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'admit';
        RETURN 0;
      END IF;

      SELECT membership.* INTO member_row
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = initiating_subject
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
      FOR SHARE;
      IF NOT FOUND THEN
        DELETE FROM opengeni_private.personal_document_authority_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'admit';
        RETURN 0;
      END IF;
      IF member_row.personal_workspace_id IS DISTINCT FROM p_workspace_id THEN
        PERFORM 1 FROM workspace_memberships workspace_membership
        WHERE workspace_membership.account_id = p_account_id
          AND workspace_membership.workspace_id = p_workspace_id
          AND workspace_membership.subject_id = initiating_subject
        FOR KEY SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'initiating human lacks target-workspace membership'
            USING ERRCODE = '42501';
        END IF;
      END IF;

      SELECT admission.document_count INTO existing_count
      FROM session_attempt_personal_document_admissions admission
      WHERE admission.attempt_id = p_attempt_id;
      IF FOUND THEN
        DELETE FROM opengeni_private.personal_document_authority_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'admit';
        RETURN existing_count;
      END IF;

      INSERT INTO session_attempt_personal_document_admissions (
        attempt_id, account_id, workspace_id, session_id, turn_id,
        execution_generation, initiating_human_subject_id,
        owner_organization_membership_id, membership_authorization_revision,
        session_visibility, session_authority_epoch, document_count
      ) VALUES (
        p_attempt_id, p_account_id, p_workspace_id, p_session_id, attempt_row.turn_id,
        attempt_row.execution_generation, initiating_subject, member_row.id,
        member_row.authorization_revision, session_row.visibility,
        session_row.authority_epoch, 0
      ) ON CONFLICT (attempt_id) DO NOTHING;
      IF NOT FOUND THEN
        SELECT admission.document_count INTO STRICT existing_count
        FROM session_attempt_personal_document_admissions admission
        WHERE admission.attempt_id = p_attempt_id;
        DELETE FROM opengeni_private.personal_document_authority_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'admit';
        RETURN existing_count;
      END IF;

      FOR document_row IN
        SELECT document_value.id, document_value.authority_id,
          authority.generation AS authority_generation
        FROM documents document_value
        JOIN organization_user_resource_authorities authority
          ON authority.id = document_value.authority_id
         AND authority.account_id = document_value.account_id
         AND authority.organization_membership_id
           = document_value.owner_organization_membership_id
         AND authority.resource_kind = 'document'
         AND authority.resource_id = document_value.id
         AND authority.status = 'active'
         AND authority.revoked_at IS NULL
        WHERE document_value.account_id = p_account_id
          AND document_value.authority_kind = 'personal'
          AND document_value.authority_workspace_id IS NULL
          AND document_value.authority_subject_id = initiating_subject
          AND document_value.owner_organization_membership_id = member_row.id
          AND document_value.status = 'ready'
          AND document_value.agent_access = true
        ORDER BY document_value.id
        FOR SHARE OF document_value, authority
      LOOP
        SELECT grant_value.* INTO grant_row
        FROM organization_user_resource_grants grant_value
        WHERE grant_value.account_id = p_account_id
          AND grant_value.authority_id = document_row.authority_id
          AND grant_value.owner_organization_membership_id = member_row.id
          AND grant_value.workspace_id = p_workspace_id
          AND grant_value.action = 'document.read'
          AND grant_value.context = session_row.visibility
          AND grant_value.status = 'active'
          AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
          AND (
            (
              grant_value.mode IN ('once', 'session')
              AND grant_value.session_id = p_session_id
              AND grant_value.authority_epoch = session_row.authority_epoch
            ) OR (
              grant_value.mode = 'always'
              AND grant_value.session_id IS NULL
              AND grant_value.authority_epoch IS NULL
            )
          )
        ORDER BY CASE grant_value.mode WHEN 'once' THEN 1 WHEN 'session' THEN 2 ELSE 3 END,
          grant_value.generation DESC, grant_value.id
        LIMIT 1
        FOR UPDATE;
        IF NOT FOUND THEN CONTINUE; END IF;

        INSERT INTO session_attempt_personal_document_snapshots (
          attempt_id, document_id, account_id, workspace_id, session_id, turn_id,
          execution_generation, owner_organization_membership_id,
          membership_authorization_revision, authority_id, authority_generation,
          target_workspace_id, session_visibility, session_authority_epoch,
          grant_id, grant_generation, grant_mode, grant_context,
          grant_session_id, grant_authority_epoch
        ) VALUES (
          p_attempt_id, document_row.id, p_account_id, p_workspace_id, p_session_id,
          attempt_row.turn_id, attempt_row.execution_generation, member_row.id,
          member_row.authorization_revision, document_row.authority_id,
          document_row.authority_generation, p_workspace_id, session_row.visibility,
          session_row.authority_epoch, grant_row.id, grant_row.generation,
          grant_row.mode, grant_row.context, grant_row.session_id,
          grant_row.authority_epoch
        );

        IF grant_row.mode = 'once' THEN
          UPDATE organization_user_resource_grants
          SET status = 'consumed', updated_at = clock_timestamp()
          WHERE id = grant_row.id AND account_id = p_account_id
            AND generation = grant_row.generation AND status = 'active';
          GET DIAGNOSTICS affected = ROW_COUNT;
          IF affected <> 1 THEN
            RAISE EXCEPTION 'once document grant lost its first-use race'
              USING ERRCODE = '40001';
          END IF;
          INSERT INTO personal_document_once_consumption_receipts (
            grant_id, account_id, attempt_id, document_id, authority_id,
            authority_generation, grant_generation
          ) VALUES (
            grant_row.id, p_account_id, p_attempt_id, document_row.id,
            document_row.authority_id, document_row.authority_generation,
            grant_row.generation
          );
        END IF;
        admitted_count := admitted_count + 1;
      END LOOP;

      UPDATE session_attempt_personal_document_admissions
      SET document_count = admitted_count
      WHERE attempt_id = p_attempt_id;

      DELETE FROM opengeni_private.personal_document_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'admit';
      RETURN admitted_count;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.personal_document_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'admit';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.resolve_session_attempt_personal_document_reads(
      p_account_id uuid,
      p_workspace_id uuid,
      p_session_id uuid,
      p_attempt_id uuid
    ) RETURNS SETOF uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      admission_row session_attempt_personal_document_admissions%%ROWTYPE;
      invalid_count integer;
      actual_count integer;
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
        RAISE EXCEPTION 'personal document resolve scope mismatch' USING ERRCODE = '42501';
      END IF;

      INSERT INTO opengeni_private.personal_document_authority_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'resolve')
      ON CONFLICT DO NOTHING;

      SELECT admission.* INTO admission_row
      FROM session_attempt_personal_document_admissions admission
      WHERE admission.attempt_id = p_attempt_id
        AND admission.account_id = p_account_id
        AND admission.workspace_id = p_workspace_id
        AND admission.session_id = p_session_id;
      IF NOT FOUND THEN
        DELETE FROM opengeni_private.personal_document_authority_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'resolve';
        RETURN;
      END IF;

      IF caller_subject IS DISTINCT FROM admission_row.initiating_human_subject_id THEN
        RAISE EXCEPTION 'personal document resolve initiating human mismatch'
          USING ERRCODE = '42501';
      END IF;

      SELECT count(*)::integer INTO invalid_count
      FROM session_attempt_personal_document_snapshots snapshot
      WHERE snapshot.attempt_id = p_attempt_id
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
              AND attempt.closed_at IS NULL
              AND attempt.quiesced_at IS NULL
              AND session_value.active_turn_id = snapshot.turn_id
              AND turn_value.active_attempt_id = snapshot.attempt_id
              AND turn_value.execution_generation = snapshot.execution_generation
              AND turn_value.status = 'running'
              AND session_value.visibility = snapshot.session_visibility
              AND session_value.authority_epoch = snapshot.session_authority_epoch
          )
          AND NOT EXISTS (
            SELECT 1 FROM session_attempt_interruptions interruption
            WHERE interruption.account_id = snapshot.account_id
              AND interruption.workspace_id = snapshot.workspace_id
              AND interruption.session_id = snapshot.session_id
              AND interruption.attempt_id = snapshot.attempt_id
              AND interruption.state IN ('pending', 'delivered', 'acknowledged')
          )
          AND EXISTS (
            SELECT 1 FROM organization_memberships membership
            WHERE membership.id = snapshot.owner_organization_membership_id
              AND membership.account_id = snapshot.account_id
              AND membership.subject_id = admission_row.initiating_human_subject_id
              AND membership.status = 'active'
              AND membership.revoked_at IS NULL
              AND membership.authorization_revision
                = snapshot.membership_authorization_revision
              AND (
                membership.personal_workspace_id = snapshot.workspace_id
                OR EXISTS (
                  SELECT 1 FROM workspace_memberships workspace_membership
                  WHERE workspace_membership.account_id = membership.account_id
                    AND workspace_membership.workspace_id = snapshot.workspace_id
                    AND workspace_membership.subject_id = membership.subject_id
                )
              )
          )
          AND EXISTS (
            SELECT 1
            FROM documents document_value
            JOIN organization_user_resource_authorities authority
              ON authority.id = document_value.authority_id
             AND authority.account_id = document_value.account_id
             AND authority.organization_membership_id
               = document_value.owner_organization_membership_id
            WHERE document_value.id = snapshot.document_id
              AND document_value.account_id = snapshot.account_id
              AND document_value.authority_kind = 'personal'
              AND document_value.authority_workspace_id IS NULL
              AND document_value.authority_subject_id
                = admission_row.initiating_human_subject_id
              AND document_value.owner_organization_membership_id
                = snapshot.owner_organization_membership_id
              AND document_value.authority_id = snapshot.authority_id
              AND document_value.status = 'ready'
              AND document_value.agent_access = true
              AND authority.resource_kind = 'document'
              AND authority.resource_id = document_value.id
              AND authority.generation = snapshot.authority_generation
              AND authority.status = 'active'
              AND authority.revoked_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM organization_user_resource_grants grant_value
            WHERE grant_value.id = snapshot.grant_id
              AND grant_value.account_id = snapshot.account_id
              AND grant_value.authority_id = snapshot.authority_id
              AND grant_value.owner_organization_membership_id
                = snapshot.owner_organization_membership_id
              AND grant_value.workspace_id = snapshot.target_workspace_id
              AND grant_value.action = 'document.read'
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
                    SELECT 1 FROM personal_document_once_consumption_receipts receipt
                    WHERE receipt.grant_id = snapshot.grant_id
                      AND receipt.account_id = snapshot.account_id
                      AND receipt.attempt_id = snapshot.attempt_id
                      AND receipt.document_id = snapshot.document_id
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
        RAISE EXCEPTION 'personal document authority snapshot is no longer live'
          USING ERRCODE = '42501';
      END IF;

      SELECT count(*)::integer INTO actual_count
      FROM session_attempt_personal_document_snapshots snapshot
      WHERE snapshot.attempt_id = p_attempt_id;
      IF actual_count <> admission_row.document_count THEN
        RAISE EXCEPTION 'personal document snapshot collection is incomplete'
          USING ERRCODE = '42501';
      END IF;

      RETURN QUERY
      SELECT snapshot.document_id
      FROM session_attempt_personal_document_snapshots snapshot
      WHERE snapshot.attempt_id = p_attempt_id
      ORDER BY snapshot.document_id;

      DELETE FROM opengeni_private.personal_document_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'resolve';
      RETURN;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.personal_document_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'resolve';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.admit_session_attempt_personal_documents()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    BEGIN
      PERFORM prepare_session_attempt_personal_document_reads(
        NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.id
      );
      RETURN NEW;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.apply_document_authority()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = %1$I, pg_catalog
    AS $body$
    BEGIN
      IF TG_OP = 'UPDATE' AND (
        NEW.authority_kind IS DISTINCT FROM OLD.authority_kind
        OR NEW.authority_workspace_id IS DISTINCT FROM OLD.authority_workspace_id
        OR NEW.authority_subject_id IS DISTINCT FROM OLD.authority_subject_id
        OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
        OR NEW.owner_organization_membership_id
          IS DISTINCT FROM OLD.owner_organization_membership_id
        OR NEW.origin_workspace_id IS DISTINCT FROM OLD.origin_workspace_id
        OR NEW.created_by IS DISTINCT FROM OLD.created_by
        OR NEW.visibility IS DISTINCT FROM OLD.visibility
      ) THEN
        RAISE EXCEPTION 'document authority is immutable';
      END IF;
      NEW.origin_workspace_id := NEW.workspace_id;
      CASE NEW.authority_kind
        WHEN 'organization' THEN
          NEW.authority_workspace_id := NULL;
          NEW.authority_subject_id := NULL;
          NEW.authority_id := NULL;
          NEW.owner_organization_membership_id := NULL;
          NEW.visibility := 'workspace';
        WHEN 'workspace' THEN
          NEW.authority_workspace_id := NEW.workspace_id;
          NEW.authority_subject_id := NULL;
          NEW.authority_id := NULL;
          NEW.owner_organization_membership_id := NULL;
          NEW.visibility := 'workspace';
        WHEN 'personal' THEN
          NEW.authority_subject_id := coalesce(
            nullif(btrim(NEW.authority_subject_id), ''),
            nullif(btrim(NEW.created_by), '')
          );
          IF NEW.authority_id IS NULL THEN
            NEW.authority_workspace_id := NEW.workspace_id;
            NEW.owner_organization_membership_id := NULL;
          ELSE
            NEW.authority_workspace_id := NULL;
          END IF;
          NEW.visibility := 'private';
        ELSE
          RAISE EXCEPTION 'invalid document authority kind: %%', NEW.authority_kind;
      END CASE;
      RETURN NEW;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.apply_document_chunk_authority()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE parent %1$I.documents%%ROWTYPE;
    BEGIN
      IF TG_OP = 'UPDATE' AND (
        NEW.authority_kind IS DISTINCT FROM OLD.authority_kind
        OR NEW.authority_workspace_id IS DISTINCT FROM OLD.authority_workspace_id
        OR NEW.authority_subject_id IS DISTINCT FROM OLD.authority_subject_id
        OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
        OR NEW.owner_organization_membership_id
          IS DISTINCT FROM OLD.owner_organization_membership_id
        OR NEW.document_id IS DISTINCT FROM OLD.document_id
      ) THEN
        RAISE EXCEPTION 'document chunk authority is immutable';
      END IF;
      SELECT * INTO parent FROM %1$I.documents WHERE id = NEW.document_id;
      IF NOT FOUND
        OR parent.account_id IS DISTINCT FROM NEW.account_id
        OR parent.workspace_id IS DISTINCT FROM NEW.workspace_id
        OR parent.base_id IS DISTINCT FROM NEW.base_id
        OR parent.file_id IS DISTINCT FROM NEW.file_id
      THEN
        RAISE EXCEPTION 'document chunk parent identity mismatch';
      END IF;
      NEW.authority_kind := parent.authority_kind;
      NEW.authority_workspace_id := parent.authority_workspace_id;
      NEW.authority_subject_id := parent.authority_subject_id;
      NEW.authority_id := parent.authority_id;
      NEW.owner_organization_membership_id := parent.owner_organization_membership_id;
      RETURN NEW;
    END
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.revoke_personal_document_authority_after_delete()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    BEGIN
      IF OLD.authority_kind <> 'personal' OR OLD.authority_id IS NULL THEN
        RETURN OLD;
      END IF;
      INSERT INTO opengeni_private.personal_document_authority_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'write')
      ON CONFLICT DO NOTHING;
      UPDATE organization_user_resource_grants
      SET status = 'revoked', generation = generation + 1,
        revoked_at = coalesce(revoked_at, clock_timestamp()),
        updated_at = clock_timestamp()
      WHERE authority_id = OLD.authority_id AND account_id = OLD.account_id
        AND status IN ('active', 'consumed');
      UPDATE organization_user_resource_authorities
      SET status = 'revoked', generation = generation + 1,
        revoked_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = OLD.authority_id AND account_id = OLD.account_id
        AND status <> 'revoked';
      DELETE FROM opengeni_private.personal_document_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'write';
      RETURN OLD;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.personal_document_authority_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'write';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);
END
$personal_document_functions$;

DROP TRIGGER "documents_authority_guard" ON "documents";
CREATE TRIGGER "documents_authority_guard"
BEFORE INSERT OR UPDATE ON "documents"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.apply_document_authority();

DROP TRIGGER "document_chunks_authority_guard" ON "document_chunks";
CREATE TRIGGER "document_chunks_authority_guard"
BEFORE INSERT OR UPDATE ON "document_chunks"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.apply_document_chunk_authority();

CREATE TRIGGER "documents_personal_authority_revoke"
AFTER DELETE ON "documents"
FOR EACH ROW EXECUTE FUNCTION revoke_personal_document_authority_after_delete();

CREATE TRIGGER "session_attempt_personal_document_admission"
AFTER INSERT ON "session_turn_attempts"
FOR EACH ROW EXECUTE FUNCTION admit_session_attempt_personal_documents();

REVOKE ALL ON FUNCTION create_personal_document_authority(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  prepare_session_attempt_personal_document_reads(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  resolve_session_attempt_personal_document_reads(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION admit_session_attempt_personal_documents() FROM PUBLIC;

DO $personal_document_runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.personal_document_authority_capability_active(text)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION create_personal_document_authority(uuid, uuid, uuid)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      resolve_session_attempt_personal_document_reads(uuid, uuid, uuid, uuid)
      TO opengeni_app;
    REVOKE ALL ON TABLE session_attempt_personal_document_admissions FROM opengeni_app;
    REVOKE ALL ON TABLE session_attempt_personal_document_snapshots FROM opengeni_app;
    REVOKE ALL ON TABLE personal_document_once_consumption_receipts FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_resource_authorities FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_resource_grants FROM opengeni_app;
  END IF;
END
$personal_document_runtime_grants$;

COMMENT ON COLUMN "documents"."origin_workspace_id" IS
  'Upload provenance only. It never narrows activated organization-user document authority.';
COMMENT ON COLUMN "documents"."authority_id" IS
  'Common organization-user resource authority for activated personal Documents; null on legacy anchored personal rows.';
COMMENT ON TABLE "session_attempt_personal_document_snapshots" IS
  'Immutable exact-attempt personal Document grants; shared-session snapshots require the grant lifecycle acknowledgement.';

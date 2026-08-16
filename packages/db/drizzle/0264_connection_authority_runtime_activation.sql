-- deployment-mode: maintenance
-- This is a drained runtime cutover. Old workers neither materialize accepted
-- connection authority nor carry exact attempt/use fences and must not restart.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $connection_authority_writer_drain_before_lock$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      '0264 connection authority activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$connection_authority_writer_drain_before_lock$;

LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_turns IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_system_updates IN ACCESS EXCLUSIVE MODE;
LOCK TABLE session_system_update_outbox IN ACCESS EXCLUSIVE MODE;
LOCK TABLE scheduled_tasks IN ACCESS EXCLUSIVE MODE;
LOCK TABLE connections IN ACCESS EXCLUSIVE MODE;

DO $connection_authority_writer_drain_after_lock$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      '0264 connection authority activation requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$connection_authority_writer_drain_after_lock$;

-- The maintenance label is operational guidance; this data precondition is
-- the durable cutover fence. Migration 0256 activated common-user Connection
-- rows before accepted-work snapshots existed. Do not install the new runtime
-- while any executable frozen source could still carry one of those rows by
-- the legacy owner tuple without an explicit grant.
DO $accepted_work_drain$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM sessions session_value
    CROSS JOIN LATERAL jsonb_array_elements(
      session_value.initial_personal_connection_delegations
    ) delegation
    JOIN connections connection_value
      ON connection_value.id::text = delegation ->> 'connectionId'
      AND connection_value.account_id = session_value.account_id
    WHERE session_value.status <> 'cancelled'
      AND NOT EXISTS (
        SELECT 1 FROM session_turns existing_turn
        WHERE existing_turn.workspace_id = session_value.workspace_id
          AND existing_turn.session_id = session_value.id
      )
      AND connection_value.authority_scope = 'user'
  ) OR EXISTS (
    SELECT 1
    FROM session_turns turn_value
    CROSS JOIN LATERAL jsonb_array_elements(
      turn_value.personal_connection_delegations
    ) delegation
    JOIN connections connection_value
      ON connection_value.id::text = delegation ->> 'connectionId'
      AND connection_value.account_id = turn_value.account_id
    WHERE turn_value.status IN (
      'queued', 'running', 'requires_action', 'recovering', 'waiting_capacity'
      )
      AND connection_value.authority_scope = 'user'
  ) OR EXISTS (
    SELECT 1
    FROM session_system_updates update_value
    CROSS JOIN LATERAL jsonb_array_elements(
      update_value.personal_connection_delegations
    ) delegation
    JOIN connections connection_value
      ON connection_value.id::text = delegation ->> 'connectionId'
      AND connection_value.account_id = update_value.account_id
    WHERE update_value.state = 'pending'
      AND connection_value.authority_scope = 'user'
  ) OR EXISTS (
    SELECT 1
    FROM session_system_update_outbox outbox
    CROSS JOIN LATERAL jsonb_array_elements(
      outbox.personal_connection_delegations
    ) delegation
    JOIN connections connection_value
      ON connection_value.id::text = delegation ->> 'connectionId'
      AND connection_value.account_id = outbox.account_id
    WHERE outbox.status = 'pending'
      AND connection_value.authority_scope = 'user'
  ) OR EXISTS (
    SELECT 1
    FROM scheduled_tasks task
    CROSS JOIN LATERAL jsonb_array_elements(
      task.personal_connection_delegations
    ) delegation
    JOIN connections connection_value
      ON connection_value.id::text = delegation ->> 'connectionId'
      AND connection_value.account_id = task.account_id
    WHERE task.status = 'active'
      AND connection_value.authority_scope = 'user'
  ) THEN
    RAISE EXCEPTION
      '0264 requires draining or superseding executable pre-activation common-user connection work'
      USING ERRCODE = '55000';
  END IF;
END
$accepted_work_drain$;

CREATE TABLE "turn_connection_authority_snapshots" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "server_id" text NOT NULL,
  "connection_id" uuid NOT NULL,
  "connection_generation" bigint NOT NULL,
  "origin_workspace_id" uuid NOT NULL,
  "provider_domain" text NOT NULL,
  "connection_kind" text NOT NULL,
  "authority_scope" text NOT NULL,
  "authority_source" text NOT NULL,
  "owner_subject_id" text,
  "owner_organization_membership_id" uuid,
  "membership_authorization_revision" bigint,
  "authority_id" uuid,
  "authority_generation" bigint,
  "grant_id" uuid,
  "grant_generation" bigint,
  "grant_mode" text,
  "grant_context" text,
  "grant_session_id" uuid,
  "grant_authority_epoch" integer,
  "session_visibility" text NOT NULL,
  "session_authority_epoch" integer NOT NULL,
  "canonical_snapshot" jsonb NOT NULL,
  "snapshot_digest" bytea NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("turn_id", "server_id"),
  CONSTRAINT "turn_connection_authority_server_check" CHECK (
    octet_length("server_id") BETWEEN 1 AND 256
  ),
  CONSTRAINT "turn_connection_authority_generation_check" CHECK (
    "connection_generation" > 0
    AND "session_authority_epoch" > 0
    AND ("membership_authorization_revision" IS NULL
      OR "membership_authorization_revision" > 0)
    AND ("authority_generation" IS NULL OR "authority_generation" > 0)
    AND ("grant_generation" IS NULL OR "grant_generation" > 0)
  ),
  CONSTRAINT "turn_connection_authority_grant_check" CHECK (
    ("authority_scope" = 'user'
      AND "authority_source" = 'user_delegation'
      AND "owner_subject_id" IS NOT NULL
      AND "owner_organization_membership_id" IS NOT NULL
      AND "membership_authorization_revision" > 0
      AND "authority_id" IS NOT NULL AND "authority_generation" > 0
      AND "grant_id" IS NOT NULL AND "grant_generation" > 0
      AND "grant_mode" IN ('once', 'session', 'always')
      AND "grant_context" IN ('user_private', 'workspace_shared')
      AND (("grant_mode" = 'always' AND "grant_session_id" IS NULL
          AND "grant_authority_epoch" IS NULL)
        OR ("grant_mode" IN ('once', 'session') AND "grant_session_id" = "session_id"
          AND "grant_authority_epoch" > 0)))
    OR ("authority_scope" = 'workspace'
      AND "authority_source" IN ('explicit_workspace', 'legacy_workspace_omission')
      AND "owner_subject_id" IS NULL
      AND "owner_organization_membership_id" IS NULL
      AND "membership_authorization_revision" IS NULL
      AND "authority_id" IS NULL AND "authority_generation" IS NULL
      AND "grant_id" IS NULL AND "grant_generation" IS NULL
      AND "grant_mode" IS NULL AND "grant_context" IS NULL
      AND "grant_session_id" IS NULL AND "grant_authority_epoch" IS NULL)
    OR ("authority_scope" = 'legacy_user'
      AND "authority_source" = 'legacy_user_compatibility'
      AND "owner_subject_id" IS NOT NULL
      AND "owner_organization_membership_id" IS NULL
      AND "membership_authorization_revision" IS NULL
      AND "authority_id" IS NULL AND "authority_generation" IS NULL
      AND "grant_id" IS NULL AND "grant_generation" IS NULL
      AND "grant_mode" IS NULL AND "grant_context" IS NULL
      AND "grant_session_id" IS NULL AND "grant_authority_epoch" IS NULL)
  ),
  CONSTRAINT "turn_connection_authority_turn_fk" FOREIGN KEY (
    "workspace_id", "turn_id"
  ) REFERENCES "session_turns"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "turn_connection_authority_connection_fk" FOREIGN KEY ("connection_id")
    REFERENCES "connections"("id") ON DELETE RESTRICT,
  CONSTRAINT "turn_connection_authority_membership_fk" FOREIGN KEY (
    "owner_organization_membership_id", "account_id"
  ) REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "turn_connection_authority_authority_fk" FOREIGN KEY (
    "authority_id", "account_id"
  ) REFERENCES "organization_user_resource_authorities"("id", "account_id")
    ON DELETE RESTRICT,
  CONSTRAINT "turn_connection_authority_grant_fk" FOREIGN KEY (
    "grant_id", "account_id"
  ) REFERENCES "organization_user_resource_grants"("id", "account_id") ON DELETE RESTRICT
);

CREATE INDEX "turn_connection_authority_connection_idx"
  ON "turn_connection_authority_snapshots" (
    "account_id", "connection_id", "turn_id", "server_id"
  );

ALTER TABLE "turn_connection_authority_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "turn_connection_authority_snapshots" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_isolation" ON "turn_connection_authority_snapshots"
  USING (
    "account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  ) WITH CHECK (
    "account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  );

CREATE TABLE "connection_use_audit_facts" (
  "physical_request_id" uuid PRIMARY KEY,
  "use_phase" text NOT NULL,
  "request_digest" bytea NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "execution_generation" integer NOT NULL,
  "server_id" text NOT NULL,
  "connection_id" uuid,
  "connection_generation" bigint,
  "authority_scope" text,
  "owner_subject_id" text,
  "authority_id" uuid,
  "grant_id" uuid,
  "outcome" text NOT NULL,
  "denial_reason" text,
  "occurred_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "connection_use_audit_shape_check" CHECK (
    octet_length("server_id") BETWEEN 1 AND 256
    AND octet_length("request_digest") = 32
    AND "execution_generation" > 0
    AND "use_phase" IN ('credential_resolution', 'provider_request')
    AND "outcome" IN ('authorized', 'denied')
    AND (("outcome" = 'authorized' AND "denial_reason" IS NULL
      AND "connection_id" IS NOT NULL AND "connection_generation" > 0
      AND "authority_scope" IN ('workspace', 'user', 'legacy_user'))
      OR ("outcome" = 'denied' AND octet_length("denial_reason") BETWEEN 1 AND 128))
  )
);

ALTER TABLE "connection_use_audit_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connection_use_audit_facts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_isolation" ON "connection_use_audit_facts"
  USING (
    "account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  ) WITH CHECK (
    "account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  );

CREATE INDEX "connection_use_audit_attempt_idx"
  ON "connection_use_audit_facts" ("workspace_id", "attempt_id", "occurred_at");

DO $connection_authority_runtime$
DECLARE
  data_schema text := current_schema();
BEGIN
EXECUTE format($ddl$
CREATE OR REPLACE FUNCTION %1$I.resolve_personal_connection_authority_selection(
  p_account_id uuid, p_target_workspace_id uuid, p_subject_id text,
  p_connection_id uuid, p_delegation jsonb
) RETURNS TABLE (origin_workspace_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = %1$I, pg_catalog, pg_temp
AS $body$
DECLARE
  membership_row organization_memberships%%ROWTYPE;
  connection_row connections%%ROWTYPE;
  authority_row organization_user_resource_authorities%%ROWTYPE;
  grant_row organization_user_resource_grants%%ROWTYPE;
BEGIN
  IF p_account_id IS NULL OR p_target_workspace_id IS NULL
    OR p_connection_id IS NULL OR nullif(btrim(p_subject_id), '') IS NULL
    OR nullif(current_setting('opengeni.account_id', true), '')::uuid
      IS DISTINCT FROM p_account_id
    OR nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      IS DISTINCT FROM p_target_workspace_id
    OR nullif(current_setting('opengeni.subject_id', true), '')
      IS DISTINCT FROM p_subject_id
    OR p_delegation ->> 'organizationId' IS DISTINCT FROM p_account_id::text
    OR p_delegation ->> 'workspaceId' IS DISTINCT FROM p_target_workspace_id::text
    OR p_delegation ->> 'action' IS DISTINCT FROM 'connection.use'
  THEN
    RAISE EXCEPTION 'personal connection authority selection context is invalid'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM workspaces workspace_value
  WHERE workspace_value.id = p_target_workspace_id
    AND workspace_value.account_id = p_account_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'connection authority target workspace is unavailable'
      USING ERRCODE = '42501';
  END IF;

  SELECT membership.* INTO STRICT membership_row
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_subject_id
    AND membership.status = 'active'
    AND membership.revoked_at IS NULL
  FOR SHARE;
  IF membership_row.personal_workspace_id IS DISTINCT FROM p_target_workspace_id
    AND NOT EXISTS (
      SELECT 1 FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = p_account_id
        AND workspace_membership.workspace_id = p_target_workspace_id
        AND workspace_membership.subject_id = p_subject_id
    )
  THEN
    RAISE EXCEPTION 'personal connection owner lacks target workspace access'
      USING ERRCODE = '42501';
  END IF;

  SELECT connection_value.* INTO STRICT connection_row
  FROM connections connection_value
  WHERE connection_value.id = p_connection_id
    AND connection_value.account_id = p_account_id
    AND connection_value.subject_id = p_subject_id
    AND connection_value.owner_organization_membership_id = membership_row.id
    AND connection_value.authority_scope = 'user'
    AND connection_value.status = 'active'
  FOR SHARE;

  SELECT authority.* INTO STRICT authority_row
  FROM organization_user_resource_authorities authority
  WHERE authority.id = nullif(p_delegation ->> 'authorityId', '')::uuid
    AND authority.account_id = p_account_id
    AND authority.organization_membership_id = membership_row.id
    AND authority.resource_kind = 'connection'
    AND authority.resource_id = connection_row.id
    AND authority.origin_workspace_id = connection_row.origin_workspace_id
    AND authority.generation = (p_delegation ->> 'authorityGeneration')::bigint
    AND authority.status = 'active'
    AND authority.revoked_at IS NULL
  FOR SHARE;
  IF connection_row.authority_id IS DISTINCT FROM authority_row.id THEN
    RAISE EXCEPTION 'personal connection authority selection is unavailable'
      USING ERRCODE = '42501';
  END IF;

  SELECT grant_value.* INTO STRICT grant_row
  FROM organization_user_resource_grants grant_value
  WHERE grant_value.id = nullif(p_delegation ->> 'grantId', '')::uuid
    AND grant_value.account_id = p_account_id
    AND grant_value.authority_id = authority_row.id
    AND grant_value.owner_organization_membership_id = membership_row.id
    AND grant_value.workspace_id = p_target_workspace_id
    AND grant_value.action = 'connection.use'
    AND grant_value.mode = p_delegation ->> 'mode'
    AND grant_value.context = p_delegation ->> 'context'
    AND grant_value.generation = (p_delegation ->> 'grantGeneration')::bigint
    AND grant_value.status = 'active'
    AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
    AND nullif(p_delegation ->> 'sessionId', '')::uuid
      IS NOT DISTINCT FROM grant_value.session_id
    AND nullif(p_delegation ->> 'authorityEpoch', '')::integer
      IS NOT DISTINCT FROM grant_value.authority_epoch
  FOR SHARE;

  origin_workspace_id := connection_row.origin_workspace_id;
  RETURN NEXT;
END
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.capture_accepted_turn_connection_authorities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = %1$I, pg_catalog, pg_temp
AS $body$
DECLARE
  session_row sessions%%ROWTYPE;
  item jsonb;
  delegation jsonb;
  connection_row connections%%ROWTYPE;
  membership_row organization_memberships%%ROWTYPE;
  authority_row organization_user_resource_authorities%%ROWTYPE;
  grant_row organization_user_resource_grants%%ROWTYPE;
  canonical jsonb;
  existing_digest bytea;
  existing_snapshot jsonb;
  initiating_subject text;
  verified_causal_subject text := coalesce(
    nullif(current_setting('opengeni.initiating_human_subject_id', true), ''),
    nullif(current_setting('opengeni.subject_id', true), '')
  );
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.personal_connection_delegations IS NOT DISTINCT FROM OLD.personal_connection_delegations
    THEN RETURN NEW;
    END IF;
    IF NEW.status <> 'queued' OR EXISTS (
      SELECT 1 FROM session_turn_attempts attempt
      WHERE attempt.turn_id = NEW.id AND attempt.workspace_id = NEW.workspace_id
    ) THEN
      RAISE EXCEPTION 'accepted connection authority cannot change after claim'
        USING ERRCODE = '42501';
    END IF;
    DELETE FROM turn_connection_authority_snapshots snapshot
    WHERE snapshot.turn_id = NEW.id AND snapshot.workspace_id = NEW.workspace_id;
  END IF;
  SELECT session_value.* INTO STRICT session_row
  FROM sessions session_value
  WHERE session_value.id = NEW.session_id
    AND session_value.account_id = NEW.account_id
    AND session_value.workspace_id = NEW.workspace_id
  FOR SHARE;
  initiating_subject := coalesce(
    nullif(btrim(NEW.initiating_human_subject_id), ''),
    CASE WHEN NEW.initiator_kind = 'subject'
      THEN nullif(btrim(NEW.initiator_subject_id), '') END
  );

  FOR item IN
    SELECT value FROM jsonb_array_elements(NEW.personal_connection_delegations)
  LOOP
    -- Social uses a distinct store. It is not activated here and must never
    -- smuggle the common connection-authority envelope past this boundary.
    IF item ->> 'connectionType' = 'social' THEN
      IF item -> 'userDelegation' IS NOT NULL THEN
        RAISE EXCEPTION 'social connection authority is not activated'
          USING ERRCODE = '42501';
      END IF;
      CONTINUE;
    END IF;
    IF nullif(item ->> 'serverId', '') IS NULL
      OR octet_length(item ->> 'serverId') > 256
      OR nullif(item ->> 'connectionId', '') IS NULL
    THEN
      RAISE EXCEPTION 'invalid accepted connection selection' USING ERRCODE = '22023';
    END IF;
    SELECT connection_value.* INTO connection_row
    FROM connections connection_value
    WHERE connection_value.id = (item ->> 'connectionId')::uuid
      AND connection_value.account_id = NEW.account_id
    FOR SHARE;

    -- First-party Atlassian remains a named successor. Legacy rows retain
    -- their bounded compatibility behavior, but a common `user` row cannot be
    -- relabeled to bypass snapshot, once, and causal-human admission.
    IF item ->> 'connectionType' = 'atlassian' THEN
      IF item -> 'userDelegation' IS NOT NULL
        OR (FOUND AND connection_row.authority_scope = 'user')
      THEN
        RAISE EXCEPTION 'Atlassian connection authority is not activated'
          USING ERRCODE = '42501';
      END IF;
      CONTINUE;
    END IF;

    IF NOT FOUND THEN
      IF item -> 'userDelegation' IS NULL THEN
        -- Bounded legacy rows are revalidated by the existing credential
        -- resolver. A missing historical row remains unavailable there; it
        -- must not make unrelated turn acceptance fail during the cutover.
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'accepted connection selection is unavailable'
        USING ERRCODE = '42501';
    END IF;

    IF connection_row.authority_scope = 'legacy_user' AND item -> 'userDelegation' IS NULL THEN
      CONTINUE;
    END IF;
    IF connection_row.authority_scope <> 'user' THEN
      RAISE EXCEPTION 'accepted personal connection scope is unavailable'
        USING ERRCODE = '42501';
    END IF;
    IF initiating_subject IS NULL OR connection_row.subject_id IS DISTINCT FROM initiating_subject
      OR connection_row.status <> 'active'
      OR lower(connection_row.provider_domain) IS DISTINCT FROM lower(item ->> 'providerDomain')
      OR (item ? 'kind' AND connection_row.kind IS DISTINCT FROM item ->> 'kind')
    THEN
      RAISE EXCEPTION 'accepted personal connection identity is unavailable'
        USING ERRCODE = '42501';
    END IF;
    delegation := item -> 'userDelegation';
    IF delegation IS NULL THEN
      RAISE EXCEPTION 'activated personal connection requires an explicit grant'
        USING ERRCODE = '42501';
    END IF;
    IF verified_causal_subject IS DISTINCT FROM initiating_subject THEN
      RAISE EXCEPTION 'accepted connection authority causal human is unverified'
        USING ERRCODE = '42501';
    END IF;

    SELECT membership.* INTO STRICT membership_row
    FROM organization_memberships membership
    WHERE membership.id = connection_row.owner_organization_membership_id
      AND membership.account_id = NEW.account_id
      AND membership.subject_id = initiating_subject
      AND membership.status = 'active'
      AND membership.revoked_at IS NULL
    FOR SHARE;
    IF membership_row.personal_workspace_id IS DISTINCT FROM NEW.workspace_id
      AND NOT EXISTS (
        SELECT 1 FROM workspace_memberships workspace_membership
        WHERE workspace_membership.account_id = NEW.account_id
          AND workspace_membership.workspace_id = NEW.workspace_id
          AND workspace_membership.subject_id = initiating_subject
      )
    THEN
      RAISE EXCEPTION 'personal connection owner lacks target workspace access'
        USING ERRCODE = '42501';
    END IF;

    SELECT authority.* INTO STRICT authority_row
    FROM organization_user_resource_authorities authority
    WHERE authority.id = nullif(delegation ->> 'authorityId', '')::uuid
      AND authority.account_id = NEW.account_id
      AND authority.organization_membership_id = membership_row.id
      AND authority.resource_kind = 'connection'
      AND authority.resource_id = connection_row.id
      AND authority.origin_workspace_id = connection_row.origin_workspace_id
      AND authority.generation = (delegation ->> 'authorityGeneration')::bigint
      AND authority.status = 'active'
      AND authority.revoked_at IS NULL
    FOR SHARE;

    SELECT grant_value.* INTO STRICT grant_row
    FROM organization_user_resource_grants grant_value
    WHERE grant_value.id = nullif(delegation ->> 'grantId', '')::uuid
      AND grant_value.account_id = NEW.account_id
      AND grant_value.authority_id = authority_row.id
      AND grant_value.owner_organization_membership_id = membership_row.id
      AND grant_value.workspace_id = NEW.workspace_id
      AND grant_value.action = 'connection.use'
      AND grant_value.mode = delegation ->> 'mode'
      AND grant_value.context = session_row.visibility
      AND grant_value.generation = (delegation ->> 'grantGeneration')::bigint
      AND grant_value.status IN ('active', 'consumed')
      AND (grant_value.expires_at IS NULL OR grant_value.expires_at > clock_timestamp())
      AND ((grant_value.mode = 'always' AND grant_value.session_id IS NULL
        AND grant_value.authority_epoch IS NULL)
        OR (grant_value.mode IN ('once', 'session')
          AND grant_value.session_id = NEW.session_id
          AND grant_value.authority_epoch = session_row.authority_epoch))
    FOR UPDATE;
    IF grant_row.mode = 'once' THEN
      IF grant_row.status = 'active' THEN
        UPDATE organization_user_resource_grants grant_value
        SET status = 'consumed', updated_at = clock_timestamp()
        WHERE grant_value.id = grant_row.id
          AND grant_value.account_id = NEW.account_id
          AND grant_value.generation = grant_row.generation
          AND grant_value.status = 'active';
        IF NOT FOUND THEN
          RAISE EXCEPTION 'connection use grant is no longer admissible'
            USING ERRCODE = '42501';
        END IF;
        INSERT INTO connection_use_once_consumption_receipts (
          grant_id, account_id, authority_id, authority_generation,
          grant_generation, accepted_work_kind, accepted_work_id
        ) VALUES (
          grant_row.id, NEW.account_id, authority_row.id,
          authority_row.generation, grant_row.generation, 'turn', NEW.id
        ) ON CONFLICT (grant_id) DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'connection use grant is already bound to other work'
            USING ERRCODE = '42501';
        END IF;
        grant_row.status := 'consumed';
      ELSIF grant_row.status <> 'consumed' OR NOT EXISTS (
        SELECT 1 FROM connection_use_once_consumption_receipts receipt
        WHERE receipt.grant_id = grant_row.id
          AND receipt.accepted_work_kind = 'turn'
          AND receipt.accepted_work_id = NEW.id
      ) THEN
        RAISE EXCEPTION 'connection use grant is no longer admissible'
          USING ERRCODE = '42501';
      END IF;
    ELSIF grant_row.status <> 'active' THEN
      RAISE EXCEPTION 'connection use grant is no longer admissible' USING ERRCODE = '42501';
    END IF;
    IF delegation ->> 'organizationId' IS DISTINCT FROM NEW.account_id::text
      OR delegation ->> 'workspaceId' IS DISTINCT FROM NEW.workspace_id::text
      OR delegation ->> 'action' IS DISTINCT FROM 'connection.use'
      OR delegation ->> 'context' IS DISTINCT FROM session_row.visibility
      OR nullif(delegation ->> 'sessionId', '')::uuid IS DISTINCT FROM grant_row.session_id
      OR nullif(delegation ->> 'authorityEpoch', '')::integer
        IS DISTINCT FROM grant_row.authority_epoch
    THEN
      RAISE EXCEPTION 'accepted connection grant metadata is contradictory'
        USING ERRCODE = '42501';
    END IF;
    IF nullif(item ->> 'originWorkspaceId', '')::uuid
      IS DISTINCT FROM connection_row.origin_workspace_id
    THEN
      RAISE EXCEPTION 'accepted connection origin is not server-resolved'
        USING ERRCODE = '42501';
    END IF;

    canonical := jsonb_build_object(
      'organizationId', NEW.account_id,
      'originWorkspaceId', connection_row.origin_workspace_id,
      'targetWorkspaceId', NEW.workspace_id,
      'targetSessionId', NEW.session_id,
      'targetSessionVisibility', session_row.visibility,
      'targetSessionAuthorityEpoch', session_row.authority_epoch,
      'acceptedWork', jsonb_build_object('kind', 'turn', 'turnId', NEW.id),
      'connectionId', connection_row.id,
      'connectionGeneration', connection_row.authority_generation,
      'connectionStatus', 'active',
      'providerDomain', lower(connection_row.provider_domain),
      'connectionKind', connection_row.kind,
      'scope', 'user',
      'ownerSubjectId', initiating_subject,
      'ownerOrganizationMembershipId', membership_row.id,
      'ownerMembershipAuthorizationRevision', membership_row.authorization_revision,
      'authoritySource', 'user_delegation',
      'selectionSources', jsonb_build_array('mcp:' || (item ->> 'serverId')),
      'userDelegation', jsonb_build_object(
        'organizationId', NEW.account_id,
        'authorityId', authority_row.id,
        'authorityGeneration', authority_row.generation,
        'workspaceId', NEW.workspace_id,
        'sessionId', grant_row.session_id,
        'action', 'connection.use',
        'mode', grant_row.mode,
        'context', grant_row.context,
        'authorityEpoch', grant_row.authority_epoch,
        'grantId', grant_row.id,
        'grantGeneration', grant_row.generation
      )
    );

    SELECT snapshot.snapshot_digest, snapshot.canonical_snapshot
    INTO existing_digest, existing_snapshot
    FROM turn_connection_authority_snapshots snapshot
    WHERE snapshot.turn_id = NEW.id AND snapshot.server_id = item ->> 'serverId';
    IF FOUND THEN
      IF existing_snapshot IS DISTINCT FROM canonical
        OR existing_digest IS DISTINCT FROM digest(convert_to(canonical::text, 'UTF8'), 'sha256')
      THEN
        RAISE EXCEPTION 'accepted connection authority changed across recovery'
          USING ERRCODE = '42501';
      END IF;
      CONTINUE;
    END IF;

    INSERT INTO turn_connection_authority_snapshots (
      account_id, workspace_id, session_id, turn_id, server_id,
      connection_id, connection_generation, origin_workspace_id,
      provider_domain, connection_kind, authority_scope, authority_source, owner_subject_id,
      owner_organization_membership_id, membership_authorization_revision,
      authority_id, authority_generation, grant_id, grant_generation,
      grant_mode, grant_context, grant_session_id, grant_authority_epoch,
      session_visibility, session_authority_epoch, canonical_snapshot, snapshot_digest
    ) VALUES (
      NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.id, item ->> 'serverId',
      connection_row.id, connection_row.authority_generation,
      connection_row.origin_workspace_id, lower(connection_row.provider_domain),
      connection_row.kind, 'user', 'user_delegation', initiating_subject, membership_row.id,
      membership_row.authorization_revision, authority_row.id, authority_row.generation,
      grant_row.id, grant_row.generation, grant_row.mode, grant_row.context,
      grant_row.session_id, grant_row.authority_epoch,
      session_row.visibility, session_row.authority_epoch, canonical,
      digest(convert_to(canonical::text, 'UTF8'), 'sha256')
    );
  END LOOP;
  RETURN NEW;
END
$body$
$ddl$, data_schema);

EXECUTE format($ddl$
CREATE TRIGGER accepted_turn_connection_authority_capture
  AFTER INSERT OR UPDATE OF personal_connection_delegations ON %1$I.session_turns
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_accepted_turn_connection_authorities()
$ddl$, data_schema);

-- Keep the 0256 ABI only for the bounded workspace/legacy compatibility lane.
-- A drained old worker that tries to execute an activated common-user snapshot
-- is denied even though the function signature still exists.
EXECUTE format(
  'ALTER FUNCTION %I.resolve_connection_use_authority(uuid, uuid, uuid, jsonb) '
    || 'RENAME TO resolve_connection_use_authority_legacy_0256',
  data_schema
);
EXECUTE format($ddl$
CREATE FUNCTION %1$I.resolve_connection_use_authority(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_snapshot jsonb
) RETURNS TABLE (
  authorization_status text, denial_reason text, connection_id uuid,
  connection_generation bigint, authority_scope text, owner_subject_id text,
  authority_id uuid, grant_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = %1$I, pg_catalog, pg_temp
AS $body$
BEGIN
  IF p_snapshot ->> 'scope' = 'user' THEN
    authorization_status := 'denied';
    denial_reason := 'accepted_attempt_authority_required';
    RETURN NEXT; RETURN;
  END IF;
  RETURN QUERY SELECT * FROM resolve_connection_use_authority_legacy_0256(
    p_account_id, p_workspace_id, p_session_id, p_snapshot
  );
END
$body$
$ddl$, data_schema);

EXECUTE format($ddl$
CREATE OR REPLACE FUNCTION %1$I.resolve_accepted_connection_use(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_physical_request_id uuid,
  p_use_phase text,
  p_server_id text,
  p_connection_id uuid,
  p_provider_domain text,
  p_connection_kind text,
  p_subject_scope text,
  p_owner_subject_id text DEFAULT NULL
) RETURNS TABLE (
  authorization_status text,
  denial_reason text,
  resolved_connection_id uuid,
  connection_generation bigint,
  origin_workspace_id uuid,
  resolved_connection_kind text,
  authority_scope text,
  owner_subject_id text,
  authority_id uuid,
  grant_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = %1$I, pg_catalog, pg_temp
AS $body$
#variable_conflict use_column
DECLARE
  prior connection_use_audit_facts%%ROWTYPE;
  connection_row connections%%ROWTYPE;
  snapshot turn_connection_authority_snapshots%%ROWTYPE;
  session_row sessions%%ROWTYPE;
  grant_row organization_user_resource_grants%%ROWTYPE;
  request_digest bytea;
  has_prior boolean := false;
  reason text;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    OR p_execution_generation <= 0
    OR p_use_phase NOT IN ('credential_resolution', 'provider_request')
    OR nullif(btrim(p_server_id), '') IS NULL
    OR octet_length(p_server_id) > 256
  THEN
    RAISE EXCEPTION 'connection use scope mismatch' USING ERRCODE = '42501';
  END IF;
  request_digest := digest(convert_to(jsonb_build_object(
    'accountId', p_account_id, 'workspaceId', p_workspace_id,
    'sessionId', p_session_id, 'turnId', p_turn_id, 'attemptId', p_attempt_id,
    'executionGeneration', p_execution_generation, 'usePhase', p_use_phase,
    'serverId', p_server_id,
    'connectionId', p_connection_id, 'providerDomain', lower(p_provider_domain),
    'connectionKind', p_connection_kind, 'subjectScope', p_subject_scope,
    'ownerSubjectId', p_owner_subject_id
  )::text, 'UTF8'), 'sha256');

  -- Match the canonical lifecycle lock prefix before inspecting mutable
  -- attempt authority: control -> workspace -> session -> turn -> attempt.
  PERFORM 1 FROM workspace_inference_controls control_row
  WHERE control_row.account_id = p_account_id
    AND control_row.workspace_id = p_workspace_id
  FOR SHARE;
  IF NOT FOUND THEN reason := 'session_identity_changed'; END IF;
  IF reason IS NULL THEN
    PERFORM 1 FROM workspaces workspace_value
    WHERE workspace_value.account_id = p_account_id AND workspace_value.id = p_workspace_id
    FOR KEY SHARE;
    IF NOT FOUND THEN reason := 'session_identity_changed'; END IF;
  END IF;
  IF reason IS NULL THEN
    SELECT session_value.* INTO session_row FROM sessions session_value
    WHERE session_value.id = p_session_id
      AND session_value.account_id = p_account_id
      AND session_value.workspace_id = p_workspace_id
    FOR NO KEY UPDATE;
    IF NOT FOUND OR session_row.active_turn_id IS DISTINCT FROM p_turn_id
      OR session_row.status = 'cancelled'
    THEN reason := 'session_identity_changed'; END IF;
  END IF;
  IF reason IS NULL THEN
    PERFORM 1 FROM session_turns turn_value
    WHERE turn_value.id = p_turn_id
      AND turn_value.account_id = p_account_id
      AND turn_value.workspace_id = p_workspace_id
      AND turn_value.session_id = p_session_id
      AND turn_value.active_attempt_id = p_attempt_id
      AND turn_value.execution_generation = p_execution_generation
      AND turn_value.status = 'running'
    FOR UPDATE;
    IF NOT FOUND THEN reason := 'session_identity_changed'; END IF;
  END IF;
  IF reason IS NULL THEN
    PERFORM 1 FROM session_turn_attempts attempt
    WHERE attempt.id = p_attempt_id
      AND attempt.account_id = p_account_id
      AND attempt.workspace_id = p_workspace_id
      AND attempt.session_id = p_session_id
      AND attempt.turn_id = p_turn_id
      AND attempt.execution_generation = p_execution_generation
      AND attempt.state IN ('claimed', 'running')
      AND attempt.closed_at IS NULL AND attempt.quiesced_at IS NULL
      AND attempt.authority_visibility = session_row.visibility
      AND attempt.authority_epoch = session_row.authority_epoch
      AND attempt.authority_owner_organization_membership_id
        IS NOT DISTINCT FROM session_row.owner_organization_membership_id
    FOR UPDATE;
    IF NOT FOUND OR EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.account_id = p_account_id
        AND interruption.workspace_id = p_workspace_id
        AND interruption.session_id = p_session_id
        AND interruption.attempt_id = p_attempt_id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    ) THEN reason := 'session_identity_changed'; END IF;
  END IF;

  -- Serialize and verify one caller-preallocated physical request identity
  -- after the canonical lifecycle locks even when those live fences now deny.
  -- A stale attempt cannot use that denial to hide conflicting UUID reuse.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_physical_request_id::text, 0));
  SELECT EXISTS (
    SELECT 1 FROM connection_use_audit_facts audit
    WHERE audit.physical_request_id = p_physical_request_id
  ) INTO has_prior;
  IF has_prior THEN
    SELECT audit.* INTO STRICT prior FROM connection_use_audit_facts audit
    WHERE audit.physical_request_id = p_physical_request_id;
  END IF;
  IF has_prior AND prior.request_digest IS DISTINCT FROM request_digest THEN
    RAISE EXCEPTION 'physical connection request id was reused for different work'
      USING ERRCODE = '23505';
  END IF;
  IF reason IS NULL AND has_prior AND prior.outcome = 'denied' THEN
    authorization_status := prior.outcome;
    denial_reason := prior.denial_reason;
    RETURN NEXT; RETURN;
  END IF;

  IF reason IS NULL THEN
    SELECT authority_snapshot.* INTO snapshot
    FROM turn_connection_authority_snapshots authority_snapshot
    WHERE authority_snapshot.turn_id = p_turn_id
      AND authority_snapshot.server_id = p_server_id
      AND authority_snapshot.account_id = p_account_id
      AND authority_snapshot.workspace_id = p_workspace_id
      AND authority_snapshot.session_id = p_session_id;

    IF FOUND THEN
      SELECT connection_value.* INTO connection_row FROM connections connection_value
      WHERE connection_value.id = snapshot.connection_id
        AND connection_value.account_id = p_account_id;
      IF snapshot.snapshot_digest IS DISTINCT FROM digest(
        convert_to(snapshot.canonical_snapshot::text, 'UTF8'), 'sha256'
      ) THEN reason := 'accepted_snapshot_digest_changed';
      ELSIF NOT FOUND THEN reason := 'connection_missing';
      ELSIF snapshot.authority_scope IS DISTINCT FROM 'user'
        OR p_subject_scope IS DISTINCT FROM 'subject'
        OR p_connection_id IS DISTINCT FROM snapshot.connection_id
        OR lower(p_provider_domain) IS DISTINCT FROM snapshot.provider_domain
        OR (p_connection_kind IS NOT NULL AND p_connection_kind IS DISTINCT FROM snapshot.connection_kind)
      THEN reason := 'connection_identity_changed';
      ELSIF connection_row.status <> 'active' THEN reason := 'connection_status_inactive';
      ELSIF connection_row.authority_scope IS DISTINCT FROM 'user'
        OR connection_row.subject_id IS DISTINCT FROM snapshot.owner_subject_id
        OR connection_row.owner_organization_membership_id
          IS DISTINCT FROM snapshot.owner_organization_membership_id
        OR connection_row.origin_workspace_id IS DISTINCT FROM snapshot.origin_workspace_id
      THEN reason := 'connection_owner_changed';
      ELSIF connection_row.authority_generation IS DISTINCT FROM snapshot.connection_generation
      THEN reason := 'connection_generation_changed';
      ELSIF session_row.visibility IS DISTINCT FROM snapshot.session_visibility
        OR session_row.authority_epoch IS DISTINCT FROM snapshot.session_authority_epoch
      THEN reason := 'session_authority_epoch_changed';
      ELSIF NOT EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = snapshot.owner_organization_membership_id
          AND membership.account_id = p_account_id
          AND membership.subject_id = snapshot.owner_subject_id
          AND membership.status = 'active' AND membership.revoked_at IS NULL
          AND membership.authorization_revision = snapshot.membership_authorization_revision
          AND (membership.personal_workspace_id = p_workspace_id OR EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = p_account_id
              AND workspace_membership.workspace_id = p_workspace_id
              AND workspace_membership.subject_id = snapshot.owner_subject_id
          ))
      ) THEN reason := 'owner_membership_inactive';
      ELSIF NOT EXISTS (
        SELECT 1 FROM organization_user_resource_authorities authority
        WHERE authority.id = snapshot.authority_id
          AND authority.account_id = p_account_id
          AND authority.organization_membership_id = snapshot.owner_organization_membership_id
          AND authority.resource_kind = 'connection'
          AND authority.resource_id = snapshot.connection_id
          AND authority.origin_workspace_id = snapshot.origin_workspace_id
          AND authority.generation = snapshot.authority_generation
          AND authority.status = 'active' AND authority.revoked_at IS NULL
      ) THEN reason := 'authority_status_inactive';
      ELSE
        SELECT grant_value.* INTO grant_row
        FROM organization_user_resource_grants grant_value
        WHERE grant_value.id = snapshot.grant_id
          AND grant_value.account_id = p_account_id
        FOR UPDATE;
        IF NOT FOUND THEN reason := 'grant_missing';
        ELSIF grant_row.authority_id IS DISTINCT FROM snapshot.authority_id
          OR grant_row.owner_organization_membership_id
            IS DISTINCT FROM snapshot.owner_organization_membership_id
          OR grant_row.workspace_id IS DISTINCT FROM p_workspace_id
          OR grant_row.action <> 'connection.use'
          OR grant_row.mode IS DISTINCT FROM snapshot.grant_mode
          OR grant_row.context IS DISTINCT FROM snapshot.grant_context
          OR grant_row.session_id IS DISTINCT FROM snapshot.grant_session_id
          OR grant_row.authority_epoch IS DISTINCT FROM snapshot.grant_authority_epoch
        THEN reason := 'grant_identity_changed';
        ELSIF grant_row.generation IS DISTINCT FROM snapshot.grant_generation
        THEN reason := 'grant_generation_changed';
        ELSIF grant_row.expires_at IS NOT NULL AND grant_row.expires_at <= clock_timestamp()
        THEN reason := 'grant_expired';
        ELSIF grant_row.mode = 'once' THEN
          IF grant_row.status <> 'consumed' OR NOT EXISTS (
            SELECT 1 FROM connection_use_once_consumption_receipts receipt
            WHERE receipt.grant_id = grant_row.id
              AND receipt.accepted_work_kind = 'turn'
              AND receipt.accepted_work_id = p_turn_id
              AND receipt.authority_id = snapshot.authority_id
              AND receipt.authority_generation = snapshot.authority_generation
              AND receipt.grant_generation = snapshot.grant_generation
          ) THEN reason := 'grant_already_consumed';
          END IF;
        ELSIF grant_row.status <> 'active' THEN reason := 'grant_status_inactive';
        END IF;
      END IF;
      resolved_connection_id := snapshot.connection_id;
      connection_generation := snapshot.connection_generation;
      origin_workspace_id := snapshot.origin_workspace_id;
      resolved_connection_kind := snapshot.connection_kind;
      authority_scope := snapshot.authority_scope;
      owner_subject_id := snapshot.owner_subject_id;
      authority_id := snapshot.authority_id;
      grant_id := snapshot.grant_id;
    ELSE
      -- A true pre-tenancy legacy_user row has no common authority/grant to
      -- snapshot. It may use only the exact connection frozen on the turn and
      -- still receives the exact live-attempt, destination, generation, and
      -- per-request audit fences above. Common `user` rows never enter this
      -- compatibility lane: already-accepted pre-cutover work therefore fails
      -- closed instead of falling back to its owner tuple.
      SELECT connection_value.* INTO connection_row FROM connections connection_value
      WHERE connection_value.id = p_connection_id
        AND connection_value.account_id = p_account_id;
      IF NOT FOUND THEN reason := 'connection_missing';
      ELSIF connection_row.authority_scope IS DISTINCT FROM 'legacy_user'
        OR p_subject_scope IS DISTINCT FROM 'subject'
        OR p_owner_subject_id IS NULL
        OR connection_row.subject_id IS DISTINCT FROM p_owner_subject_id
        OR connection_row.workspace_id IS DISTINCT FROM p_workspace_id
        OR connection_row.origin_workspace_id IS DISTINCT FROM p_workspace_id
        OR lower(connection_row.provider_domain) IS DISTINCT FROM lower(p_provider_domain)
        OR (p_connection_kind IS NOT NULL
          AND connection_row.kind IS DISTINCT FROM p_connection_kind)
      THEN reason := 'connection_identity_changed';
      ELSIF connection_row.status <> 'active' THEN reason := 'connection_status_inactive';
      ELSE
        resolved_connection_id := connection_row.id;
        connection_generation := connection_row.authority_generation;
        origin_workspace_id := connection_row.origin_workspace_id;
        resolved_connection_kind := connection_row.kind;
        authority_scope := 'legacy_user';
        owner_subject_id := connection_row.subject_id;
      END IF;
    END IF;
  END IF;

  authorization_status := CASE WHEN reason IS NULL THEN 'authorized' ELSE 'denied' END;
  denial_reason := reason;
  IF NOT has_prior THEN
    INSERT INTO connection_use_audit_facts (
    physical_request_id, use_phase, request_digest, account_id, workspace_id, session_id, turn_id,
    attempt_id, execution_generation, server_id, connection_id,
    connection_generation, authority_scope, owner_subject_id, authority_id,
    grant_id, outcome, denial_reason
  ) VALUES (
    p_physical_request_id, p_use_phase, request_digest,
    p_account_id, p_workspace_id, p_session_id, p_turn_id,
    p_attempt_id, p_execution_generation, p_server_id, resolved_connection_id,
    connection_generation, authority_scope, owner_subject_id, authority_id,
    grant_id, authorization_status, denial_reason
  ) ON CONFLICT (physical_request_id) DO NOTHING;
  END IF;
  RETURN NEXT;
END
$body$
$ddl$, data_schema);
END
$connection_authority_runtime$;

REVOKE ALL ON FUNCTION opengeni_private.capture_accepted_turn_connection_authorities() FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_connection_use_authority_legacy_0256(
  uuid, uuid, uuid, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_connection_use_authority(uuid, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_personal_connection_authority_selection(
  uuid, uuid, text, uuid, jsonb
) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_accepted_connection_use(
  uuid, uuid, uuid, uuid, uuid, integer, uuid, text, text, uuid, text, text, text, text
) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON FUNCTION resolve_connection_use_authority_legacy_0256(
      uuid, uuid, uuid, jsonb
    ) FROM opengeni_app;
    GRANT EXECUTE ON FUNCTION resolve_connection_use_authority(
      uuid, uuid, uuid, jsonb
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION resolve_personal_connection_authority_selection(
      uuid, uuid, text, uuid, jsonb
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION resolve_accepted_connection_use(
      uuid, uuid, uuid, uuid, uuid, integer, uuid, text, text, uuid, text, text, text, text
    ) TO opengeni_app;
    REVOKE ALL ON TABLE turn_connection_authority_snapshots FROM opengeni_app;
    REVOKE ALL ON TABLE connection_use_audit_facts FROM opengeni_app;
  END IF;
END
$grants$;

COMMENT ON TABLE "turn_connection_authority_snapshots" IS
  'Canonical credential-free connection authority frozen for one accepted logical turn; runtime access is only through exact-attempt SECURITY DEFINER resolution.';
COMMENT ON TABLE "connection_use_audit_facts" IS
  'Idempotent metadata-only facts for physical connection requests; contains no token, header, provider payload, response, quota, or usage value.';

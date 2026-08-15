-- deployment-mode: rolling
-- Activate explicit workspace and organization+user authority for provider
-- connections. Credential material remains in connections. This migration owns
-- only metadata authority, immutable generations, grants, and pre-use fencing.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "connections"
  ADD COLUMN "authority_scope" text NOT NULL DEFAULT 'workspace',
  ADD COLUMN "authority_id" uuid,
  ADD COLUMN "owner_organization_membership_id" uuid,
  ADD COLUMN "origin_workspace_id" uuid,
  ADD COLUMN "authority_generation" bigint NOT NULL DEFAULT 1;

UPDATE "connections"
SET "origin_workspace_id" = "workspace_id"
WHERE "origin_workspace_id" IS NULL;

DO $backfill_personal_connection_authority$
DECLARE
  connection_row record;
  membership_id uuid;
  authority_value uuid;
BEGIN
  FOR connection_row IN
    SELECT connection_value.id, connection_value.account_id,
      connection_value.workspace_id, connection_value.subject_id
    FROM connections connection_value
    WHERE connection_value.subject_id IS NOT NULL
    ORDER BY connection_value.account_id, connection_value.id
    FOR UPDATE
  LOOP
    SELECT membership.id INTO membership_id
    FROM organization_memberships membership
    WHERE membership.account_id = connection_row.account_id
      AND membership.subject_id = connection_row.subject_id
      AND membership.status = 'active'
      AND membership.revoked_at IS NULL;

    IF membership_id IS NULL THEN
      UPDATE connections
      SET authority_scope = 'legacy_user', authority_id = NULL,
        owner_organization_membership_id = NULL,
        origin_workspace_id = connection_row.workspace_id,
        authority_generation = 1
      WHERE id = connection_row.id;
      CONTINUE;
    END IF;

    authority_value := pg_catalog.gen_random_uuid();
    INSERT INTO organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id,
      origin_workspace_id, generation, status
    ) VALUES (
      authority_value, connection_row.account_id, membership_id, 'connection',
      connection_row.id, connection_row.workspace_id, 1, 'active'
    );

    UPDATE connections
    SET authority_scope = 'user', authority_id = authority_value,
      owner_organization_membership_id = membership_id,
      origin_workspace_id = connection_row.workspace_id,
      authority_generation = 1
    WHERE id = connection_row.id;
  END LOOP;
END
$backfill_personal_connection_authority$;

ALTER TABLE "connections"
  ADD CONSTRAINT "connections_authority_scope_check"
    CHECK ("authority_scope" IN ('workspace', 'user', 'legacy_user')) NOT VALID,
  ADD CONSTRAINT "connections_authority_shape_check" CHECK (
    (
      "authority_scope" = 'workspace'
      AND "subject_id" IS NULL
      AND "authority_id" IS NULL
      AND "owner_organization_membership_id" IS NULL
      AND "origin_workspace_id" = "workspace_id"
    ) OR (
      "authority_scope" = 'user'
      AND "subject_id" IS NOT NULL
      AND "authority_id" IS NOT NULL
      AND "owner_organization_membership_id" IS NOT NULL
      AND "origin_workspace_id" IS NOT NULL
    ) OR (
      "authority_scope" = 'legacy_user'
      AND "subject_id" IS NOT NULL
      AND "authority_id" IS NULL
      AND "owner_organization_membership_id" IS NULL
      AND "origin_workspace_id" IS NOT NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT "connections_authority_generation_check"
    CHECK ("authority_generation" > 0) NOT VALID,
  ADD CONSTRAINT "connections_authority_fk" FOREIGN KEY (
    "authority_id", "account_id", "owner_organization_membership_id"
  ) REFERENCES "organization_user_resource_authorities"(
    "id", "account_id", "organization_membership_id"
  ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "connections_origin_workspace_fk" FOREIGN KEY (
    "origin_workspace_id", "account_id"
  ) REFERENCES "workspaces"("id", "account_id")
    ON DELETE SET NULL ("origin_workspace_id") NOT VALID;

ALTER TABLE "connections"
  VALIDATE CONSTRAINT "connections_authority_scope_check",
  VALIDATE CONSTRAINT "connections_authority_shape_check",
  VALIDATE CONSTRAINT "connections_authority_generation_check",
  VALIDATE CONSTRAINT "connections_authority_fk",
  VALIDATE CONSTRAINT "connections_origin_workspace_fk";

CREATE UNIQUE INDEX "connections_authority_identity_uq"
  ON "connections" ("account_id", "authority_id")
  WHERE "authority_id" IS NOT NULL;
CREATE INDEX "connections_owner_authority_idx"
  ON "connections" (
    "account_id", "owner_organization_membership_id", "status", "updated_at", "id"
  ) WHERE "authority_scope" = 'user';

CREATE TABLE "connection_use_once_consumption_receipts" (
  "grant_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "authority_id" uuid NOT NULL,
  "authority_generation" bigint NOT NULL,
  "grant_generation" bigint NOT NULL,
  "accepted_work_kind" text NOT NULL,
  "accepted_work_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "connection_once_receipts_authority_fk" FOREIGN KEY (
    "authority_id", "account_id"
  ) REFERENCES "organization_user_resource_authorities"("id", "account_id")
    ON DELETE CASCADE,
  CONSTRAINT "connection_once_receipts_grant_fk" FOREIGN KEY (
    "grant_id", "account_id"
  ) REFERENCES "organization_user_resource_grants"("id", "account_id")
    ON DELETE CASCADE,
  CONSTRAINT "connection_once_receipts_generation_check" CHECK (
    "authority_generation" > 0 AND "grant_generation" > 0
  ),
  CONSTRAINT "connection_once_receipts_work_kind_check" CHECK (
    "accepted_work_kind" IN ('turn', 'scheduled_task')
  )
);

ALTER TABLE "connection_use_once_consumption_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connection_use_once_consumption_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organization_isolation" ON "connection_use_once_consumption_receipts"
  USING (
    account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
  ) WITH CHECK (
    account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
  );

DO $connection_authority_routines$
DECLARE
  data_schema text := current_schema();
BEGIN
EXECUTE format($ddl$
CREATE OR REPLACE FUNCTION opengeni_private.bind_connection_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = %1$I, pg_catalog, pg_temp
AS $body$
DECLARE
  caller_subject text := nullif(current_setting('opengeni.subject_id', true), '');
  membership_id uuid;
  authority_value uuid;
  identity_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.origin_workspace_id := NEW.workspace_id;
    NEW.authority_generation := 1;
    IF NEW.subject_id IS NULL THEN
      NEW.authority_scope := 'workspace';
      NEW.authority_id := NULL;
      NEW.owner_organization_membership_id := NULL;
      RETURN NEW;
    END IF;
    IF caller_subject IS DISTINCT FROM NEW.subject_id THEN
      RAISE EXCEPTION 'personal connection owner must be the authenticated subject'
        USING ERRCODE = '42501';
    END IF;
    SELECT membership.id INTO membership_id
    FROM organization_memberships membership
    WHERE membership.account_id = NEW.account_id
      AND membership.subject_id = caller_subject
      AND membership.status = 'active'
      AND membership.revoked_at IS NULL
    FOR SHARE;
    IF membership_id IS NULL THEN
      NEW.authority_scope := 'legacy_user';
      NEW.authority_id := NULL;
      NEW.owner_organization_membership_id := NULL;
      RETURN NEW;
    END IF;
    authority_value := gen_random_uuid();
    INSERT INTO organization_user_resource_authorities (
      id, account_id, organization_membership_id, resource_kind, resource_id,
      origin_workspace_id, generation, status
    ) VALUES (
      authority_value, NEW.account_id, membership_id, 'connection', NEW.id,
      NEW.workspace_id, 1, 'active'
    );
    NEW.authority_scope := 'user';
    NEW.authority_id := authority_value;
    NEW.owner_organization_membership_id := membership_id;
    RETURN NEW;
  END IF;

  IF NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
    OR NEW.authority_scope IS DISTINCT FROM OLD.authority_scope
    OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
    OR NEW.owner_organization_membership_id
      IS DISTINCT FROM OLD.owner_organization_membership_id
    OR NEW.origin_workspace_id IS DISTINCT FROM OLD.origin_workspace_id
  THEN
    RAISE EXCEPTION 'connection owner authority is immutable' USING ERRCODE = '23514';
  END IF;

  identity_changed := NEW.provider_domain IS DISTINCT FROM OLD.provider_domain
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.status IS DISTINCT FROM OLD.status;
  IF identity_changed THEN
    NEW.authority_generation := OLD.authority_generation + 1;
  ELSIF NEW.authority_generation NOT IN (
    OLD.authority_generation, OLD.authority_generation + 1
  ) THEN
    RAISE EXCEPTION 'connection authority generation must be stable or advance once'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$body$
$ddl$, data_schema);

EXECUTE format($ddl$
CREATE TRIGGER connections_authority_binding
  BEFORE INSERT OR UPDATE ON %1$I.connections
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.bind_connection_authority()
$ddl$, data_schema);

EXECUTE format($ddl$
CREATE OR REPLACE FUNCTION %1$I.list_self_connection_authorities(
  p_account_id uuid
) RETURNS TABLE (
  authority_id uuid, authority_generation bigint, authority_status text,
  grant_id uuid, target_workspace_id uuid, target_session_id uuid,
  grant_mode text, grant_context text, grant_generation bigint,
  grant_status text, expires_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = %1$I, pg_catalog, pg_temp
AS $body$
  SELECT authority.authority_id, authority.authority_generation,
    authority.authority_status, authority.grant_id,
    authority.target_workspace_id, authority.target_session_id,
    authority.grant_mode, authority.grant_context,
    authority.grant_generation, authority.grant_status, authority.expires_at
  FROM list_self_user_resource_authorities(p_account_id) authority
  WHERE authority.resource_kind = 'connection'
    AND (authority.grant_id IS NULL OR authority.action = 'connection.use')
$body$
$ddl$, data_schema);

EXECUTE format($ddl$
CREATE OR REPLACE FUNCTION %1$I.issue_self_connection_use_grant(
  p_account_id uuid,
  p_authority_id uuid,
  p_workspace_id uuid,
  p_mode text,
  p_context text,
  p_session_id uuid DEFAULT NULL,
  p_workspace_shared_acknowledged boolean DEFAULT false
) RETURNS TABLE (
  grant_id uuid, target_workspace_id uuid, target_session_id uuid,
  action text, grant_mode text, grant_context text, grant_generation bigint,
  grant_status text, expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = %1$I, pg_catalog, pg_temp
AS $body$
BEGIN
  PERFORM 1
  FROM organization_user_resource_authorities authority
  WHERE authority.id = p_authority_id
    AND authority.account_id = p_account_id
    AND authority.resource_kind = 'connection';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'self-owned connection authority required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM issue_self_user_resource_grant(
    p_account_id, p_authority_id, p_workspace_id, 'connection.use', p_mode,
    p_context, p_session_id, p_workspace_shared_acknowledged
  );
END
$body$
$ddl$, data_schema);

EXECUTE format($ddl$
CREATE OR REPLACE FUNCTION %1$I.revoke_self_connection_use_grant(
  p_account_id uuid,
  p_grant_id uuid
) RETURNS TABLE (
  grant_id uuid, grant_generation bigint, grant_status text, revoked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = %1$I, pg_catalog, pg_temp
AS $body$
BEGIN
  PERFORM 1
  FROM organization_user_resource_grants grant_value
  JOIN organization_user_resource_authorities authority
    ON authority.id = grant_value.authority_id
   AND authority.account_id = grant_value.account_id
  WHERE grant_value.id = p_grant_id
    AND grant_value.account_id = p_account_id
    AND grant_value.action = 'connection.use'
    AND authority.resource_kind = 'connection';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'self-owned connection use grant required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM revoke_self_user_resource_grant(p_account_id, p_grant_id);
END
$body$
$ddl$, data_schema);

EXECUTE format($ddl$
CREATE OR REPLACE FUNCTION %1$I.resolve_connection_use_authority(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_snapshot jsonb
) RETURNS TABLE (
  authorization_status text,
  denial_reason text,
  connection_id uuid,
  connection_generation bigint,
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
  session_row record;
  connection_row record;
  membership_row record;
  authority_row record;
  grant_row record;
  receipt_row record;
  accepted_kind text := p_snapshot #>> '{acceptedWork,kind}';
  accepted_id uuid := coalesce(
    nullif(p_snapshot #>> '{acceptedWork,turnId}', '')::uuid,
    nullif(p_snapshot #>> '{acceptedWork,taskId}', '')::uuid
  );
  snapshot_scope text := p_snapshot ->> 'scope';
  snapshot_owner text := nullif(p_snapshot ->> 'ownerSubjectId', '');
  snapshot_membership uuid := nullif(
    p_snapshot ->> 'ownerOrganizationMembershipId', ''
  )::uuid;
  snapshot_authority uuid := nullif(
    p_snapshot #>> '{userDelegation,authorityId}', ''
  )::uuid;
  snapshot_grant uuid := nullif(p_snapshot #>> '{userDelegation,grantId}', '')::uuid;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
    OR p_snapshot ->> 'organizationId' IS DISTINCT FROM p_account_id::text
    OR p_snapshot ->> 'targetWorkspaceId' IS DISTINCT FROM p_workspace_id::text
    OR p_snapshot ->> 'targetSessionId' IS DISTINCT FROM p_session_id::text
  THEN
    RAISE EXCEPTION 'connection use scope mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT session_value.id, session_value.account_id, session_value.workspace_id,
    session_value.visibility, session_value.authority_epoch, session_value.status
  INTO session_row
  FROM sessions session_value
  WHERE session_value.id = p_session_id
    AND session_value.account_id = p_account_id
    AND session_value.workspace_id = p_workspace_id;
  IF NOT FOUND OR session_row.status = 'cancelled' THEN
    authorization_status := 'denied'; denial_reason := 'session_inactive';
    RETURN NEXT; RETURN;
  END IF;
  IF session_row.visibility IS DISTINCT FROM p_snapshot ->> 'targetSessionVisibility' THEN
    authorization_status := 'denied'; denial_reason := 'session_visibility_changed';
    RETURN NEXT; RETURN;
  END IF;
  IF session_row.authority_epoch IS DISTINCT FROM (
    p_snapshot ->> 'targetSessionAuthorityEpoch'
  )::integer THEN
    authorization_status := 'denied'; denial_reason := 'session_authority_epoch_changed';
    RETURN NEXT; RETURN;
  END IF;
  IF accepted_kind = 'turn' AND NOT EXISTS (
    SELECT 1 FROM session_turns turn_value
    WHERE turn_value.id = accepted_id
      AND turn_value.account_id = p_account_id
      AND turn_value.workspace_id = p_workspace_id
      AND turn_value.session_id = p_session_id
      AND turn_value.status <> 'cancelled'
  ) THEN
    authorization_status := 'denied'; denial_reason := 'session_identity_changed';
    RETURN NEXT; RETURN;
  ELSIF accepted_kind = 'scheduled_task' AND NOT EXISTS (
    SELECT 1 FROM scheduled_tasks task
    WHERE task.id = accepted_id
      AND task.account_id = p_account_id
      AND task.workspace_id = p_workspace_id
      AND task.authority_revision = (
        p_snapshot #>> '{acceptedWork,taskAuthorityRevision}'
      )::bigint
      AND task.status = 'active'
  ) THEN
    authorization_status := 'denied'; denial_reason := 'session_identity_changed';
    RETURN NEXT; RETURN;
  END IF;

  SELECT connection_value.id, connection_value.account_id,
    connection_value.workspace_id, connection_value.origin_workspace_id,
    connection_value.subject_id, connection_value.provider_domain,
    connection_value.kind, connection_value.status,
    connection_value.authority_scope, connection_value.authority_id,
    connection_value.owner_organization_membership_id,
    connection_value.authority_generation
  INTO connection_row
  FROM connections connection_value
  WHERE connection_value.id = (p_snapshot ->> 'connectionId')::uuid
    AND connection_value.account_id = p_account_id;
  IF NOT FOUND THEN
    authorization_status := 'denied'; denial_reason := 'connection_missing';
    RETURN NEXT; RETURN;
  END IF;
  IF connection_row.origin_workspace_id::text IS DISTINCT FROM
      p_snapshot ->> 'originWorkspaceId'
    OR lower(connection_row.provider_domain) IS DISTINCT FROM lower(
      p_snapshot ->> 'providerDomain'
    )
    OR connection_row.kind IS DISTINCT FROM p_snapshot ->> 'connectionKind'
    OR connection_row.authority_scope IS DISTINCT FROM snapshot_scope
  THEN
    authorization_status := 'denied'; denial_reason := 'connection_identity_changed';
    RETURN NEXT; RETURN;
  END IF;
  IF connection_row.authority_generation IS DISTINCT FROM (
    p_snapshot ->> 'connectionGeneration'
  )::bigint THEN
    authorization_status := 'denied'; denial_reason := 'connection_generation_changed';
    RETURN NEXT; RETURN;
  END IF;
  IF connection_row.status <> 'active' THEN
    authorization_status := 'denied'; denial_reason := 'connection_status_inactive';
    RETURN NEXT; RETURN;
  END IF;
  IF connection_row.subject_id IS DISTINCT FROM snapshot_owner
    OR connection_row.owner_organization_membership_id
      IS DISTINCT FROM snapshot_membership
  THEN
    authorization_status := 'denied'; denial_reason := 'connection_owner_changed';
    RETURN NEXT; RETURN;
  END IF;

  connection_id := connection_row.id;
  connection_generation := connection_row.authority_generation;
  authority_scope := snapshot_scope;
  owner_subject_id := snapshot_owner;
  authority_id := snapshot_authority;
  grant_id := snapshot_grant;

  IF snapshot_scope = 'workspace' THEN
    IF connection_row.workspace_id <> p_workspace_id
      OR connection_row.origin_workspace_id <> p_workspace_id
      OR connection_row.subject_id IS NOT NULL
      OR snapshot_authority IS NOT NULL
      OR snapshot_grant IS NOT NULL
    THEN
      authorization_status := 'denied'; denial_reason := 'connection_owner_changed';
      RETURN NEXT; RETURN;
    END IF;
    authorization_status := 'authorized'; denial_reason := NULL;
    RETURN NEXT; RETURN;
  END IF;

  SELECT membership.id, membership.account_id, membership.subject_id,
    membership.status, membership.revoked_at
  INTO membership_row
  FROM organization_memberships membership
  WHERE membership.id = snapshot_membership
    AND membership.account_id = p_account_id
    AND membership.subject_id = snapshot_owner;
  IF NOT FOUND OR membership_row.status <> 'active' OR membership_row.revoked_at IS NOT NULL
    OR NOT EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.id = snapshot_membership
        AND (
          membership.personal_workspace_id = p_workspace_id
          OR EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = p_account_id
              AND workspace_membership.workspace_id = p_workspace_id
              AND workspace_membership.subject_id = snapshot_owner
          )
        )
    )
  THEN
    authorization_status := 'denied'; denial_reason := 'owner_membership_inactive';
    RETURN NEXT; RETURN;
  END IF;

  SELECT authority.id, authority.account_id, authority.organization_membership_id,
    authority.resource_kind, authority.resource_id, authority.origin_workspace_id,
    authority.generation, authority.status, authority.revoked_at
  INTO authority_row
  FROM organization_user_resource_authorities authority
  WHERE authority.id = snapshot_authority
    AND authority.account_id = p_account_id;
  IF NOT FOUND THEN
    authorization_status := 'denied'; denial_reason := 'authority_missing';
    RETURN NEXT; RETURN;
  END IF;
  IF authority_row.organization_membership_id <> snapshot_membership
    OR authority_row.resource_kind <> 'connection'
    OR authority_row.resource_id <> connection_row.id
    OR authority_row.origin_workspace_id <> connection_row.origin_workspace_id
  THEN
    authorization_status := 'denied'; denial_reason := 'authority_identity_changed';
    RETURN NEXT; RETURN;
  END IF;
  IF authority_row.generation IS DISTINCT FROM (
    p_snapshot #>> '{userDelegation,authorityGeneration}'
  )::bigint THEN
    authorization_status := 'denied'; denial_reason := 'authority_generation_changed';
    RETURN NEXT; RETURN;
  END IF;
  IF authority_row.status <> 'active' OR authority_row.revoked_at IS NOT NULL THEN
    authorization_status := 'denied'; denial_reason := 'authority_status_inactive';
    RETURN NEXT; RETURN;
  END IF;

  SELECT grant_value.id, grant_value.account_id, grant_value.authority_id,
    grant_value.owner_organization_membership_id, grant_value.workspace_id,
    grant_value.session_id, grant_value.action, grant_value.mode,
    grant_value.context, grant_value.authority_epoch, grant_value.generation,
    grant_value.status, grant_value.expires_at
  INTO grant_row
  FROM organization_user_resource_grants grant_value
  WHERE grant_value.id = snapshot_grant
    AND grant_value.account_id = p_account_id
  FOR UPDATE;
  IF NOT FOUND THEN
    authorization_status := 'denied'; denial_reason := 'grant_missing';
    RETURN NEXT; RETURN;
  END IF;
  IF grant_row.authority_id <> snapshot_authority
    OR grant_row.owner_organization_membership_id <> snapshot_membership
    OR grant_row.workspace_id <> p_workspace_id
    OR grant_row.action <> 'connection.use'
    OR grant_row.mode IS DISTINCT FROM p_snapshot #>> '{userDelegation,mode}'
    OR grant_row.context IS DISTINCT FROM p_snapshot ->> 'targetSessionVisibility'
    OR grant_row.session_id IS DISTINCT FROM nullif(
      p_snapshot #>> '{userDelegation,sessionId}', ''
    )::uuid
    OR grant_row.authority_epoch IS DISTINCT FROM nullif(
      p_snapshot #>> '{userDelegation,authorityEpoch}', ''
    )::integer
  THEN
    authorization_status := 'denied'; denial_reason := 'grant_identity_changed';
    RETURN NEXT; RETURN;
  END IF;
  IF grant_row.generation IS DISTINCT FROM (
    p_snapshot #>> '{userDelegation,grantGeneration}'
  )::bigint THEN
    authorization_status := 'denied'; denial_reason := 'grant_generation_changed';
    RETURN NEXT; RETURN;
  END IF;
  IF grant_row.expires_at IS NOT NULL AND grant_row.expires_at <= clock_timestamp() THEN
    authorization_status := 'denied'; denial_reason := 'grant_expired';
    RETURN NEXT; RETURN;
  END IF;

  IF grant_row.mode = 'once' THEN
    SELECT receipt.accepted_work_kind, receipt.accepted_work_id
    INTO receipt_row
    FROM connection_use_once_consumption_receipts receipt
    WHERE receipt.grant_id = grant_row.id;
    IF FOUND THEN
      IF receipt_row.accepted_work_kind IS DISTINCT FROM accepted_kind
        OR receipt_row.accepted_work_id IS DISTINCT FROM accepted_id
      THEN
        authorization_status := 'denied'; denial_reason := 'grant_already_consumed';
        RETURN NEXT; RETURN;
      END IF;
    ELSIF grant_row.status = 'active' THEN
      UPDATE organization_user_resource_grants
      SET status = 'consumed', updated_at = clock_timestamp()
      WHERE id = grant_row.id AND account_id = p_account_id
        AND generation = grant_row.generation AND status = 'active';
      IF NOT FOUND THEN
        authorization_status := 'denied'; denial_reason := 'grant_already_consumed';
        RETURN NEXT; RETURN;
      END IF;
      INSERT INTO connection_use_once_consumption_receipts (
        grant_id, account_id, authority_id, authority_generation,
        grant_generation, accepted_work_kind, accepted_work_id
      ) VALUES (
        grant_row.id, p_account_id, snapshot_authority, authority_row.generation,
        grant_row.generation, accepted_kind, accepted_id
      );
    ELSE
      authorization_status := 'denied'; denial_reason := 'grant_status_inactive';
      RETURN NEXT; RETURN;
    END IF;
  ELSIF grant_row.status <> 'active' THEN
    authorization_status := 'denied'; denial_reason := 'grant_status_inactive';
    RETURN NEXT; RETURN;
  END IF;

  authorization_status := 'authorized'; denial_reason := NULL;
  RETURN NEXT;
END
$body$
$ddl$, data_schema);
END
$connection_authority_routines$;

REVOKE ALL ON FUNCTION list_self_connection_authorities(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION issue_self_connection_use_grant(
  uuid, uuid, uuid, text, text, uuid, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_self_connection_use_grant(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_connection_use_authority(uuid, uuid, uuid, jsonb) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION list_self_connection_authorities(uuid) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION issue_self_connection_use_grant(
      uuid, uuid, uuid, text, text, uuid, boolean
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION revoke_self_connection_use_grant(uuid, uuid) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION resolve_connection_use_authority(
      uuid, uuid, uuid, jsonb
    ) TO opengeni_app;
    REVOKE ALL ON TABLE connection_use_once_consumption_receipts FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_resource_authorities FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_resource_grants FROM opengeni_app;
  END IF;
END
$grants$;

COMMENT ON COLUMN "connections"."authority_generation" IS
  'Monotonic execution-authority generation. Token refresh does not advance it; reconnect, disconnect, provider/kind, and status transitions do.';
COMMENT ON TABLE "connection_use_once_consumption_receipts" IS
  'Exact accepted turn/task that consumed one connection.use grant; contains no credential, quota, provider response, or usage value.';

-- deployment-mode: rolling
-- Organization invitation, role, suspension, reactivation, offboarding and
-- retention-policy authority and the operator-driven destructive retention
-- lifecycle. Provider email delivery remains outside this database lifecycle.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "organization_memberships"
  ADD COLUMN "role" text NOT NULL DEFAULT 'member';

UPDATE "organization_memberships" membership
SET role = 'owner'
FROM "managed_accounts" account
WHERE account.id = membership.account_id
  AND account.external_source = 'better-auth:user'
  AND membership.subject_id = 'user:' || account.external_id;

ALTER TABLE "organization_memberships"
  ADD CONSTRAINT "organization_memberships_role_check"
  CHECK ("role" IN ('owner', 'admin', 'member')) NOT VALID;
ALTER TABLE "organization_memberships"
  VALIDATE CONSTRAINT "organization_memberships_role_check";

ALTER TABLE "organization_user_retention_policies"
  DROP CONSTRAINT "organization_user_retention_policies_duration_check";
ALTER TABLE "organization_user_retention_policies"
  ADD CONSTRAINT "organization_user_retention_policies_duration_check" CHECK (
    ("mode" = 'retain' AND "retention_days" IS NULL)
    OR (
      "mode" = 'delete_after'
      AND "retention_days" IS NOT NULL
      AND "retention_days" BETWEEN 30 AND 90
    )
  ) NOT VALID;
ALTER TABLE "organization_user_retention_policies"
  VALIDATE CONSTRAINT "organization_user_retention_policies_duration_check";

-- The pre-existing managed-human provisioner creates the one organization
-- whose external identity is the same human but predates roles. Preserve that
-- seamless bootstrap without teaching the general invitation path to infer
-- authority from provenance: only this exact self-organization INSERT is
-- promoted, and later role changes remain explicit lifecycle commands.
CREATE OR REPLACE FUNCTION opengeni_private.assign_managed_self_organization_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  IF EXISTS (
    SELECT 1 FROM managed_accounts account
    WHERE account.id = NEW.account_id
      AND account.external_source = 'better-auth:user'
      AND NEW.subject_id = 'user:' || account.external_id
  ) THEN
    NEW.role := 'owner';
  END IF;
  RETURN NEW;
END
$body$;
CREATE TRIGGER organization_memberships_assign_managed_self_owner
  BEFORE INSERT ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.assign_managed_self_organization_owner();

CREATE TABLE "organization_membership_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "target_subject_id" text NOT NULL,
  "target_email" text NOT NULL,
  "role" text NOT NULL DEFAULT 'member',
  "status" text NOT NULL DEFAULT 'pending',
  "revision" bigint NOT NULL DEFAULT 1,
  "created_by_membership_id" uuid NOT NULL,
  "accepted_membership_id" uuid,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "organization_membership_invitations_creator_fk"
    FOREIGN KEY ("created_by_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_membership_invitations_accepted_membership_fk"
    FOREIGN KEY ("accepted_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_membership_invitations_subject_check" CHECK (
    "target_subject_id" = btrim("target_subject_id")
    AND "target_subject_id" LIKE 'user:%'
    AND octet_length(convert_to("target_subject_id", 'UTF8')) BETWEEN 6 AND 1024
  ),
  CONSTRAINT "organization_membership_invitations_email_check" CHECK (
    "target_email" = lower(btrim("target_email"))
    AND octet_length(convert_to("target_email", 'UTF8')) BETWEEN 3 AND 320
  ),
  CONSTRAINT "organization_membership_invitations_role_check"
    CHECK ("role" IN ('owner', 'admin', 'member')),
  CONSTRAINT "organization_membership_invitations_status_check"
    CHECK ("status" IN ('pending', 'accepted', 'revoked', 'expired')),
  CONSTRAINT "organization_membership_invitations_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "organization_membership_invitations_acceptance_check" CHECK (
    ("status" = 'accepted' AND "accepted_membership_id" IS NOT NULL)
    OR ("status" <> 'accepted' AND "accepted_membership_id" IS NULL)
  )
);
CREATE UNIQUE INDEX "organization_membership_invitations_id_account_idx"
  ON "organization_membership_invitations" ("id", "account_id");
CREATE UNIQUE INDEX "organization_membership_invitations_pending_target_uq"
  ON "organization_membership_invitations" ("account_id", "target_subject_id")
  WHERE "status" = 'pending';
CREATE INDEX "organization_membership_invitations_account_created_idx"
  ON "organization_membership_invitations" ("account_id", "created_at" DESC, "id" DESC);
CREATE INDEX "organization_membership_invitations_subject_created_idx"
  ON "organization_membership_invitations" ("target_subject_id", "created_at" DESC, "id" DESC);

CREATE TABLE "organization_membership_operation_receipts" (
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "operation_id" uuid NOT NULL,
  "action" text NOT NULL,
  "input_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "organization_membership_operation_receipts_pk"
    PRIMARY KEY ("account_id", "operation_id"),
  CONSTRAINT "organization_membership_operation_receipts_action_check" CHECK (
    "action" IN ('invite', 'accept', 'revoke_invitation', 'change_role', 'suspend', 'reactivate', 'offboard', 'retention')
  ),
  CONSTRAINT "organization_membership_operation_receipts_input_hash_check"
    CHECK ("input_hash" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "organization_membership_lifecycle_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "operation_id" uuid NOT NULL,
  "actor_membership_id" uuid NOT NULL,
  "target_membership_id" uuid,
  "kind" text NOT NULL,
  "prior_authorization_revision" bigint,
  "resulting_authorization_revision" bigint,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "organization_membership_lifecycle_events_actor_fk"
    FOREIGN KEY ("actor_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_membership_lifecycle_events_target_fk"
    FOREIGN KEY ("target_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_membership_lifecycle_events_kind_check" CHECK (
    "kind" IN ('invite', 'accept', 'revoke_invitation', 'change_role', 'suspend', 'reactivate', 'offboard', 'retention')
  ),
  CONSTRAINT "organization_membership_lifecycle_events_reason_check" CHECK (
    "reason" IS NULL OR octet_length(convert_to("reason", 'UTF8')) <= 512
  )
);
CREATE UNIQUE INDEX "organization_membership_lifecycle_events_operation_uq"
  ON "organization_membership_lifecycle_events" ("account_id", "operation_id");

CREATE TABLE "organization_user_retention_deletions" (
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "membership_id" uuid NOT NULL,
  "retention_until" timestamptz NOT NULL,
  "state" text NOT NULL DEFAULT 'claimed',
  "claim_operation_id" uuid NOT NULL,
  "claim_expires_at" timestamptz NOT NULL,
  "attempt_count" integer NOT NULL DEFAULT 1,
  "database_result" jsonb,
  "database_finalized_at" timestamptz,
  "result" jsonb,
  "completed_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "organization_user_retention_deletions_pk"
    PRIMARY KEY ("account_id", "membership_id"),
  CONSTRAINT "organization_user_retention_deletions_membership_fk"
    FOREIGN KEY ("membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_user_retention_deletions_state_check"
    CHECK ("state" IN ('claimed', 'failed', 'completed')),
  CONSTRAINT "organization_user_retention_deletions_attempt_check"
    CHECK ("attempt_count" > 0),
  CONSTRAINT "organization_user_retention_deletions_completion_check" CHECK (
    ("state" = 'completed' AND "completed_at" IS NOT NULL AND "result" IS NOT NULL)
    OR ("state" <> 'completed' AND "completed_at" IS NULL AND "result" IS NULL)
  ),
  CONSTRAINT "organization_retention_deletions_db_finalized_chk" CHECK (
    ("database_finalized_at" IS NULL AND "database_result" IS NULL)
    OR ("database_finalized_at" IS NOT NULL AND "database_result" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "organization_user_retention_deletions_operation_uq"
  ON "organization_user_retention_deletions" ("claim_operation_id");
CREATE INDEX "organization_user_retention_deletions_claim_idx"
  ON "organization_user_retention_deletions" ("account_id", "state", "claim_expires_at");
CREATE INDEX "organization_memberships_retention_due_idx"
  ON "organization_memberships" ("account_id", "personal_retention_until", "id")
  WHERE "status" = 'revoked' AND "personal_retention_until" IS NOT NULL;

CREATE TABLE "organization_user_retention_object_obligations" (
  "account_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "object_kind" text NOT NULL,
  "source_id" text NOT NULL,
  "object_bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "prepared_operation_id" uuid NOT NULL,
  "object_key_hash" text NOT NULL,
  "prepared_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "organization_user_retention_object_obligations_pk"
    PRIMARY KEY ("account_id", "membership_id", "object_kind", "source_id", "object_bucket"),
  CONSTRAINT "organization_retention_object_obligations_deletion_fk"
    FOREIGN KEY ("account_id", "membership_id")
    REFERENCES "organization_user_retention_deletions"("account_id", "membership_id")
    ON DELETE RESTRICT,
  CONSTRAINT "organization_user_retention_object_obligations_hash_check"
    CHECK ("object_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "organization_user_retention_object_obligations_shape_check" CHECK (
    "object_kind" IN (
      'file', 'session_recording', 'browser_state_artifact', 'browser_state_upload',
      'transcription_recording_object', 'video_staging_reference',
      'workspace_artifact_version', 'editable_artifact_blob',
      'workspace_capture_manifest', 'workspace_capture_tree_index',
      'workspace_capture_blob'
    )
    AND octet_length("source_id") BETWEEN 1 AND 2048
    AND octet_length(convert_to("object_bucket", 'UTF8')) BETWEEN 1 AND 1024
    AND octet_length(convert_to("object_key", 'UTF8')) BETWEEN 1 AND 4096
  )
);

CREATE TABLE "organization_user_retention_object_deletion_receipts" (
  "account_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "object_kind" text NOT NULL,
  "source_id" text NOT NULL,
  "object_bucket" text NOT NULL,
  "operation_id" uuid NOT NULL,
  "deleted_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "organization_user_retention_object_deletion_receipts_pk"
    PRIMARY KEY ("account_id", "membership_id", "object_kind", "source_id", "object_bucket"),
  CONSTRAINT "organization_retention_object_deletions_obligation_fk"
    FOREIGN KEY ("account_id", "membership_id", "object_kind", "source_id", "object_bucket")
    REFERENCES "organization_user_retention_object_obligations"(
      "account_id", "membership_id", "object_kind", "source_id", "object_bucket"
    ) ON DELETE RESTRICT
);

CREATE TABLE "organization_user_retention_deletion_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "reason_code" text,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "organization_user_retention_deletion_events_membership_fk"
    FOREIGN KEY ("membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_user_retention_deletion_events_kind_check"
    CHECK ("kind" IN ('claimed', 'failed', 'completed')),
  CONSTRAINT "organization_user_retention_deletion_events_reason_check"
    CHECK ("reason_code" IS NULL OR "reason_code" ~ '^[a-z0-9_]{1,64}$')
);
CREATE UNIQUE INDEX "organization_user_retention_deletion_events_operation_kind_uq"
  ON "organization_user_retention_deletion_events" ("account_id", "operation_id", "kind");
CREATE INDEX "organization_retention_events_member_created_idx"
  ON "organization_user_retention_deletion_events" ("account_id", "membership_id", "created_at", "id");

ALTER TABLE "organization_membership_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_membership_invitations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_membership_operation_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_membership_operation_receipts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_membership_lifecycle_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_membership_lifecycle_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_retention_deletions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_retention_deletions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_retention_object_obligations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_retention_object_obligations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_retention_object_deletion_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_retention_object_deletion_receipts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_retention_deletion_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_retention_deletion_events" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS organization_tenancy_lifecycle ON "organization_memberships";
CREATE POLICY organization_tenancy_lifecycle ON "organization_memberships"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN (
      'managed_human_provisioning',
      'session_visibility_activation',
      'organization_membership_lifecycle'
    ))
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN (
      'managed_human_provisioning',
      'session_visibility_activation',
      'organization_membership_lifecycle'
    ));
DROP POLICY IF EXISTS organization_tenancy_lifecycle ON "organization_user_retention_policies";
CREATE POLICY organization_tenancy_lifecycle ON "organization_user_retention_policies"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN ('managed_human_provisioning', 'organization_membership_lifecycle'))
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN ('managed_human_provisioning', 'organization_membership_lifecycle'));
DROP POLICY IF EXISTS organization_tenancy_lifecycle ON "organization_user_resource_authorities";
CREATE POLICY organization_tenancy_lifecycle ON "organization_user_resource_authorities"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN ('managed_human_provisioning', 'organization_membership_lifecycle'))
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN ('managed_human_provisioning', 'organization_membership_lifecycle'));
DROP POLICY IF EXISTS organization_tenancy_lifecycle ON "organization_user_resource_grants";
CREATE POLICY organization_tenancy_lifecycle ON "organization_user_resource_grants"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN (
      'managed_human_provisioning',
      'session_visibility_activation',
      'organization_membership_lifecycle'
    ))
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    IN (
      'managed_human_provisioning',
      'session_visibility_activation',
      'organization_membership_lifecycle'
    ));

CREATE POLICY organization_tenancy_lifecycle ON "organization_membership_invitations"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle');
CREATE POLICY organization_tenancy_lifecycle ON "organization_membership_operation_receipts"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle');
CREATE POLICY organization_tenancy_lifecycle ON "organization_membership_lifecycle_events"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle');
CREATE POLICY organization_tenancy_lifecycle ON "organization_user_retention_deletions"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle');
CREATE POLICY organization_tenancy_lifecycle ON "organization_user_retention_object_obligations"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle');
CREATE POLICY organization_tenancy_lifecycle ON "organization_user_retention_object_deletion_receipts"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle');
CREATE POLICY organization_tenancy_lifecycle ON "organization_user_retention_deletion_events"
  USING (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle')
  WITH CHECK (current_setting('opengeni.organization_tenancy_lifecycle', true)
    = 'organization_membership_lifecycle');

CREATE OR REPLACE FUNCTION opengeni_private.organization_membership_row_json(
  p_membership organization_memberships
) RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $body$
  SELECT pg_catalog.jsonb_build_object(
    'id', p_membership.id,
    'organizationId', p_membership.account_id,
    'subjectId', p_membership.subject_id,
    'role', p_membership.role,
    'status', p_membership.status,
    'authorizationRevision', p_membership.authorization_revision,
    'personalWorkspaceId', p_membership.personal_workspace_id,
    'revokedAt', p_membership.revoked_at,
    'personalRetentionUntil', p_membership.personal_retention_until,
    'createdAt', p_membership.created_at,
    'updatedAt', p_membership.updated_at
  )
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.organization_invitation_row_json(
  p_invitation organization_membership_invitations
) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $body$
  SELECT pg_catalog.jsonb_build_object(
    'id', p_invitation.id,
    'organizationId', p_invitation.account_id,
    'targetEmail', p_invitation.target_email,
    'role', p_invitation.role,
    'status', CASE
      WHEN p_invitation.status = 'pending'
        AND p_invitation.expires_at <= pg_catalog.clock_timestamp()
      THEN 'expired'
      ELSE p_invitation.status
    END,
    'revision', p_invitation.revision,
    'expiresAt', p_invitation.expires_at,
    'acceptedMembershipId', p_invitation.accepted_membership_id,
    'createdAt', p_invitation.created_at,
    'updatedAt', p_invitation.updated_at
  )
$body$;

CREATE OR REPLACE FUNCTION list_self_organization_memberships(p_subject_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE result jsonb;
BEGIN
  IF p_subject_id IS NULL
    OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_subject_id NOT LIKE 'user:%'
  THEN
    RAISE EXCEPTION 'managed human subject authority required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  SELECT coalesce(
    pg_catalog.jsonb_agg(
      opengeni_private.organization_membership_row_json(membership)
      ORDER BY membership.created_at, membership.id
    ), '[]'::jsonb
  ) INTO result
  FROM organization_memberships membership
  WHERE membership.subject_id = p_subject_id;
  RETURN result;
END
$body$;

CREATE OR REPLACE FUNCTION list_self_organization_invitations(
  p_subject_id text,
  p_cursor_id uuid,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  cursor_created_at timestamptz;
  result jsonb;
BEGIN
  IF p_subject_id IS NULL
    OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_subject_id NOT LIKE 'user:%'
    OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100
  THEN
    RAISE EXCEPTION 'managed human subject authority required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  IF p_cursor_id IS NOT NULL THEN
    SELECT invitation.created_at INTO cursor_created_at
    FROM organization_membership_invitations invitation
    WHERE invitation.target_subject_id = p_subject_id
      AND invitation.id = p_cursor_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'organization invitation cursor not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  SELECT coalesce(
    pg_catalog.jsonb_agg(
      opengeni_private.organization_invitation_row_json(candidate)
      ORDER BY candidate.created_at DESC, candidate.id DESC
    ), '[]'::jsonb
  ) INTO result
  FROM (
    SELECT invitation.*
    FROM organization_membership_invitations invitation
    WHERE invitation.target_subject_id = p_subject_id
      AND (
        p_cursor_id IS NULL
        OR (invitation.created_at, invitation.id) < (cursor_created_at, p_cursor_id)
      )
    ORDER BY invitation.created_at DESC, invitation.id DESC
    LIMIT p_limit + 1
  ) candidate;
  RETURN result;
END
$body$;

-- Rolling compatibility for callers that predate keyset pagination. The
-- legacy signature is deliberately capped rather than returning unbounded
-- invitation history.
CREATE OR REPLACE FUNCTION list_self_organization_invitations(p_subject_id text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
  SELECT list_self_organization_invitations(p_subject_id, NULL::uuid, 100)
$body$;

CREATE OR REPLACE FUNCTION get_self_organization_invitation(
  p_subject_id text,
  p_invitation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE invitation organization_membership_invitations%ROWTYPE;
BEGIN
  IF p_subject_id IS NULL
    OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_subject_id NOT LIKE 'user:%'
    OR p_invitation_id IS NULL
  THEN
    RAISE EXCEPTION 'managed human subject authority required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  SELECT candidate.* INTO invitation
  FROM organization_membership_invitations candidate
  WHERE candidate.id = p_invitation_id
    AND candidate.target_subject_id = p_subject_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization invitation not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN opengeni_private.organization_invitation_row_json(invitation);
END
$body$;

CREATE OR REPLACE FUNCTION list_organization_members(
  p_account_id uuid,
  p_actor_subject_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE actor organization_memberships%ROWTYPE; result jsonb;
BEGIN
  IF p_account_id IS NULL
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization member authority required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(
    pg_catalog.jsonb_agg(
      opengeni_private.organization_membership_row_json(membership)
      ORDER BY membership.created_at, membership.id
    ), '[]'::jsonb
  ) INTO result
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id;
  RETURN result;
END
$body$;

CREATE OR REPLACE FUNCTION list_organization_invitations(
  p_account_id uuid,
  p_actor_subject_id text,
  p_cursor_id uuid,
  p_limit integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  actor organization_memberships%ROWTYPE;
  cursor_created_at timestamptz;
  result jsonb;
BEGIN
  IF p_account_id IS NULL
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_limit IS NULL OR p_limit < 1 OR p_limit > 100
  THEN
    RAISE EXCEPTION 'organization invitation page authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  IF p_cursor_id IS NOT NULL THEN
    SELECT invitation.created_at INTO cursor_created_at
    FROM organization_membership_invitations invitation
    WHERE invitation.account_id = p_account_id AND invitation.id = p_cursor_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'organization invitation cursor not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  SELECT coalesce(
    pg_catalog.jsonb_agg(
      opengeni_private.organization_invitation_row_json(candidate)
      ORDER BY candidate.created_at DESC, candidate.id DESC
    ), '[]'::jsonb
  ) INTO result
  FROM (
    SELECT invitation.*
    FROM organization_membership_invitations invitation
    WHERE invitation.account_id = p_account_id
      AND (
        p_cursor_id IS NULL
        OR (invitation.created_at, invitation.id) < (cursor_created_at, p_cursor_id)
      )
    ORDER BY invitation.created_at DESC, invitation.id DESC
    LIMIT p_limit + 1
  ) candidate;
  RETURN result;
END
$body$;

CREATE OR REPLACE FUNCTION organization_membership_command(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  action_name text := p_command ->> 'action';
  account_id_value uuid := nullif(p_command ->> 'organizationId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  operation_id_value uuid := nullif(p_command ->> 'operationId', '')::uuid;
  input_hash_value text;
  receipt_row organization_membership_operation_receipts%ROWTYPE;
  actor organization_memberships%ROWTYPE;
  target organization_memberships%ROWTYPE;
  invitation organization_membership_invitations%ROWTYPE;
  policy organization_user_retention_policies%ROWTYPE;
  result jsonb;
  now_value timestamptz := pg_catalog.clock_timestamp();
  target_subject text;
  target_email text;
  requested_role text;
  target_id uuid;
  expected_revision bigint;
  workspace_id_value uuid;
  reason_value text;
  retention_days_value integer;
  previous_workspace text := pg_catalog.current_setting('opengeni.workspace_id', true);
  previous_visibility_capability text := pg_catalog.current_setting(
    'opengeni.session_visibility_write_capability', true
  );
  visibility_capability_id uuid;
  interruption_operation_id uuid;
BEGIN
  IF p_command IS NULL
    OR action_name NOT IN ('invite', 'accept', 'revoke_invitation', 'change_role', 'suspend', 'reactivate', 'offboard', 'retention')
    OR account_id_value IS NULL
    OR operation_id_value IS NULL
    OR actor_subject IS NULL
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization membership command authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  input_hash_value := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_command::text, 'UTF8')), 'hex'
  );
  PERFORM 1 FROM managed_accounts account WHERE account.id = account_id_value FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );

  SELECT * INTO receipt_row
  FROM organization_membership_operation_receipts receipt
  WHERE receipt.account_id = account_id_value
    AND receipt.operation_id = operation_id_value
  FOR UPDATE;
  IF FOUND THEN
    IF receipt_row.action IS DISTINCT FROM action_name
      OR receipt_row.input_hash IS DISTINCT FROM input_hash_value
    THEN
      RAISE EXCEPTION 'organization operation id was reused with different input'
        USING ERRCODE = '23505';
    END IF;
    RETURN receipt_row.result;
  END IF;

  IF action_name = 'accept' THEN
    target_id := nullif(p_command ->> 'invitationId', '')::uuid;
    expected_revision := nullif(p_command ->> 'expectedRevision', '')::bigint;
    SELECT * INTO invitation
    FROM organization_membership_invitations candidate
    WHERE candidate.id = target_id AND candidate.account_id = account_id_value
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'P0002'; END IF;
    IF invitation.target_subject_id IS DISTINCT FROM actor_subject THEN
      RAISE EXCEPTION 'invitation belongs to another subject' USING ERRCODE = '42501';
    END IF;
    IF invitation.status <> 'pending' OR invitation.expires_at <= now_value THEN
      RAISE EXCEPTION 'invitation is not active' USING ERRCODE = '55000';
    END IF;
    IF invitation.revision IS DISTINCT FROM expected_revision THEN
      RAISE EXCEPTION 'invitation revision is stale' USING ERRCODE = '40001';
    END IF;
    SELECT * INTO target FROM organization_memberships membership
    WHERE membership.account_id = account_id_value
      AND membership.subject_id = actor_subject
    FOR UPDATE;
    IF NOT FOUND THEN
      workspace_id_value := gen_random_uuid();
      PERFORM pg_catalog.set_config('opengeni.workspace_id', workspace_id_value::text, true);
      INSERT INTO workspaces (
        id, account_id, name, slug, external_source, external_id
      ) VALUES (
        workspace_id_value, account_id_value, 'Personal workspace', NULL,
        'opengeni:organization-membership', account_id_value::text || ':' || actor_subject
      ) ON CONFLICT (external_source, external_id) DO UPDATE
        SET updated_at = workspaces.updated_at
      RETURNING id INTO workspace_id_value;
      INSERT INTO workspace_inference_controls (workspace_id, account_id)
      VALUES (workspace_id_value, account_id_value) ON CONFLICT DO NOTHING;
      INSERT INTO organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id
      ) VALUES (
        account_id_value, actor_subject, invitation.role, 'active', workspace_id_value
      ) RETURNING * INTO target;
    ELSE
      IF target.status = 'active' THEN
        RAISE EXCEPTION 'organization membership is already active' USING ERRCODE = '55000';
      END IF;
      workspace_id_value := target.personal_workspace_id;
      IF workspace_id_value IS NULL THEN
        workspace_id_value := gen_random_uuid();
        PERFORM pg_catalog.set_config('opengeni.workspace_id', workspace_id_value::text, true);
        INSERT INTO workspaces (
          id, account_id, name, slug, external_source, external_id
        ) VALUES (
          workspace_id_value, account_id_value, 'Personal workspace', NULL,
          'opengeni:organization-membership', account_id_value::text || ':' || actor_subject
        ) ON CONFLICT (external_source, external_id) DO UPDATE
          SET updated_at = workspaces.updated_at
        RETURNING id INTO workspace_id_value;
        INSERT INTO workspace_inference_controls (workspace_id, account_id)
        VALUES (workspace_id_value, account_id_value) ON CONFLICT DO NOTHING;
      END IF;
      UPDATE organization_memberships SET
        role = invitation.role,
        status = 'active',
        personal_workspace_id = workspace_id_value,
        authorization_revision = authorization_revision + 1,
        revoked_at = NULL,
        personal_retention_until = NULL,
        updated_at = now_value
      WHERE id = target.id RETURNING * INTO target;
    END IF;
    UPDATE organization_membership_invitations SET
      status = 'accepted', revision = revision + 1,
      accepted_membership_id = target.id, updated_at = now_value
    WHERE id = invitation.id RETURNING * INTO invitation;
    result := pg_catalog.jsonb_build_object(
      'invitation', opengeni_private.organization_invitation_row_json(invitation),
      'membership', opengeni_private.organization_membership_row_json(target)
    );
    actor := target;
  ELSE
    -- Existing session-visibility activation serializes workspace -> member ->
    -- session. Offboarding spans every owned workspace, so pre-lock that exact
    -- workspace prefix in UUID order before locking either actor or target
    -- membership. This prevents member/workspace lock inversion while the
    -- later per-workspace pass takes the canonical session/turn/attempt suffix.
    IF action_name IN ('suspend', 'offboard') THEN
      FOR workspace_id_value IN
        SELECT workspace.id
        FROM workspaces workspace
        WHERE workspace.account_id = account_id_value
        ORDER BY workspace.id
      LOOP
        PERFORM pg_catalog.set_config(
          'opengeni.workspace_id', workspace_id_value::text, true
        );
        PERFORM 1 FROM workspace_inference_controls control
        WHERE control.account_id = account_id_value
          AND control.workspace_id = workspace_id_value
        FOR SHARE;
        PERFORM 1 FROM workspaces workspace
        WHERE workspace.account_id = account_id_value
          AND workspace.id = workspace_id_value
        FOR UPDATE;
      END LOOP;
    END IF;
    SELECT * INTO actor FROM organization_memberships membership
    WHERE membership.account_id = account_id_value
      AND membership.subject_id = actor_subject
    FOR UPDATE;
    IF NOT FOUND OR actor.status <> 'active' THEN
      RAISE EXCEPTION 'active organization membership required' USING ERRCODE = '42501';
    END IF;

    IF action_name = 'invite' THEN
      IF actor.role NOT IN ('owner', 'admin') THEN
        RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
      END IF;
      target_subject := p_command ->> 'targetSubjectId';
      target_email := lower(btrim(p_command ->> 'targetEmail'));
      requested_role := p_command ->> 'role';
      IF target_subject IS NULL OR target_subject NOT LIKE 'user:%'
        OR requested_role NOT IN ('owner', 'admin', 'member')
        OR (actor.role = 'admin' AND requested_role <> 'member')
        OR nullif(p_command ->> 'expiresAt', '')::timestamptz <= now_value
        OR nullif(p_command ->> 'expiresAt', '')::timestamptz > now_value + interval '30 days'
      THEN
        RAISE EXCEPTION 'invitation input is invalid' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.account_id = account_id_value
          AND membership.subject_id = target_subject
          AND membership.status = 'active'
      ) THEN
        RAISE EXCEPTION 'subject is already an active organization member' USING ERRCODE = '55000';
      END IF;
      UPDATE organization_membership_invitations SET
        status = 'revoked', revision = revision + 1, updated_at = now_value
      WHERE account_id = account_id_value
        AND target_subject_id = target_subject AND status = 'pending';
      INSERT INTO organization_membership_invitations (
        account_id, target_subject_id, target_email, role,
        created_by_membership_id, expires_at
      ) VALUES (
        account_id_value, target_subject, target_email, requested_role,
        actor.id, nullif(p_command ->> 'expiresAt', '')::timestamptz
      ) RETURNING * INTO invitation;
      result := opengeni_private.organization_invitation_row_json(invitation);
      target := NULL;
    ELSIF action_name = 'revoke_invitation' THEN
      IF actor.role NOT IN ('owner', 'admin') THEN
        RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
      END IF;
      target_id := nullif(p_command ->> 'invitationId', '')::uuid;
      expected_revision := nullif(p_command ->> 'expectedRevision', '')::bigint;
      SELECT * INTO invitation
      FROM organization_membership_invitations candidate
      WHERE candidate.id = target_id AND candidate.account_id = account_id_value
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'invitation not found' USING ERRCODE = 'P0002'; END IF;
      IF invitation.revision IS DISTINCT FROM expected_revision THEN
        RAISE EXCEPTION 'invitation revision is stale' USING ERRCODE = '40001';
      END IF;
      IF invitation.status <> 'pending' THEN
        RAISE EXCEPTION 'only a pending invitation can be revoked' USING ERRCODE = '55000';
      END IF;
      IF actor.role = 'admin' AND invitation.role <> 'member' THEN
        RAISE EXCEPTION 'administrators may revoke member invitations only' USING ERRCODE = '42501';
      END IF;
      UPDATE organization_membership_invitations SET
        status = 'revoked', revision = revision + 1, updated_at = now_value
      WHERE id = invitation.id RETURNING * INTO invitation;
      result := opengeni_private.organization_invitation_row_json(invitation);
      target := NULL;
    ELSIF action_name = 'retention' THEN
      IF actor.role <> 'owner' THEN
        RAISE EXCEPTION 'organization owner required' USING ERRCODE = '42501';
      END IF;
      expected_revision := nullif(p_command ->> 'expectedVersion', '')::bigint;
      requested_role := p_command ->> 'mode';
      retention_days_value := nullif(p_command ->> 'retentionDays', '')::integer;
      IF requested_role NOT IN ('retain', 'delete_after')
        OR (requested_role = 'retain' AND retention_days_value IS NOT NULL)
        OR (requested_role = 'delete_after' AND retention_days_value NOT BETWEEN 30 AND 90)
      THEN
        RAISE EXCEPTION 'retention policy input is invalid' USING ERRCODE = '22023';
      END IF;
      SELECT * INTO policy FROM organization_user_retention_policies candidate
      WHERE candidate.account_id = account_id_value FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO organization_user_retention_policies (
          account_id, mode, retention_days, version, updated_by_membership_id
        ) VALUES (account_id_value, 'retain', NULL, 1, actor.id)
        RETURNING * INTO policy;
      END IF;
      IF policy.version IS DISTINCT FROM expected_revision THEN
        RAISE EXCEPTION 'retention policy version is stale' USING ERRCODE = '40001';
      END IF;
      UPDATE organization_user_retention_policies SET
        mode = requested_role, retention_days = retention_days_value,
        version = version + 1, updated_by_membership_id = actor.id,
        updated_at = now_value
      WHERE account_id = account_id_value RETURNING * INTO policy;
      result := pg_catalog.jsonb_build_object(
        'organizationId', policy.account_id, 'mode', policy.mode,
        'retentionDays', policy.retention_days, 'version', policy.version,
        'updatedAt', policy.updated_at
      );
      target := NULL;
    ELSE
      IF actor.role NOT IN ('owner', 'admin') THEN
        RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
      END IF;
      target_id := nullif(p_command ->> 'membershipId', '')::uuid;
      expected_revision := nullif(p_command ->> 'expectedAuthorizationRevision', '')::bigint;
      requested_role := p_command ->> 'role';
      reason_value := nullif(btrim(p_command ->> 'reason'), '');
      IF reason_value IS NOT NULL
        AND octet_length(convert_to(reason_value, 'UTF8')) > 512
      THEN RAISE EXCEPTION 'reason is too large' USING ERRCODE = '22023'; END IF;
      PERFORM 1 FROM organization_memberships membership
      WHERE membership.account_id = account_id_value
        AND membership.id IN (actor.id, target_id)
      ORDER BY membership.id FOR UPDATE;
      SELECT * INTO target FROM organization_memberships membership
      WHERE membership.account_id = account_id_value AND membership.id = target_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'organization member not found' USING ERRCODE = 'P0002'; END IF;
      IF target.authorization_revision IS DISTINCT FROM expected_revision THEN
        RAISE EXCEPTION 'organization membership revision is stale' USING ERRCODE = '40001';
      END IF;
      IF actor.role = 'admin' AND target.role <> 'member' THEN
        RAISE EXCEPTION 'administrators may manage members only' USING ERRCODE = '42501';
      END IF;
      IF target.role = 'owner' AND (
        action_name IN ('suspend', 'offboard')
        OR (action_name = 'change_role' AND requested_role <> 'owner')
      ) AND NOT EXISTS (
        SELECT 1 FROM organization_memberships other
        WHERE other.account_id = account_id_value AND other.id <> target.id
          AND other.status = 'active' AND other.role = 'owner'
      ) THEN
        RAISE EXCEPTION 'cannot remove the last active organization owner'
          USING ERRCODE = '55000';
      END IF;
      IF action_name = 'change_role' THEN
        IF target.status <> 'active' OR requested_role NOT IN ('owner', 'admin', 'member')
          OR (actor.role = 'admin' AND requested_role <> 'member')
        THEN RAISE EXCEPTION 'role transition is invalid' USING ERRCODE = '55000'; END IF;
        UPDATE organization_memberships SET role = requested_role,
          authorization_revision = authorization_revision + 1, updated_at = now_value
        WHERE id = target.id RETURNING * INTO target;
      ELSIF action_name = 'reactivate' THEN
        IF target.status <> 'suspended' THEN
          RAISE EXCEPTION 'only a suspended member can be reactivated' USING ERRCODE = '55000';
        END IF;
        UPDATE organization_memberships SET status = 'active',
          authorization_revision = authorization_revision + 1, updated_at = now_value
        WHERE id = target.id RETURNING * INTO target;
      ELSIF action_name IN ('suspend', 'offboard') THEN
        IF action_name = 'suspend' AND target.status <> 'active' THEN
          RAISE EXCEPTION 'only an active member can be suspended' USING ERRCODE = '55000';
        ELSIF action_name = 'offboard' AND target.status NOT IN ('active', 'suspended') THEN
          RAISE EXCEPTION 'only an active or suspended member can be offboarded'
            USING ERRCODE = '55000';
        END IF;
        SELECT * INTO policy FROM organization_user_retention_policies candidate
        WHERE candidate.account_id = account_id_value;
        UPDATE organization_user_resource_grants SET
          status = 'revoked', generation = generation + 1,
          revoked_at = now_value, updated_at = now_value
        WHERE account_id = account_id_value
          AND owner_organization_membership_id = target.id AND status = 'active';
        UPDATE organization_user_resource_authorities SET
          status = 'retained', generation = generation + 1, updated_at = now_value
        WHERE account_id = account_id_value
          AND organization_membership_id = target.id AND status = 'active'
          AND action_name = 'offboard';
        DELETE FROM workspace_memberships
        WHERE account_id = account_id_value AND subject_id = target.subject_id;
        -- Private-session attempts carry the exact authority epoch. Advance it
        -- under each workspace's FORCE-RLS context without touching updated_at
        -- (the session activity commit gate owns that separate concern).
        visibility_capability_id := pg_catalog.gen_random_uuid();
        INSERT INTO session_visibility_write_capabilities (
          backend_pid, transaction_id, capability_id
        ) VALUES (
          pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(),
          visibility_capability_id
        );
        PERFORM pg_catalog.set_config(
          'opengeni.session_visibility_write_capability',
          visibility_capability_id::text, true
        );
        FOR workspace_id_value IN
          SELECT workspace.id
          FROM workspaces workspace
          WHERE workspace.account_id = account_id_value
          ORDER BY workspace.id
        LOOP
          PERFORM pg_catalog.set_config(
            'opengeni.workspace_id', workspace_id_value::text, true
          );
          PERFORM 1 FROM workspace_inference_controls control
          WHERE control.account_id = account_id_value
            AND control.workspace_id = workspace_id_value
          FOR SHARE;
          PERFORM 1 FROM workspaces workspace
          WHERE workspace.account_id = account_id_value
            AND workspace.id = workspace_id_value
          FOR KEY SHARE;
          PERFORM 1 FROM sessions affected
          WHERE affected.account_id = account_id_value
            AND affected.workspace_id = workspace_id_value
            AND (
              affected.owner_organization_membership_id = target.id
              OR EXISTS (
                SELECT 1 FROM session_turns initiated
                WHERE initiated.session_id = affected.id
                  AND initiated.initiating_human_subject_id = target.subject_id
              )
            )
          ORDER BY affected.id
          FOR UPDATE;
          PERFORM 1 FROM session_turns turn_row
          WHERE turn_row.account_id = account_id_value
            AND turn_row.workspace_id = workspace_id_value
            AND EXISTS (
              SELECT 1 FROM sessions owned
              WHERE owned.id = turn_row.session_id
                AND (
                  owned.owner_organization_membership_id = target.id
                  OR turn_row.initiating_human_subject_id = target.subject_id
                )
            )
          ORDER BY turn_row.id
          FOR UPDATE;
          PERFORM 1 FROM session_turn_attempts attempt
          WHERE attempt.account_id = account_id_value
            AND attempt.workspace_id = workspace_id_value
            AND EXISTS (
              SELECT 1 FROM sessions owned
              WHERE owned.id = attempt.session_id
                AND (
                  owned.owner_organization_membership_id = target.id
                  OR EXISTS (
                    SELECT 1 FROM session_turns initiated
                    WHERE initiated.id = attempt.turn_id
                      AND initiated.initiating_human_subject_id = target.subject_id
                  )
                )
            )
          ORDER BY attempt.id
          FOR UPDATE;
          interruption_operation_id := pg_catalog.gen_random_uuid();
          INSERT INTO session_command_receipts (
            id, account_id, workspace_id, actor_type, actor_subject_id,
            action, operation_key, canonical_request_hash, result
          ) VALUES (
            interruption_operation_id, account_id_value, workspace_id_value,
            'human', actor_subject, 'organization.membership.' || action_name,
            'organization-membership:' || operation_id_value::text,
            input_hash_value,
            pg_catalog.jsonb_build_object(
              'organizationMembershipOperationId', operation_id_value,
              'organizationMembershipId', target.id
            )
          );
          INSERT INTO session_attempt_interruptions (
            account_id, workspace_id, session_id, operation_id, attempt_id,
            kind, control_revision
          )
          SELECT attempt.account_id, attempt.workspace_id, attempt.session_id,
            interruption_operation_id, attempt.id, 'authority_change',
            CASE WHEN owned.owner_organization_membership_id = target.id
              THEN owned.authority_epoch + 1 ELSE owned.authority_epoch END
          FROM session_turn_attempts attempt
          JOIN sessions owned ON owned.id = attempt.session_id
          JOIN session_turns initiated ON initiated.id = attempt.turn_id
          WHERE attempt.account_id = account_id_value
            AND attempt.workspace_id = workspace_id_value
            AND (
              owned.owner_organization_membership_id = target.id
              OR initiated.initiating_human_subject_id = target.subject_id
            )
            AND attempt.state IN ('claimed', 'running')
          ON CONFLICT ON CONSTRAINT session_attempt_interruptions_operation_attempt_uq
          DO NOTHING;
          UPDATE session_turns turn_row
          SET status = 'cancelled', cancelled_by = actor_subject,
            cancel_reason = 'authority_changed', finished_at = now_value,
            updated_at = now_value, version = turn_row.version + 1
          WHERE turn_row.account_id = account_id_value
            AND turn_row.workspace_id = workspace_id_value
            AND turn_row.status = 'queued'
            AND EXISTS (
              SELECT 1 FROM sessions owned
              WHERE owned.id = turn_row.session_id
                AND (
                  owned.owner_organization_membership_id = target.id
                  OR turn_row.initiating_human_subject_id = target.subject_id
                )
            );
          UPDATE session_system_updates update_row SET state = 'cancelled'
          WHERE update_row.account_id = account_id_value
            AND update_row.workspace_id = workspace_id_value
            AND update_row.state = 'pending'
            AND EXISTS (
              SELECT 1 FROM sessions owned
              WHERE owned.id = update_row.session_id
                AND owned.owner_organization_membership_id = target.id
            );
          UPDATE session_goals goal_row
          SET status = 'paused', paused_reason = 'api',
            rationale = CASE WHEN action_name = 'suspend'
              THEN 'Organization membership was suspended; explicit reauthorization is required.'
              ELSE 'Organization membership was revoked; explicit reauthorization is required.' END,
            version = goal_row.version + 1, updated_at = now_value
          WHERE goal_row.account_id = account_id_value
            AND goal_row.workspace_id = workspace_id_value
            AND goal_row.status = 'active'
            AND EXISTS (
              SELECT 1 FROM sessions owned
              WHERE owned.id = goal_row.session_id
                AND owned.owner_organization_membership_id = target.id
            );
          UPDATE organization_user_resource_grants grant_row
          SET status = 'revoked', revoked_at = now_value,
            generation = grant_row.generation + 1, updated_at = now_value
          WHERE grant_row.account_id = account_id_value
            AND grant_row.workspace_id = workspace_id_value
            AND grant_row.status = 'active'
            AND EXISTS (
              SELECT 1 FROM sessions owned
              WHERE owned.id = grant_row.session_id
                AND owned.owner_organization_membership_id = target.id
                AND owned.authority_epoch = grant_row.authority_epoch
            );
          WITH advanced AS (
            UPDATE sessions owned SET
              authority_epoch = owned.authority_epoch + 1,
              initial_personal_connection_delegations = '[]'::jsonb,
              last_sequence = owned.last_sequence + 1
            WHERE owned.account_id = account_id_value
              AND owned.workspace_id = workspace_id_value
              AND owned.owner_organization_membership_id = target.id
            RETURNING owned.id, owned.workspace_id, owned.last_sequence,
              owned.authority_epoch
          )
          INSERT INTO session_events (
            account_id, workspace_id, session_id, sequence, type, payload, occurred_at
          )
          SELECT account_id_value, advanced.workspace_id, advanced.id,
            advanced.last_sequence,
            CASE WHEN action_name = 'suspend'
              THEN 'session.authority.suspended' ELSE 'session.authority.revoked' END,
            pg_catalog.jsonb_build_object(
              'operationId', operation_id_value,
              'organizationMembershipId', target.id,
              'previousAuthorityEpoch', advanced.authority_epoch - 1,
              'authorityEpoch', advanced.authority_epoch
            ), now_value
          FROM advanced;
        END LOOP;
        DELETE FROM session_visibility_write_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id()
          AND capability.capability_id = visibility_capability_id;
        PERFORM pg_catalog.set_config(
          'opengeni.session_visibility_write_capability',
          coalesce(previous_visibility_capability, ''), true
        );
        UPDATE organization_memberships SET
          status = CASE WHEN action_name = 'suspend' THEN 'suspended' ELSE 'revoked' END,
          authorization_revision = authorization_revision + 1,
          revoked_at = CASE WHEN action_name = 'offboard' THEN now_value ELSE NULL END,
          personal_retention_until = CASE
            WHEN action_name = 'offboard' AND policy.mode = 'delete_after'
              THEN now_value + pg_catalog.make_interval(days => policy.retention_days)
            ELSE NULL
          END,
          updated_at = now_value
        WHERE id = target.id RETURNING * INTO target;
      END IF;
      result := opengeni_private.organization_membership_row_json(target);
    END IF;
  END IF;

  INSERT INTO organization_membership_operation_receipts (
    account_id, operation_id, action, input_hash, result
  ) VALUES (
    account_id_value, operation_id_value, action_name, input_hash_value, result
  );
  INSERT INTO organization_membership_lifecycle_events (
    account_id, operation_id, actor_membership_id, target_membership_id, kind,
    prior_authorization_revision, resulting_authorization_revision, reason
  ) VALUES (
    account_id_value, operation_id_value, actor.id,
    CASE WHEN target.id IS NULL THEN NULL ELSE target.id END,
    action_name, expected_revision,
    CASE WHEN target.id IS NULL THEN NULL ELSE target.authorization_revision END,
    reason_value
  );
  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', coalesce(previous_workspace, ''), true
  );
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.workspace_id', coalesce(previous_workspace, ''), true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.session_visibility_write_capability',
    coalesce(previous_visibility_capability, ''), true
  );
  RAISE;
END
$body$;

CREATE OR REPLACE FUNCTION get_organization_retention_policy(
  p_account_id uuid,
  p_actor_subject_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE actor organization_memberships%ROWTYPE; policy organization_user_retention_policies%ROWTYPE;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN RAISE EXCEPTION 'organization authority required' USING ERRCODE = '42501'; END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle',
    'organization_membership_lifecycle', true
  );
  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = p_account_id AND membership.subject_id = p_actor_subject_id;
  IF NOT FOUND OR actor.status <> 'active' OR actor.role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'organization administration required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO policy FROM organization_user_retention_policies candidate
  WHERE candidate.account_id = p_account_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'organizationId', p_account_id, 'mode', 'retain',
      'retentionDays', NULL, 'version', 1, 'updatedAt', actor.created_at
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'organizationId', policy.account_id, 'mode', policy.mode,
    'retentionDays', policy.retention_days, 'version', policy.version,
    'updatedAt', policy.updated_at
  );
END
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.organization_retention_file_candidates(
  p_account_id uuid,
  p_membership_id uuid
) RETURNS TABLE(file_id uuid, object_bucket text, object_key text)
LANGUAGE sql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
  WITH member AS (
    SELECT membership.personal_workspace_id
    FROM organization_memberships membership
    WHERE membership.account_id = p_account_id
      AND membership.id = p_membership_id
  ), owned_document_files AS (
    SELECT document.file_id
    FROM documents document
    JOIN organization_user_resource_authorities authority
      ON authority.id = document.authority_id
     AND authority.account_id = document.account_id
     AND authority.organization_membership_id = document.owner_organization_membership_id
     AND authority.resource_kind = 'document'
     AND authority.resource_id = document.id
    WHERE authority.account_id = p_account_id
      AND authority.organization_membership_id = p_membership_id
  )
  SELECT file.id, file.bucket, file.object_key
  FROM files file
  CROSS JOIN member
  WHERE file.account_id = p_account_id
    AND (
      file.workspace_id = member.personal_workspace_id
      OR file.id IN (SELECT owned.file_id FROM owned_document_files owned)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM documents other
      LEFT JOIN organization_user_resource_authorities other_authority
        ON other_authority.id = other.authority_id
       AND other_authority.account_id = other.account_id
       AND other_authority.organization_membership_id = other.owner_organization_membership_id
       AND other_authority.resource_kind = 'document'
       AND other_authority.resource_id = other.id
      WHERE other.file_id = file.id
        AND (
          other_authority.id IS NULL
          OR other_authority.account_id <> p_account_id
          OR other_authority.organization_membership_id <> p_membership_id
        )
    )
  ORDER BY file.id
$body$;

-- Closed inventory of every @opengeni/storage key whose owning metadata is
-- removed with a personal workspace. Provider-native sandbox checkpoint
-- artifacts deliberately do not appear here: their global GC rows survive
-- workspace deletion and remain the sole provider-bound deletion authority.
CREATE OR REPLACE FUNCTION opengeni_private.organization_retention_object_candidates(
  p_account_id uuid,
  p_membership_id uuid
) RETURNS TABLE(object_kind text, source_id text, object_bucket text, object_key text)
LANGUAGE sql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
  WITH member AS (
    SELECT membership.personal_workspace_id
    FROM organization_memberships membership
    WHERE membership.account_id = p_account_id
      AND membership.id = p_membership_id
  )
  SELECT 'file'::text, candidate.file_id::text, candidate.object_bucket, candidate.object_key
  FROM opengeni_private.organization_retention_file_candidates(
    p_account_id, p_membership_id
  ) candidate
  UNION ALL
  SELECT 'session_recording', recording.id::text, NULL::text, recording.storage_key
  FROM session_recordings recording CROSS JOIN member
  WHERE recording.account_id = p_account_id
    AND recording.workspace_id = member.personal_workspace_id
    AND recording.storage_key IS NOT NULL
  UNION ALL
  SELECT 'browser_state_artifact', artifact.id::text, NULL::text, artifact.object_key
  FROM browser_state_artifacts artifact CROSS JOIN member
  WHERE artifact.account_id = p_account_id
    AND artifact.workspace_id = member.personal_workspace_id
    AND artifact.state <> 'deleted'
  UNION ALL
  SELECT 'browser_state_upload', upload.id::text, NULL::text, upload.object_key
  FROM browser_state_uploads upload CROSS JOIN member
  WHERE upload.account_id = p_account_id
    AND upload.workspace_id = member.personal_workspace_id
    AND upload.state <> 'deleted'
    AND (
      upload.state <> 'committed'
      OR NOT EXISTS (
        SELECT 1
        FROM browser_state_artifacts committed
        WHERE committed.account_id = upload.account_id
          AND committed.workspace_id = upload.workspace_id
          AND committed.id = upload.committed_artifact_id
          AND committed.object_key = upload.object_key
          AND committed.state <> 'deleted'
      )
    )
  UNION ALL
  SELECT 'transcription_recording_object',
    recording_object.recording_id::text || ':' || encode(
      digest(recording_object.object_key, 'sha256'), 'hex'
    ),
    NULL::text,
    recording_object.object_key
  FROM transcription_recording_objects recording_object CROSS JOIN member
  WHERE recording_object.account_id = p_account_id
    AND recording_object.workspace_id = member.personal_workspace_id
    AND recording_object.cleaned_at IS NULL
  UNION ALL
  SELECT 'video_staging_reference',
    reference.operation_id::text || ':' || reference.ordinal::text,
    NULL::text,
    reference.staging_object_key
  FROM video_generation_references reference CROSS JOIN member
  WHERE reference.account_id = p_account_id
    AND reference.workspace_id = member.personal_workspace_id
    AND reference.staging_object_key IS NOT NULL
    AND reference.cleaned_at IS NULL
  UNION ALL
  SELECT 'workspace_artifact_version', version.id::text, NULL::text, version.content_key
  FROM workspace_artifact_versions version CROSS JOIN member
  WHERE version.account_id = p_account_id
    AND version.workspace_id = member.personal_workspace_id
  UNION ALL
  SELECT 'editable_artifact_blob',
    blob.artifact_id || ':' || blob.id,
    NULL::text,
    blob.object_reference
  FROM editable_artifact_blob_refs blob CROSS JOIN member
  WHERE blob.account_id = p_account_id
    AND blob.workspace_id = member.personal_workspace_id
  UNION ALL
  SELECT 'workspace_capture_manifest', capture.id::text, NULL::text, capture.manifest_key
  FROM workspace_captures capture CROSS JOIN member
  WHERE capture.account_id = p_account_id
    AND capture.workspace_id = member.personal_workspace_id
    AND capture.manifest_key IS NOT NULL
  UNION ALL
  SELECT 'workspace_capture_tree_index', capture.id::text, NULL::text, capture.tree_index_key
  FROM workspace_captures capture CROSS JOIN member
  WHERE capture.account_id = p_account_id
    AND capture.workspace_id = member.personal_workspace_id
    AND capture.tree_index_key IS NOT NULL
  UNION ALL
  SELECT 'workspace_capture_blob',
    capture.id::text || ':' || blob.ordinality::text,
    NULL::text,
    blob.value #>> '{}'
  FROM workspace_captures capture CROSS JOIN member
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(capture.blob_keys) = 'array'
      THEN capture.blob_keys ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS blob(value, ordinality)
  WHERE capture.account_id = p_account_id
    AND capture.workspace_id = member.personal_workspace_id
    AND jsonb_typeof(blob.value) = 'string'
  ORDER BY 1, 2
$body$;

CREATE OR REPLACE FUNCTION preview_organization_retention_deletions(
  p_account_id uuid,
  p_limit integer DEFAULT 25
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE result jsonb;
BEGIN
  IF p_account_id IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid retention preview input' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'membershipId', candidate.id,
    'retentionUntil', candidate.personal_retention_until,
    'personalWorkspaceId', candidate.personal_workspace_id,
    'resourceCount', candidate.resource_count,
    'objectCount', candidate.object_count
  ) ORDER BY candidate.personal_retention_until, candidate.id), '[]'::jsonb)
  INTO result
  FROM (
    SELECT membership.id, membership.personal_retention_until,
      membership.personal_workspace_id,
      (SELECT count(*)::integer FROM organization_user_resource_authorities authority
       WHERE authority.account_id = p_account_id
         AND authority.organization_membership_id = membership.id) AS resource_count,
      CASE WHEN deletion.database_finalized_at IS NOT NULL THEN
        (SELECT count(*)::integer
         FROM organization_user_retention_object_obligations receipt
         WHERE receipt.account_id = p_account_id
           AND receipt.membership_id = membership.id
           AND NOT EXISTS (
             SELECT 1
             FROM organization_user_retention_object_deletion_receipts deleted
             WHERE deleted.account_id = receipt.account_id
               AND deleted.membership_id = receipt.membership_id
               AND deleted.object_kind = receipt.object_kind
               AND deleted.source_id = receipt.source_id
               AND deleted.object_bucket = receipt.object_bucket
           ))
      ELSE
        (SELECT count(*)::integer
         FROM opengeni_private.organization_retention_object_candidates(
           p_account_id, membership.id
         ))
      END AS object_count
    FROM organization_memberships membership
    LEFT JOIN organization_user_retention_deletions deletion
      ON deletion.account_id = membership.account_id
     AND deletion.membership_id = membership.id
    WHERE membership.account_id = p_account_id
      AND membership.status = 'revoked'
      AND membership.personal_retention_until IS NOT NULL
      AND membership.personal_retention_until <= clock_timestamp()
      AND (deletion.state IS NULL OR deletion.state <> 'completed')
    ORDER BY membership.personal_retention_until, membership.id
    LIMIT p_limit
  ) candidate;
  RETURN result;
END
$body$;

CREATE OR REPLACE FUNCTION claim_organization_retention_deletion(
  p_account_id uuid,
  p_operation_id uuid,
  p_excluded_membership_ids uuid[] DEFAULT ARRAY[]::uuid[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  member organization_memberships%ROWTYPE;
  deletion organization_user_retention_deletions%ROWTYPE;
  prior_event organization_user_retention_deletion_events%ROWTYPE;
  result_value jsonb;
  object_count integer;
  deleted_object_count integer;
BEGIN
  IF p_account_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'invalid retention claim input' USING ERRCODE = '22023';
  END IF;
  IF coalesce(pg_catalog.array_length(p_excluded_membership_ids, 1), 0) > 100 THEN
    RAISE EXCEPTION 'too many excluded retention memberships' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-retention:' || p_operation_id::text, 0)
  );
  SELECT * INTO prior_event
  FROM organization_user_retention_deletion_events event
  WHERE event.account_id = p_account_id AND event.operation_id = p_operation_id
  ORDER BY CASE event.kind WHEN 'completed' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END
  LIMIT 1;
  IF FOUND THEN
    IF prior_event.kind = 'failed' THEN
      RAISE EXCEPTION 'retention operation previously failed: %', prior_event.reason_code
        USING ERRCODE = '55000';
    END IF;
    RETURN prior_event.result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM organization_user_retention_deletion_events event
    WHERE event.operation_id = p_operation_id AND event.account_id <> p_account_id
  ) THEN
    RAISE EXCEPTION 'retention operation belongs to another organization'
      USING ERRCODE = '42501';
  END IF;

  SELECT membership.* INTO member
  FROM organization_memberships membership
  LEFT JOIN organization_user_retention_deletions current_deletion
    ON current_deletion.account_id = membership.account_id
   AND current_deletion.membership_id = membership.id
  WHERE membership.account_id = p_account_id
    AND NOT (membership.id = ANY(p_excluded_membership_ids))
    AND membership.status = 'revoked'
    AND membership.personal_retention_until IS NOT NULL
    AND membership.personal_retention_until <= clock_timestamp()
    AND (
      current_deletion.state IS NULL
      OR current_deletion.state = 'failed'
      OR (current_deletion.state = 'claimed'
        AND current_deletion.claim_expires_at <= clock_timestamp())
    )
  ORDER BY membership.personal_retention_until, membership.id
  FOR UPDATE OF membership SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  INSERT INTO organization_user_retention_deletions (
    account_id, membership_id, retention_until, state, claim_operation_id,
    claim_expires_at, attempt_count, updated_at
  ) VALUES (
    p_account_id, member.id, member.personal_retention_until, 'claimed',
    p_operation_id, clock_timestamp() + interval '15 minutes', 1, clock_timestamp()
  )
  ON CONFLICT (account_id, membership_id) DO UPDATE SET
    retention_until = EXCLUDED.retention_until,
    state = 'claimed',
    claim_operation_id = EXCLUDED.claim_operation_id,
    claim_expires_at = EXCLUDED.claim_expires_at,
    attempt_count = organization_user_retention_deletions.attempt_count + 1,
    result = NULL,
    completed_at = NULL,
    updated_at = clock_timestamp()
  RETURNING * INTO deletion;

  IF deletion.database_finalized_at IS NULL THEN
    SELECT count(*)::integer INTO object_count
    FROM opengeni_private.organization_retention_object_candidates(p_account_id, member.id);
  ELSE
    SELECT count(*)::integer INTO object_count
    FROM organization_user_retention_object_obligations receipt
    WHERE receipt.account_id = p_account_id AND receipt.membership_id = member.id;
  END IF;
  SELECT count(*)::integer INTO deleted_object_count
  FROM organization_user_retention_object_deletion_receipts receipt
  WHERE receipt.account_id = p_account_id AND receipt.membership_id = member.id;
  result_value := pg_catalog.jsonb_build_object(
    'organizationId', p_account_id,
    'membershipId', member.id,
    'operationId', p_operation_id,
    'retentionUntil', member.personal_retention_until,
    'claimExpiresAt', deletion.claim_expires_at,
    'personalWorkspaceId', member.personal_workspace_id,
    'objectCount', object_count,
    'deletedObjectCount', deleted_object_count
  );
  INSERT INTO organization_user_retention_deletion_events (
    account_id, membership_id, operation_id, kind, result
  ) VALUES (p_account_id, member.id, p_operation_id, 'claimed', result_value);
  RETURN result_value;
END
$body$;

CREATE OR REPLACE FUNCTION list_organization_retention_deletion_objects(
  p_account_id uuid,
  p_membership_id uuid,
  p_operation_id uuid,
  p_object_bucket text,
  p_limit integer DEFAULT 100
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE result jsonb;
BEGIN
  IF nullif(p_object_bucket, '') IS NULL
    OR octet_length(convert_to(p_object_bucket, 'UTF8')) > 1024
  THEN
    RAISE EXCEPTION 'invalid retention object bucket' USING ERRCODE = '22023';
  END IF;
  IF p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid retention object page size' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  UPDATE organization_user_retention_deletions deletion
  SET claim_expires_at = clock_timestamp() + interval '15 minutes', updated_at = clock_timestamp()
  WHERE deletion.account_id = p_account_id
    AND deletion.membership_id = p_membership_id
    AND deletion.claim_operation_id = p_operation_id
    AND deletion.state = 'claimed'
    AND deletion.claim_expires_at > clock_timestamp()
    AND deletion.database_finalized_at IS NOT NULL
    AND deletion.database_result ->> 'objectBucket' = p_object_bucket;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention deletion claim is stale' USING ERRCODE = '40001';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'objectKind', candidate.object_kind,
    'sourceId', candidate.source_id,
    'objectBucket', candidate.object_bucket,
    'objectKey', candidate.object_key
  ) ORDER BY candidate.object_kind, candidate.source_id), '[]'::jsonb)
  INTO result
  FROM (
    SELECT receipt.object_kind, receipt.source_id, receipt.object_bucket, receipt.object_key
    FROM organization_user_retention_object_obligations receipt
    WHERE receipt.account_id = p_account_id
      AND receipt.membership_id = p_membership_id
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_retention_object_deletion_receipts deleted
        WHERE deleted.account_id = receipt.account_id
          AND deleted.membership_id = receipt.membership_id
          AND deleted.object_kind = receipt.object_kind
          AND deleted.source_id = receipt.source_id
          AND deleted.object_bucket = receipt.object_bucket
      )
    ORDER BY receipt.object_kind, receipt.source_id
    LIMIT p_limit
  ) candidate;
  RETURN result;
END
$body$;

CREATE OR REPLACE FUNCTION record_organization_retention_object_deleted(
  p_account_id uuid,
  p_membership_id uuid,
  p_operation_id uuid,
  p_object_kind text,
  p_source_id text,
  p_object_bucket text,
  p_object_key text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE obligation organization_user_retention_object_obligations%ROWTYPE;
BEGIN
  IF p_object_kind NOT IN (
      'file', 'session_recording', 'browser_state_artifact', 'browser_state_upload',
      'transcription_recording_object', 'video_staging_reference',
      'workspace_artifact_version', 'editable_artifact_blob',
      'workspace_capture_manifest', 'workspace_capture_tree_index',
      'workspace_capture_blob'
    )
    OR nullif(p_source_id, '') IS NULL
    OR octet_length(convert_to(p_source_id, 'UTF8')) > 2048
    OR nullif(p_object_bucket, '') IS NULL
    OR octet_length(convert_to(p_object_bucket, 'UTF8')) > 1024
    OR nullif(p_object_key, '') IS NULL
    OR octet_length(convert_to(p_object_key, 'UTF8')) > 4096
  THEN RAISE EXCEPTION 'invalid retention object key' USING ERRCODE = '22023'; END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  UPDATE organization_user_retention_deletions deletion
  SET claim_expires_at = clock_timestamp() + interval '15 minutes', updated_at = clock_timestamp()
  WHERE deletion.account_id = p_account_id
    AND deletion.membership_id = p_membership_id
    AND deletion.claim_operation_id = p_operation_id
    AND deletion.state = 'claimed'
    AND deletion.claim_expires_at > clock_timestamp()
    AND deletion.database_finalized_at IS NOT NULL
    AND deletion.database_result ->> 'objectBucket' = p_object_bucket;
  IF NOT FOUND THEN RAISE EXCEPTION 'retention deletion claim is stale' USING ERRCODE = '40001'; END IF;
  SELECT * INTO obligation
  FROM organization_user_retention_object_obligations receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.membership_id = p_membership_id
    AND receipt.object_kind = p_object_kind
    AND receipt.source_id = p_source_id
    AND receipt.object_bucket = p_object_bucket
  FOR UPDATE;
  IF NOT FOUND OR obligation.object_key IS DISTINCT FROM p_object_key
    OR obligation.object_key_hash <> encode(digest(p_object_key, 'sha256'), 'hex')
  THEN
    RAISE EXCEPTION 'retention object is outside the exact claim' USING ERRCODE = '42501';
  END IF;
  INSERT INTO organization_user_retention_object_deletion_receipts (
    account_id, membership_id, object_kind, source_id, object_bucket, operation_id
  ) VALUES (
    p_account_id, p_membership_id, p_object_kind, p_source_id, p_object_bucket, p_operation_id
  ) ON CONFLICT (account_id, membership_id, object_kind, source_id, object_bucket) DO NOTHING;
  RETURN FOUND;
END
$body$;

CREATE OR REPLACE FUNCTION fail_organization_retention_deletion(
  p_account_id uuid,
  p_membership_id uuid,
  p_operation_id uuid,
  p_reason_code text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE event_result jsonb;
BEGIN
  IF p_reason_code !~ '^[a-z0-9_]{1,64}$' THEN
    RAISE EXCEPTION 'invalid retention failure code' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  UPDATE organization_user_retention_deletions deletion
  SET state = 'failed', claim_expires_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE deletion.account_id = p_account_id
    AND deletion.membership_id = p_membership_id
    AND deletion.claim_operation_id = p_operation_id
    AND deletion.state = 'claimed';
  IF NOT FOUND THEN
    RETURN EXISTS (
      SELECT 1 FROM organization_user_retention_deletion_events event
      WHERE event.account_id = p_account_id AND event.operation_id = p_operation_id
        AND event.kind = 'failed' AND event.reason_code = p_reason_code
    );
  END IF;
  event_result := pg_catalog.jsonb_build_object(
    'organizationId', p_account_id, 'membershipId', p_membership_id,
    'operationId', p_operation_id, 'outcome', 'failed', 'reasonCode', p_reason_code
  );
  INSERT INTO organization_user_retention_deletion_events (
    account_id, membership_id, operation_id, kind, reason_code, result
  ) VALUES (
    p_account_id, p_membership_id, p_operation_id, 'failed', p_reason_code, event_result
  ) ON CONFLICT (account_id, operation_id, kind) DO NOTHING;
  RETURN true;
END
$body$;

CREATE OR REPLACE FUNCTION finalize_organization_retention_deletion(
  p_account_id uuid,
  p_membership_id uuid,
  p_operation_id uuid,
  p_object_bucket text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  member organization_memberships%ROWTYPE;
  deletion organization_user_retention_deletions%ROWTYPE;
  prior_event organization_user_retention_deletion_events%ROWTYPE;
  unsupported_kind text;
  candidate_file_ids uuid[];
  deleted_documents integer := 0;
  deleted_files integer := 0;
  deleted_variable_sets integer := 0;
  deleted_rigs integer := 0;
  deleted_connections integer := 0;
  deleted_codex integer := 0;
  deleted_xai integer := 0;
  tombstoned_machines integer := 0;
  deleted_workspace integer := 0;
  object_count integer := 0;
  locked_personal_workspace_id uuid;
  result_value jsonb;
BEGIN
  IF nullif(p_object_bucket, '') IS NULL
    OR octet_length(convert_to(p_object_bucket, 'UTF8')) > 1024
  THEN
    RAISE EXCEPTION 'invalid retention object bucket' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  SELECT * INTO prior_event FROM organization_user_retention_deletion_events event
  WHERE event.account_id = p_account_id AND event.operation_id = p_operation_id
    AND event.kind = 'completed';
  IF FOUND THEN
    SELECT candidate.database_result INTO result_value
    FROM organization_user_retention_deletions candidate
    WHERE candidate.account_id = p_account_id
      AND candidate.membership_id = p_membership_id;
    RETURN result_value;
  END IF;
  SELECT * INTO member FROM organization_memberships membership
  WHERE membership.account_id = p_account_id AND membership.id = p_membership_id;
  IF NOT FOUND OR member.status <> 'revoked'
    OR member.personal_retention_until IS NULL
    OR member.personal_retention_until > clock_timestamp()
  THEN RAISE EXCEPTION 'retention membership is not eligible' USING ERRCODE = '42501'; END IF;
  locked_personal_workspace_id := member.personal_workspace_id;
  IF locked_personal_workspace_id IS NOT NULL THEN
    PERFORM 1 FROM workspaces workspace
    WHERE workspace.account_id = p_account_id
      AND workspace.id = locked_personal_workspace_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'retention personal workspace is missing' USING ERRCODE = '40001';
    END IF;
  END IF;
  SELECT * INTO member FROM organization_memberships membership
  WHERE membership.account_id = p_account_id AND membership.id = p_membership_id
  FOR UPDATE;
  IF NOT FOUND OR member.status <> 'revoked'
    OR member.personal_retention_until IS NULL
    OR member.personal_retention_until > clock_timestamp()
    OR member.personal_workspace_id IS DISTINCT FROM locked_personal_workspace_id
  THEN RAISE EXCEPTION 'retention membership changed during finalization'
    USING ERRCODE = '40001'; END IF;
  SELECT * INTO deletion FROM organization_user_retention_deletions candidate
  WHERE candidate.account_id = p_account_id AND candidate.membership_id = p_membership_id
  FOR UPDATE;
  IF NOT FOUND OR deletion.state <> 'claimed'
    OR deletion.claim_operation_id <> p_operation_id
    OR deletion.claim_expires_at <= clock_timestamp()
  THEN RAISE EXCEPTION 'retention deletion claim is stale' USING ERRCODE = '40001'; END IF;
  IF deletion.retention_until IS DISTINCT FROM member.personal_retention_until THEN
    RAISE EXCEPTION 'retention deadline changed after claim' USING ERRCODE = '40001';
  END IF;
  IF deletion.database_finalized_at IS NOT NULL THEN
    IF deletion.database_result ->> 'objectBucket' IS DISTINCT FROM p_object_bucket
      OR EXISTS (
        SELECT 1 FROM organization_user_retention_object_obligations obligation
        WHERE obligation.account_id = p_account_id
          AND obligation.membership_id = p_membership_id
          AND obligation.object_bucket <> p_object_bucket
      )
    THEN
      RAISE EXCEPTION 'retention object bucket changed after database finalization'
        USING ERRCODE = '40001';
    END IF;
    RETURN pg_catalog.jsonb_set(
      deletion.database_result,
      '{operationId}',
      pg_catalog.to_jsonb(p_operation_id::text),
      false
    );
  END IF;
  IF member.personal_workspace_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM documents document
    LEFT JOIN organization_user_resource_authorities authority
      ON authority.id = document.authority_id
     AND authority.account_id = document.account_id
     AND authority.organization_membership_id = document.owner_organization_membership_id
     AND authority.resource_kind = 'document'
     AND authority.resource_id = document.id
    WHERE document.account_id = p_account_id
      AND document.workspace_id = member.personal_workspace_id
      AND (
        authority.id IS NULL
        OR authority.organization_membership_id <> p_membership_id
      )
  ) THEN
    RAISE EXCEPTION 'personal workspace contains retained external document authority'
      USING ERRCODE = '55000';
  END IF;
  IF member.personal_workspace_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM workspace_captures capture
    WHERE capture.account_id = p_account_id
      AND capture.workspace_id = member.personal_workspace_id
      AND (
        pg_catalog.jsonb_typeof(capture.blob_keys) <> 'array'
        OR CASE WHEN pg_catalog.jsonb_typeof(capture.blob_keys) = 'array' THEN EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(capture.blob_keys) blob(value)
            WHERE pg_catalog.jsonb_typeof(blob.value) <> 'string'
              OR octet_length(convert_to(blob.value #>> '{}', 'UTF8')) NOT BETWEEN 1 AND 4096
          ) ELSE false END
      )
  ) THEN
    RAISE EXCEPTION 'personal workspace contains malformed external object inventory'
      USING ERRCODE = '55000';
  END IF;
  SELECT authority.resource_kind INTO unsupported_kind
  FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind NOT IN (
      'codex_subscription', 'connected_machine', 'connection', 'document',
      'rig', 'variable_set', 'xai_subscription'
    )
  ORDER BY authority.resource_kind LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'unsupported retained resource kind: %', unsupported_kind
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
  ORDER BY authority.id FOR UPDATE;
  SELECT COALESCE(array_agg(candidate.file_id ORDER BY candidate.file_id), ARRAY[]::uuid[])
  INTO candidate_file_ids
  FROM opengeni_private.organization_retention_file_candidates(
    p_account_id, p_membership_id
  ) candidate;
  PERFORM 1 FROM files file
  WHERE file.account_id = p_account_id AND file.id = ANY(candidate_file_ids)
  ORDER BY file.id FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM opengeni_private.organization_retention_file_candidates(
      p_account_id, p_membership_id
    ) candidate
    WHERE candidate.object_bucket IS DISTINCT FROM p_object_bucket
  ) THEN
    RAISE EXCEPTION 'retention file bucket differs from configured object storage'
      USING ERRCODE = '55000';
  END IF;
  -- Freeze every external-key source before materializing obligations. The
  -- workspace row above excludes new FK children; these row locks exclude key
  -- rotation while exact obligations are copied and the workspace is erased.
  PERFORM 1 FROM session_recordings recording
  WHERE recording.account_id = p_account_id
    AND recording.workspace_id = member.personal_workspace_id
  ORDER BY recording.id FOR UPDATE;
  PERFORM 1 FROM browser_state_artifacts artifact
  WHERE artifact.account_id = p_account_id
    AND artifact.workspace_id = member.personal_workspace_id
  ORDER BY artifact.id FOR UPDATE;
  PERFORM 1 FROM browser_state_uploads upload
  WHERE upload.account_id = p_account_id
    AND upload.workspace_id = member.personal_workspace_id
  ORDER BY upload.id FOR UPDATE;
  PERFORM 1 FROM transcription_recording_objects recording_object
  WHERE recording_object.account_id = p_account_id
    AND recording_object.workspace_id = member.personal_workspace_id
  ORDER BY recording_object.object_key FOR UPDATE;
  PERFORM 1 FROM video_generation_references reference
  WHERE reference.account_id = p_account_id
    AND reference.workspace_id = member.personal_workspace_id
  ORDER BY reference.operation_id, reference.ordinal FOR UPDATE;
  PERFORM 1 FROM workspace_artifact_versions version
  WHERE version.account_id = p_account_id
    AND version.workspace_id = member.personal_workspace_id
  ORDER BY version.id FOR UPDATE;
  PERFORM 1 FROM editable_artifact_blob_refs blob
  WHERE blob.account_id = p_account_id
    AND blob.workspace_id = member.personal_workspace_id
  ORDER BY blob.artifact_id, blob.id FOR UPDATE;
  PERFORM 1 FROM workspace_captures capture
  WHERE capture.account_id = p_account_id
    AND capture.workspace_id = member.personal_workspace_id
  ORDER BY capture.id FOR UPDATE;
  INSERT INTO organization_user_retention_object_obligations (
    account_id, membership_id, object_kind, source_id, object_bucket, object_key,
    prepared_operation_id, object_key_hash
  )
  SELECT p_account_id, p_membership_id, candidate.object_kind,
    candidate.source_id, p_object_bucket, candidate.object_key, p_operation_id,
    encode(digest(candidate.object_key, 'sha256'), 'hex')
  FROM opengeni_private.organization_retention_object_candidates(
    p_account_id, p_membership_id
  ) candidate;
  GET DIAGNOSTICS object_count = ROW_COUNT;

  DELETE FROM documents document
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'document'
    AND authority.resource_id = document.id
    AND document.account_id = authority.account_id
    AND document.authority_id = authority.id
    AND document.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_documents = ROW_COUNT;
  DELETE FROM files file
  WHERE file.account_id = p_account_id AND file.id = ANY(candidate_file_ids)
    AND NOT EXISTS (SELECT 1 FROM documents document WHERE document.file_id = file.id);
  GET DIAGNOSTICS deleted_files = ROW_COUNT;

  UPDATE scheduled_tasks task SET status = 'paused', variable_set_id = NULL,
    authority_revision = authority_revision + 1, updated_at = clock_timestamp()
  WHERE task.account_id = p_account_id AND task.variable_set_id IN (
    SELECT authority.resource_id FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_account_id
      AND authority.organization_membership_id = p_membership_id
      AND authority.resource_kind = 'variable_set'
  );
  DELETE FROM workspace_variable_sets resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'variable_set'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_variable_sets = ROW_COUNT;

  UPDATE capability_facet_installations binding SET connection_id = NULL,
    status = 'needs_attention',
    attention_code = 'owner_retention_deleted',
    version = version + 1, updated_at = clock_timestamp()
  WHERE binding.account_id = p_account_id AND binding.connection_id IN (
    SELECT authority.resource_id FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_account_id
      AND authority.organization_membership_id = p_membership_id
      AND authority.resource_kind = 'connection'
  );
  UPDATE integration_facet_bindings binding SET connection_id = NULL,
    status = 'needs_attention',
    last_error_code = 'owner_retention_deleted',
    version = version + 1, updated_at = clock_timestamp()
  WHERE binding.account_id = p_account_id AND binding.connection_id IN (
    SELECT authority.resource_id FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_account_id
      AND authority.organization_membership_id = p_membership_id
      AND authority.resource_kind = 'connection'
  );
  DELETE FROM connections resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'connection'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_connections = ROW_COUNT;

  DELETE FROM codex_subscription_credentials resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'codex_subscription'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.organization_user_resource_authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_codex = ROW_COUNT;
  DELETE FROM xai_subscription_credentials resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'xai_subscription'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.organization_user_resource_authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_xai = ROW_COUNT;

  DELETE FROM rigs resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'rig'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_rigs = ROW_COUNT;

  UPDATE enrollments resource SET status = 'revoked',
    revoked_at = COALESCE(resource.revoked_at, clock_timestamp()),
    generation = resource.generation + 1, connection_instance_id = NULL,
    connection_lease_expires_at = NULL, desktop_unavailable_reason = NULL,
    updated_at = clock_timestamp()
  FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'connected_machine'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS tombstoned_machines = ROW_COUNT;

  UPDATE organization_user_resource_authorities authority
  SET status = 'revoked', revoked_at = COALESCE(authority.revoked_at, clock_timestamp()),
    generation = authority.generation + 1, updated_at = clock_timestamp()
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.status <> 'revoked';
  UPDATE organization_memberships membership
  SET personal_workspace_id = NULL, updated_at = clock_timestamp()
  WHERE membership.account_id = p_account_id AND membership.id = p_membership_id;
  IF member.personal_workspace_id IS NOT NULL THEN
    DELETE FROM workspaces workspace
    WHERE workspace.account_id = p_account_id AND workspace.id = member.personal_workspace_id;
    GET DIAGNOSTICS deleted_workspace = ROW_COUNT;
  END IF;
  result_value := pg_catalog.jsonb_build_object(
    'organizationId', p_account_id,
    'membershipId', p_membership_id,
    'operationId', p_operation_id,
    'outcome', 'cleanup_pending',
    'objectBucket', p_object_bucket,
    'objectCount', object_count,
    'deletedResources', pg_catalog.jsonb_build_object(
      'documents', deleted_documents, 'files', deleted_files,
      'variableSets', deleted_variable_sets, 'rigs', deleted_rigs,
      'connections', deleted_connections, 'codexSubscriptions', deleted_codex,
      'xaiSubscriptions', deleted_xai, 'connectedMachinesTombstoned', tombstoned_machines,
      'personalWorkspaces', deleted_workspace
    ),
    'databaseFinalizedAt', clock_timestamp()
  );
  UPDATE organization_user_retention_deletions current_deletion
  SET database_result = result_value, database_finalized_at = clock_timestamp(),
    claim_expires_at = clock_timestamp() + interval '15 minutes',
    updated_at = clock_timestamp()
  WHERE current_deletion.account_id = p_account_id
    AND current_deletion.membership_id = p_membership_id
    AND current_deletion.claim_operation_id = p_operation_id;
  RETURN result_value;
END
$body$;

CREATE OR REPLACE FUNCTION complete_organization_retention_deletion(
  p_account_id uuid,
  p_membership_id uuid,
  p_operation_id uuid,
  p_object_bucket text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  deletion organization_user_retention_deletions%ROWTYPE;
  prior_event organization_user_retention_deletion_events%ROWTYPE;
  result_value jsonb;
  object_count integer;
BEGIN
  IF nullif(p_object_bucket, '') IS NULL
    OR octet_length(convert_to(p_object_bucket, 'UTF8')) > 1024
  THEN
    RAISE EXCEPTION 'invalid retention object bucket' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  SELECT * INTO prior_event
  FROM organization_user_retention_deletion_events event
  WHERE event.account_id = p_account_id
    AND event.operation_id = p_operation_id
    AND event.kind = 'completed';
  IF FOUND THEN RETURN prior_event.result; END IF;
  SELECT * INTO deletion
  FROM organization_user_retention_deletions candidate
  WHERE candidate.account_id = p_account_id
    AND candidate.membership_id = p_membership_id
  FOR UPDATE;
  IF NOT FOUND OR deletion.state <> 'claimed'
    OR deletion.claim_operation_id <> p_operation_id
    OR deletion.claim_expires_at <= clock_timestamp()
    OR deletion.database_finalized_at IS NULL
    OR deletion.database_result ->> 'objectBucket' IS DISTINCT FROM p_object_bucket
  THEN
    RAISE EXCEPTION 'retention deletion claim is stale' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM organization_user_retention_object_obligations receipt
    WHERE receipt.account_id = p_account_id
      AND receipt.membership_id = p_membership_id
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_retention_object_deletion_receipts deleted
        WHERE deleted.account_id = receipt.account_id
          AND deleted.membership_id = receipt.membership_id
          AND deleted.object_kind = receipt.object_kind
          AND deleted.source_id = receipt.source_id
          AND deleted.object_bucket = receipt.object_bucket
      )
  ) THEN
    RAISE EXCEPTION 'retention object cleanup remains incomplete' USING ERRCODE = '55000';
  END IF;
  SELECT count(*)::integer INTO object_count
  FROM organization_user_retention_object_obligations receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.membership_id = p_membership_id;
  result_value := pg_catalog.jsonb_build_object(
    'organizationId', p_account_id,
    'membershipId', p_membership_id,
    'operationId', p_operation_id,
    'outcome', 'completed',
    'deletedResources', deletion.database_result -> 'deletedResources'
      || pg_catalog.jsonb_build_object('externalObjects', object_count),
    'completedAt', clock_timestamp()
  );
  UPDATE organization_user_retention_deletions current_deletion
  SET state = 'completed', result = result_value, completed_at = clock_timestamp(),
    claim_expires_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE current_deletion.account_id = p_account_id
    AND current_deletion.membership_id = p_membership_id
    AND current_deletion.claim_operation_id = p_operation_id;
  INSERT INTO organization_user_retention_deletion_events (
    account_id, membership_id, operation_id, kind, result
  ) VALUES (p_account_id, p_membership_id, p_operation_id, 'completed', result_value);
  RETURN result_value;
END
$body$;

-- Pin every SECURITY DEFINER routine after creation. FROM CURRENT is used only
-- while parsing the target-schema migration; the durable posture is closed.
DO $pin_and_grant$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.assign_managed_self_organization_owner() SET search_path = pg_catalog, %I, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.list_self_organization_memberships(text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.list_self_organization_invitations(text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.list_self_organization_invitations(text,uuid,integer) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.get_self_organization_invitation(text,uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.list_organization_members(uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.list_organization_invitations(uuid,text,uuid,integer) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.organization_membership_command(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.get_organization_retention_policy(uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.organization_retention_file_candidates(uuid,uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.organization_retention_object_candidates(uuid,uuid) SET search_path = pg_catalog, %I, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.preview_organization_retention_deletions(uuid,integer) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.claim_organization_retention_deletion(uuid,uuid,uuid[]) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.list_organization_retention_deletion_objects(uuid,uuid,uuid,text,integer) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.record_organization_retention_object_deleted(uuid,uuid,uuid,text,text,text,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.fail_organization_retention_deletion(uuid,uuid,uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.finalize_organization_retention_deletion(uuid,uuid,uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.complete_organization_retention_deletion(uuid,uuid,uuid,text) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.assign_managed_self_organization_owner() TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.organization_membership_row_json(organization_memberships) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.organization_invitation_row_json(organization_membership_invitations) TO opengeni_app;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.list_self_organization_memberships(text) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.list_self_organization_invitations(text) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.list_self_organization_invitations(text,uuid,integer) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.get_self_organization_invitation(text,uuid) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.list_organization_members(uuid,text) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.list_organization_invitations(uuid,text,uuid,integer) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.organization_membership_command(jsonb) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.get_organization_retention_policy(uuid,text) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.preview_organization_retention_deletions(uuid,integer) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.claim_organization_retention_deletion(uuid,uuid,uuid[]) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.list_organization_retention_deletion_objects(uuid,uuid,uuid,text,integer) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.record_organization_retention_object_deleted(uuid,uuid,uuid,text,text,text,text) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.fail_organization_retention_deletion(uuid,uuid,uuid,text) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.finalize_organization_retention_deletion(uuid,uuid,uuid,text) TO opengeni_app', data_schema);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.complete_organization_retention_deletion(uuid,uuid,uuid,text) TO opengeni_app', data_schema);
  END IF;
END
$pin_and_grant$;

REVOKE ALL ON FUNCTION opengeni_private.organization_membership_row_json(organization_memberships) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.organization_invitation_row_json(organization_membership_invitations) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.assign_managed_self_organization_owner() FROM PUBLIC;
REVOKE ALL ON FUNCTION list_self_organization_memberships(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_self_organization_invitations(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_self_organization_invitations(text,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_self_organization_invitation(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_organization_members(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_organization_invitations(uuid,text,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION organization_membership_command(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION get_organization_retention_policy(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.organization_retention_file_candidates(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.organization_retention_object_candidates(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION preview_organization_retention_deletions(uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_organization_retention_deletion(uuid,uuid,uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_organization_retention_deletion_objects(uuid,uuid,uuid,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_organization_retention_object_deleted(uuid,uuid,uuid,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fail_organization_retention_deletion(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finalize_organization_retention_deletion(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_organization_retention_deletion(uuid,uuid,uuid,text) FROM PUBLIC;

REVOKE ALL ON TABLE organization_memberships FROM PUBLIC;
REVOKE ALL ON TABLE organization_user_retention_policies FROM PUBLIC;
REVOKE ALL ON TABLE organization_membership_invitations FROM PUBLIC;
REVOKE ALL ON TABLE organization_membership_operation_receipts FROM PUBLIC;
REVOKE ALL ON TABLE organization_user_retention_deletions FROM PUBLIC;
REVOKE ALL ON TABLE organization_user_retention_object_obligations FROM PUBLIC;
REVOKE ALL ON TABLE organization_user_retention_object_deletion_receipts FROM PUBLIC;
REVOKE ALL ON TABLE organization_user_retention_deletion_events FROM PUBLIC;
DO $revoke_app_dml$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON TABLE organization_memberships FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_retention_policies FROM opengeni_app;
    REVOKE ALL ON TABLE organization_membership_invitations FROM opengeni_app;
    REVOKE ALL ON TABLE organization_membership_operation_receipts FROM opengeni_app;
    REVOKE ALL ON TABLE organization_membership_lifecycle_events FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_retention_deletions FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_retention_object_obligations FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_retention_object_deletion_receipts FROM opengeni_app;
    REVOKE ALL ON TABLE organization_user_retention_deletion_events FROM opengeni_app;
  END IF;
END
$revoke_app_dml$;

CREATE OR REPLACE FUNCTION opengeni_private.organization_membership_history_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
BEGIN RAISE EXCEPTION 'organization membership history is immutable' USING ERRCODE = '55000'; END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.organization_membership_history_immutable() FROM PUBLIC;
CREATE TRIGGER organization_membership_operation_receipts_immutable
  BEFORE UPDATE OR DELETE ON organization_membership_operation_receipts
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();
CREATE TRIGGER organization_membership_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON organization_membership_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();
CREATE TRIGGER organization_user_retention_object_obligations_immutable
  BEFORE UPDATE OR DELETE ON organization_user_retention_object_obligations
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();
CREATE TRIGGER organization_user_retention_object_deletion_receipts_immutable
  BEFORE UPDATE OR DELETE ON organization_user_retention_object_deletion_receipts
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();
CREATE TRIGGER organization_user_retention_deletion_events_immutable
  BEFORE UPDATE OR DELETE ON organization_user_retention_deletion_events
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.organization_membership_history_immutable();

COMMENT ON TABLE organization_membership_invitations IS
  'Registered-human organization invitations; acceptance is exact-subject and provider delivery is external.';
COMMENT ON TABLE organization_membership_operation_receipts IS
  'Immutable input-bound idempotency receipts for organization membership lifecycle commands.';
COMMENT ON TABLE organization_membership_lifecycle_events IS
  'Immutable value-bounded organization membership lifecycle audit evidence.';
COMMENT ON TABLE organization_user_retention_deletions IS
  'Mutable, claim-fenced state for bounded destructive retention of one expired offboarded member.';
COMMENT ON TABLE organization_user_retention_object_obligations IS
  'Immutable exact-bucket/key cleanup obligations prepared by database-first retention finalization; protected lifecycle capability only.';
COMMENT ON TABLE organization_user_retention_object_deletion_receipts IS
  'Immutable content-free proof that one exact-bucket/key prepared retention cleanup obligation was deleted from external storage.';
COMMENT ON TABLE organization_user_retention_deletion_events IS
  'Immutable content-free claim, failure and completion evidence for membership retention deletion.';

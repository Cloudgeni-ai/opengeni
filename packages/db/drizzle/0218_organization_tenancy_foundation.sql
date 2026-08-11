-- deployment-mode: rolling
-- Additive organization-tenancy Slice A foundation only. This migration names
-- durable organization membership, user-resource authority/grant identity,
-- retention policy, and generic session visibility/fork provenance. It does
-- not move an existing resource, grant runtime access, or activate sharing.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "organization_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'provisioning',
  "personal_workspace_id" uuid,
  "authorization_revision" bigint NOT NULL DEFAULT 1,
  "revoked_at" timestamptz,
  "personal_retention_until" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_memberships_status_check" CHECK (
    "status" IN ('provisioning', 'active', 'suspended', 'revoked')
  ),
  CONSTRAINT "organization_memberships_active_personal_workspace_check" CHECK (
    "status" <> 'active' OR "personal_workspace_id" IS NOT NULL
  ),
  CONSTRAINT "organization_memberships_subject_check" CHECK (
    length(btrim("subject_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "organization_memberships_revision_check" CHECK (
    "authorization_revision" > 0
  ),
  CONSTRAINT "organization_memberships_revocation_check" CHECK (
    ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
    OR ("status" <> 'revoked' AND "revoked_at" IS NULL)
  ),
  CONSTRAINT "organization_memberships_personal_workspace_account_fk"
    FOREIGN KEY ("personal_workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "organization_memberships_id_account_idx"
  ON "organization_memberships" ("id", "account_id");
CREATE UNIQUE INDEX "organization_memberships_account_subject_idx"
  ON "organization_memberships" ("account_id", "subject_id");
CREATE UNIQUE INDEX "organization_memberships_personal_workspace_idx"
  ON "organization_memberships" ("account_id", "personal_workspace_id")
  WHERE "personal_workspace_id" IS NOT NULL;

CREATE TABLE "organization_user_retention_policies" (
  "account_id" uuid PRIMARY KEY REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "mode" text NOT NULL DEFAULT 'retain',
  "retention_days" integer,
  "version" bigint NOT NULL DEFAULT 1,
  "updated_by_membership_id" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_user_retention_policies_updater_fk"
    FOREIGN KEY ("updated_by_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_user_retention_policies_mode_check" CHECK (
    "mode" IN ('retain', 'delete_after')
  ),
  CONSTRAINT "organization_user_retention_policies_duration_check" CHECK (
    ("mode" = 'retain' AND "retention_days" IS NULL)
    OR ("mode" = 'delete_after' AND "retention_days" BETWEEN 1 AND 3650)
  ),
  CONSTRAINT "organization_user_retention_policies_version_check" CHECK (
    "version" > 0
  )
);

CREATE TABLE "organization_user_resource_authorities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "organization_membership_id" uuid NOT NULL,
  "resource_kind" text NOT NULL,
  "resource_id" uuid NOT NULL,
  "origin_workspace_id" uuid,
  "generation" bigint NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'active',
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_user_resource_authorities_membership_fk"
    FOREIGN KEY ("organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_user_resource_authorities_origin_workspace_fk"
    FOREIGN KEY ("origin_workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id")
    ON DELETE SET NULL ("origin_workspace_id"),
  CONSTRAINT "organization_user_resource_authorities_kind_check" CHECK (
    "resource_kind" = lower(btrim("resource_kind"))
    AND length("resource_kind") BETWEEN 1 AND 64
    AND "resource_kind" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
  ),
  CONSTRAINT "organization_user_resource_authorities_generation_check" CHECK (
    "generation" > 0
  ),
  CONSTRAINT "organization_user_resource_authorities_status_check" CHECK (
    "status" IN ('active', 'retained', 'revoked')
  ),
  CONSTRAINT "organization_user_resource_authorities_revocation_check" CHECK (
    ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
    OR ("status" <> 'revoked' AND "revoked_at" IS NULL)
  )
);

CREATE UNIQUE INDEX "organization_user_resource_authorities_id_account_idx"
  ON "organization_user_resource_authorities" ("id", "account_id");
CREATE UNIQUE INDEX "organization_user_resource_authorities_id_account_membership_idx"
  ON "organization_user_resource_authorities" ("id", "account_id", "organization_membership_id");
CREATE UNIQUE INDEX "organization_user_resource_authorities_resource_identity_idx"
  ON "organization_user_resource_authorities" (
    "account_id",
    "organization_membership_id",
    "resource_kind",
    "resource_id"
  );

-- Existing sessions remain explicitly workspace-owned/workspace-visible. Null
-- owner and fork facts are non-authority; epoch 1 is the legacy baseline.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "owner_organization_membership_id" uuid,
  ADD COLUMN IF NOT EXISTS "visibility" text NOT NULL DEFAULT 'workspace_shared',
  ADD COLUMN IF NOT EXISTS "authority_epoch" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "forked_from_session_id" uuid,
  ADD COLUMN IF NOT EXISTS "forked_from_authority_epoch" integer,
  ADD COLUMN IF NOT EXISTS "forked_from_visibility" text,
  ADD COLUMN IF NOT EXISTS "forked_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "forked_by_organization_membership_id" uuid;

CREATE UNIQUE INDEX IF NOT EXISTS "sessions_id_account_idx"
  ON "sessions" ("id", "account_id");

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_owner_organization_membership_fk"
    FOREIGN KEY ("owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "sessions_forked_from_session_account_fk"
    FOREIGN KEY ("forked_from_session_id", "account_id")
    REFERENCES "sessions"("id", "account_id") ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "sessions_forked_by_organization_membership_fk"
    FOREIGN KEY ("forked_by_organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "sessions_visibility_check" CHECK (
    "visibility" IN ('user_private', 'workspace_shared')
  ) NOT VALID,
  ADD CONSTRAINT "sessions_private_owner_check" CHECK (
    "visibility" <> 'user_private' OR "owner_organization_membership_id" IS NOT NULL
  ) NOT VALID,
  ADD CONSTRAINT "sessions_authority_epoch_check" CHECK (
    "authority_epoch" > 0
  ) NOT VALID,
  ADD CONSTRAINT "sessions_fork_provenance_check" CHECK (
    (
      "forked_from_session_id" IS NULL
      AND "forked_from_authority_epoch" IS NULL
      AND "forked_from_visibility" IS NULL
      AND "forked_at" IS NULL
      AND "forked_by_organization_membership_id" IS NULL
    ) OR (
      "forked_from_session_id" IS NOT NULL
      AND "forked_from_authority_epoch" > 0
      AND "forked_from_visibility" IN ('user_private', 'workspace_shared')
      AND "forked_at" IS NOT NULL
      AND "forked_by_organization_membership_id" IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE "sessions"
  VALIDATE CONSTRAINT "sessions_owner_organization_membership_fk",
  VALIDATE CONSTRAINT "sessions_forked_from_session_account_fk",
  VALIDATE CONSTRAINT "sessions_forked_by_organization_membership_fk",
  VALIDATE CONSTRAINT "sessions_visibility_check",
  VALIDATE CONSTRAINT "sessions_private_owner_check",
  VALIDATE CONSTRAINT "sessions_authority_epoch_check",
  VALIDATE CONSTRAINT "sessions_fork_provenance_check";

CREATE TABLE "organization_user_resource_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "authority_id" uuid NOT NULL,
  "owner_organization_membership_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid,
  "action" text NOT NULL,
  "mode" text NOT NULL,
  "context" text NOT NULL,
  "authority_epoch" integer,
  "generation" bigint NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'active',
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_user_resource_grants_authority_fk"
    FOREIGN KEY ("authority_id", "account_id")
    REFERENCES "organization_user_resource_authorities"("id", "account_id")
    ON DELETE RESTRICT,
  CONSTRAINT "organization_user_resource_grants_owner_membership_fk"
    FOREIGN KEY ("owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_user_resource_grants_authority_owner_fk"
    FOREIGN KEY ("authority_id", "account_id", "owner_organization_membership_id")
    REFERENCES "organization_user_resource_authorities"(
      "id", "account_id", "organization_membership_id"
    ) ON DELETE RESTRICT,
  CONSTRAINT "organization_user_resource_grants_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "organization_user_resource_grants_session_workspace_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "organization_user_resource_grants_action_check" CHECK (
    "action" = lower(btrim("action"))
    AND length("action") BETWEEN 1 AND 64
    AND "action" ~ '^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$'
  ),
  CONSTRAINT "organization_user_resource_grants_mode_check" CHECK (
    "mode" IN ('once', 'session', 'always')
  ),
  CONSTRAINT "organization_user_resource_grants_context_check" CHECK (
    "context" IN ('user_private', 'workspace_shared')
  ),
  CONSTRAINT "organization_user_resource_grants_session_fence_check" CHECK (
    (
      "mode" = 'always'
      AND "session_id" IS NULL
      AND "authority_epoch" IS NULL
    ) OR (
      "mode" IN ('once', 'session')
      AND
      "session_id" IS NOT NULL
      AND "authority_epoch" > 0
    )
  ),
  CONSTRAINT "organization_user_resource_grants_generation_check" CHECK (
    "generation" > 0
  ),
  CONSTRAINT "organization_user_resource_grants_status_check" CHECK (
    "status" IN ('active', 'consumed', 'revoked', 'expired')
  ),
  CONSTRAINT "organization_user_resource_grants_revocation_check" CHECK (
    ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
    OR ("status" <> 'revoked' AND "revoked_at" IS NULL)
  )
);

CREATE UNIQUE INDEX "organization_user_resource_grants_id_account_idx"
  ON "organization_user_resource_grants" ("id", "account_id");
CREATE INDEX "organization_user_resource_grants_authority_workspace_idx"
  ON "organization_user_resource_grants" ("authority_id", "workspace_id", "status");

-- Slice A is intentionally inert. These tables have no policies and no direct
-- opengeni_app privileges, so FORCE RLS is a deny-all backstop until a later
-- reviewed dual-write/backfill/validate/activate slice installs exact behavior.
ALTER TABLE "organization_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_retention_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_retention_policies" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_resource_authorities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_resource_authorities" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_resource_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_resource_grants" FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE "organization_memberships" IS
  'Organization membership and personal-workspace lifecycle metadata; not workspace content access.';
COMMENT ON COLUMN "organization_memberships"."personal_workspace_id" IS
  'One personal workspace per membership; lifecycle metadata, never user-resource ownership.';
COMMENT ON TABLE "organization_user_resource_authorities" IS
  'Stable organization+membership user-resource authority identity; inert in Slice A.';
COMMENT ON COLUMN "organization_user_resource_authorities"."origin_workspace_id" IS
  'Non-authoritative provenance only; deletion clears this fact without transferring authority.';
COMMENT ON TABLE "organization_user_resource_grants" IS
  'Opaque once/session/always user-resource grant identities; inert in Slice A.';
COMMENT ON COLUMN "sessions"."visibility" IS
  'Generic user_private/workspace_shared tenancy visibility; Slice A adds storage only.';
COMMENT ON COLUMN "sessions"."authority_epoch" IS
  'Monotonic execution-authority fence for later sharing/fork runtime; Slice A baseline is 1.';
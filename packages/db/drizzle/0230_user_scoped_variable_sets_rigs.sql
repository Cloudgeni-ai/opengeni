-- deployment-mode: rolling
-- Inert authority identity foundation for Variable Sets and Rigs. This slice
-- changes no runtime authorization, RLS policy, lifecycle GUC, API/DAO path,
-- runnable snapshot, grant consumption, or worker materialization behavior.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "workspace_variable_sets"
  ADD COLUMN "authority_scope" text NOT NULL DEFAULT 'workspace',
  ADD COLUMN "authority_id" uuid,
  ADD COLUMN "owner_organization_membership_id" uuid,
  ADD COLUMN "origin_workspace_id" uuid;

ALTER TABLE "rigs"
  ADD COLUMN "authority_scope" text NOT NULL DEFAULT 'workspace',
  ADD COLUMN "authority_id" uuid,
  ADD COLUMN "owner_organization_membership_id" uuid,
  ADD COLUMN "origin_workspace_id" uuid;

ALTER TABLE "workspace_variable_sets"
  ADD CONSTRAINT "workspace_variable_sets_authority_scope_check"
    CHECK ("authority_scope" IN ('workspace', 'user')) NOT VALID,
  ADD CONSTRAINT "workspace_variable_sets_authority_shape_check" CHECK (
    (
      "authority_scope" = 'workspace'
      AND "authority_id" IS NULL
      AND "owner_organization_membership_id" IS NULL
    ) OR (
      "authority_scope" = 'user'
      AND "authority_id" IS NOT NULL
      AND "owner_organization_membership_id" IS NOT NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT "workspace_variable_sets_authority_fk" FOREIGN KEY (
    "authority_id", "account_id", "owner_organization_membership_id"
  ) REFERENCES "organization_user_resource_authorities"(
    "id", "account_id", "organization_membership_id"
  ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "workspace_variable_sets_origin_workspace_fk" FOREIGN KEY (
    "origin_workspace_id", "account_id"
  ) REFERENCES "workspaces"("id", "account_id")
    ON DELETE SET NULL ("origin_workspace_id") NOT VALID;

ALTER TABLE "rigs"
  ADD CONSTRAINT "rigs_authority_scope_check"
    CHECK ("authority_scope" IN ('workspace', 'user')) NOT VALID,
  ADD CONSTRAINT "rigs_authority_shape_check" CHECK (
    (
      "authority_scope" = 'workspace'
      AND "authority_id" IS NULL
      AND "owner_organization_membership_id" IS NULL
    ) OR (
      "authority_scope" = 'user'
      AND "authority_id" IS NOT NULL
      AND "owner_organization_membership_id" IS NOT NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT "rigs_authority_fk" FOREIGN KEY (
    "authority_id", "account_id", "owner_organization_membership_id"
  ) REFERENCES "organization_user_resource_authorities"(
    "id", "account_id", "organization_membership_id"
  ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "rigs_origin_workspace_fk" FOREIGN KEY (
    "origin_workspace_id", "account_id"
  ) REFERENCES "workspaces"("id", "account_id")
    ON DELETE SET NULL ("origin_workspace_id") NOT VALID;

ALTER TABLE "workspace_variable_sets"
  VALIDATE CONSTRAINT "workspace_variable_sets_authority_scope_check",
  VALIDATE CONSTRAINT "workspace_variable_sets_authority_shape_check",
  VALIDATE CONSTRAINT "workspace_variable_sets_authority_fk",
  VALIDATE CONSTRAINT "workspace_variable_sets_origin_workspace_fk";

ALTER TABLE "rigs"
  VALIDATE CONSTRAINT "rigs_authority_scope_check",
  VALIDATE CONSTRAINT "rigs_authority_shape_check",
  VALIDATE CONSTRAINT "rigs_authority_fk",
  VALIDATE CONSTRAINT "rigs_origin_workspace_fk";

COMMENT ON COLUMN "workspace_variable_sets"."authority_scope" IS
  'Inert authority identity foundation. Runtime access remains workspace-scoped until a later activation migration.';
COMMENT ON COLUMN "rigs"."authority_scope" IS
  'Inert authority identity foundation. Runtime access remains workspace-scoped until a later activation migration.';
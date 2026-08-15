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

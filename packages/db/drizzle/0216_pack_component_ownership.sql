-- deployment-mode: rolling
-- Additive Pack installation evidence and component ownership. Old API/worker
-- binaries continue to use the original columns; new binaries freeze the
-- reviewed manifest and populate the normalized component ledger.

ALTER TABLE "pack_installations"
  ADD COLUMN "version" integer NOT NULL DEFAULT 1,
  ADD COLUMN "manifest_snapshot" jsonb,
  ADD COLUMN "manifest_digest" text,
  ADD COLUMN "selected_rig_id" uuid REFERENCES "rigs"("id") ON DELETE SET NULL,
  ADD COLUMN "installed_by_subject_id" text;

ALTER TABLE "pack_installations"
  ADD CONSTRAINT "pack_installations_version_chk" CHECK ("version" > 0) NOT VALID,
  ADD CONSTRAINT "pack_installations_manifest_chk" CHECK (
    ("manifest_snapshot" IS NULL AND "manifest_digest" IS NULL)
    OR (
      jsonb_typeof("manifest_snapshot") = 'object'
      AND octet_length(convert_to("manifest_snapshot"::text, 'UTF8')) <= 1048576
      AND "manifest_digest" ~ '^[0-9a-f]{64}$'
    )
  ) NOT VALID,
  ADD CONSTRAINT "pack_installations_actor_chk" CHECK (
    "installed_by_subject_id" IS NULL
    OR length(btrim("installed_by_subject_id")) BETWEEN 1 AND 1024
  ) NOT VALID,
  ADD CONSTRAINT "pack_installations_status_chk" CHECK (
    "status" IN ('installing', 'active', 'needs_attention', 'disabled')
  ) NOT VALID;

ALTER TABLE "pack_installations"
  VALIDATE CONSTRAINT "pack_installations_version_chk";
ALTER TABLE "pack_installations"
  VALIDATE CONSTRAINT "pack_installations_manifest_chk";
ALTER TABLE "pack_installations"
  VALIDATE CONSTRAINT "pack_installations_actor_chk";
ALTER TABLE "pack_installations"
  VALIDATE CONSTRAINT "pack_installations_status_chk";

CREATE INDEX "pack_installations_workspace_rig_idx"
  ON "pack_installations" ("workspace_id", "selected_rig_id")
  WHERE "selected_rig_id" IS NOT NULL;

CREATE TABLE "pack_installation_components" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "pack_installation_id" uuid NOT NULL REFERENCES "pack_installations"("id") ON DELETE CASCADE,
  "component_key" text NOT NULL,
  "kind" text NOT NULL,
  "capability_id" text NOT NULL,
  "resolved_id" text NOT NULL,
  "digest" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pack_installation_components_key_chk" CHECK (
    length("component_key") BETWEEN 1 AND 128
    AND "component_key" ~ '^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$'
  ),
  CONSTRAINT "pack_installation_components_kind_chk" CHECK (
    "kind" IN ('plugin', 'skill', 'integration', 'feature', 'inline_skill')
  ),
  CONSTRAINT "pack_installation_components_identity_chk" CHECK (
    length("capability_id") BETWEEN 1 AND 512
    AND length("resolved_id") BETWEEN 1 AND 512
    AND "capability_id" !~ '[[:cntrl:]]'
    AND "resolved_id" !~ '[[:cntrl:]]'
    AND "digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "pack_installation_components_metadata_chk" CHECK (
    jsonb_typeof("metadata") = 'object'
    AND octet_length(convert_to("metadata"::text, 'UTF8')) <= 131072
  ),
  CONSTRAINT "pack_installation_components_pack_key_uq"
    UNIQUE ("pack_installation_id", "component_key")
);

CREATE INDEX "pack_installation_components_workspace_capability_idx"
  ON "pack_installation_components" ("workspace_id", "kind", "capability_id");

CREATE OR REPLACE FUNCTION pack_v2_validate_installation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."manifest_snapshot" IS NOT NULL
    AND NEW."manifest_snapshot" ->> 'id' IS DISTINCT FROM NEW."pack_id"
  THEN
    RAISE EXCEPTION 'pack installation snapshot id does not match pack_id'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."selected_rig_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "rigs" r
    WHERE r."id" = NEW."selected_rig_id"
      AND r."account_id" = NEW."account_id"
      AND r."workspace_id" = NEW."workspace_id"
  ) THEN
    RAISE EXCEPTION 'pack installation Rig belongs to another tenant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pack_installations_v2_validate
  BEFORE INSERT OR UPDATE ON "pack_installations"
  FOR EACH ROW EXECUTE FUNCTION pack_v2_validate_installation();

CREATE OR REPLACE FUNCTION pack_v2_validate_component()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pack_installations" i
    WHERE i."id" = NEW."pack_installation_id"
      AND i."account_id" = NEW."account_id"
      AND i."workspace_id" = NEW."workspace_id"
  ) THEN
    RAISE EXCEPTION 'Pack component does not match its installation tenant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pack_installation_components_validate
  BEFORE INSERT OR UPDATE ON "pack_installation_components"
  FOR EACH ROW EXECUTE FUNCTION pack_v2_validate_component();

-- Harden the polymorphic owner identity added by 0202 now that first-class
-- Pack installation ids exist. Direct/migration owners remain textual, and
-- rolling legacy Pack owners remain valid when they are not UUID-shaped.
CREATE OR REPLACE FUNCTION capability_v2_validate_component_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "capability_facet_installations" i
    WHERE i."id" = NEW."facet_installation_id"
      AND i."account_id" = NEW."account_id"
      AND i."workspace_id" = NEW."workspace_id"
  ) THEN
    RAISE EXCEPTION 'component owner does not match its facet installation tenant'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."owner_kind" = 'plugin' THEN
    IF NEW."owner_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'plugin component owner belongs to another tenant or does not exist'
        USING ERRCODE = '23514';
    ELSIF NOT EXISTS (
        SELECT 1 FROM "capability_plugin_installations" p
        WHERE p."id" = NEW."owner_id"::uuid
          AND p."account_id" = NEW."account_id"
          AND p."workspace_id" = NEW."workspace_id"
      ) THEN
      RAISE EXCEPTION 'plugin component owner belongs to another tenant or does not exist'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."owner_kind" = 'pack'
    AND NEW."owner_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    IF NOT EXISTS (
      SELECT 1 FROM "pack_installations" p
      WHERE p."id" = NEW."owner_id"::uuid
        AND p."account_id" = NEW."account_id"
        AND p."workspace_id" = NEW."workspace_id"
    ) THEN
      RAISE EXCEPTION 'Pack component owner belongs to another tenant or does not exist'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION capability_v2_validate_feature_binding_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "integration_feature_bindings" b
    WHERE b."id" = NEW."binding_id"
      AND b."account_id" = NEW."account_id"
      AND b."workspace_id" = NEW."workspace_id"
  ) THEN
    RAISE EXCEPTION 'feature binding owner does not match its binding tenant'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."owner_kind" = 'plugin' THEN
    IF NEW."owner_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'plugin feature binding owner belongs to another tenant or does not exist'
        USING ERRCODE = '23514';
    ELSIF NOT EXISTS (
        SELECT 1 FROM "capability_plugin_installations" p
        WHERE p."id" = NEW."owner_id"::uuid
          AND p."account_id" = NEW."account_id"
          AND p."workspace_id" = NEW."workspace_id"
      ) THEN
      RAISE EXCEPTION 'plugin feature binding owner belongs to another tenant or does not exist'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."owner_kind" = 'pack'
    AND NEW."owner_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    IF NOT EXISTS (
      SELECT 1 FROM "pack_installations" p
      WHERE p."id" = NEW."owner_id"::uuid
        AND p."account_id" = NEW."account_id"
        AND p."workspace_id" = NEW."workspace_id"
    ) THEN
      RAISE EXCEPTION 'Pack feature binding owner belongs to another tenant or does not exist'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "pack_installation_components" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pack_installation_components" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "pack_installation_components"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "pack_installation_components" TO opengeni_app;
  END IF;
END $$;
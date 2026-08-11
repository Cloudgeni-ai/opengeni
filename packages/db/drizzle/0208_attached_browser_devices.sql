-- deployment-mode: maintenance
-- Canonical live attached-Chrome endpoints. A row names one extension installation in one
-- Chrome profile; immutable BrowserIdentity revisions remain a separate resource.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "enrollments"
  ADD CONSTRAINT "enrollments_workspace_id_uq" UNIQUE ("workspace_id", "id");

CREATE TABLE "attached_browser_devices" (
  "id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "enrollment_id" uuid NOT NULL,
  "name" text NOT NULL,
  "profile_label" text,
  "browser_name" text NOT NULL,
  "browser_version" text NOT NULL,
  "extension_version" text NOT NULL,
  "platform" text NOT NULL,
  "architecture" text NOT NULL,
  "connection_generation" text NOT NULL,
  "inventory_revision" bigint NOT NULL,
  "tab_count" integer NOT NULL,
  "capabilities" jsonb NOT NULL,
  "last_seen_at" timestamptz NOT NULL,
  "disconnected_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "attached_browser_devices_workspace_id_pk"
    PRIMARY KEY ("workspace_id", "id"),
  CONSTRAINT "attached_browser_devices_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "attached_browser_devices_enrollment_fk"
    FOREIGN KEY ("workspace_id", "enrollment_id")
    REFERENCES "enrollments"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "attached_browser_devices_platform_check"
    CHECK ("platform" IN ('linux', 'macos', 'windows')),
  CONSTRAINT "attached_browser_devices_architecture_check"
    CHECK ("architecture" IN ('x64', 'arm64')),
  CONSTRAINT "attached_browser_devices_values_check" CHECK (
    octet_length("name") BETWEEN 1 AND 200
    AND "name" = btrim("name")
    AND ("profile_label" IS NULL OR (
      octet_length("profile_label") BETWEEN 1 AND 200
      AND "profile_label" = btrim("profile_label")
    ))
    AND octet_length("browser_name") BETWEEN 1 AND 100
    AND "browser_name" = btrim("browser_name")
    AND octet_length("browser_version") BETWEEN 1 AND 256
    AND "browser_version" = btrim("browser_version")
    AND octet_length("extension_version") BETWEEN 1 AND 256
    AND "extension_version" = btrim("extension_version")
    AND octet_length("connection_generation") BETWEEN 1 AND 256
    AND "connection_generation" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    AND "inventory_revision" >= 0
    AND "tab_count" BETWEEN 0 AND 100000
    AND jsonb_typeof("capabilities") = 'object'
    AND octet_length("capabilities"::text) BETWEEN 2 AND 65536
  )
);

CREATE INDEX "attached_browser_devices_enrollment_idx"
  ON "attached_browser_devices" (
    "workspace_id", "enrollment_id", "disconnected_at", "updated_at"
  );
CREATE INDEX "attached_browser_devices_discovery_idx"
  ON "attached_browser_devices" (
    "workspace_id", "disconnected_at", "updated_at", "id"
  );

CREATE TABLE "attached_browser_inventories" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "enrollment_id" uuid NOT NULL,
  "bridge_generation" text NOT NULL,
  "revision" bigint NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "attached_browser_inventories_workspace_enrollment_pk"
    PRIMARY KEY ("workspace_id", "enrollment_id"),
  CONSTRAINT "attached_browser_inventories_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "attached_browser_inventories_enrollment_fk"
    FOREIGN KEY ("workspace_id", "enrollment_id")
    REFERENCES "enrollments"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "attached_browser_inventories_values_check" CHECK (
    octet_length("bridge_generation") BETWEEN 1 AND 256
    AND "bridge_generation" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    AND "revision" >= 0
  )
);

CREATE FUNCTION opengeni_private.attached_browser_devices_update_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $guard$
BEGIN
  IF ROW(
    NEW.id, NEW.account_id, NEW.workspace_id, NEW.enrollment_id, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.account_id, OLD.workspace_id, OLD.enrollment_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Attached browser endpoint identity cannot change'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.last_seen_at < OLD.last_seen_at OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Attached browser endpoint time cannot move backwards'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.connection_generation = OLD.connection_generation
     AND NEW.inventory_revision < OLD.inventory_revision THEN
    RAISE EXCEPTION 'Attached browser inventory revision cannot move backwards'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE TRIGGER "attached_browser_devices_update_guard_trg"
BEFORE UPDATE ON "attached_browser_devices"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.attached_browser_devices_update_guard();

REVOKE ALL ON FUNCTION opengeni_private.attached_browser_devices_update_guard() FROM PUBLIC;

ALTER TABLE "browser_sessions"
  ADD CONSTRAINT "browser_sessions_attached_device_fk"
  FOREIGN KEY ("workspace_id", "device_id")
  REFERENCES "attached_browser_devices"("workspace_id", "id") ON DELETE RESTRICT;

ALTER TABLE "attached_browser_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attached_browser_devices" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "attached_browser_devices"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "attached_browser_inventories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attached_browser_inventories" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "attached_browser_inventories"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.attached_browser_devices, %I.attached_browser_inventories FROM opengeni_app',
      target_schema,
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.attached_browser_devices TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.attached_browser_inventories TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;

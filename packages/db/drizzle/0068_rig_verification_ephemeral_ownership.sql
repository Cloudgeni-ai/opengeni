-- deployment-mode: rolling
-- Phase A of the rig-verifier ownership rollout. Install the bounded owner
-- registry and make the Modal orphan reaper recognize exact future verifier
-- owners before any verifier is permitted to create them. Phase B activates
-- owner creation only after every shared-queue worker runs this reaper.

CREATE TABLE "sandbox_ephemeral_owners" (
  "execution_id" uuid PRIMARY KEY NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "backend" text NOT NULL,
  "instance_id" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "expires_at" timestamptz NOT NULL,
  "deactivated_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sandbox_ephemeral_owners_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id")
    ON DELETE CASCADE,
  CONSTRAINT "sandbox_ephemeral_owners_kind_check"
    CHECK ("kind" IN ('rig_verification'))
);

CREATE UNIQUE INDEX "sandbox_ephemeral_owners_active_instance_idx"
  ON "sandbox_ephemeral_owners" ("backend", "instance_id")
  WHERE "active" = true;
CREATE INDEX "sandbox_ephemeral_owners_active_expiry_idx"
  ON "sandbox_ephemeral_owners" ("backend", "expires_at")
  WHERE "active" = true;
CREATE INDEX "sandbox_ephemeral_owners_workspace_created_idx"
  ON "sandbox_ephemeral_owners" ("workspace_id", "created_at");

ALTER TABLE "sandbox_ephemeral_owners" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sandbox_ephemeral_owners" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "sandbox_ephemeral_owners"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- This is the one provider-side orphan-sweep projection. Lease rows preserve
-- their existing OPE-48/OPE-60 semantics; only exact, active, unexpired
-- ephemeral instances join them. Provider tags are intentionally absent from
-- this authority boundary.
-- Capture and qualify the host-selected data schema at migration time. Pinning
-- the SECURITY DEFINER search_path to pg_catalog avoids caller-controlled name
-- resolution while remaining safe for both standalone `public` and embedded
-- dedicated-schema installs.
DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.list_live_modal_sandbox_instances()
    RETURNS TABLE (
      owner_kind text,
      owner_id text,
      workspace_id uuid,
      instance_id text,
      sandbox_group_id uuid,
      liveness text,
      expires_at timestamptz
    )
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
      SELECT
        'lease'::text,
        L.id::text,
        L.workspace_id,
        L.instance_id,
        L.sandbox_group_id,
        L.liveness,
        null::timestamptz
      FROM %1$I.sandbox_leases L
      WHERE L.liveness IN ('warming', 'warm', 'draining')
        AND (L.backend = 'modal' OR L.resume_backend_id = 'modal')

      UNION ALL

      SELECT
        O.kind,
        O.execution_id::text,
        O.workspace_id,
        O.instance_id,
        null::uuid,
        null::text,
        O.expires_at
      FROM %1$I.sandbox_ephemeral_owners O
      WHERE O.backend = 'modal'
        AND O.active = true
        AND O.expires_at > now()
    $function$
  $create$, target_schema);
END
$migration$;

REVOKE ALL ON FUNCTION opengeni_private.list_live_modal_sandbox_instances() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE %I.sandbox_ephemeral_owners TO opengeni_app',
      current_schema()
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.list_live_modal_sandbox_instances()
      TO opengeni_app;
  END IF;
END $$;

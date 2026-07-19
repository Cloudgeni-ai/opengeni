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

-- Direct app-role mutation of this registry would bypass its exact lifecycle
-- contract. In particular, deleting a live row would make a running verifier
-- appear orphaned to the provider reaper. Capture and qualify the host-selected
-- data schema at migration time, and expose only tenant-fenced register/rebind
-- and exact-deactivate functions. Pinning every SECURITY DEFINER search_path to
-- pg_catalog prevents caller-controlled name resolution while remaining safe
-- for both standalone `public` and embedded dedicated-schema installs.
DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.register_sandbox_ephemeral_owner(
      p_execution_id uuid,
      p_account_id uuid,
      p_workspace_id uuid,
      p_kind text,
      p_backend text,
      p_instance_id text,
      p_expires_at timestamptz
    )
    RETURNS TABLE (
      execution_id uuid,
      account_id uuid,
      workspace_id uuid,
      kind text,
      backend text,
      instance_id text,
      active boolean,
      expires_at timestamptz,
      deactivated_at timestamptz
    )
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF NOT opengeni_private.workspace_rls_visible(p_account_id, p_workspace_id) THEN
        RAISE EXCEPTION 'sandbox ephemeral owner scope denied'
          USING ERRCODE = '42501';
      END IF;

      RETURN QUERY
      INSERT INTO %1$I.sandbox_ephemeral_owners AS owner (
        execution_id,
        account_id,
        workspace_id,
        kind,
        backend,
        instance_id,
        active,
        expires_at,
        deactivated_at,
        created_at,
        updated_at
      ) VALUES (
        p_execution_id,
        p_account_id,
        p_workspace_id,
        p_kind,
        p_backend,
        p_instance_id,
        true,
        p_expires_at,
        null,
        now(),
        now()
      )
      ON CONFLICT ON CONSTRAINT sandbox_ephemeral_owners_pkey DO UPDATE SET
        instance_id = excluded.instance_id,
        expires_at = excluded.expires_at,
        updated_at = now()
      WHERE owner.account_id = excluded.account_id
        AND owner.workspace_id = excluded.workspace_id
        AND owner.kind = excluded.kind
        AND owner.backend = excluded.backend
        AND owner.active = true
      RETURNING
        owner.execution_id,
        owner.account_id,
        owner.workspace_id,
        owner.kind,
        owner.backend,
        owner.instance_id,
        owner.active,
        owner.expires_at,
        owner.deactivated_at;
    END
    $function$
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.deactivate_sandbox_ephemeral_owner(
      p_execution_id uuid,
      p_account_id uuid,
      p_workspace_id uuid,
      p_kind text,
      p_backend text,
      p_instance_id text
    )
    RETURNS boolean
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE deactivated boolean := false;
    BEGIN
      IF NOT opengeni_private.workspace_rls_visible(p_account_id, p_workspace_id) THEN
        RAISE EXCEPTION 'sandbox ephemeral owner scope denied'
          USING ERRCODE = '42501';
      END IF;

      UPDATE %1$I.sandbox_ephemeral_owners AS owner SET
        active = false,
        deactivated_at = now(),
        expires_at = least(owner.expires_at, now()),
        updated_at = now()
      WHERE owner.execution_id = p_execution_id
        AND owner.account_id = p_account_id
        AND owner.workspace_id = p_workspace_id
        AND owner.kind = p_kind
        AND owner.backend = p_backend
        AND owner.instance_id = p_instance_id
        AND owner.active = true
      RETURNING true INTO deactivated;

      RETURN coalesce(deactivated, false);
    END
    $function$
  $create$, target_schema);

  -- This is the one provider-side orphan-sweep projection. Lease rows preserve
  -- their existing OPE-48/OPE-60 semantics; only exact, active, unexpired
  -- ephemeral instances join them. Provider tags are intentionally absent from
  -- this authority boundary.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.list_live_modal_sandbox_instances()
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

REVOKE ALL ON FUNCTION opengeni_private.register_sandbox_ephemeral_owner(
  uuid, uuid, uuid, text, text, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.deactivate_sandbox_ephemeral_owner(
  uuid, uuid, uuid, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.list_live_modal_sandbox_instances() FROM PUBLIC;

DO $$
BEGIN
  -- Migration 0040 intentionally grants ordinary application DML on future
  -- tables. This registry is the narrow exception: remove inherited/default
  -- and prior broad grants before granting tenant-scoped read access only.
  EXECUTE format(
    'REVOKE ALL PRIVILEGES ON TABLE %I.sandbox_ephemeral_owners FROM PUBLIC',
    current_schema()
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.sandbox_ephemeral_owners FROM opengeni_app',
      current_schema()
    );
    EXECUTE format(
      'GRANT SELECT ON TABLE %I.sandbox_ephemeral_owners TO opengeni_app',
      current_schema()
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.register_sandbox_ephemeral_owner(
      uuid, uuid, uuid, text, text, text, timestamptz
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.deactivate_sandbox_ephemeral_owner(
      uuid, uuid, uuid, text, text, text
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.list_live_modal_sandbox_instances()
      TO opengeni_app;
  END IF;
END $$;

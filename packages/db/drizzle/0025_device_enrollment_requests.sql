-- The OAuth 2.0 device-authorization (RFC 8628) PENDING request store (M5 of the
-- bring-your-own-compute mega-PR; design-of-record .agent/implementation-dossier.md
-- §10.2 enrollment device-flow + §18 LOUD consent). One short-TTL, SINGLE-USE row
-- per in-flight enrollment, keyed by an opaque device_code (the agent polls with) +
-- a short user_code (the user types at the approve page).
--
-- WHY a table (not in-memory / a signed stateless code): the agent polling and the
-- user approving can hit DIFFERENT api replicas, and the consent record (WHO
-- approved WHEN to WHAT) must be durable + auditable. An in-memory map would break
-- across replicas and lose the consent trail. Postgres is the consistent,
-- multi-replica-safe store the rest of the control plane already uses (no KV/Redis
-- in the API). Mirrors the M2 0024 conventions verbatim (RLS + grants boilerplate).
--
-- STATE MACHINE: pending → approved | denied. A pending row past expires_at is
-- EXPIRED on poll (no separate state — the expiry is read at poll time). Once the
-- agent polls an approved row's credentials, the row flips to 'consumed' (so the
-- credentials are single-use). The DURABLE identity the approve produced is the
-- `enrollments` row (+ a `sandboxes` row, acceptance #2); this request row is
-- transient and a retention sweep prunes terminal rows.
--
-- ROLLBACK (forward-only repo, but cleanly reversible):
--   DROP TABLE device_enrollment_requests;
-- (the migration up/down/up gate exercises exactly this.)

-- The lifecycle domain (text + CHECK so a future state is a CHECK widening, not a
-- re-key — same discipline as enrollments.status / sandboxes.kind in 0024).
CREATE TABLE IF NOT EXISTS "device_enrollment_requests" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The opaque code the agent polls with (unguessable, single-use). Globally unique.
  "device_code"               text NOT NULL,
  -- The short human-typed code (e.g. 'WDJB-MJHT'). Unique among LIVE (pending) rows.
  "user_code"                 text NOT NULL,
  "account_id"                uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id"              uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  -- The agent's ed25519 public key (the machine identity the enrollment binds to).
  "pubkey"                    text NOT NULL,
  "os"                        text NOT NULL DEFAULT 'linux',
  "arch"                      text NOT NULL DEFAULT 'x86_64',
  "machine_name"              text,
  -- The exposure the agent REQUESTED (whole-machine in v1; loudly consented at approve).
  "requested_exposure"        text NOT NULL DEFAULT 'whole-machine',
  -- The agent CAN offer a display (a real screen / Xvfb is available).
  "can_offer_display"         boolean NOT NULL DEFAULT false,
  -- The agent REQUESTS screen control (computer-use); the user's allow_screen_control
  -- at approve is the AUTHORITATIVE consent.
  "requests_screen_control"   boolean NOT NULL DEFAULT false,
  "status"                    text NOT NULL DEFAULT 'pending',
  -- ── LOUD CONSENT capture (who/when/what), stamped at approve ────────────────
  "approved_by_subject_id"    text,
  "approved_by_subject_label" text,
  -- The user's screen-control consent decision (whole-machine is mandatory at approve).
  "allow_screen_control"      boolean NOT NULL DEFAULT false,
  "approved_at"               timestamptz,
  -- The enrollment + sandbox the approve produced (acceptance #2). Null until approved.
  -- ON DELETE SET NULL so deleting an enrollment never cascade-kills this audit row.
  "enrollment_id"             uuid REFERENCES "enrollments"("id") ON DELETE SET NULL,
  "sandbox_id"                uuid REFERENCES "sandboxes"("id") ON DELETE SET NULL,
  "expires_at"                timestamptz NOT NULL,
  "created_at"                timestamptz NOT NULL DEFAULT now(),
  "updated_at"                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "device_enrollment_requests_status_chk"
    CHECK ("status" IN ('pending', 'approved', 'denied', 'consumed')),
  CONSTRAINT "device_enrollment_requests_exposure_chk"
    CHECK ("requested_exposure" IN ('whole-machine')),
  CONSTRAINT "device_enrollment_requests_os_chk"
    CHECK ("os" IN ('linux', 'macos', 'windows'))
);

-- The device_code is the agent's poll key — globally unique + indexed.
CREATE UNIQUE INDEX IF NOT EXISTS "device_enrollment_requests_device_code_idx"
  ON "device_enrollment_requests" ("device_code");

-- The user_code must be unique among LIVE (pending) rows so the approve lookup is
-- unambiguous; a terminal row's code may be recycled (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS "device_enrollment_requests_user_code_pending_idx"
  ON "device_enrollment_requests" ("user_code")
  WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "device_enrollment_requests_workspace_created_idx"
  ON "device_enrollment_requests" ("workspace_id", "created_at");

CREATE INDEX IF NOT EXISTS "device_enrollment_requests_expires_idx"
  ON "device_enrollment_requests" ("expires_at");

-- ============== RLS + grants (verbatim 0017/0021/0024 boilerplate) ===========
-- Workspace-scoped behind the SAME workspace_rls_visible policy the lease/pty/
-- enrollment tables use, so a scoped opengeni_app connection only ever sees its own
-- workspace's pending device-auth requests.
ALTER TABLE "device_enrollment_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "device_enrollment_requests" FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'device_enrollment_requests' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "device_enrollment_requests";
  END IF;
  CREATE POLICY workspace_isolation ON "device_enrollment_requests"
    USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
    WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "device_enrollment_requests" TO opengeni_app;
  END IF;
END $$;

-- ============== device_code → (account_id, workspace_id) resolver ============
-- The agent's POST /poll presents ONLY the opaque device_code — it has NO
-- workspace context yet (it isn't enrolled). FORCE RLS would block a scoped
-- connection from reading the row to discover which workspace it belongs to. So,
-- exactly like the global reaper's cross-workspace sweep (0017
-- opengeni_private.reap_sandbox_leases), the lookup is a SECURITY DEFINER read fn
-- that returns ONLY the (account_id, workspace_id) for an UNEXPIRED-or-recent row.
-- The DAO then re-reads the FULL row under the resolved workspace's RLS scope, so
-- the device_code is the capability (unguessable + unique) and no broad table read
-- ever escapes RLS. Returns no rows for an unknown code.
CREATE OR REPLACE FUNCTION opengeni_private.resolve_device_enrollment_request(
  p_device_code text
)
RETURNS TABLE (account_id uuid, workspace_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, opengeni_private
AS $$
  SELECT d.account_id, d.workspace_id
  FROM device_enrollment_requests d
  WHERE d.device_code = p_device_code
  LIMIT 1
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.resolve_device_enrollment_request(text) TO opengeni_app;
  END IF;
END $$;

-- First-class swappable sandboxes + enrollment records + per-machine metrics, and
-- the per-session mutable, epoch-fenced active-sandbox POINTER (M2 of the
-- bring-your-own-compute mega-PR; design-of-record .agent/implementation-dossier.md
-- §10.3 routing proxy + §10.7 metrics + §23 enrollment).
--
-- WHY these four tables land together:
--   * enrollments       — a user's own machine, registered once (the agent's
--                          ed25519 pubkey IS its identity; whole-machine consent +
--                          display/screen-control capture; active|revoked).
--   * sandboxes          — the first-class NAMED sandbox a session's active pointer
--                          points AT (kind modal|selfhosted; a selfhosted sandbox
--                          carries enrollment_id → the machine it lives on).
--   * sessions.active_sandbox_id / active_epoch — the mutable, epoch-fenced pointer
--                          (the second epoch ABOVE lease_epoch) the routing proxy
--                          re-reads PER TOOL CALL to make hot-swap seamless.
--   * machine_metrics_{latest,series} — last-sample upsert + ~1/min downsampled
--                          series per enrollment (NOT Prometheus; §10.7).
--
-- INTEGER epoch (NOT bigint): the lease-epoch spike proved postgres-js returns int8
-- from a raw query as a JS STRING, which breaks a strict epoch-fence compare. The
-- active_epoch fence shares that discipline — int4 returns a JS number. Epochs never
-- approach 2^31, so the narrower type loses nothing (same rationale as
-- sandbox_leases.lease_epoch in 0017).
--
-- DDL is INERT until the M3+ provider/routing/enrollment code wires it (gated behind
-- sandboxSelfhostedEnabled). Forward-only + behavior-preserving: active_sandbox_id
-- defaults to NULL (a NULL pointer resolves to the session's own group sandbox — the
-- backward-compat default of §10.3), active_epoch defaults to 0; no backfill needed.
--
-- ROLLBACK (forward-only repo, but each statement is cleanly reversible): the down
-- order is the FK-reverse of the up order —
--   DROP TABLE machine_metrics_series;
--   DROP TABLE machine_metrics_latest;
--   ALTER TABLE sessions DROP COLUMN active_epoch, DROP COLUMN active_sandbox_id;
--   DROP TABLE sandboxes;
--   DROP TABLE enrollments;
-- (the migration up/down/up gate exercises exactly this.)

-- ============== enrollments (one row per registered machine) =================
-- The agent's ed25519 PUBLIC key is the machine's identity (the control-plane
-- subject the agent subscribes to maps to it). exposure is the loudly-consented
-- access mode ('whole-machine' today; the column is text+CHECK so a future
-- narrower mode is a CHECK widening, not a re-key). has_display/allow_screen_control
-- are the desktop/computer-use consent bits (default FALSE — consent is opt-in).
-- status is the lifecycle: 'active' until the user revokes (uninstall --purge /
-- dashboard revoke), then 'revoked' (revoked_at stamped). last_seen_at is the
-- heartbeat-driven liveness cursor surfaced in the Machines dashboard.
CREATE TABLE IF NOT EXISTS "enrollments" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id"           uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id"         uuid NOT NULL REFERENCES "workspaces"("id")       ON DELETE CASCADE,

  -- The agent's ed25519 public key (the machine identity). Unique per workspace —
  -- one machine enrolls once per workspace (a re-enroll of the same key is an
  -- idempotent UPDATE, not a second row).
  "pubkey"               text NOT NULL,

  -- The loudly-consented access mode. 'whole-machine' is the only mode today.
  "exposure"             text NOT NULL DEFAULT 'whole-machine'
                           CHECK ("exposure" IN ('whole-machine')),

  -- Desktop / computer-use consent bits (default FALSE — opt-in per §3/§18).
  "has_display"          boolean NOT NULL DEFAULT false,
  "allow_screen_control" boolean NOT NULL DEFAULT false,

  -- Lifecycle. 'active' until revoked; the reaper / Machines list filter on it.
  "status"               text NOT NULL DEFAULT 'active'
                           CHECK ("status" IN ('active','revoked')),

  -- The machine's OS/arch (linux|macos|windows + the cargo arch). Reported at
  -- enroll; informs the asset/desktop-capability decisions.
  "os"                   text NOT NULL DEFAULT 'linux'
                           CHECK ("os" IN ('linux','macos','windows')),
  "arch"                 text NOT NULL DEFAULT 'x86_64',

  -- Heartbeat liveness cursor (online/reconnecting/offline derive from this +
  -- the §10.6 thresholds). NULL until the first connect.
  "last_seen_at"         timestamptz,

  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "revoked_at"           timestamptz,
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);

-- One enrollment per (workspace, pubkey): a re-enroll of the same machine is an
-- idempotent upsert, never a duplicate machine row.
CREATE UNIQUE INDEX IF NOT EXISTS "enrollments_workspace_pubkey_idx"
  ON "enrollments" ("workspace_id", "pubkey");

-- List a workspace's ACTIVE machines for the Machines dashboard without scanning
-- revoked rows.
CREATE INDEX IF NOT EXISTS "enrollments_workspace_status_idx"
  ON "enrollments" ("workspace_id", "status");

-- ============== sandboxes (the first-class named sandbox pointer target) ======
-- The row a session's active_sandbox_id points AT. kind discriminates the backend
-- the routing proxy resolves to: 'modal' (a cloud box) or 'selfhosted' (a user's
-- machine, carrying enrollment_id → the enrollment it lives on). A modal sandbox
-- has NULL enrollment_id; a selfhosted sandbox MUST carry one (enforced by the
-- partial CHECK below). enrollment_id is ON DELETE SET NULL so deleting an
-- enrollment never cascade-kills a sandbox row a session might still point at —
-- the routing layer surfaces agent_offline instead.
CREATE TABLE IF NOT EXISTS "sandboxes" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id"    uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id"  uuid NOT NULL REFERENCES "workspaces"("id")       ON DELETE CASCADE,

  -- The backend this sandbox resolves to.
  "kind"          text NOT NULL CHECK ("kind" IN ('modal','selfhosted')),

  -- A human-facing name (the Machines/sandbox-list label).
  "name"          text NOT NULL,

  -- The enrollment a selfhosted sandbox lives on. NULL for a modal sandbox; SET
  -- NULL (not CASCADE) on enrollment delete so a pointed-at sandbox row is never
  -- swept out from under a session.
  "enrollment_id" uuid REFERENCES "enrollments"("id") ON DELETE SET NULL,

  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),

  -- A selfhosted sandbox is meaningless without its machine; a modal sandbox has
  -- no enrollment. Pin the invariant at the DB edge.
  CONSTRAINT "sandboxes_selfhosted_enrollment_chk"
    CHECK (("kind" = 'selfhosted' AND "enrollment_id" IS NOT NULL)
        OR ("kind" <> 'selfhosted' AND "enrollment_id" IS NULL))
);

-- List a workspace's sandboxes (the sandboxes_list tool / Machines surface).
CREATE INDEX IF NOT EXISTS "sandboxes_workspace_created_idx"
  ON "sandboxes" ("workspace_id", "created_at");

-- Enumerate the sandboxes living on one enrollment (a machine's sandbox; a
-- selfhosted enrollment is maxSandboxes:1, but the index is general).
CREATE INDEX IF NOT EXISTS "sandboxes_enrollment_idx"
  ON "sandboxes" ("enrollment_id")
  WHERE "enrollment_id" IS NOT NULL;

-- ============== sessions.active_sandbox_id + active_epoch (the pointer) =======
-- The mutable, epoch-fenced pointer the routing proxy re-reads PER TOOL CALL.
-- active_sandbox_id NULL == "use the session's own group sandbox" (the §10.3
-- backward-compat default — no backfill flips existing rows). ON DELETE SET NULL
-- so deleting a sandbox a session points at degrades to the group default, never
-- a dangling FK. active_epoch is the SECOND epoch ABOVE lease_epoch, bumped on
-- every swap; an in-flight op fenced by a stale active_epoch retries against the
-- new active sandbox. integer (NOT bigint) — see header.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "active_sandbox_id" uuid
    REFERENCES "sandboxes"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "active_epoch" integer NOT NULL DEFAULT 0;

-- ============== machine_metrics_latest (one row per enrollment) ===============
-- Last-sample upsert: ONE row per enrollment, overwritten on every sample. The
-- PRIMARY KEY on enrollment_id is the upsert conflict target (ON CONFLICT
-- (enrollment_id) DO UPDATE). ON DELETE CASCADE — metrics die with the machine.
-- The sampled signals (§10.7): CPU%, load1/5/15, RAM/disk used+total, optional
-- GPU util/mem, and a contention signal (run-queue length / pressure). Nullable
-- where a platform/sample may not provide it (no GPU, headless).
CREATE TABLE IF NOT EXISTS "machine_metrics_latest" (
  "enrollment_id"  uuid PRIMARY KEY REFERENCES "enrollments"("id") ON DELETE CASCADE,
  "account_id"     uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id"   uuid NOT NULL REFERENCES "workspaces"("id")       ON DELETE CASCADE,

  "cpu_percent"    numeric,
  "load1"          numeric,
  "load5"          numeric,
  "load15"         numeric,
  "mem_used_bytes"   bigint,
  "mem_total_bytes"  bigint,
  "disk_used_bytes"  bigint,
  "disk_total_bytes" bigint,
  "gpu_util_percent" numeric,
  "gpu_mem_used_bytes"  bigint,
  "gpu_mem_total_bytes" bigint,
  "contention"     numeric,

  -- When the agent took the sample (the agent's clock) vs when we stored it.
  "sampled_at"     timestamptz NOT NULL,
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "machine_metrics_latest_workspace_idx"
  ON "machine_metrics_latest" ("workspace_id");

-- ============== machine_metrics_series (downsampled ~1/min, retained N days) ===
-- Append-only downsampled history (one row ~per minute per enrollment). Retention
-- (delete rows older than N days) is a later concern; the table shape lands here.
-- Same signal columns as _latest. The (enrollment_id, sampled_at) index serves the
-- dashboard time-range read AND the retention sweep.
CREATE TABLE IF NOT EXISTS "machine_metrics_series" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "enrollment_id"  uuid NOT NULL REFERENCES "enrollments"("id") ON DELETE CASCADE,
  "account_id"     uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id"   uuid NOT NULL REFERENCES "workspaces"("id")       ON DELETE CASCADE,

  "cpu_percent"    numeric,
  "load1"          numeric,
  "load5"          numeric,
  "load15"         numeric,
  "mem_used_bytes"   bigint,
  "mem_total_bytes"  bigint,
  "disk_used_bytes"  bigint,
  "disk_total_bytes" bigint,
  "gpu_util_percent" numeric,
  "gpu_mem_used_bytes"  bigint,
  "gpu_mem_total_bytes" bigint,
  "contention"     numeric,

  "sampled_at"     timestamptz NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

-- Dashboard time-range read (newest-first per machine) + the retention sweep.
CREATE INDEX IF NOT EXISTS "machine_metrics_series_enrollment_sampled_idx"
  ON "machine_metrics_series" ("enrollment_id", "sampled_at");

-- The retention sweep scans by age across all machines.
CREATE INDEX IF NOT EXISTS "machine_metrics_series_sampled_idx"
  ON "machine_metrics_series" ("sampled_at");

-- ============== RLS + grants (verbatim 0017/0021 boilerplate) ================
-- Every new table is workspace-scoped behind the SAME workspace_rls_visible policy
-- the lease/pty tables use, so a scoped opengeni_app connection only ever sees its
-- own workspace's machines/sandboxes/metrics.
ALTER TABLE "enrollments"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrollments"            FORCE  ROW LEVEL SECURITY;
ALTER TABLE "sandboxes"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sandboxes"              FORCE  ROW LEVEL SECURITY;
ALTER TABLE "machine_metrics_latest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "machine_metrics_latest" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "machine_metrics_series" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "machine_metrics_series" FORCE  ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enrollments','sandboxes','machine_metrics_latest','machine_metrics_series']
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'workspace_isolation'
    ) THEN
      EXECUTE format('DROP POLICY workspace_isolation ON %I', t);
    END IF;
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I '
      'USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)) '
      'WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id))',
      t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "enrollments"            TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "sandboxes"              TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "machine_metrics_latest" TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "machine_metrics_series" TO opengeni_app;
  END IF;
END $$;

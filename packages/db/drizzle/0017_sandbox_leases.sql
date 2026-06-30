-- Sandbox singleton lease + refcounted holders + the cross-workspace reaper sweep.
--
-- The SOLE enforcer of one-box-per-group (P1.1; design-of-record
-- 08-implementation-plan.md P1.1 + modules/01-lease.md, re-keyed to
-- sandbox_group_id per addendum B.2). Two tables, authored GROUP-keyed from the
-- start so today's 1:1 world (sandbox_group_id == session id, set in 0018) is a
-- behavior-preserving no-op and the shared-sandbox surface (P1.4) needs no
-- re-key later.
--
-- The three Criticals land here together:
--   * CAS keys   — every lease op keyed (workspace_id, sandbox_group_id).
--   * meter key  — last_meter_at/last_meter_tick shape (warm_seconds accrues
--                  idempotent on (sandbox_group_id, lease_epoch, last_meter_tick)
--                  in P2.1; the column shape lands here).
--   * envelope split — resume_backend_id + resume_state fold the group's box
--                  recovery envelope onto the lease (no per-session join).
--
-- lease_epoch is INTEGER (not bigint/int8): the lease-epoch spike proved
-- postgres-js returns int8 from a raw query as a JS STRING, so the strict
-- epoch-fence compare (row.lease_epoch !== expectedEpoch) was always-true and
-- fenced every turn; an integer/int4 column comes back as a JS number, which
-- restores the fence. Epochs never approach 2^31, so the narrower type loses
-- nothing.
--
-- sandbox_group_id is a BARE uuid, DELIBERATELY NOT an FK to sessions(id): the
-- value is a session id or an ancestor's id in the same workspace; an FK would
-- let a founder's deletion cascade-kill a box still in use by a spawned session.
-- The live lease row IS the materialization of "this group has a box" (there is
-- no sandbox_groups table).
--
-- DDL is INERT until P1.2 wires it (flag sandboxOwnershipEnabled); this
-- migration only creates the tables, indexes, RLS, grants, and the sweep fn.

-- ============== sandbox_leases (exactly one logical row per group) ===========
-- The UNIQUE (workspace_id, sandbox_group_id) index is the only hardware that
-- prevents a second box. CAS, epoch, and FOR UPDATE all layer on top of it.
CREATE TABLE IF NOT EXISTS "sandbox_leases" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id"       uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id"     uuid NOT NULL REFERENCES "workspaces"("id")       ON DELETE CASCADE,

  -- The BOX's identity: a session id (singleton group) or an ancestor's id
  -- (shared group). NOT an FK (see header). The lease is per-group, not
  -- per-session; holders carry the attributing session_id.
  "sandbox_group_id" uuid NOT NULL,

  -- The 4-state machine. CHECK pins the domain at the DB edge so a buggy writer
  -- cannot persist an off-grid liveness value.
  "liveness"         text NOT NULL DEFAULT 'cold'
                       CHECK ("liveness" IN ('cold','warming','warm','draining')),

  -- Derived refcount = COUNT(sandbox_lease_holders for this lease). Stored
  -- denormalized for fast branch decisions, but every mutation recomputes it
  -- from the holder rows (holders are the source of truth; this is a cache).
  "refcount"         integer NOT NULL DEFAULT 0 CHECK ("refcount" >= 0),

  -- Split counts. turn_holders is TTL-EXEMPT (released only by the Temporal
  -- activity lifecycle / worker-death requeue, never reaped). viewer_holders is
  -- TTL-reapable. The warm->draining CAS is guarded AND turn_holders = 0.
  "turn_holders"     integer NOT NULL DEFAULT 0 CHECK ("turn_holders"   >= 0),
  "viewer_holders"   integer NOT NULL DEFAULT 0 CHECK ("viewer_holders" >= 0),

  -- Provider identity of the live box + how to reach it.
  "instance_id"      text,                 -- provider sandbox id (NULL while cold)
  "backend"          text NOT NULL,        -- 'modal'|'daytona'|... (sessions.sandbox_backend copy)
  "os"               text NOT NULL DEFAULT 'linux',
  "data_plane_url"   text,                 -- current scoped Channel-B (VNC-WS) URL,
                                           -- recorded by any worker via an
                                           -- event-driven resolveExposedPort under
                                           -- the epoch fence (no owner process).

  -- THE FENCE. Monotonic, bumped on every warming->warm commit / re-establish.
  -- A stale re-dispatched writer fails its CAS and backs off when its cached
  -- epoch != row epoch. integer (NOT bigint) — see header.
  "lease_epoch"      integer NOT NULL DEFAULT 0,

  -- THE GROUP BOX-ENVELOPE (the "envelope split" Critical). resume_backend_id +
  -- resume_state are the small recovery descriptor needed to resume()-by-id the
  -- group's box (warm reattach or cold restore from snapshot) without a
  -- per-session DB join. Folded onto the lease so the group has ONE envelope.
  "resume_backend_id" text,
  "resume_state"      jsonb,

  -- Warm-time billing cursor (the meter the stateless ticks advance in P2.1):
  --   * last_meter_at   = the accrual cursor (when warm-seconds were last metered);
  --   * last_meter_tick = the idempotency tick; warm_seconds is accrued idempotent
  --     on (sandbox_group_id, lease_epoch, last_meter_tick) so a retried/duplicate
  --     tick never double-counts.
  "last_meter_at"    timestamptz,
  "last_meter_tick"  integer NOT NULL DEFAULT 0,

  -- Heartbeat-TTL of the LEASE itself: refreshed on acquire, on the turn's 30s
  -- activity heartbeat, and on a viewer's app-level API heartbeat. A 'warming'
  -- row whose expires_at lapses = an uncaught spawner death -> reaper resets to
  -- 'cold' (warming-death == lapse, single expires_at).
  "expires_at"       timestamptz NOT NULL,

  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);

-- THE SINGLETON GUARANTEE. One lease row per (workspace, group); INSERT ON
-- CONFLICT DO NOTHING + this index is what makes acquireLease idempotent under
-- a race.
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_leases_group_idx"
  ON "sandbox_leases" ("workspace_id", "sandbox_group_id");

-- Reaper scan index: find lapsed leases cheaply. Partial on the three states the
-- reaper sweep acts on (warming-TTL-expired -> cold; warm-idle -> draining;
-- draining-grace-elapsed -> drainable). The SECURITY-DEFINER sweep predicate
-- rides this index.
CREATE INDEX IF NOT EXISTS "sandbox_leases_reaper_idx"
  ON "sandbox_leases" ("expires_at")
  WHERE "liveness" IN ('warming','warm','draining');

-- ============== sandbox_lease_holders (one row per holder) ===================
-- Release is delete-my-row, never a blind refcount--. A retried release
-- (Temporal at-least-once) deleting an already-gone row is a clean no-op.
CREATE TABLE IF NOT EXISTS "sandbox_lease_holders" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id"         uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id"       uuid NOT NULL REFERENCES "workspaces"("id")       ON DELETE CASCADE,
  "lease_id"           uuid NOT NULL REFERENCES "sandbox_leases"("id")   ON DELETE CASCADE,

  "kind"               text NOT NULL CHECK ("kind" IN ('turn','viewer')),

  -- Stable per-holder identity:
  --   turn   -> the session_turns.id (one turn = one holder; turns are sequential)
  --   viewer -> the access-grant-scoped viewer connection id minted at handshake
  -- Carrying holder_id makes acquire idempotent: a duplicate acquire for the
  -- same (lease,kind,holder) is ON CONFLICT DO UPDATE (heartbeat refresh), not a
  -- double-increment.
  "holder_id"          text NOT NULL,

  -- The attributing session within the (possibly shared) group: which session
  -- this holder belongs to (attribution/disclosure for shared boxes). The lease
  -- is group-keyed; the holder records the session.
  "subject_id"         uuid,

  -- Last app-level heartbeat. turn holders refresh via the 30s activity
  -- heartbeat; viewer holders via the client->server Channel-A viewer ping.
  -- reapStaleLeaseHolders deletes viewer rows older than viewerHolderTTL.
  "last_heartbeat_at"  timestamptz NOT NULL DEFAULT now(),
  "created_at"         timestamptz NOT NULL DEFAULT now()
);

-- Idempotency key for a holder: a given (lease, kind, holder) exists at most
-- once. acquireLease inserts ON CONFLICT DO UPDATE (refresh heartbeat) so a
-- reconnecting viewer or a retried acquire never double-counts.
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_lease_holders_holder_idx"
  ON "sandbox_lease_holders" ("lease_id", "kind", "holder_id");

-- Reaper scan: viewer holders by staleness.
CREATE INDEX IF NOT EXISTS "sandbox_lease_holders_stale_idx"
  ON "sandbox_lease_holders" ("kind", "last_heartbeat_at");

-- Recompute-refcount join.
CREATE INDEX IF NOT EXISTS "sandbox_lease_holders_lease_idx"
  ON "sandbox_lease_holders" ("lease_id");

-- ============== RLS + grants (verbatim 0005/0007 boilerplate) ================
ALTER TABLE "sandbox_leases"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sandbox_leases"        FORCE  ROW LEVEL SECURITY;
ALTER TABLE "sandbox_lease_holders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sandbox_lease_holders" FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'sandbox_leases' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "sandbox_leases";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "sandbox_leases"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'sandbox_lease_holders' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "sandbox_lease_holders";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "sandbox_lease_holders"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- ============== The SECURITY-DEFINER cross-workspace reaper sweep (OD-3) =====
-- The reaper Temporal Schedule (P1.3) runs ONE global sweep, not a per-workspace
-- loop: it must see stale rows across ALL workspaces in a single pass. Under
-- FORCE RLS the workspace_isolation policy would hide every other workspace's
-- rows from a scoped connection, so the sweep is a SECURITY DEFINER function
-- owned by the migration role (which owns the tables and thus is not subject to
-- their RLS when it runs as DEFINER) — the one sanctioned cross-workspace read.
--
-- DB-ONLY: this function does NOT call any provider. It mutates the lease rows
-- (TTL-reap stale viewer holders, reset warming-death to cold, recompute
-- refcounts, enter draining at refcount 0) and RETURNS the (workspace_id,
-- sandbox_group_id) of leases whose drain grace has elapsed so the caller can
-- issue the provider stop() (that stop() is P1.3's runtime concern, not the
-- DB's). One predicate-driven pass over the reaper index.
CREATE OR REPLACE FUNCTION opengeni_private.reap_sandbox_leases(
  p_viewer_holder_ttl_ms bigint,
  p_idle_grace_ms        bigint
)
RETURNS TABLE (workspace_id uuid, sandbox_group_id uuid, instance_id text, lease_epoch integer)
LANGUAGE plpgsql
SECURITY DEFINER
-- EMBED-SAFE: this function references sandbox_leases / sandbox_lease_holders
-- (the DATA schema) and opengeni_private helpers. It deliberately does NOT pin
-- `SET search_path = public, ...` because under the embedded dedicated-schema
-- topology those tables live in the host's chosen schema (e.g. `opengeni`), not
-- `public`; a pinned `public` path would silently resolve them to an empty/
-- absent table and the reaper sweep would no-op. Inheriting the caller's
-- search_path resolves the data tables in standalone (caller path `public,
-- opengeni_private`) AND embedded (caller path `<schema>, opengeni_private`)
-- alike. opengeni_private fns are still called with an absolute prefix below.
AS $$
BEGIN
  -- (a) Reap stale VIEWER holders cross-workspace (turn holders are TTL-exempt).
  DELETE FROM sandbox_lease_holders h
  WHERE h.kind = 'viewer'
    AND h.last_heartbeat_at < now() - make_interval(secs => p_viewer_holder_ttl_ms / 1000.0);

  -- (b) Recompute refcounts from the holder rows for every lease; warm leases
  --     that hit 0 (AND turn_holders = 0) enter draining with a fresh grace
  --     deadline (idleGraceMs, the SAME horizon releaseLeaseHolder stamps).
  UPDATE sandbox_leases L SET
    refcount       = c.total,
    turn_holders   = c.turns,
    viewer_holders = c.viewers,
    liveness = CASE WHEN L.liveness = 'warm' AND c.total = 0 AND c.turns = 0
                    THEN 'draining' ELSE L.liveness END,
    expires_at = CASE WHEN L.liveness = 'warm' AND c.total = 0 AND c.turns = 0
                    THEN now() + make_interval(secs => p_idle_grace_ms / 1000.0)
                    ELSE L.expires_at END,
    updated_at = now()
  FROM (
    SELECT L2.id,
           (SELECT count(*) FROM sandbox_lease_holders h WHERE h.lease_id = L2.id)::int                          AS total,
           (SELECT count(*) FROM sandbox_lease_holders h WHERE h.lease_id = L2.id AND h.kind = 'turn')::int      AS turns,
           (SELECT count(*) FROM sandbox_lease_holders h WHERE h.lease_id = L2.id AND h.kind = 'viewer')::int    AS viewers
    FROM sandbox_leases L2
  ) c
  WHERE L.id = c.id;

  -- (c) WARMING-death: a 'warming' row whose LEASE TTL lapsed = the spawner
  --     process died mid-resume. Reset to cold so a queued turn can re-acquire
  --     and re-spawn. instance_id/data_plane_url cleared (a warming row may have
  --     a stale handle from a prior epoch).
  UPDATE sandbox_leases SET
    liveness = 'cold', instance_id = NULL,
    resume_backend_id = NULL, resume_state = NULL,
    data_plane_url = NULL, updated_at = now()
  WHERE liveness = 'warming' AND expires_at < now();

  -- (d) DRAINING-grace elapsed: surface the (workspace, group) of every lease
  --     whose grace is up AND still idle, with instance_id + epoch, so the
  --     caller (P1.3) can issue the provider stop() then confirmDrainCold-CAS
  --     draining->cold under the epoch fence. DB-only: no provider call here.
  RETURN QUERY
    SELECT L.workspace_id, L.sandbox_group_id, L.instance_id, L.lease_epoch
    FROM sandbox_leases L
    WHERE L.liveness = 'draining' AND L.expires_at < now() AND L.refcount = 0;
END;
$$;

-- ============================================================================
-- Warm-meter read (P2.1) — the reaper-tick metering input.
--
-- The reaper sweep is the warm-meter tick for VIEWER-ONLY boxes between turns (a
-- turn-held box is metered by the turn's own activity heartbeat, so we EXCLUDE
-- turn_holders > 0 here to avoid double-metering). Like the reaper sweep this is
-- a cross-workspace read that FORCE RLS would hide from a scoped connection, so
-- it is a SECURITY DEFINER read fn (DB-only, no mutation — the worker calls
-- accrueWarmSeconds per row, which does the epoch-fenced cursor advance + the
-- (group, epoch, tick)-idempotent usage insert under the lease row lock).
--
-- Returns ONE row per WARM group with no turn holders (a singleton group is one
-- box → one row → one warm-seconds stream regardless of N viewer sessions).
CREATE OR REPLACE FUNCTION opengeni_private.list_meterable_warm_leases()
RETURNS TABLE (
  account_id        uuid,
  workspace_id      uuid,
  sandbox_group_id  uuid,
  lease_epoch       integer,
  backend           text
)
LANGUAGE sql
SECURITY DEFINER
-- EMBED-SAFE: see reap_sandbox_leases above — no pinned `public` search_path so
-- the cross-workspace warm-lease read resolves sandbox_leases in whatever data
-- schema the caller's search_path selects (standalone `public`, embedded
-- `<schema>`). Inherits the caller's path instead of hardcoding `public`.
AS $$
  SELECT L.account_id, L.workspace_id, L.sandbox_group_id, L.lease_epoch, L.backend
  FROM sandbox_leases L
  WHERE L.liveness = 'warm' AND L.turn_holders = 0;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.reap_sandbox_leases(bigint, bigint) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.list_meterable_warm_leases() TO opengeni_app;
  END IF;
END $$;

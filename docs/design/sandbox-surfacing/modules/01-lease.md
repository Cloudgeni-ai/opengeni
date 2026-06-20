# Module: Lease & singleton state machine  (lease)

## Specification

# MODULE SPEC — Lease & Singleton State Machine

**Scope:** the Postgres lease layer that is the *sole* enforcer of the strict-singleton-sandbox-per-session invariant. Two new tables (`sandbox_leases`, `sandbox_lease_holders`), the Drizzle schema, the exact `acquireLease`/`releaseLease`/`heartbeatLease`/`reapStaleLeaseHolders`/`drainLease`/`reArmLease` query functions as runnable SQL + Drizzle, the 4-state machine with every transition (including the uncaught-spawner-death and split-brain `lease_epoch` fence), and the boot-validated cadence invariant `reaperPeriod < viewerHolderTTL < idleTimeout`.

This spec designs **on top of** the settled architecture; it does not re-litigate it. Everything below mirrors the existing in-repo lease pattern at `packages/db/src/index.ts:3077` (`claimNextQueuedTurn`), the envelope table at `packages/db/src/schema.ts:360` (`sandboxSessionEnvelopes`), the RLS migration boilerplate at `packages/db/drizzle/0005_session_goals.sql`, and the config validation block at `packages/config/src/index.ts:985`.

---

## 0. Files touched (exhaustive, file-by-file)

| File | Change | Anchor |
|---|---|---|
| `packages/db/src/schema.ts` | ADD `sandboxLeaseLivenessValues` const + `sandboxLeases` + `sandboxLeaseHolders` tables, mirroring `sandboxSessionEnvelopes` FK chain/indexes | after `:370` |
| `packages/db/drizzle/0017_sandbox_leases.sql` | NEW migration: 2 tables, indexes, RLS policies, grants (copy `0005` boilerplate) | NEW FILE |
| `packages/db/drizzle/meta/_journal.json` + `0017_snapshot.json` | drizzle-kit generated journal entry | regenerated |
| `packages/db/src/index.ts` | ADD types `SandboxLeaseLiveness`, `LeaseHolderKind`, `LeaseSnapshot`, `AcquireLeaseInput/Result`, and 7 query fns (`acquireLease`, `releaseLeaseHolder`, `heartbeatLeaseHolder`, `commitWarmingToWarm`, `failWarmingToCold`, `reapStaleLeaseHolders`, `reArmDrainingLease`, `confirmDrainCold`, `readLease`) | after `:2636` (next to envelope fns) |
| `packages/db/src/index.ts` (imports) | ADD `SandboxLeaseLiveness`, `LeaseHolderKind` to the type-import block | `:1-40` |
| `packages/config/src/index.ts` | ADD 3 settings fields (`sandboxLeaseReaperPeriodMs`, `sandboxViewerHolderTtlMs`, `sandboxIdleGraceMs`) + env mappings + the boot-validated cadence-invariant refine block. (No keep-alive knob — between turns the box survives on the provider's existing `modalTimeoutSeconds`.) | `:244`, `:481`, `:985` |
| `packages/db/test/sandbox-leases.test.ts` | NEW: concurrency/CAS/reaper/epoch-fence tests | NEW FILE |

No change to `sessions.sandbox_backend` (free-text column, `schema.ts:117`) — the lease references it for the `backend`/`os` columns but stores its own copy.

---

## 1. DDL — `sandbox_leases` & `sandbox_lease_holders`

### 1.1 `sandbox_leases` — exactly one logical row per session (the singleton enforcer)

The `UNIQUE (workspace_id, session_id)` index is the *only* hardware that prevents a second box. Every other guard (CAS, epoch, FOR UPDATE) layers on top of this uniqueness.

```sql
-- packages/db/drizzle/0017_sandbox_leases.sql  (part 1)

CREATE TABLE IF NOT EXISTS "sandbox_leases" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id"       uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id"     uuid NOT NULL REFERENCES "workspaces"("id")       ON DELETE CASCADE,
  "session_id"       uuid NOT NULL REFERENCES "sessions"("id")         ON DELETE CASCADE,

  -- The 4-state machine. CHECK pins the domain at the DB edge so a buggy
  -- writer cannot persist an off-grid liveness value.
  "liveness"         text NOT NULL DEFAULT 'cold'
                       CHECK ("liveness" IN ('cold','warming','warm','draining')),

  -- Derived refcount = COUNT(sandbox_lease_holders for this lease). Stored
  -- denormalized for fast branch decisions, but the reaper recomputes it from
  -- the holder rows (holders are the source of truth; this is a cache).
  "refcount"         integer NOT NULL DEFAULT 0 CHECK ("refcount" >= 0),

  -- Split counts. turn_holders is TTL-EXEMPT (released only by the Temporal
  -- activity lifecycle / worker-death requeue, never reaped). viewer_holders
  -- is TTL-reapable. The warm->draining CAS is guarded AND turn_holders = 0.
  "turn_holders"     integer NOT NULL DEFAULT 0 CHECK ("turn_holders"   >= 0),
  "viewer_holders"   integer NOT NULL DEFAULT 0 CHECK ("viewer_holders" >= 0),

  -- Provider identity of the live box + how to reach it.
  "instance_id"      text,                 -- provider sandbox id (NULL while cold)
  "backend"          text NOT NULL,        -- 'modal'|'daytona'|... (sessions.sandbox_backend copy)
  "os"               text NOT NULL DEFAULT 'linux',
  "data_plane_url"   text,                 -- current scoped Channel-B (VNC-WS) URL,
                                           -- recorded by any worker via an event-driven
                                           -- resolveExposedPort under the epoch fence
                                           -- (no persistent owner process).

  -- THE FENCE. Monotonic, bumped on every warming->warm commit / re-establish.
  -- A stale re-dispatched writer fails its CAS and backs off when its cached
  -- epoch != row epoch (no persistent owner; the per-turn handle is already gone).
  -- integer (NOT bigint/int8): the lease-epoch spike proved postgres-js returns
  -- int8 from a raw query as a JS STRING, so the strict epoch-fence comparison
  -- (row.lease_epoch !== expectedEpoch) was always-true and fenced every turn;
  -- an `integer`/int4 column comes back as a JS number, restoring the fence.
  "lease_epoch"      integer NOT NULL DEFAULT 0,

  -- Warm-time billing cursor (the meter the stateless ticks advance):
  --   * last_meter_at   = the accrual cursor (when warm-seconds were last metered);
  --   * last_meter_tick = the idempotency tick; warm_seconds is accrued idempotent
  --     on (lease_epoch, last_meter_tick) so a retried/duplicate tick never
  --     double-counts. Advanced by the turn's 30s heartbeat (while a turn runs)
  --     and by the reaper sweep (for viewer-only boxes between turns).
  "last_meter_at"    timestamptz,
  "last_meter_tick"  integer NOT NULL DEFAULT 0,

  -- Heartbeat-TTL of the LEASE itself (distinct from per-holder TTL):
  --   * refreshed on acquire, on the turn's 30s activity heartbeat, and on
  --     a viewer's app-level API heartbeat.
  --   * a 'warming' row whose expires_at lapses = an uncaught spawner death
  --     -> reaper resets it to 'cold' (transition W2).
  "expires_at"       timestamptz NOT NULL,

  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);

-- THE SINGLETON GUARANTEE. One lease row per (workspace, session); ON CONFLICT
-- DO NOTHING + this index is what makes acquireLease idempotent under a race.
CREATE UNIQUE INDEX IF NOT EXISTS "sandbox_leases_session_idx"
  ON "sandbox_leases" ("workspace_id", "session_id");

-- Reaper scan index: find lapsed leases cheaply. Partial on the two states the
-- reaper acts on (warming-TTL-expired -> cold; draining-grace-elapsed -> cold).
CREATE INDEX IF NOT EXISTS "sandbox_leases_reaper_idx"
  ON "sandbox_leases" ("expires_at")
  WHERE "liveness" IN ('warming','warm','draining');
```

### 1.2 `sandbox_lease_holders` — one row per holder (makes release idempotent)

Release is **delete-my-row**, never a blind `refcount--`. A retried release activity (Temporal at-least-once) deleting an already-gone row is a clean no-op.

```sql
-- packages/db/drizzle/0017_sandbox_leases.sql  (part 2)

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
  -- same (lease,kind,holder) is ON CONFLICT DO NOTHING, not a double-increment.
  "holder_id"          text NOT NULL,

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
```

### 1.3 RLS + grants (verbatim from the `0005` boilerplate, both tables)

```sql
-- packages/db/drizzle/0017_sandbox_leases.sql  (part 3) — repeat per table

ALTER TABLE "sandbox_leases"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sandbox_leases"        FORCE  ROW LEVEL SECURITY;
ALTER TABLE "sandbox_lease_holders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sandbox_lease_holders" FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
             AND tablename='sandbox_leases' AND policyname='workspace_isolation')
  THEN DROP POLICY workspace_isolation ON "sandbox_leases"; END IF;
END $$;
CREATE POLICY workspace_isolation ON "sandbox_leases"
  USING      (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
             AND tablename='sandbox_lease_holders' AND policyname='workspace_isolation')
  THEN DROP POLICY workspace_isolation ON "sandbox_lease_holders"; END IF;
END $$;
CREATE POLICY workspace_isolation ON "sandbox_lease_holders"
  USING      (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
```

> **Migration ordering note:** the partial unique/reaper indexes use `IF NOT EXISTS` to stay idempotent on re-run, matching every prior migration. No `ON DELETE` ambiguity: `sandbox_lease_holders.lease_id → sandbox_leases.id ON DELETE CASCADE` means deleting the lease row (only the `draining→cold` reaper does this, and even it prefers `UPDATE … SET liveness='cold'` over `DELETE` — see §3) cleans up holders automatically.

---

## 2. Drizzle schema (mirrors `sandboxSessionEnvelopes`, `schema.ts:360`)

```ts
// packages/db/src/schema.ts — INSERT after sandboxSessionEnvelopes (after :370)

// The 4 liveness states of the singleton lease. Exported so the query layer and
// the stateless resume-by-id path share one source of truth for the domain.
export const sandboxLeaseLivenessValues = ["cold", "warming", "warm", "draining"] as const;

// One row per session: the SOLE enforcer of the strict-singleton-sandbox
// invariant. uniqueIndex(workspaceId, sessionId) + SELECT…FOR UPDATE +
// cold->warming CAS + lease_epoch fence. Mirrors the FK chain and index shape
// of sandboxSessionEnvelopes (account/workspace/session, all cascade).
export const sandboxLeases = pgTable("sandbox_leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),

  liveness: text("liveness", { enum: sandboxLeaseLivenessValues }).notNull().default("cold"),
  refcount: integer("refcount").notNull().default(0),
  turnHolders: integer("turn_holders").notNull().default(0),
  viewerHolders: integer("viewer_holders").notNull().default(0),

  instanceId: text("instance_id"),
  backend: text("backend").notNull(),
  os: text("os").notNull().default("linux"),
  dataPlaneUrl: text("data_plane_url"),

  // integer (NOT bigint): the lease-epoch spike proved a raw int8 read returns a
  // JS STRING from postgres-js, breaking the strict epoch-fence comparison (it was
  // always-true → every turn fenced); int4 returns a JS number, which is the fix.
  // Epochs never approach 2^31, so the narrower type loses nothing.
  leaseEpoch: integer("lease_epoch").notNull().default(0),

  // Warm-time billing cursor: last_meter_at = accrual cursor; last_meter_tick =
  // idempotency tick (warm_seconds accrued idempotent on (lease_epoch, tick)).
  lastMeterAt: timestamp("last_meter_at", { withTimezone: true }),
  lastMeterTick: integer("last_meter_tick").notNull().default(0),

  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sessionIdx: uniqueIndex("sandbox_leases_session_idx").on(table.workspaceId, table.sessionId),
  reaperIdx: index("sandbox_leases_reaper_idx").on(table.expiresAt)
    .where(sql`${table.liveness} in ('warming','warm','draining')`),
}));

// N rows per session: one per live holder. Makes release idempotent
// (delete-my-row, never blind decrement) and lets the reaper recompute refcount.
export const sandboxLeaseHolders = pgTable("sandbox_lease_holders", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  leaseId: uuid("lease_id").notNull().references(() => sandboxLeases.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["turn", "viewer"] }).notNull(),
  holderId: text("holder_id").notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  holderIdx: uniqueIndex("sandbox_lease_holders_holder_idx").on(table.leaseId, table.kind, table.holderId),
  staleIdx: index("sandbox_lease_holders_stale_idx").on(table.kind, table.lastHeartbeatAt),
  leaseIdx: index("sandbox_lease_holders_lease_idx").on(table.leaseId),
}));
```

> `integer`, `timestamp`, `index`, `sql` are already imported at `schema.ts:1-2`. No new imports (the epoch is `integer`, not `bigint` — see the lease-epoch spike rationale above).

---

## 3. State machine — 4 states, every transition

States: **`cold`** (no box) · **`warming`** (a spawner is resuming/building) · **`warm`** (box live; any worker resumes it by id per turn, no persistent handle-holder) · **`draining`** (refcount hit 0, in mandatory grace window before the reaper issues the provider `stop()`).

```
                     acquire: INSERT-or-FOR-UPDATE, refcount++ on EVERY arrival
                     ┌──────────────────────────────────────────────────────────┐
                     │                                                            │
            (C1) cold ──CAS liveness='cold'──▶ warming                           │
              ▲  ▲           (exactly one winner; row is FOR UPDATE-held)         │
              │  │                  │  │  │                                       │
   (W2) spawn │  │ (W2) warming      │  │  └─(W3) spawn fails & spawner CATCHES ──┘ back to cold
   fails &    │  │ TTL lapses        │  │                                          (failWarmingToCold)
   reaper     │  │ (uncaught         │  │
   (rare)     │  │  spawner death)   │  └─(W1) spawn OK: resume-from-envelope, expose
              │  │  -> reaper resets │  │      stream port, lease_epoch++ ──▶ warm
              │  └───────────────────┘  │                          (commitWarmingToWarm)
              │                          │
        (D3) draining grace elapsed      │   acquire while warming = refcount++ ONLY
        & idle confirmed:                │   (NEVER touch liveness; spawner owns warming->warm)
        reaper issues provider    ▼
        stop() (prompt cost-stop; ┌──────────────┐  refcount->0 AND turn_holders=0
        provider idle-timeout is  │     warm     │ ──CAS─────────────────────────▶ draining
        the backstop) ──────▶ cold └──────────────┘   (warm->draining)
                                    ▲      (D2) refcount==0 timeout reaper
                                    │
                                    └─(D1) late arrival re-arms: draining->warm, refcount++
                                          (reArmDrainingLease — closes drain-vs-arrive race)
```

| # | From → To | Trigger | Guard (CAS predicate) | Side effects | Fn |
|---|---|---|---|---|---|
| C1 | cold → warming | acquire finds `liveness='cold'` inside its `FOR UPDATE` txn | `WHERE liveness='cold'` (atomic; row already locked so exactly one txn sees `cold`) | none yet — caller becomes the spawner | `acquireLease` |
| W1 | warming → warm | spawner finished resume-by-id + exposed stream port | `WHERE liveness='warming' AND lease_epoch=$expectedEpoch` | set `instance_id, data_plane_url`; **`lease_epoch++`**; refresh `expires_at` | `commitWarmingToWarm` |
| W2 | warming → cold | spawner *process dies* mid-resume (uncaught) | reaper: `WHERE liveness='warming' AND expires_at < now()` | clear `instance_id/data_plane_url`; `refcount`/holders untouched (a queued turn re-acquires) | `reapStaleLeaseHolders` (warming branch) |
| W3 | warming → cold | spawn throws and spawner *catches* it | `WHERE liveness='warming' AND lease_epoch=$expectedEpoch` | clear `instance_id/data_plane_url`; leave holders (the arrival that triggered the spawn still wants a box → next acquire re-CAS cold→warming) | `failWarmingToCold` |
| A1 | warming → warming | concurrent acquire arrives while spawning | (no liveness write) `refcount++`, holder upsert | loser waits on `warming` then attaches to same box | `acquireLease` (warming branch) |
| A2 | warm → warm | acquire arrives, box live | (no liveness write) `refcount++`, holder upsert, refresh `expires_at` | attach, no spawn | `acquireLease` (warm branch) |
| D2 | warm → draining | refcount reached 0 | `WHERE liveness='warm' AND refcount=0 AND turn_holders=0` | stamp `expires_at = now()+idleGraceMs` (the grace deadline) | `releaseLeaseHolder` (when it drops to 0) **or** `reapStaleLeaseHolders` |
| D1 | draining → warm | late acquire during grace | `WHERE liveness='draining'` → set `warm`, `refcount++` | re-arm: box was never torn down (grace window still open), so just resume serving | `reArmDrainingLease` |
| D3 | draining → cold | grace elapsed, still idle | reaper: `WHERE liveness='draining' AND expires_at<now() AND refcount=0` | the **stateless reaper** issues the provider's existing **`stop()`/terminate at refcount 0** (prompt cost-stop) and CASes to `cold`; the per-turn handle was already dropped at the last turn's end (envelope is upserted per turn). The **provider idle-timeout is the backstop** for any leaked/missed box. | `confirmDrainCold` |

**Critical invariants enforced structurally (do not relax):**

1. **The `(workspace_id, session_id)` unique index + `SELECT … FOR UPDATE` is the ONLY double-spawn guard.** Per the settled ruling: Temporal serializes *signals*, not *activity executions* — a viewer's `exposeStreamPort` activity runs **concurrently** with `runAgentSegment`. Any "fast path" that reads liveness without the row lock reintroduces double-spawn. Every branch goes through the `FOR UPDATE` txn.
2. **`cold→warming` CAS is exactly-one-winner** because the row is already `FOR UPDATE`-held: concurrent acquirers serialize on the lock; the first sees `cold` and flips to `warming`, the rest see `warming` and take branch A1.
3. **Release during `warming` decrements refcount ONLY** (never touches liveness). The spawner exclusively owns `warming→warm`; after committing it re-reads refcount and, if 0, immediately CAS `warm→draining`.
4. **`warm→draining` is guarded `AND turn_holders=0`** so a live multi-day turn (refcount could momentarily look like 0 only if both counters are 0) can never be drained out from under the agent. Only `viewer_holders` are TTL-reapable; `turn_holders` are released solely by the activity lifecycle.
5. **The `lease_epoch` fence is pre-emptive.** W1 bumps the epoch; the worker that re-established the box caches it for the duration of its turn. The split-brain fix re-validates `lease_epoch == myEpoch` *inside* the same `FOR UPDATE` txn that increments `turn_holders` (see `acquireLease` turn-arrival fencing in §4). A stale writer — e.g. a re-dispatched turn from a worker that died mid-turn — fails the CAS and backs off (there is no persistent owner to "self-evict"; the in-memory handle was already dropped at the previous turn's end). **`create()` is NEVER called on resume-conflict** — the only path to a genuine 2nd box; back off until the stale epoch is fenced.

---

## 4. Query functions — runnable SQL + Drizzle

All live in `packages/db/src/index.ts` after `getSandboxSessionEnvelope` (`:2636`). They reuse `withWorkspaceRls` + `scopedDb.transaction` exactly as `claimNextQueuedTurn` (`:3077`) does, and raw `sql\`\`` via `tx.execute` exactly as `:3079`.

### 4.0 Types (add to the type block / co-locate)

```ts
// packages/db/src/types.ts (or contracts) — add:
export type SandboxLeaseLiveness = "cold" | "warming" | "warm" | "draining";
export type LeaseHolderKind = "turn" | "viewer";

// packages/db/src/index.ts — add near the lease fns:
export interface LeaseSnapshot {
  id: string;
  liveness: SandboxLeaseLiveness;
  refcount: number;
  turnHolders: number;
  viewerHolders: number;
  instanceId: string | null;
  backend: string;
  os: string;
  dataPlaneUrl: string | null;
  leaseEpoch: number;
  expiresAt: Date;
}

export interface AcquireLeaseInput {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  kind: LeaseHolderKind;
  holderId: string;            // session_turns.id (turn) | viewer connection id (viewer)
  backend: string;             // sessions.sandbox_backend
  os?: string;                 // default 'linux'
  leaseTtlMs: number;          // refresh window for expires_at (turn-heartbeat cadence)
  // Optional epoch fence for a re-establishing turn holder: when set, the
  // turn-arrival increment is gated on lease_epoch == expectedEpoch (split-brain).
  expectedEpoch?: number;
}

export type AcquireLeaseResult =
  // Caller WON the cold->warming CAS: it is the spawner (any pool worker). Must
  // resume-by-id from the envelope, expose the stream port (resolveExposedPort),
  // then call commitWarmingToWarm. No owner process is started.
  | { role: "spawner"; lease: LeaseSnapshot }
  // Box live or being built by someone else: attach (and, for warming, wait).
  | { role: "attached"; lease: LeaseSnapshot }
  // Re-armed a draining lease back to warm (box never torn down).
  | { role: "rearmed"; lease: LeaseSnapshot }
  // Epoch fence rejected the turn-arrival increment: a newer epoch exists (a
  // later turn re-established the box). Caller must back off and re-read; NEVER
  // create().
  | { role: "fenced"; lease: LeaseSnapshot };
```

### 4.1 `acquireLease` — the get-or-create critical section (verbatim)

The single most load-bearing function. One transaction: insert-or-nothing → lock → branch on liveness → bump refcount/holders/expires.

```ts
export async function acquireLease(db: Database, input: AcquireLeaseInput): Promise<AcquireLeaseResult> {
  const { accountId, workspaceId, sessionId, kind, holderId, backend } = input;
  const os = input.os ?? "linux";
  return await withRlsContext(db, { accountId, workspaceId }, async (scopedDb) =>
    await scopedDb.transaction(async (tx) => {
      // (1) Materialize the singleton row if absent. ON CONFLICT DO NOTHING +
      // the unique index = idempotent under a race; concurrent inserts collapse
      // to one row. expires_at seeded to now()+ttl so a never-warmed cold row
      // is still reaper-visible.
      await tx.execute(sql`
        insert into sandbox_leases
          (account_id, workspace_id, session_id, liveness, backend, os, expires_at)
        values
          (${accountId}, ${workspaceId}, ${sessionId}, 'cold', ${backend}, ${os},
           now() + (${input.leaseTtlMs}::text || ' milliseconds')::interval)
        on conflict (workspace_id, session_id) do nothing
      `);

      // (2) Serialize ALL concurrent arrivals on this session's row. Plain FOR
      // UPDATE (block, do NOT skip) — unlike claimNextQueuedTurn's SKIP LOCKED,
      // because we WANT the loser to wait and then attach, not skip.
      const [row] = await tx.execute<LeaseRow>(sql`
        select * from sandbox_leases
        where workspace_id = ${workspaceId} and session_id = ${sessionId}
        for update
      `);
      if (!row) throw new Error(`Lease row vanished post-insert: ${sessionId}`);

      // (3) Branch on liveness.
      const liveness = row.liveness as SandboxLeaseLiveness;

      // -- draining: late arrival re-arms (D1). Box still alive (grace open).
      if (liveness === "draining") {
        await upsertHolder(tx, row.id, accountId, workspaceId, kind, holderId);
        const updated = await bumpAndStamp(tx, row.id, kind, input.leaseTtlMs, "warm");
        return { role: "rearmed", lease: updated };
      }

      // -- cold: WIN the cold->warming CAS (C1). Exactly one winner: row is
      // FOR UPDATE-held, so this UPDATE … WHERE liveness='cold' commits for the
      // first arrival only; concurrent arrivals serialized behind us see warming.
      if (liveness === "cold") {
        const casRows = await tx.execute<{ id: string }>(sql`
          update sandbox_leases set liveness = 'warming', updated_at = now()
          where id = ${row.id} and liveness = 'cold'
          returning id
        `);
        if (casRows.length === 0) {
          // Lost the CAS to a sibling in the same lock queue (cannot happen under
          // a held row lock, but defensive): fall through to warming branch.
          await upsertHolder(tx, row.id, accountId, workspaceId, kind, holderId);
          const updated = await bumpAndStamp(tx, row.id, kind, input.leaseTtlMs, null);
          return { role: "attached", lease: updated };
        }
        await upsertHolder(tx, row.id, accountId, workspaceId, kind, holderId);
        const updated = await bumpAndStamp(tx, row.id, kind, input.leaseTtlMs, null);
        return { role: "spawner", lease: updated };
      }

      // -- warm: epoch fence for re-establishing turn holders (split-brain).
      // A turn arriving with expectedEpoch must match the live row epoch;
      // a stale-epoch re-dispatched turn is fenced out -> back off, NEVER create().
      if (liveness === "warm" && kind === "turn" && input.expectedEpoch !== undefined
          && row.lease_epoch !== input.expectedEpoch) {
        const snapshot = mapLeaseRow(row);
        return { role: "fenced", lease: snapshot };
      }

      // -- warm / warming: attach (A2 / A1). refcount++ ONLY; never touch
      // liveness. Spawner exclusively owns warming->warm.
      await upsertHolder(tx, row.id, accountId, workspaceId, kind, holderId);
      const updated = await bumpAndStamp(tx, row.id, kind, input.leaseTtlMs, null);
      return { role: "attached", lease: updated };
    }),
  );
}
```

Helper `upsertHolder` (idempotent acquire — the unique index makes a retried/duplicate acquire a no-op refresh, never a double-count):

```ts
async function upsertHolder(
  tx: Database, leaseId: string, accountId: string, workspaceId: string,
  kind: LeaseHolderKind, holderId: string,
): Promise<void> {
  await tx.execute(sql`
    insert into sandbox_lease_holders
      (account_id, workspace_id, lease_id, kind, holder_id, last_heartbeat_at)
    values (${accountId}, ${workspaceId}, ${leaseId}, ${kind}, ${holderId}, now())
    on conflict (lease_id, kind, holder_id)
      do update set last_heartbeat_at = now()
  `);
}
```

Helper `bumpAndStamp` — recompute refcount/split-counts from the holder rows (holders are source of truth), refresh `expires_at`, optionally set liveness:

```ts
async function bumpAndStamp(
  tx: Database, leaseId: string, _kind: LeaseHolderKind, leaseTtlMs: number,
  setLiveness: SandboxLeaseLiveness | null,
): Promise<LeaseSnapshot> {
  // Derive counts from the holder rows so the cache can never drift from truth.
  const [counts] = await tx.execute<{ total: number; turns: number; viewers: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where kind='turn')::int   as turns,
           count(*) filter (where kind='viewer')::int as viewers
    from sandbox_lease_holders where lease_id = ${leaseId}
  `);
  const [updated] = await tx.execute<LeaseRow>(sql`
    update sandbox_leases set
      refcount       = ${counts.total},
      turn_holders   = ${counts.turns},
      viewer_holders = ${counts.viewers},
      expires_at     = now() + (${leaseTtlMs}::text || ' milliseconds')::interval,
      ${setLiveness ? sql`liveness = ${setLiveness},` : sql``}
      updated_at     = now()
    where id = ${leaseId}
    returning *
  `);
  return mapLeaseRow(updated);
}
```

> `LeaseRow` is the snake_case raw shape; `mapLeaseRow` maps to the camelCase `LeaseSnapshot` (mirrors `mapSessionTurn` at the existing `claimNextQueuedTurn` return). Because `lease_epoch` is `integer`/int4 (NOT bigint/int8 — the lease-epoch spike fix), postgres-js returns it as a JS **number** directly, so the strict epoch-fence comparison (`row.lease_epoch !== input.expectedEpoch`) is exact with no coercion; the mapper keeps a defensive `Number(row.lease_epoch)` anyway. The `::int`/int4 `counts.*` aggregates already return numbers for the same reason.

### 4.2 `commitWarmingToWarm` (W1) — the only `lease_epoch++` site

```ts
export async function commitWarmingToWarm(db: Database, input: {
  accountId: string; workspaceId: string; sessionId: string;
  expectedEpoch: number;          // the epoch the spawner observed at cold->warming
  instanceId: string;
  dataPlaneUrl: string | null;    // event-driven resolveExposedPort result, any worker
  leaseTtlMs: number;
}): Promise<{ committed: boolean; lease: LeaseSnapshot | null }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await scopedDb.transaction(async (tx) => {
      const rows = await tx.execute<LeaseRow>(sql`
        update sandbox_leases set
          liveness         = 'warm',
          instance_id      = ${input.instanceId},
          data_plane_url   = ${input.dataPlaneUrl},
          lease_epoch      = lease_epoch + 1,
          expires_at       = now() + (${input.leaseTtlMs}::text || ' milliseconds')::interval,
          updated_at       = now()
        where workspace_id = ${input.workspaceId} and session_id = ${input.sessionId}
          and liveness = 'warming' and lease_epoch = ${input.expectedEpoch}
        returning *
      `);
      // CAS miss = a reaper already reset this warming row to cold (W2, spawner
      // was too slow), or another spawner re-established and bumped the epoch. The
      // spawner MUST drop its in-memory handle and re-acquire — DO NOT force warm.
      // (Never provider-delete the box: it survives on the provider idle-timeout.)
      // Returns committed:false.
      if (rows.length === 0) return { committed: false, lease: null };
      return { committed: true, lease: mapLeaseRow(rows[0]) };
    }));
}
```

### 4.3 `failWarmingToCold` (W3) — caught spawn failure

```ts
export async function failWarmingToCold(db: Database, input: {
  accountId: string; workspaceId: string; sessionId: string; expectedEpoch: number;
}): Promise<void> {
  await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb.execute(sql`
        update sandbox_leases set
          liveness = 'cold', instance_id = null,
          data_plane_url = null, updated_at = now()
        where workspace_id = ${input.workspaceId} and session_id = ${input.sessionId}
          and liveness = 'warming' and lease_epoch = ${input.expectedEpoch}
      `);
      // Holders are intentionally left intact: the arrival that triggered the
      // spawn still wants a box, so the NEXT acquireLease re-CAS cold->warming.
    });
}
```

### 4.4 `releaseLeaseHolder` — idempotent delete-my-row (+ opportunistic warm→draining)

```ts
export async function releaseLeaseHolder(db: Database, input: {
  accountId: string; workspaceId: string; sessionId: string;
  kind: LeaseHolderKind; holderId: string; idleGraceMs: number;
}): Promise<{ liveness: SandboxLeaseLiveness; refcount: number } | null> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await scopedDb.transaction(async (tx) => {
      const [row] = await tx.execute<LeaseRow>(sql`
        select * from sandbox_leases
        where workspace_id = ${input.workspaceId} and session_id = ${input.sessionId}
        for update
      `);
      if (!row) return null;  // already cold-and-reaped; release is a no-op (idempotent)

      // Idempotent: deleting an already-gone holder affects 0 rows, fine.
      await tx.execute(sql`
        delete from sandbox_lease_holders
        where lease_id = ${row.id} and kind = ${input.kind} and holder_id = ${input.holderId}
      `);

      // Recompute counts from truth.
      const [c] = await tx.execute<{ total: number; turns: number; viewers: number }>(sql`
        select count(*)::int total,
               count(*) filter (where kind='turn')::int turns,
               count(*) filter (where kind='viewer')::int viewers
        from sandbox_lease_holders where lease_id = ${row.id}
      `);

      // RELEASE DURING warming: decrement only, NEVER touch liveness (spawner
      // owns warming->warm; it re-checks refcount after committing).
      let nextLiveness = row.liveness as SandboxLeaseLiveness;
      const grace = sql`now() + (${input.idleGraceMs}::text || ' milliseconds')::interval`;

      // warm + dropped to 0 (AND no turn holders) -> draining, stamp grace deadline.
      const enterDraining =
        nextLiveness === "warm" && c.total === 0 && c.turns === 0;

      const [updated] = await tx.execute<LeaseRow>(sql`
        update sandbox_leases set
          refcount = ${c.total}, turn_holders = ${c.turns}, viewer_holders = ${c.viewers},
          ${enterDraining ? sql`liveness = 'draining', expires_at = ${grace},` : sql``}
          updated_at = now()
        where id = ${row.id}
        returning *
      `);
      return { liveness: updated.liveness as SandboxLeaseLiveness, refcount: c.total };
    }));
}
```

### 4.5 `heartbeatLeaseHolder` — refresh holder + lease TTL (turn 30s activity heartbeat & app-level viewer heartbeat)

```ts
export async function heartbeatLeaseHolder(db: Database, input: {
  accountId: string; workspaceId: string; sessionId: string;
  kind: LeaseHolderKind; holderId: string; leaseTtlMs: number;
}): Promise<boolean> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await scopedDb.transaction(async (tx) => {
      const updated = await tx.execute<{ id: string }>(sql`
        update sandbox_lease_holders set last_heartbeat_at = now()
        where lease_id = (select id from sandbox_leases
                          where workspace_id = ${input.workspaceId} and session_id = ${input.sessionId})
          and kind = ${input.kind} and holder_id = ${input.holderId}
        returning id
      `);
      if (updated.length === 0) return false;   // holder was reaped — caller re-acquires
      // Refresh the LEASE TTL too so the reaper can't kill a live multi-day turn.
      await tx.execute(sql`
        update sandbox_leases set
          expires_at = now() + (${input.leaseTtlMs}::text || ' milliseconds')::interval,
          updated_at = now()
        where workspace_id = ${input.workspaceId} and session_id = ${input.sessionId}
      `);
      return true;
    }));
}
```

### 4.6 `reapStaleLeaseHolders` — the reaper (viewer-TTL + warming-death + draining-grace, one pass)

Cross-session sweep, scoped per workspace by the caller loop; runs on the boot-validated `reaperPeriod` cadence. Three independent actions in one function.

```ts
export async function reapStaleLeaseHolders(db: Database, input: {
  workspaceId: string;
  viewerHolderTtlMs: number;   // delete viewer rows older than this
  idleGraceMs: number;         // drain-grace horizon (matches releaseLeaseHolder)
}): Promise<{ reapedViewers: number; warmingReset: number; drained: Array<{ sessionId: string; instanceId: string | null }> }> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) =>
    await scopedDb.transaction(async (tx) => {
      // (a) Reap stale VIEWER holders (turn holders are TTL-exempt — never reaped).
      const reaped = await tx.execute<{ lease_id: string }>(sql`
        delete from sandbox_lease_holders
        where workspace_id = ${input.workspaceId} and kind = 'viewer'
          and last_heartbeat_at < now() - (${input.viewerHolderTtlMs}::text || ' milliseconds')::interval
        returning lease_id
      `);

      // (b) Recompute refcounts for every touched lease; warm leases that hit
      // 0 (AND turn_holders=0) enter draining with a fresh grace deadline.
      // (Recompute is a correlated update over all leases in the workspace; the
      // partial index keeps it cheap. Grace = idleGraceMs, the SAME horizon
      // releaseLeaseHolder stamps, so the drain window is identical by path.)
      await tx.execute(sql`
        update sandbox_leases L set
          refcount       = c.total,
          turn_holders   = c.turns,
          viewer_holders = c.viewers,
          liveness = case when L.liveness='warm' and c.total=0 and c.turns=0
                          then 'draining' else L.liveness end,
          expires_at = case when L.liveness='warm' and c.total=0 and c.turns=0
                          then now() + (${input.idleGraceMs}::text || ' milliseconds')::interval
                          else L.expires_at end,
          updated_at = now()
        from (
          select id,
                 (select count(*) from sandbox_lease_holders h where h.lease_id = L2.id)::int total,
                 (select count(*) from sandbox_lease_holders h where h.lease_id = L2.id and h.kind='turn')::int turns,
                 (select count(*) from sandbox_lease_holders h where h.lease_id = L2.id and h.kind='viewer')::int viewers
          from sandbox_leases L2 where L2.workspace_id = ${input.workspaceId}
        ) c
        where L.id = c.id and L.workspace_id = ${input.workspaceId}
      `);

      // (c) WARMING-death (W2): a 'warming' row whose LEASE TTL lapsed = the
      // spawner process died mid-resume. Reset to cold so a queued turn can
      // re-acquire and re-spawn.
      const warmingReset = await tx.execute<{ id: string }>(sql`
        update sandbox_leases set
          liveness='cold', instance_id=null,
          data_plane_url=null, updated_at=now()
        where workspace_id = ${input.workspaceId}
          and liveness='warming' and expires_at < now()
        returning id
      `);

      // (d) DRAINING-grace elapsed (D3): surface leases whose grace is up AND
      // still idle, together with their instance_id, so THIS stateless reaper
      // can issue the provider's existing stop()/terminate (prompt cost-stop)
      // and then CAS draining->cold via confirmDrainCold. There is NO owner
      // process to drop a handle — the per-turn handle was already dropped at the
      // last turn's end and the envelope was upserted per turn. The provider
      // idle-timeout is the backstop for any leaked/missed box.
      const drainable = await tx.execute<{ session_id: string; instance_id: string | null }>(sql`
        select session_id, instance_id from sandbox_leases
        where workspace_id = ${input.workspaceId}
          and liveness='draining' and expires_at < now() and refcount = 0
      `);

      return {
        reapedViewers: reaped.length,
        warmingReset: warmingReset.length,
        // Each surfaced lease is one the caller terminates: the reaper loop calls
        // the provider's stop()/terminate on instance_id (prompt cost-stop), then
        // confirmDrainCold(sessionId) to CAS draining->cold under the epoch fence
        // (a late re-arm during the grace wins and confirmDrainCold returns
        // wentCold:false, in which case the box is NOT stopped). The provider
        // idle-timeout is the backstop if a stop() is missed.
        drained: drainable.map((r) => ({ sessionId: r.session_id, instanceId: r.instance_id })),
      };
    }));
}
```

### 4.7 `reArmDrainingLease` (D1) — explicit re-arm seam (also covered inline by `acquireLease`)

`acquireLease` already re-arms a `draining` lease on a late arrival (the `draining` branch). `reArmDrainingLease` is the standalone version the workflow uses when it learns a turn was queued during the grace window without going through `acquireLease` first:

```ts
export async function reArmDrainingLease(db: Database, input: {
  accountId: string; workspaceId: string; sessionId: string; leaseTtlMs: number;
}): Promise<{ rearmed: boolean }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb.execute<{ id: string }>(sql`
        update sandbox_leases set
          liveness='warm',
          expires_at = now() + (${input.leaseTtlMs}::text || ' milliseconds')::interval,
          updated_at = now()
        where workspace_id = ${input.workspaceId} and session_id = ${input.sessionId}
          and liveness='draining'
        returning id
      `);
      return { rearmed: rows.length > 0 };
    });
}
```

### 4.8 `confirmDrainCold` (D3) — the stateless reaper's final teardown commit

Called by the **stateless reaper** *after* it has issued the provider's existing `stop()`/terminate on `instance_id`. The envelope was already upserted at the last turn's end (`upsertSandboxSessionEnvelope`, `:2609`) and the per-turn handle was dropped then — there is no owner process. CAS-guarded so a re-arm that snuck in during teardown wins (in which case the reaper must NOT have stopped the box yet — see the ordering note below):

```ts
export async function confirmDrainCold(db: Database, input: {
  accountId: string; workspaceId: string; sessionId: string; expectedEpoch: number;
}): Promise<{ wentCold: boolean }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await scopedDb.transaction(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        update sandbox_leases set
          liveness='cold', instance_id=null,
          data_plane_url=null, updated_at=now()
        where workspace_id = ${input.workspaceId} and session_id = ${input.sessionId}
          and liveness='draining' and refcount = 0 and lease_epoch = ${input.expectedEpoch}
        returning id
      `);
      // CAS miss = a late acquire re-armed to warm (D1) during teardown, OR a
      // newer epoch exists. The reaper ABORTS teardown — the box is still wanted.
      // ORDERING: the reaper checks confirmDrainCold's CAS BEFORE issuing the
      // provider stop() (or re-reads it after a no-op stop), so a re-armed box is
      // never killed. wentCold:false => leave the box running.
      return { wentCold: rows.length > 0 };
    }));
}
```

### 4.9 `readLease` — non-locking snapshot for the API handshake & health

```ts
export async function readLease(db: Database, workspaceId: string, sessionId: string): Promise<LeaseSnapshot | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.sandboxLeases)
      .where(and(eq(schema.sandboxLeases.workspaceId, workspaceId), eq(schema.sandboxLeases.sessionId, sessionId)))
      .limit(1);
    return row ? mapLeaseRow(row) : null;
  });
}
```

---

## 5. Heartbeat / TTL / reaper cadence — exact values & the boot invariant

### 5.1 Cadences (defaults from the settled design)

| Knob | Default | Source-of-truth cadence | Notes |
|---|---|---|---|
| `reaperPeriod` | 30 s | reaper loop interval | must be the SMALLEST — fires before any TTL it polices; also the sole cost-stop driver (`stop()` at refcount 0) |
| `viewerHolderTTL` | 90 s | `reapStaleLeaseHolders` deletes viewer rows older than this | = ~3 missed app-level viewer heartbeats |
| `idleTimeout` | 900 s (`modalTimeoutSeconds`, `config:241`) | provider idle-kill horizon | the LARGEST — the box rides this between turns; it is the **backstop** for a leaked/missed box. No keep-alive loop. |
| `idleGraceMs` | 30–60 s | `draining` grace window | flap-collapse; the reaper `stop()`s once it elapses at refcount 0 |
| lease `leaseTtlMs` | 45 s (= 1.5× reaperPeriod) | `expires_at` refresh window | refreshed on acquire + the turn's 30s activity heartbeat + a viewer's app-level heartbeat |

### 5.2 The boot-validated cadence invariant `reaperPeriod < viewerHolderTTL < idleTimeout`

Add to `packages/config/src/index.ts`. New fields after `:244`:

```ts
  // --- sandbox lease cadences (cadence invariant validated below) ---
  sandboxLeaseReaperPeriodMs: z.coerce.number().int().positive().default(30_000),
  sandboxViewerHolderTtlMs:   z.coerce.number().int().positive().default(90_000),
  sandboxIdleGraceMs:         z.coerce.number().int().positive().default(45_000),
  // NOTE: no keep-alive knob. Between turns the box survives on the provider's
  // EXISTING idle-timeout (modalTimeoutSeconds, config:241) — there is no
  // keepalive loop to bound, so no new idle config or tuning knob is introduced.
```

Env mappings after `:481`:

```ts
    sandboxLeaseReaperPeriodMs: optional("OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS"),
    sandboxViewerHolderTtlMs:   optional("OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS"),
    sandboxIdleGraceMs:         optional("OPENGENI_SANDBOX_IDLE_GRACE_MS"),
```

Boot validation — appended to the post-`.parse()` `throw new Error` block (the same block as the Modal-token check at `:985`). `idleTimeout` derives from `modalTimeoutSeconds` (the provider idle horizon):

```ts
  // --- sandbox lease cadence invariant (fail fast at boot) ---
  {
    const reaperPeriod   = settings.sandboxLeaseReaperPeriodMs;
    const viewerTtl      = settings.sandboxViewerHolderTtlMs;
    const idleTimeoutMs  = settings.modalTimeoutSeconds * 1000;

    if (!(reaperPeriod < viewerTtl)) {
      throw new Error(
        `OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS (${reaperPeriod}) must be strictly less than ` +
        `OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS (${viewerTtl}): the reaper must run more often ` +
        `than the TTL it polices, or stale viewer holders outlive a full reaper period.`);
    }
    if (!(viewerTtl < idleTimeoutMs)) {
      throw new Error(
        `OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS (${viewerTtl}) must be strictly less than the provider ` +
        `idle timeout (OPENGENI_MODAL_TIMEOUT_SECONDS*1000 = ${idleTimeoutMs}): a viewer holder must be ` +
        `reapable before the box idles out from under it (the provider idle-timeout is the backstop).`);
    }
  }
```

This realizes the settled invariant: **`reaperPeriod (30s) < viewerHolderTTL (90s) < idleTimeout (900s)`**. There is no keep-alive clause — the box rides the provider idle-timeout between turns and the reaper `stop()`s at refcount 0; nothing needs to "beat" the idle horizon. The process refuses to start on violation, identical to every other cross-field check in this block.

---

## 6. Failure / edge-case matrix (each maps to a concrete code path above)

| Stress case (settled §J) | Mechanism | Function / branch |
|---|---|---|
| (a) Turn + viewer hit idle simultaneously | `(ws,session)` unique + `FOR UPDATE` serializes; first wins `cold→warming` CAS, the loser attaches to the same box | `acquireLease` cold/warming branches |
| (a′) Spawner *dies* mid-resume (uncaught) | `warming` lease-TTL lapses → reaper resets to `cold` (W2) | `reapStaleLeaseHolders` (c) |
| (b) Worker restart mid-turn / viewer-only liveness | turn liveness = the turn's 30s Temporal activity heartbeat refreshing `expires_at`; viewer-only liveness = the viewer's app-level API heartbeat refreshing its holder. A worker dying mid-turn → the requeued turn re-resumes the box **by id on any pool worker** (no owner to restart). Between turns the box rides the provider idle-timeout. | `heartbeatLeaseHolder` + reaper |
| (c) Split-brain (2nd control handle) | `lease_epoch` fence: `commitWarmingToWarm` bumps; a re-establishing turn is gated on `expectedEpoch` inside the `FOR UPDATE` txn → a stale re-dispatched writer gets `role:"fenced"`, backs off; **NEVER `create()`** | `acquireLease` warm+fence branch; `commitWarmingToWarm` |
| (d) Lease expires during legit multi-day turn | `expires_at` refreshed on the turn's 30s heartbeat; `warm→draining` CAS guarded `AND turn_holders=0` (only viewers TTL-reapable) | `heartbeatLeaseHolder`; `releaseLeaseHolder` `enterDraining` guard; reaper (b) |
| (e1/e2) Box dies under agent / lone viewer | box-exec failure routes back through `acquireLease` (re-CAS `cold→warming`, re-resume-from-envelope) — unified "re-establish-singleton-from-envelope-under-CAS"; never `failSession` | `acquireLease` (the one recovery primitive) |
| (f) Closed laptop | client→server Channel-A viewer ping refreshes the viewer holder; absent → `reapStaleLeaseHolders` drops it within ≤`viewerHolderTTL` (~90s) | `heartbeatLeaseHolder` (viewer) / reaper (a) |
| (g) Flapping connect/disconnect | mandatory `draining` grace window (`idleGraceMs`) collapses N flaps → 1 box; re-arm `draining→warm` on late arrival; release-during-`warming` decrements only | `releaseLeaseHolder` grace stamp; `acquireLease` draining branch / `reArmDrainingLease` |
| Retried release (Temporal at-least-once) | delete-my-holder-row affects 0 rows on retry → idempotent | `releaseLeaseHolder` delete |
| Retried/duplicate acquire (same holder) | holder unique index → `ON CONFLICT DO UPDATE` heartbeat-refresh, no double-count | `upsertHolder` |
| Lease row missing on release | `readLease`/lock returns null → no-op | `releaseLeaseHolder` null-guard |
| Re-arm racing teardown | `confirmDrainCold` CAS `AND liveness='draining' AND refcount=0 AND lease_epoch=expectedEpoch` → loses to D1 re-arm, the reaper aborts teardown (does not `stop()`), box stays alive | `confirmDrainCold` |
| Refcount cache drift | every mutation recomputes `refcount/turn_holders/viewer_holders` from `COUNT(holders)` — holders are source of truth | `bumpAndStamp`, `releaseLeaseHolder`, reaper (b) |

---

## 7. Test plan (`packages/db/test/sandbox-leases.test.ts`, NEW)

Mirror the existing db test harness. Required cases:

1. **Singleton under concurrency:** fire N=50 `acquireLease(cold)` in parallel against a fresh session → **exactly one** `role:"spawner"`, N−1 `role:"attached"`; `refcount == 50`, `liveness=='warming'`.
2. **cold→warming→warm→draining→cold full cycle:** acquire(turn) → spawner; `commitWarmingToWarm` → warm, epoch++; release(turn) → draining + grace stamp; advance clock; `reapStaleLeaseHolders`/`confirmDrainCold` → cold.
3. **Epoch fence:** warm at epoch E; acquire(turn, expectedEpoch=E−1) → `role:"fenced"`, no refcount change.
4. **Warming-death TTL:** insert warming with `expires_at` in the past → reaper resets to cold; refcount/holders preserved.
5. **Viewer TTL reap vs turn exemption:** one stale viewer + one stale-looking turn holder → reaper deletes only the viewer; turn survives; `warm→draining` only when `turn_holders==0`.
6. **Drain-vs-arrive re-arm:** lease draining within grace; `acquireLease` → `role:"rearmed"`, `liveness=='warm'`; subsequent `confirmDrainCold` returns `wentCold:false` (reaper does NOT stop the box).
7. **Idempotent release:** call `releaseLeaseHolder` for the same holder twice → second is a 0-row no-op, refcount stable.
8. **Idempotent acquire:** same `(lease,kind,holder)` acquired twice → one holder row, refcount counts it once.
9. **Cadence invariant boot check:** `loadSettings` with `viewerTtl <= reaperPeriod` (and `idleTimeout <= viewerTtl`) throws with the exact messages.
10. **Reaper terminate at refcount 0:** advance a `draining` lease past grace with `refcount=0` → `reapStaleLeaseHolders` surfaces it with its `instanceId`; the loop issues the provider `stop()` then `confirmDrainCold` CASes `draining→cold`. A late `acquireLease` re-arm before `confirmDrainCold` → `wentCold:false`, box left running.

---

## 8. Net summary of what this module delivers

- **2 tables** (`sandbox_leases` 1-per-session singleton + `sandbox_lease_holders` N-per-session idempotent refcount), DDL + Drizzle + RLS migration `0017`, FK chain and index shape copied verbatim from `sandboxSessionEnvelopes` (`schema.ts:360`).
- **9 query functions** in `packages/db/src/index.ts` co-located with the envelope fns, every one built on the in-repo `withWorkspaceRls` + `scopedDb.transaction` + raw `sql\`\`` lease pattern (`claimNextQueuedTurn`, `:3077`).
- **The exact `acquireLease` critical section**: `INSERT … ON CONFLICT DO NOTHING` → `SELECT … FOR UPDATE` (block, not `SKIP LOCKED`) → branch (cold/warming/warm/draining) → conditional `cold→warming` CAS → `refcount`/split-holder/`expires_at` bump — the **sole** double-spawn guard.
- **The 4-state machine** with all 9 labeled transitions including the two the base design missed (W2 uncaught-spawner-death `warming` lease-TTL→cold; D1 `draining→warm` re-arm) and the pre-emptive `lease_epoch` fence (`commitWarmingToWarm` bumps; `acquireLease`/`confirmDrainCold` validate) that makes split-brain safe and forbids `create()`-on-conflict. At refcount 0 the **stateless reaper issues the provider's existing `stop()`/terminate** (prompt cost-stop), with the provider idle-timeout as the backstop — there is no owner process, no keep-alive loop, and no per-session task queue.
- **Heartbeat/reaper** cadences with the boot-validated `reaperPeriod < viewerHolderTTL < idleTimeout` invariant added to the existing `config/src/index.ts:985` validation block, reusing `modalTimeoutSeconds` (`:241`) as the idle horizon/backstop. Lease TTL is refreshed by the turn's existing 30s Temporal activity heartbeat (turns are still activities) and by a viewer's app-level API heartbeat — there is **no** `ownerHeartbeat` activity and **no** keep-alive knob.

Key real-file anchors this builds on: `packages/db/src/schema.ts:360` (envelope table mirror), `packages/db/src/index.ts:3077` (`claimNextQueuedTurn` lease txn pattern), `packages/db/src/index.ts:2609` (`upsertSandboxSessionEnvelope`), `packages/db/drizzle/0005_session_goals.sql:25-45` (RLS+grant boilerplate), `packages/config/src/index.ts:241` (`modalTimeoutSeconds`) and `:985` (cross-field validation block).

---

## Adversarial Review

# Adversarial Review — Lease & Singleton State Machine spec

I verified every load-bearing claim against the codebase (HEAD) and ran the suspect SQL/types against real Postgres 16 + postgres-js. Anchors mostly check out (`claimNextQueuedTurn` is at `packages/db/src/index.ts:3077`; envelope table at `schema.ts:360`; config validation block at `config/src/index.ts:985`; `0005` RLS boilerplate matches; `0017` is the correct next migration number). The architecture is sound and most SQL is valid. But there are several real bugs — two of them defeat the module's headline invariants.

## CRITICAL — defeats a stated invariant

**C1. The epoch fence comparison is always-true → the fence fires on every turn, AND it never actually fences a stale-epoch turn.** Two distinct defects in the same mechanism:

- *(a) Type bug — verified empirically. **RESOLVED**: `lease_epoch` is now `integer`/int4, not `bigint`/int8.* The original defect: in `acquireLease`'s warm branch the fence is `row.lease_epoch !== input.expectedEpoch`; when `lease_epoch` was `bigint`/int8, postgres-js returned int8 from a raw `tx.execute`/`sql` query as a **JS string**, not a number (confirmed: `typeof === "string"`, and `"1" === 1` is `false`), so the strict comparison was *always* true and **every** turn arriving with `expectedEpoch` set was wrongly returned as `role:"fenced"` and never attached. The spike fix (now the design of record, §1.1/§2) makes the column `integer`/int4, which postgres-js returns as a JS **number**, so the strict comparison is exact and the fence works. (`::int`/int4 and `integer` columns *do* come back as numbers — only int8 was a string — so the `counts.*` interpolations were always fine.) `mapLeaseRow` keeps a defensive `Number(row.lease_epoch)` coercion regardless.

- *(b) Coverage bug — the split-brain it claims to close stays open.* §3 invariant #5 and §6(c) assert a stale re-dispatched writer "fails the CAS and backs off." But the only lease write between turns is `heartbeatLeaseHolder`, and that function does **no epoch check** — its second UPDATE blindly refreshes `expires_at` for the session. So if a turn from a worker presumed dead is still running (a partition, not a real death) after a newer turn re-established and bumped the epoch, the stale turn keeps heartbeating, keeps the lease alive at the new epoch, and keeps running its own live (now-non-owned) handle — two concurrent turns against the same box. Under the unlimited-concurrency ruling, two **current-epoch** turns running concurrently is *fine* (last-writer-wins); the problem is specifically the **stale-epoch** turn that should have been fenced. The fence is checked only on the turn-arrival path, not on the 30s heartbeat path. **Fix:** carry `expectedEpoch` (the epoch the turn established/attached under) into `heartbeatLeaseHolder` and gate the lease-refresh UPDATE on `... AND lease_epoch = ${expectedEpoch}`; return `false` on mismatch so the stale-epoch turn drops its handle and stops heartbeating.

**C2. `heartbeatLeaseHolder` un-guarded `expires_at` refresh wedges a draining lease forever.** The second UPDATE in `heartbeatLeaseHolder` refreshes `expires_at = now()+ttl` for the session with **no `liveness` guard**. A turn-holder heartbeat (or a viewer ping) that races the drain fires while `liveness='draining'`, pushing the grace deadline into the future without re-arming. D3 (`confirmDrainCold`/reaper step d) requires `expires_at < now()`, so the lease can never reach `cold`; and since the heartbeat never touches `liveness`, it never re-arms to `warm` either. The box sits in `draining` indefinitely while a holder heartbeats. **Fix:** either restrict the refresh to `WHERE ... AND liveness IN ('warm','warming')`, or have the heartbeat re-arm `draining→warm` when a holder still exists (and recompute refcount). This is the same missing-guard class as C1b.

## MAJOR — correctness / contract bugs

**M1. ~~Two different grace windows depending on which path drains.~~ RESOLVED in the stateless-reaper revision.** Originally `reapStaleLeaseHolders` step (b) stamped `now()+viewerHolderTtlMs` (~90s) while `releaseLeaseHolder` stamped `now()+idleGraceMs` (~45s), so the grace window differed by path. The revision now threads `idleGraceMs` into `reapStaleLeaseHolders` and uses it for the drain stamp — both paths use the identical horizon.

**M2. `LeaseRow` and `mapLeaseRow` are undefined yet referenced ~15×, and they cannot satisfy both call shapes.** For an "implementation-grade, runnable" spec they must be concrete. Worse, `readLease` builds rows via the Drizzle query builder (`.select().from(schema.sandboxLeases)`), which returns **camelCase** keys with `leaseEpoch` already a number (`mode:"number"`), while every other function feeds `mapLeaseRow` a **snake_case** raw row with `lease_epoch` as a string. A single `mapLeaseRow` can't map both. **Fix:** define `LeaseRow` (snake_case) and a single `mapLeaseRow` that takes the raw row; make `readLease` also go through raw `sql` (or write a second mapper). Specify the `Number(row.lease_epoch)` coercion and `Date` handling explicitly.

**M3. `tx.execute<LeaseRow>(...)` puts the generic in the wrong place and types `tx` wrong.** The in-repo pattern (`index.ts:3079`) is `tx.execute(sql<{id:string}>\`...\`)` — the row type goes on the `sql` tag, not on `.execute`. `PostgresJsDatabase.execute` is not generic this way, so every `tx.execute<LeaseRow>` in the spec is a type error as written. Separately, the helper signatures `upsertHolder(tx: Database, ...)`/`bumpAndStamp(tx: Database, ...)` are wrong: inside `scopedDb.transaction` the value is a `PgTransaction`, not `Database` (the existing code casts `tx as unknown as Database`). **Fix:** move the generic onto `sql<...>` and either cast the tx or type the helpers as the transaction type.

**M4. Redundant nested transaction, and an RLS-context inconsistency.** `withRlsContext`/`withWorkspaceRls` already open a transaction internally (`index.ts:94`, casts `tx` to `Database`), so the spec's `withRlsContext(db, …, async (scopedDb) => scopedDb.transaction(async (tx) => …))` opens a **nested** (savepoint) transaction. `claimNextQueuedTurn` does this too (`withWorkspaceRls(…) → scopedDb.transaction`), so it's tolerated — but it's worth stating that the outer wrapper is already transactional. More substantively: the spec mixes `withRlsContext` (needs `accountId`+`workspaceId`, used by acquire/release/heartbeat/commit) and `withWorkspaceRls` (derives `accountId`, used by reaper/readLease). That's fine, but `reapStaleLeaseHolders` and the cross-session recompute only work because the RLS predicate `workspace_rls_visible(account_id, workspace_id)` is scoped to one workspace from the GUC context — the spec should state the reaper MUST be invoked per-workspace (it says so in prose; make it a hard contract, since a cross-workspace sweep would silently see nothing under FORCE RLS).

**M5. ~~The reaper returns a dead/duplicating contract.~~ RESOLVED in the stateless-reaper revision.** Originally the reaper hardcoded `drainingReset: 0` (dead weight) and returned `drained: string[]`, re-reporting the same draining session ids every pass for some other actor to tear down. The revision drops `drainingReset`, and — under stateless workers there is no per-session owner to defer to — the reaper itself owns teardown: `drained` now carries `{ sessionId, instanceId }`, and the reaper loop issues the provider `stop()` on `instanceId` then immediately `confirmDrainCold`-CASes `draining→cold` under the epoch fence. A row only reappears next pass if `confirmDrainCold` lost to a D1 re-arm (correct: the box is still wanted), so there is no thrash.

## MINOR — doc/internal contradictions and dead rationale

**m1. Internal contradiction on the singleton guard.** §1.1 says "UNIQUE (workspace_id, session_id) … is the *only* hardware." Invariant #1 says "SELECT … FOR UPDATE is the ONLY double-spawn guard." Both mechanisms are present and both are needed (the unique index serializes the *create* race via the index-tuple lock under READ COMMITTED — I verified the INSERT-ON-CONFLICT-DO-NOTHING + FOR-UPDATE interaction is safe — and FOR UPDATE serializes the liveness CAS for *post-existence* arrivals). Pick one accurate framing; "only" is wrong for both in isolation.

**m2. "Never-warmed cold row is still reaper-visible" is false.** `acquireLease` seeds a new cold row's `expires_at`, but the reaper's partial index and all of steps (b)/(c)/(d) exclude/never select `liveness='cold'`. A cold row with zero holders is never GC'd (until session cascade). Harmless, but the stated rationale is wrong and there's no cold-row cleanup. Either drop the comment or add a cold-row sweep.

**m3. Transition IDs disagree across the diagram, the table, and the matrix.** Uncaught-spawner-death is labeled **W4** in the §3 ASCII art but **W2** in the §3 table and "(a′) → reaper (c)" in §6. The §3 table also has no row for the diagram's "W4." Renumber consistently.

**m4. §3 W2 side-effects are vacuous.** The table says W2 clears `instance_id/data_plane_url`; but a `warming` row never set `instance_id` (it's NULL until `commitWarmingToWarm`), so the clear is a no-op. Cosmetic. (The `owner_worker_id`/`owner_task_queue` columns this once also cleared are now gone under the stateless-workers model.)

**m5. DDL prose vs predicate mismatch.** §1.1 comment says the reaper partial index is "on the two states the reaper acts on," but the predicate lists three (`'warming','warm','draining'`). Also step (b)'s full-workspace recompute has no `expires_at` filter, so that index doesn't serve it. Align the comment.

**m6. Test plan is partly unimplementable as worded.** Cases 2 and 6 say "advance the clock," but all TTL/grace logic uses SQL `now()` (DB clock) — a test can't advance Postgres's `now()`. Tests must inject past `expires_at` (as case 4 correctly does) or use tiny TTLs + real sleeps. Reword.

## Things I checked that are actually fine
- `count(*) filter (where …)::int` (no parens) — valid; returns a JS number. Verified in pg16.
- The `(${ms}::text || ' milliseconds')::interval` construction — valid.
- The conditional `${cond ? sql\`x = y,\` : sql\`\`}` fragments in `bumpAndStamp`/`releaseLeaseHolder` SET lists — comma placement is valid in both branches (the fragment always sits between a trailing-comma line and `updated_at`).
- The reaper's correlated `UPDATE … FROM (SELECT … FROM sandbox_leases L2 …) c` recompute — valid and produces correct counts. Verified in pg16.
- INSERT-ON-CONFLICT-DO-NOTHING + SELECT-FOR-UPDATE under READ COMMITTED — safe; the create race serializes on the unique index, the liveness CAS on the row lock.
- `0017` is the correct next migration; `0005` RLS/grant boilerplate matches verbatim; config-validation `settings.X` referencing style matches the surrounding block.

**Net:** the design is sound and the SQL largely runs, but as written the module does **not** deliver its two headline guarantees — the `lease_epoch` split-brain fence is both type-broken (always-fires) and never checked on the heartbeat path that matters (C1), and an un-guarded heartbeat can wedge a lease in `draining` forever (C2). Those two plus the undefined `LeaseRow`/`mapLeaseRow` (M2) and the `tx.execute<T>` typing (M3) are the must-fixes before this compiles and is correct.

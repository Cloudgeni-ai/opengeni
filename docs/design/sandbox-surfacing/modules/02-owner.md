# Module: Stateless resume-by-id + ownership inversion + Temporal integration  (owner)

## Specification

# MODULE SPEC: Stateless resume-by-id + Ownership Inversion + Temporal Integration

This is the layer that turns OpenGeni's per-run, build-and-discard sandbox client into a logical singleton served by a **stateless worker pool** (for turns) and an **API-direct control plane** (for everything else). For a **turn**, any worker resumes the one box by id (warm reattach if still alive, else cold-restore from snapshot), injects it as a **non-owned** session into `runStream`, runs the agent, lets the SDK serialize the updated envelope, and **drops the in-memory handle at turn end**. For every **non-turn op** (viewer attach, mint/rotate the desktop tunnel URL, FileSystem list/read for the Pierre tree, Git status/diff, capability negotiation) the path is **API-DIRECT**: client → `apps/api` → box. The API process itself runs the cold→warming lease CAS as a Postgres transaction it owns, `resume()`s the box by id from the lease envelope, and calls `session.exec`/`readFile`/`resolveExposedPort` in-process — **no Temporal, no worker RPC, no NATS request-reply, and no `sandboxOwnerRpcWorkflow`** in that synchronous path. The Postgres lease + epoch fence remain the singleton/recovery primitives; there is **no in-worker `SandboxOwner` actor**, no per-session/per-group Temporal task queue, no `Map<id, SandboxOwner>`, and no worker-per-session. **Temporal hosts exactly two things: the long-running agent turn (`sessionWorkflow`) and one global reaper Temporal Schedule** — nothing else.

All line numbers are HEAD-relative (±a few lines); named symbols are exact.

---

## 0. The four-layer mental model

```
                    ┌──────────────────────────────────────────────────────────┐
                    │  Postgres: sandbox_leases (1/session) + holders (N/session)│  ← SOLE singleton enforcer
                    └──────────────────────────────────────────────────────────┘
                            ▲ FOR UPDATE / CAS / lease_epoch fence ▲
       turn acquire/release │                                      │ NON-TURN ops (API-DIRECT)
   ┌────────────────────────┴──────────────┐         ┌─────────────┴──────────────────────────┐
   │  STATELESS WORKER POOL (apps/worker)   │         │  apps/api process  — CONTROL PLANE       │
   │    each TURN: any worker resumes the   │         │    client → API → box, IN-PROCESS:       │
   │    box BY ID from the lease/envelope    │         │    viewer attach, mint/rotate the        │
   │    (warm reattach or cold-restore),     │         │    desktop tunnel URL, FileSystem        │
   │    ensureDisplayStack/exposeStreamPort  │         │    list/read, Git status/diff, capability│
   │    (idempotent), drops the handle when  │         │    negotiation. The API runs the         │
   │    the turn returns                     │         │    cold→warming CAS as a Postgres txn it │
   └────────────────────────┬──────────────┘         │    owns, resume()s by id, and calls      │
              resume-by-id   │                         │    session.exec/readFile/resolveExposed- │
              per turn       │                         │    Port directly. NO Temporal, NO worker │
   ┌────────────────────────┴──────────────┐         │    RPC, NO NATS request-reply.           │
   │  runtime.runStream(..., {session,…})   │         └─────────────┬────────────────────────────┘
   │   packages/runtime/src/index.ts:1003   │       resume-by-id    │  (@opengeni/runtime/sandbox: the
   │   injects a NON-OWNED live session     │       in the API      │   sandbox-access module the API imports
   │   (SDK never reaps it; keystone spike) │                       │   WITHOUT the agent-loop graph)
   └────────────────────────┬──────────────┘         ┌─────────────┴────────────────────────────┐
              existing       │  settings.                          │  box (Modal etc.): desktop pixels reach
              GLOBAL queue   │  temporalTaskQueue                  │  the viewer DIRECTLY via the tunnel URL;
   ┌────────────────────────┴──────────────────────┐               │  no proxy through API/worker
   │  Temporal: EXACTLY TWO things —                │               └──────────────────────────────────────────┘
   │   (1) the long-running agent TURN (sessionWorkflow)            │
   │   (2) ONE GLOBAL REAPER as a Temporal Schedule.                │
   │  NOTHING else. No per-session queue, no per-RPC workflow,      │
   │  no sandboxOwnerRpcWorkflow, no viewer-attach activity.        │
   └───────────────────────────────────────────────────────────────┘
```

**Liveness** is the lease refcount (turns + viewers over the lease) — UNCHANGED. **Control plane is API-DIRECT:** for ALL non-turn ops (viewer attach, mint/rotate the desktop tunnel URL, FileSystem list/read for the Pierre tree, Git status/diff, capability negotiation) the path is **client → API → box** — the `apps/api` process itself does `resume()`-by-id from the lease's envelope, `session.exec/readFile`, and `resolveExposedPort` in-process, and runs the cold→warming lease CAS as a Postgres transaction it owns. There is **no Temporal, no worker RPC, and no NATS request-reply in the synchronous control path** (verified: `ModalSandboxClient.resume()` is per-call with no pool/singleton; the API already makes outbound HTTPS to Stripe/OpenAI/GitHub and owns Postgres; the sandbox-client functions have zero coupling to the agent-loop/Temporal code — `packages/runtime` has no `@temporalio` dep). **Temporal is used for exactly two things:** the long-running agent turn (the existing `sessionWorkflow`) and one global reaper as a Temporal Schedule. **Between turns** the box survives on the provider's existing idle-timeout (`modalTimeoutSeconds`, `config/src/index.ts:241`); no keepalive loop, no new idle config. At **refcount 0** (after the short drain grace) the **reaper** issues the provider's existing `stop()`/terminate for a prompt cost-stop; the provider idle-timeout is the backstop for a leaked/missed box. **Viewers** connect directly to the tunnel URL stored in the lease (`data_plane_url`); the desktop pixel plane never proxies through the API or worker.

---

## 1. DDL — two new tables

New file `packages/db/migrations/00NN_sandbox_leases.sql` (Drizzle-generated from schema; raw DDL below for the SOLE-enforcer semantics that Drizzle expresses). Both mirror `sandboxSessionEnvelopes` (`packages/db/src/schema.ts:360-370`): same FK cascade chain (`accountId→managed_accounts`, `workspaceId→workspaces`, `sessionId→sessions`, all `ON DELETE CASCADE`).

### 1.1 `sandbox_leases` — one row per session (logical singleton)

```sql
CREATE TABLE sandbox_leases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id)       ON DELETE CASCADE,
  session_id      uuid NOT NULL REFERENCES sessions(id)         ON DELETE CASCADE,

  -- STATE MACHINE (sec 4). Free-text + CHECK, matching sandbox_backend's text-column convention.
  liveness        text NOT NULL DEFAULT 'cold'
                    CHECK (liveness IN ('cold','warming','warm','draining')),

  -- REFCOUNT (denormalized COUNT(holders); reaper recomputes — never the source of truth).
  refcount        integer NOT NULL DEFAULT 0,
  turn_holders    integer NOT NULL DEFAULT 0,   -- TTL-EXEMPT (released by activity lifecycle only)
  viewer_holders  integer NOT NULL DEFAULT 0,   -- TTL-reapable

  -- BOX IDENTITY (which provider box the resume-by-id path reattaches to)
  instance_id     text,            -- provider sandbox id (Modal sandboxId, e2b host id, …)
  backend_id      text,            -- 'modal' | 'e2b' | … — fences resume to the original provider

  -- DATA PLANE (Channel B)
  data_plane_url  text,            -- current scoped tunnel URL for the desktop port
  data_plane_expires_at timestamptz,  -- when data_plane_url must be re-minted

  -- FENCE + TTL
  lease_epoch     bigint NOT NULL DEFAULT 0,    -- bumped on every warming→warm and re-election
  expires_at      timestamptz NOT NULL,         -- heartbeat-TTL; refreshed on acquire AND turn 30s heartbeat
  warming_expires_at timestamptz,               -- separate TTL for a spawner that DIES mid-resume (sec 4)

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- THE singleton enforcer. One row per (workspace, session); every arrival
-- serializes on this via SELECT … FOR UPDATE.
CREATE UNIQUE INDEX sandbox_leases_session_idx
  ON sandbox_leases (workspace_id, session_id);

-- Reaper scan support: find leases whose holder TTL or warming TTL has expired.
CREATE INDEX sandbox_leases_reap_idx
  ON sandbox_leases (liveness, expires_at);
```

### 1.2 `sandbox_lease_holders` — N rows per session (idempotent release)

```sql
CREATE TABLE sandbox_lease_holders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id)       ON DELETE CASCADE,
  lease_id         uuid NOT NULL REFERENCES sandbox_leases(id)   ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('turn','viewer')),
  -- holder_id: for turns = the Temporal activityId (unique per scheduled exec);
  --            for viewers = the access-grant id (one viewer attach = one grant).
  holder_id        text NOT NULL,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Idempotent acquire/release: re-acquiring the same holder is a no-op upsert;
-- release is DELETE … WHERE (lease_id, kind, holder_id), never a blind decrement.
CREATE UNIQUE INDEX sandbox_lease_holders_holder_idx
  ON sandbox_lease_holders (lease_id, kind, holder_id);

-- Reaper: find viewer holders whose heartbeat is stale.
CREATE INDEX sandbox_lease_holders_stale_idx
  ON sandbox_lease_holders (kind, last_heartbeat_at);
```

### 1.3 Drizzle schema additions (`packages/db/src/schema.ts`, after line 370)

```ts
export const sandboxLeases = pgTable("sandbox_leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  liveness: text("liveness").notNull().default("cold").$type<"cold" | "warming" | "warm" | "draining">(),
  refcount: integer("refcount").notNull().default(0),
  turnHolders: integer("turn_holders").notNull().default(0),
  viewerHolders: integer("viewer_holders").notNull().default(0),
  instanceId: text("instance_id"),
  backendId: text("backend_id"),
  dataPlaneUrl: text("data_plane_url"),
  dataPlaneExpiresAt: timestamp("data_plane_expires_at", { withTimezone: true }),
  leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  warmingExpiresAt: timestamp("warming_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  sessionIdx: uniqueIndex("sandbox_leases_session_idx").on(table.workspaceId, table.sessionId),
  reapIdx: index("sandbox_leases_reap_idx").on(table.liveness, table.expiresAt),
}));

export const sandboxLeaseHolders = pgTable("sandbox_lease_holders", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  leaseId: uuid("lease_id").notNull().references(() => sandboxLeases.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().$type<"turn" | "viewer">(),
  holderId: text("holder_id").notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  holderIdx: uniqueIndex("sandbox_lease_holders_holder_idx").on(table.leaseId, table.kind, table.holderId),
  staleIdx: index("sandbox_lease_holders_stale_idx").on(table.kind, table.lastHeartbeatAt),
}));
```

`bigint`/`integer`/`index` are already imported at `schema.ts:2`. **No migration is needed for the `sandbox_backend` enum** (text columns; grounding §2). A new migration file is needed only for these two tables.

---

## 2. DB layer functions (`packages/db/src/index.ts`)

All follow the established `withWorkspaceRls(db, workspaceId, async (scopedDb) => scopedDb.transaction(...))` form (the exact shape of `claimNextSessionExecution` at `:3077-3106`). **The grounding's CRITICAL CORRECTION drives this: Temporal does NOT serialize the two acquireLease activities; the `(workspace_id, session_id)` unique index + `SELECT … FOR UPDATE` is the only double-spawn guard.** `FOR UPDATE` (not `SKIP LOCKED` — the concurrent arrival must BLOCK and then observe the winner's state, not skip past it).

### 2.1 `LeaseAcquireResult` and `acquireSandboxLease`

```ts
export type LeaseLiveness = "cold" | "warming" | "warm" | "draining";

export type SandboxLeaseRow = {
  id: string; liveness: LeaseLiveness; refcount: number;
  turnHolders: number; viewerHolders: number;
  instanceId: string | null; backendId: string | null;
  dataPlaneUrl: string | null; dataPlaneExpiresAt: Date | null;
  leaseEpoch: number; expiresAt: Date; warmingExpiresAt: Date | null;
};

export type AcquireSandboxLeaseInput = {
  accountId: string; workspaceId: string; sessionId: string;
  kind: "turn" | "viewer"; holderId: string;
  leaseTtlMs: number;        // expires_at = now()+leaseTtlMs (default 90s; >> turn heartbeat 30s)
  warmingTtlMs: number;      // warming_expires_at on a cold→warming win (default 120s)
};

// Returns the post-increment lease snapshot. The CALLER (the stateless
// per-turn resume path, sec 3) branches on `disposition`:
//   "warm"      -> resume the existing box BY ID, do NOT cold-restore/create
//   "warming"   -> another worker is spawning; wait-for-warm then resume by id
//   "won-cold"  -> THIS caller won the cold→warming CAS; it MUST resume-or-create,
//                  then call commitSandboxLeaseWarm (or rollbackSandboxLeaseToCold)
export type AcquireSandboxLeaseResult = {
  lease: SandboxLeaseRow;
  disposition: "warm" | "warming" | "won-cold";
};
```

```ts
export async function acquireSandboxLease(
  db: Database, input: AcquireSandboxLeaseInput,
): Promise<AcquireSandboxLeaseResult> {
  return await withRlsContext(db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await scopedDb.transaction(async (tx) => {
      const now = new Date();
      const newExpiry = new Date(now.getTime() + input.leaseTtlMs);

      // (1) Ensure the singleton row exists. ON CONFLICT DO NOTHING so two
      //     concurrent inserts collapse to one row (the unique index decides).
      await tx.execute(sql`
        insert into sandbox_leases
          (account_id, workspace_id, session_id, liveness, expires_at)
        values
          (${input.accountId}, ${input.workspaceId}, ${input.sessionId}, 'cold', ${newExpiry})
        on conflict (workspace_id, session_id) do nothing
      `);

      // (2) SERIALIZE. Every concurrent arrival blocks here until the holder
      //     of the row lock commits. This is the SOLE double-spawn guard.
      const [lease] = await tx.select().from(schema.sandboxLeases)
        .where(and(eq(schema.sandboxLeases.workspaceId, input.workspaceId),
                   eq(schema.sandboxLeases.sessionId, input.sessionId)))
        .for("update").limit(1);
      if (!lease) throw new Error(`sandbox_lease vanished for session ${input.sessionId}`);

      // (3) Register the holder (idempotent on (lease_id, kind, holder_id)).
      await tx.insert(schema.sandboxLeaseHolders).values({
        accountId: input.accountId, workspaceId: input.workspaceId,
        leaseId: lease.id, kind: input.kind, holderId: input.holderId,
        lastHeartbeatAt: now,
      }).onConflictDoUpdate({
        target: [schema.sandboxLeaseHolders.leaseId, schema.sandboxLeaseHolders.kind, schema.sandboxLeaseHolders.holderId],
        set: { lastHeartbeatAt: now },
      });

      // (4) Recompute refcount from holders (source of truth) and refresh TTL.
      //     draining→warm re-arm is implicit: a holder arriving during the
      //     grace window flips liveness back to warm (closes drain-vs-arrive).
      const nextLiveness: LeaseLiveness =
        lease.liveness === "draining" ? "warm"
        : lease.liveness === "cold" ? "warming"      // cold→warming CAS, this caller wins
        : lease.liveness;                            // warm / warming unchanged

      const wonCold = lease.liveness === "cold";
      const [updated] = await tx.update(schema.sandboxLeases).set({
        liveness: nextLiveness,
        turnHolders: input.kind === "turn" ? lease.turnHolders + 1 : lease.turnHolders,
        viewerHolders: input.kind === "viewer" ? lease.viewerHolders + 1 : lease.viewerHolders,
        refcount: lease.refcount + 1,
        expiresAt: newExpiry,
        ...(wonCold ? { warmingExpiresAt: new Date(now.getTime() + input.warmingTtlMs) } : {}),
        updatedAt: now,
      }).where(eq(schema.sandboxLeases.id, lease.id)).returning();

      const row = mapSandboxLease(updated!);
      const disposition =
        wonCold ? "won-cold" as const
        : row.liveness === "warm" ? "warm" as const
        : "warming" as const;   // someone else is mid-spawn; caller waits
      return { lease: row, disposition };
    }));
}
```

### 2.2 `commitSandboxLeaseWarm` / `rollbackSandboxLeaseToCold`

The cold-winner calls one of these AFTER it has resumed-or-created the box. `warming→warm` bumps `lease_epoch` (the fence). Both run under `FOR UPDATE` to serialize with a concurrent release.

```ts
export type CommitSandboxLeaseWarmInput = {
  accountId: string; workspaceId: string; sessionId: string;
  instanceId: string; backendId: string;
  dataPlaneUrl?: string | null; dataPlaneExpiresAt?: Date | null;
  leaseTtlMs: number;
};
// returns the NEW lease_epoch the turn stamps on its in-memory handle (its fence token)
export async function commitSandboxLeaseWarm(
  db: Database, input: CommitSandboxLeaseWarmInput,
): Promise<{ leaseEpoch: number }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await scopedDb.transaction(async (tx) => {
      const [lease] = await tx.select().from(schema.sandboxLeases)
        .where(and(eq(schema.sandboxLeases.workspaceId, input.workspaceId),
                   eq(schema.sandboxLeases.sessionId, input.sessionId)))
        .for("update").limit(1);
      if (!lease) throw new Error("lease vanished before warm commit");
      // Only the cold-winner commits warming→warm. If a reaper already drove it
      // back to cold (warming TTL fired because THIS spawner was slow/dead),
      // refuse — the caller treats this as "I was superseded; drop my in-memory
      // handle (never provider-delete) and back off".
      if (lease.liveness !== "warming") {
        throw new SandboxLeaseSupersededError(lease.liveness);
      }
      const now = new Date();
      const nextEpoch = lease.leaseEpoch + 1;     // THE FENCE bump
      await tx.update(schema.sandboxLeases).set({
        liveness: "warm",
        instanceId: input.instanceId, backendId: input.backendId,
        dataPlaneUrl: input.dataPlaneUrl ?? null,
        dataPlaneExpiresAt: input.dataPlaneExpiresAt ?? null,
        leaseEpoch: nextEpoch,
        warmingExpiresAt: null,
        expiresAt: new Date(now.getTime() + input.leaseTtlMs),
        updatedAt: now,
      }).where(eq(schema.sandboxLeases.id, lease.id));
      return { leaseEpoch: nextEpoch };
    }));
}

export async function rollbackSandboxLeaseToCold(
  db: Database, input: { accountId; workspaceId; sessionId; holderId; kind },
): Promise<void> { /* FOR UPDATE; liveness='warming'→'cold'; delete THIS holder;
                      refcount = COUNT(remaining holders); warmingExpiresAt=null.
                      If holders remain (a late arrival), leave at 'cold' so the
                      next acquire re-CASes — never silently drop refcount<0. */ }
```

### 2.3 `releaseSandboxLease` — idempotent, delete-my-holder-row

```ts
export type ReleaseSandboxLeaseResult = {
  refcount: number; liveness: LeaseLiveness;
  // true => refcount hit 0 and we CAS'd warm→draining; the caller schedules
  // the grace-window drain (sec 4). turn_holders>0 blocks the transition.
  enteredDraining: boolean;
};
export async function releaseSandboxLease(
  db, input: { accountId; workspaceId; sessionId; kind; holderId; idleGraceMs },
): Promise<ReleaseSandboxLeaseResult> {
  // withRlsContext → tx →
  //   SELECT … FOR UPDATE
  //   DELETE FROM sandbox_lease_holders WHERE lease_id=$ AND kind=$ AND holder_id=$  (idempotent)
  //   refcount = COUNT(remaining); turn_holders/viewer_holders = COUNT by kind
  //   IF refcount=0 AND turn_holders=0 AND liveness='warm':
  //        liveness='draining'  (the reaper/grace timer finalizes draining→cold)
  //   IF liveness='warming': decrement-only, NEVER touch liveness (spawner owns warming→warm)
}
```

### 2.4 `heartbeatSandboxLease` — refresh TTL while refcount>0

```ts
// Called by the turn's 30s activity heartbeat (turn holder) AND by the viewer's
// app-level API heartbeat (viewer holder). There is NO ownerHeartbeat activity —
// between turns the box rides the provider idle-timeout, not a keepalive loop.
// Refreshes expires_at AND bumps the holder's last_heartbeat_at so the reaper
// can't kill a live multi-day turn or an attached viewer.
export async function heartbeatSandboxLease(
  db, input: { accountId; workspaceId; sessionId; kind; holderId; leaseTtlMs },
): Promise<{ alive: boolean; leaseEpoch: number; liveness: LeaseLiveness }> {
  // FOR UPDATE; if holder row gone (reaped) → { alive:false } (caller stops heartbeating);
  // else UPDATE expires_at, holder.last_heartbeat_at; return current leaseEpoch (fence re-check).
}
```

### 2.5 `reapStaleSandboxLeaseHolders` — the stateless reaper

The reaper is the **sole liveness/GC/cost-stop driver**. It is a single global scheduled job (one Temporal Schedule firing every `sandboxReaperPeriodMs`); it holds no handles and there is nothing per-session to "stop". It is fully stateless — drain at refcount 0, TTL-reap stale viewer holders, reset warming-death rows, and issue the provider's existing `stop()` once a drained lease is past the grace window.

```ts
// Boot-validated invariant (sec 5): reaperPeriod < viewerHolderTTL < providerIdleTimeout.
export async function reapStaleSandboxLeaseHolders(
  db, input: { now: Date; viewerHolderTtlMs: number; warmingTtlMs: number; idleGraceMs: number },
): Promise<Array<{ workspaceId; sessionId; leaseId; instanceId: string | null; backendId: string | null; action: "drain" | "terminate" | "cold-reset" }>> {
  // For each lease (NOT workspace-scoped — this is a cross-workspace janitor;
  // runs under a SUPERUSER/service RLS context like the other system sweeps):
  //  (1) DELETE viewer holders WHERE last_heartbeat_at < now - viewerHolderTtlMs.
  //  (2) Recompute refcount/viewer_holders per lease.
  //  (3) warm leases with refcount=0 AND turn_holders=0 → 'draining' (action: drain).
  //  (4) warming leases with warming_expires_at < now → 'cold' (spawner died
  //      mid-resume; action: cold-reset) — the NEW transition the base design lacked.
  //  (5) draining leases past the grace window (expires_at < now-idleGraceMs) with
  //      refcount=0 AND turn_holders=0 → call the provider's EXISTING stop()/terminate
  //      for a prompt cost-stop (action: terminate, carrying instance_id/backend_id
  //      to the stateless terminate activity), then CAS draining→cold and null
  //      instance_id/data_plane_url. The provider idle-timeout is the BACKSTOP for any
  //      box this misses. NO keepalive loop exists — between turns the box rides the
  //      provider idle-timeout; the reaper's stop() is the only proactive cost-stop.
  // Returns the affected leases so the global terminate activity can issue stop().
}
```

### 2.6 Lease read helpers (for the workflow + API)

```ts
export async function getSandboxLease(db, workspaceId, sessionId): Promise<SandboxLeaseRow | null>;
// Read by BOTH control planes. The API's non-turn ops (viewer attach, FileSystem
// list/read, Git status/diff, capability negotiation) call this IN-PROCESS to read
// data_plane_url / expiry / instance_id / backend_id, then resume()-by-id and
// session.exec/readFile/resolveExposedPort directly (sec 6) — viewers connect
// DIRECTLY to data_plane_url. The turn activity reads the same row for the
// resume-by-id turn path (sec 3). No Temporal/worker RPC sits between the API and
// this read or the box ops that follow it.
```

---

## 3. The stateless per-turn resume path — `resumeBoxForTurn` (runtime/activities)

There is **no in-worker `SandboxOwner` actor and no `Map<id, SandboxOwner>`.** Each turn is a self-contained critical section run by *any* pool worker; each viewer-attach (and the other non-turn ops) is the SAME self-contained critical section run **in the `apps/api` process** (§6.3). Both: acquire the lease under `FOR UPDATE`, resume the one box **by id** (warm reattach if alive, else cold-restore from snapshot), expose the desktop port if needed, and — for a turn — hand the **non-owned** live handle to `runStream`, then **drop the in-memory handle when the call returns** (never provider-delete — the box survives between turns on the provider idle-timeout until the reaper `stop()`s it at refcount 0). `resumeBoxForTurn` (the turn copy, §3.2) and the API's `attachViewer` (§6.3) are the same shared `@opengeni/runtime/sandbox` code path parameterized by `kind`. The `lease_epoch` (the fence token) is stamped on the in-memory handle for the duration of the call so a stale write fails the CAS.

### 3.1 Type sketch

```ts
import type { Database } from "@opengeni/db";
import type { Settings } from "@opengeni/config";
import {
  acquireSandboxLease, commitSandboxLeaseWarm, rollbackSandboxLeaseToCold,
  releaseSandboxLease, heartbeatSandboxLease, getSandboxLease,
  SandboxLeaseSupersededError,
} from "@opengeni/db";
// The runtime exposes these (sec 7): build a client for a backend, and
// resume-or-create a live session from the recovery envelope.
import {
  createSandboxClientForBackend,          // moved-out of createSandboxClient switch
  establishSandboxSessionFromEnvelope,     // resume() or create() under CAS rules
  type EstablishedSandboxSession,          // { client, session, sessionState, instanceId, backendId }
} from "@opengeni/runtime";

// VNC desktop port; the ONE exposed port the stream-server listens on (grounding §desktop).
export const DESKTOP_STREAM_PORT = 6080;

export type AcquireKind = "turn" | "viewer";

// What a resolved turn holds IN MEMORY for the duration of the turn ONLY.
// Dropped (never provider-deleted) in the caller's finally.
export type ResolvedSandbox = EstablishedSandboxSession & {
  leaseEpoch: number;          // fence token; stamped on every lease write this turn
};
```

### 3.2 `resumeBoxForTurn(services, ids, kind, holderId)` — the per-turn critical section

A pure function any worker calls. No persistent state survives the call beyond the lease/envelope rows in Postgres.

```ts
export async function resumeBoxForTurn(
  services: ActivityServices,
  ids: { accountId: string; workspaceId: string; sessionId: string },
  kind: AcquireKind, holderId: string,
): Promise<ResolvedSandbox> {
  const { db, settings } = services;
  const res = await acquireSandboxLease(db, {
    ...ids, kind, holderId,
    leaseTtlMs: settings.sandboxLeaseTtlMs,        // default 90_000
    warmingTtlMs: settings.sandboxLeaseWarmingTtlMs, // default 120_000
  });

  // (warm | warming) — the box is (or is becoming) alive; resume it BY ID.
  if (res.disposition === "warm" || res.disposition === "warming") {
    const lease = res.disposition === "warming"
      ? await waitForWarmOrRetry(services, ids, kind, holderId)   // poll until warm or re-CAS
      : res.lease;
    // Warm reattach (resume-by-id from instance_id) if still alive, else the
    // resume path cold-restores from the snapshot envelope (NotFound→create).
    const handle = await establishSandboxSessionFromEnvelope(settings,
      await getSandboxSessionEnvelope(db, ids.workspaceId, ids.sessionId),
      { sessionId: ids.sessionId });
    return { ...handle, leaseEpoch: lease.leaseEpoch };
  }

  // "won-cold": THIS turn won the cold→warming CAS — it cold-restores/creates,
  // exposes the port, and commits warm. The very next turn (any worker) just
  // resumes by id off the committed lease.
  try {
    const handle = await establishSandboxSessionFromEnvelope(settings,
      await getSandboxSessionEnvelope(db, ids.workspaceId, ids.sessionId),
      { sessionId: ids.sessionId });
    await ensureDisplayStack(settings, handle);                  // Channel B (desktop tier)
    const endpoint = await exposeStreamPort(settings, handle);   // mint scoped URL (or null headless)
    const { leaseEpoch } = await commitSandboxLeaseWarm(db, {
      ...ids,
      instanceId: handle.instanceId, backendId: handle.backendId,
      dataPlaneUrl: endpoint?.url ?? null,
      dataPlaneExpiresAt: endpoint?.expiresAt ?? null,
      leaseTtlMs: settings.sandboxLeaseTtlMs,
    });
    return { ...handle, leaseEpoch };
  } catch (err) {
    if (err instanceof SandboxLeaseSupersededError) throw err;   // reaper drove warming→cold; back off
    await rollbackSandboxLeaseToCold(db, { ...ids, kind, holderId });
    throw err;
  }
}
```

**The caller owns the lifecycle.** For a **turn** that caller is the turn activity (sec 9): it calls `resumeBoxForTurn` at start, threads the handle non-owned into `runStream`, and in `finally` calls `releaseSandboxLease(...)` and **drops the in-memory handle** (lets it go out of scope). For a **viewer attach** (and the other non-turn ops) that caller is the `apps/api` request handler (sec 6.3), which runs the same critical section in-process and releases the viewer holder on detach/TTL — **no Temporal activity, no worker RPC.** Neither caller ever stops the box — that is the reaper's job at refcount 0. Concurrent turns/viewers on the same box are fine: all resume the same box by id and run live against one filesystem/desktop (last-writer-wins; sec 4).

### 3.3 Release (in the caller's `finally`)

```ts
  // Called in the turn/viewer activity's finally. Idempotent delete-my-holder-row;
  // CASes warm→draining if refcount hits 0 AND turn_holders=0 (the reaper then
  // stop()s the box once the grace window elapses — sec 2.5/4).
  await releaseSandboxLease(db, {
    ...ids, kind, holderId, idleGraceMs: settings.sandboxIdleGraceMs,  // default 30_000
  });
  // …then the in-memory handle simply goes out of scope. NO provider-delete.
```

### 3.4 Liveness between turns (no keepalive loop)

There is **no keepalive timer and no `ownerHeartbeat` activity.** Between turns the box survives on the **provider's existing idle-timeout** (`modalTimeoutSeconds`, `config/src/index.ts:241`) — no exec no-op, no new idle config. While a turn runs, its existing 30s Temporal activity heartbeat refreshes the lease TTL via `heartbeatSandboxLease("turn", …)`. While a viewer is attached with no running turn, the **viewer's app-level API heartbeat** refreshes its viewer holder. The reaper TTL-reaps stale viewer holders and issues the provider `stop()` at refcount 0; the provider idle-timeout is the backstop for any leaked box.

### 3.5 `ensureDisplayStack` / `exposeStreamPort` (Channel B, per-backend, idempotent)

Plain functions any worker calls on the resumed handle — no persistent actor, no rotation timer. Idempotency is keyed on the live box (an already-running display stack is detected and skipped), not on in-memory latch state, so a fresh resume on any worker re-checks and re-runs exactly once.

```ts
  // Idempotent: launches Xvfb→XFCE→x11vnc→websockify/noVNC on the live box via
  // session.execCommand (grounding §desktop-stack startup order). Detects an
  // already-running stack (xdpyinfo probe) so a resume/rollover re-runs it at
  // most once. No-op when the backend is headless (cloudflare/vercel/local/none/
  // docker) or the desktop tier is disabled for this session.
  export async function ensureDisplayStack(settings: Settings, handle: EstablishedSandboxSession): Promise<void> {
    if (!backendSupportsDesktop(handle.backendId)) return;  // modal/daytona/runloop/e2b/blaxel only
    if (await displayStackAlreadyUp(handle)) return;        // xdpyinfo probe — idempotent on the live box
    const W = settings.sandboxDesktopWidth;   // default 1024
    const H = settings.sandboxDesktopHeight;  // default 768
    // Each step gated on the prior's readiness (xdpyinfo poll). Errors here are
    // surfaced as a SessionCapabilities degrade, NEVER silently swallowed.
    await handle.session.execCommand!({ cmd: ["/opt/opengeni/desktop-up.sh", `${W}`, `${H}`] });
  }

  // Mints the short-lived scoped tunnel URL via the SDK's resolveExposedPort
  // (session.d.ts:124; real on modal/daytona/runloop/e2b/blaxel, THROWS on
  // cloudflare). Returns null on headless backends → DesktopStream.transport=null
  // in the capability handshake (degradation is a value, never silent). This is
  // the EVENT-DRIVEN URL mint: any worker calls it and records the result in the
  // lease under the epoch fence — there is no rotation timer thread. A viewer
  // whose URL has aged out triggers a stateless re-resolve, recorded in the lease.
  export async function exposeStreamPort(settings: Settings, handle: EstablishedSandboxSession): Promise<{ url: string; expiresAt: Date } | null> {
    if (!backendSupportsDesktop(handle.backendId)) return null;
    try {
      const ep = await handle.session.resolveExposedPort!(DESKTOP_STREAM_PORT);
      // urlForExposedPort(ep, 'ws') (session.d.ts:100) → scheme-correct viewer URL.
      const url = urlForExposedPort(ep, "ws");
      const ttlS = settings.sandboxExposedPortTtlS ?? 3600;
      return { url, expiresAt: new Date(Date.now() + ttlS * 1000) };
    } catch (err) {
      if (isUnsupportedFeatureError(err)) return null; // cloudflare stub path
      throw err;
    }
  }
```

### 3.6 `establishSandboxSessionFromEnvelope` — the ONE resume/recovery primitive

This is the unified "resume-singleton-from-envelope-under-CAS" the grounding demands (its runtime half is in sec 7). On every turn the resume path either **warm-reattaches by id** (Modal `fromId`, e2b reconnect — NO LOCK, R4-safe) or, when the provider reports the box genuinely gone (`isProviderSandboxNotFoundError`, per `assertResumeRecreateAllowed` shared/session.js:76; Modal `resume` throws only when `poll()!==null`, sandbox.js:255), **cold-restores from the snapshot** via `create()`. **Never `create()` on a resume-conflict** — only on NotFound. Box-death mid-turn surfaces through the turn's normal worker-death/retry path (sec 9): the requeued turn re-resumes by id on any pool worker; there is no owner to re-elect. A viewer-only box-death just drops the in-memory handle and the next viewer-attach re-resumes.

```ts
  // (runtime, sec 7) Builds the backend client (fences on envelope.backendId),
  // resume(state) by id — NO LOCK — and create() ONLY when resume reports NotFound.
  // Returns the live { client, session, sessionState, instanceId, backendId }.
  // A new/rolled box has no display stack yet → ensureDisplayStack re-probes and
  // re-runs it on the next resume.
```

**Invariant:** at most one warm lease per session (the DB unique index + CAS); a turn holds its handle only for the turn's duration and drops it at the end; the resume path never calls provider `create()` except behind NotFound. There is no in-memory singleton to keep coherent across turns — the lease + envelope ARE the coherence.

---

## 4. State machine (the lease `liveness` column)

```
                         acquire (won cold→warming CAS, FOR UPDATE)
        ┌──────┐ ────────────────────────────────────────────────► ┌─────────┐
        │ cold │                                                     │ warming │
        └──────┘ ◄──────────────────────────────────────────────── └─────────┘
            ▲   rollbackToCold (spawn failed, caught)                    │  │
            │   ───────────────────────────────────────────────────────┘  │
            │   reaper: warming_expires_at < now  (SPAWNER DIED mid-resume) │
            │   ◄───────────────────────────────────────────────────────── │
            │                                                               │ commitWarm
            │                                                               │ (lease_epoch++)
            │                                                               ▼
            │   draining→cold finalize (grace elapsed,           ┌──────┐
            │   refcount=0, turn_holders=0)                       │ warm │
            └─────────────────────────────────┐                  └──────┘
                                               │                   │   ▲
                                          ┌────────────┐  release  │   │ acquire during grace
                                          │  draining  │ ◄─────────┘   │ (draining→warm re-arm)
                                          └────────────┘ ──────────────┘
                                            (refcount→0 AND turn_holders=0)
```

Transition table (every edge, with the guard):

| From | To | Trigger | Guard / SQL |
|---|---|---|---|
| cold | warming | `acquire` | `WHERE liveness='cold'` under FOR UPDATE (one winner per epoch) |
| warming | warm | spawner commits | `commitSandboxLeaseWarm`; `liveness='warming'`→`'warm'`, `lease_epoch++` |
| warming | cold | spawn failed (caught) | `rollbackSandboxLeaseToCold`; only if no other holders remain |
| warming | cold | **spawner DIED mid-resume** | reaper: `warming_expires_at < now` (NEW edge; base design only had caught) |
| warm | draining | `release` → refcount 0 | `WHERE liveness='warm' AND turn_holders=0` (turns are TTL-exempt) |
| draining | warm | late `acquire` re-arms | acquire sets `liveness='warm'` (closes drain-vs-arrive double-spawn) |
| draining | cold | grace elapsed, idle confirmed | **reaper** finalize: the per-turn handle was already dropped at the last turn's end (envelope already upserted per turn); the reaper issues the provider's existing `stop()` (prompt cost-stop) and CASes `draining→cold` |
| (any) | (re-resume) | box death detected mid-turn | the requeued turn re-resumes by id (any worker) via `establishSandboxSessionFromEnvelope` under the fence; liveness unchanged, lease_epoch re-validated |

**Release-during-warming rule (carried from grounding):** decrement refcount/holders only; NEVER touch `liveness`. The spawner exclusively owns `warming→warm`, then re-checks refcount after committing.

---

## 5. Config additions (`packages/config/src/index.ts`)

New settings fields (after `:244`), `OPENGENI_*` env mappings (after `:481`), boot-validated invariant (after `:986`):

```ts
// Settings schema additions
sandboxLeaseTtlMs:           z.coerce.number().int().positive().default(90_000),
sandboxLeaseWarmingTtlMs:    z.coerce.number().int().positive().default(120_000),
sandboxIdleGraceMs:          z.coerce.number().int().nonnegative().default(30_000),
sandboxViewerHolderTtlMs:    z.coerce.number().int().positive().default(90_000),
sandboxReaperPeriodMs:       z.coerce.number().int().positive().default(15_000),
sandboxExposedPortTtlS:      z.coerce.number().int().positive().default(3_600),
sandboxDesktopWidth:         z.coerce.number().int().positive().default(1024),
sandboxDesktopHeight:        z.coerce.number().int().positive().default(768),
sandboxOwnerEnabled:         z.coerce.boolean().default(false),  // v1 rollout flag for ownership inversion
```

There is **no `sandboxKeepAliveIntervalMs` and no `sandboxUrlRotationLeadMs`** — the box rides the provider idle-timeout between turns (no keepalive loop) and the URL is minted/re-resolved event-driven (no rotation timer). The provider idle-timeout is the **existing** `modalTimeoutSeconds` (`config/src/index.ts:241`); **no new idle config or tuning knob is introduced.**

```ts
// env mapping (mirror the OPENGENI_MODAL_* block at :472-481)
OPENGENI_SANDBOX_LEASE_TTL_MS, OPENGENI_SANDBOX_LEASE_WARMING_TTL_MS,
OPENGENI_SANDBOX_IDLE_GRACE_MS, OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS,
OPENGENI_SANDBOX_REAPER_PERIOD_MS, OPENGENI_SANDBOX_EXPOSED_PORT_TTL_S,
OPENGENI_SANDBOX_DESKTOP_WIDTH, OPENGENI_SANDBOX_DESKTOP_HEIGHT, OPENGENI_SANDBOX_OWNER_ENABLED
```

```ts
// boot-validated invariant (the grounding's hard ordering). No keepAlive clause:
// there is no keepalive loop — the provider idle-timeout is the between-turn backstop.
.refine(s =>
  s.sandboxReaperPeriodMs < s.sandboxViewerHolderTtlMs
  && s.sandboxViewerHolderTtlMs < s.modalTimeoutSeconds * 1000,
  { message: "reaperPeriod < viewerHolderTTL < providerIdleTimeout must hold" })
```

---

## 6. Temporal integration + the API-direct control plane

**Temporal is used for EXACTLY TWO things:** (1) the long-running agent **turn** (the existing `sessionWorkflow`, §6.1–6.2), and (2) **ONE GLOBAL REAPER** as a Temporal Schedule (§6.4). NOTHING else routes through Temporal. Every **non-turn op** — viewer attach, mint/rotate the desktop tunnel URL, FileSystem list/read for the Pierre tree, Git status/diff, capability negotiation — is **API-DIRECT** (§6.3): the `apps/api` process resolves the lease, runs the cold→warming CAS as a Postgres transaction it owns, `resume()`s the box by id, and calls `session.exec`/`readFile`/`resolveExposedPort` in-process. There is **no `signalWithStart`, no `openStreamRequest` signal, no viewer-attach activity, no `sandboxOwnerRpcWorkflow`, and no NATS request-reply** in the synchronous control path.

### 6.1 No per-session queue — turns run on the existing GLOBAL queue

There is **no per-session/per-group Temporal task queue and no per-session `Worker.create`.** Today there is one static `Worker.create` on `settings.temporalTaskQueue` (`apps/worker/src/index.ts:33-39`); that stays exactly as is. Turns dispatch on this **existing global queue**; the `runAgentTurn` activity that runs them resolves the lease, resumes the box by id (sec 3.2), injects the non-owned handle into `runStream`, and releases its turn holder in `finally`. Because workers are a stateless pool, ANY worker can run ANY session's turn — the lease + envelope carry all the coherence, so there is no need to route a turn to a particular worker, and no worker holds a handle between turns.

The spike proved per-session `Worker.create` non-viable at session scale (one full poller/bundle per session, ~35 MB each) — that machinery is **removed entirely**, not "fixed". See `04-spike-results.md` (spike 5, SUPERSEDED).

### 6.2 Turn dispatch + lease bookkeeping (`apps/worker/src/workflows/session.ts`)

The workflow dispatches `runAgentTurn` on the module-level `activity` proxy (the global queue). The **turn activity self-acquires** its holder (`activityId`, unique per scheduled execution) and releases it in `finally`, so refcount is tied to the activity lifecycle. There is no `resolveOwnerTaskQueue`, dynamic `proxyActivities({ taskQueue })`, or per-session-queue routing.

```ts
// workflows/session.ts — runTurn keeps dispatching on the GLOBAL queue (no taskQueue
// override). The activity resolves the lease, resumes by id, injects non-owned, and
// releases its turn holder in finally (sec 9). The workflow change is only the
// patched-gate + worker-death re-resume edge — no queue plumbing.
const turn = scope.run(() => activity.runAgentTurn({
  accountId, workspaceId, sessionId, triggerEventId, workflowId, turnId,
}));
/* … existing Promise.race / cancellation / outcome handling unchanged … */
```

Steer/Pause cancellation is by activity handle (`scope.cancel()` followed by the fenced `settleSessionControl` activity) and is unaffected — the activity still runs on the global queue.

### 6.3 Viewer attach + all non-turn ops are API-DIRECT (no Temporal, no signal, no worker RPC)

A viewer attach — and every other non-turn op (mint/rotate the desktop tunnel URL, FileSystem list/read, Git status/diff, capability negotiation) — is handled **entirely inside the `apps/api` process**: **client → API → box**. There is **no `openStreamRequest`/`closeStreamRequest` signal, no `signalWithStart`, no viewer-attach activity, and no `sandboxOwnerRpcWorkflow`.** The API does NOT wake or route through `sessionWorkflow` to attach a viewer; it acquires the viewer holder and resolves the data-plane URL synchronously in-process and returns it on the same HTTP response. The viewer then connects **directly** to `data_plane_url`.

Why this is sound (verified against real code): `ModalSandboxClient.resume()` is a per-call static `fromId` with no pool/singleton and no lock (R4-safe); the `apps/api` process already makes outbound HTTPS (Stripe/OpenAI/GitHub) and already owns Postgres; and the sandbox-access functions (`createSandboxClient`, `establishSandboxSessionFromEnvelope`, the envelope (de)serializers) have **zero coupling** to the agent-loop / Temporal / model-provider code (`packages/runtime` has no `@temporalio` dep). The API imports them from the thin **`@opengeni/runtime/sandbox`** sub-export (the sandbox-access module extracted in `03-providers.md` §3.5) so it pulls in the provider registry WITHOUT the `@openai/agents` agent-loop import graph.

```ts
// apps/api — the viewer-attach handler runs the FULL critical section in-process.
// No Temporal client call. attachViewer mirrors resumeBoxForTurn (sec 3.2) but for
// kind="viewer", and is the SAME stateless code path (shared @opengeni/runtime/sandbox).
async function attachViewer(api: ApiServices, input: {
  accountId: string; workspaceId: string; sessionId: string; viewerGrantId: string;
}): Promise<{ dataPlaneUrl: string | null; capabilities: NegotiatedCapabilities }> {
  const res = await acquireSandboxLease(api.db, {
    ...input, kind: "viewer", holderId: input.viewerGrantId,
    leaseTtlMs: api.settings.sandboxLeaseTtlMs,
    warmingTtlMs: api.settings.sandboxLeaseWarmingTtlMs,
  });
  // won-cold | warming | warm — IDENTICAL disposition handling to the turn path,
  // running IN THE API PROCESS. The DB FOR UPDATE + cold→warming CAS (a Postgres
  // txn the API owns) is the only double-spawn guard against a concurrent turn.
  if (res.disposition === "won-cold") {
    const handle = await establishSandboxSessionFromEnvelope(api.settings,
      await getSandboxSessionEnvelope(api.db, input.workspaceId, input.sessionId),
      { sessionId: input.sessionId });
    await ensureDisplayStack(api.settings, handle);
    const endpoint = await exposeStreamPort(api.settings, handle);  // resolveExposedPort IN-PROCESS
    await commitSandboxLeaseWarm(api.db, {
      ...input, instanceId: handle.instanceId, backendId: handle.backendId,
      dataPlaneUrl: endpoint?.url ?? null, dataPlaneExpiresAt: endpoint?.expiresAt ?? null,
      leaseTtlMs: api.settings.sandboxLeaseTtlMs,
    });
    // handle dropped — the API never holds it across requests (no provider-delete).
  }
  const lease = await getSandboxLease(api.db, input.workspaceId, input.sessionId);
  return { dataPlaneUrl: lease?.dataPlaneUrl ?? null, capabilities: negotiateCapabilities(/*…*/) };
}
```

**Idle (no running turn) attach is also API-direct:** a viewer attaching to a session whose `sessionWorkflow` has completed does NOT start a workflow. The API wins the cold→warming CAS itself and cold-restores the box in-process (the `won-cold` branch above) — there is no `signalWithStart`/`wakeSessionWorkflow` on this path. The next agent *turn* still goes through `sessionWorkflow` as usual (§6.1–6.2); a viewer never needs the turn workflow to be running.

**Concurrency with a running turn:** when a turn is mid-flight on a worker, the API's `attachViewer` and the worker's `runAgentSegment` both funnel through `acquireSandboxLease` under the DB `FOR UPDATE` + cold→warming CAS. Temporal never sat between them — the row lock was always the sole double-spawn guard (the old design's "two activities aren't serialized by Temporal" caveat applies verbatim to "the API request and the turn activity aren't serialized by Temporal" — same guard, same correctness). One wins cold→warming; the loser sees `warming`/`warm` and resumes the SAME box by id.

The other non-turn ops are the same shape, all in `apps/api`: **FileSystem list/read** (Pierre tree) and **Git status/diff** resolve the lease, `resume()`-by-id, and call `session.readFile`/`session.exec` directly; **capability negotiation** reads the lease + descriptor (`03-providers.md` §5.3) and returns `NegotiatedCapabilities`; **mint/rotate the desktop URL** calls `exposeStreamPort` (`resolveExposedPort` in-process) and records the result in the lease under the epoch fence. None of these touch Temporal, a worker, or NATS-request-reply.

> **Agent events remain worker → NATS → API-SSE → client** (NATS is events-only, the existing async event bus). That is unchanged and is NOT a request-reply control-plane call; it does not contradict the API-direct rule above.

### 6.4 Viewer-only liveness — app-level viewer heartbeats + the reaper (no `ownerHeartbeat`)

There is **no `ownerHeartbeat` activity and no keepalive loop.** The old `ownerHeartbeat` existed for two reasons — keepalive (now replaced by the **provider idle-timeout**: between turns the box rides `modalTimeoutSeconds`) and owner-death detection (now **moot** — there is no owner). Both are removed.

Viewer-only liveness is instead:
- **Turn liveness:** the turn's existing 30s Temporal activity heartbeat refreshes the lease TTL via `heartbeatSandboxLease("turn", …)` (sec 9) — unchanged.
- **Viewer liveness:** a **viewer's app-level API heartbeat** (Channel A, served by `apps/api` in-process — NOT a Temporal activity) refreshes its viewer holder's `last_heartbeat_at` via `heartbeatSandboxLease("viewer", …)`. The reaper TTL-reaps a viewer holder whose heartbeat goes stale (`viewerHolderTtlMs`, default 90s).
- **Cost-stop:** the reaper (one global Temporal Schedule, sec 2.5) drains at refcount 0 and issues the provider's existing `stop()`; the provider idle-timeout is the backstop.

A viewer-only warm box (a viewer attached, no turn running) therefore survives on its viewer holder's heartbeat + the provider idle-timeout, and is cost-stopped by the reaper when the last viewer's holder is reaped — with **no in-worker process and no long-poll activity** holding it open.

**Viewer acquire/release/heartbeat run IN THE API process** (the `attachViewer` path in §6.3, plus a detach handler that calls `releaseSandboxLease("viewer", grantId)` and a heartbeat route that calls `heartbeatSandboxLease("viewer", grantId)`) — they are plain calls into the shared lease DB functions + `@opengeni/runtime/sandbox`, NOT Temporal activities and NOT worker RPCs. **The ONLY Temporal-hosted piece of the lease machinery is the reaper:**

```ts
// apps/worker/src/activities/sandbox-lease.ts (NEW) — the reaper activity ONLY.
// (There is NO acquireSandboxLeaseForViewer / releaseSandboxLeaseForViewer /
//  heartbeatSandboxLeaseForViewer Temporal activity — the API does viewer
//  acquire/release/heartbeat directly via the shared @opengeni/db lease fns.)
export function createSandboxLeaseActivities(services) {
  // reapSandboxLeases: the global scheduled reaper (sec 2.5) — TTL-reap viewer holders,
  //   warming-death cold-reset, drain at refcount 0, and provider stop() past the grace.
  //   Runs in the worker because the worker has the runtime (provider clients) to issue
  //   stop(); reuses the existing temporalScheduleOptions pattern.
  return { reapSandboxLeases };
}
```

The reaper runs as a **single global Temporal Schedule** (firing every `sandboxReaperPeriodMs`) under the system-RLS context — it is the sole liveness/GC/cost-stop driver and the only non-turn use of Temporal. (The cross-workspace RLS path it needs is the unchanged blocker A1 below.)

---

## 7. Ownership inversion (`packages/runtime/src/index.ts`)

The central refactor. Today `runAgentStream` (`:1003`) builds and discards a client per call: `createSandboxClient(settings, environment)` at `:1006`, wrapped through `withManifestRefreshOnResume`/`withSandboxFileDownloads`/`withSandboxLifecycleHooks`, attached as `runOptions.sandbox = { client, sessionState }` at `:1044-1048`.

**The SDK already supports the inversion:** `SandboxRunConfig` (core `sandbox/client.d.ts:60-64`) accepts `session?: SandboxSessionLike` and `sessionState?` alongside `client`. Verified above.

### 7.1 Extend `RunAgentStreamOptions` (`:968`)

```ts
export type RunAgentStreamOptions = {
  sandboxClient?: unknown;
  sandboxEnvironment?: Record<string, string>;
  onRuntimeEvent?: (event: NormalizedRuntimeEvent) => Promise<void> | void;
  // OWNERSHIP INVERSION: an externally-owned, already-live sandbox session.
  // When present, runAgentStream does NOT build (or wrap, or discard) a client:
  // it threads these straight into runOptions.sandbox. Mutually exclusive with
  // the per-run createSandboxClient path.
  ownedSandbox?: {
    client: unknown;          // built by the per-turn resume path; runtime re-wraps only agent-dependent decorators (§7.2)
    session: unknown;         // SandboxSessionLike — the live, NON-OWNED handle (the SDK never reaps it)
    sessionState?: unknown;   // SandboxSessionState
  };
};
```

### 7.2 Branch in `runAgentStream` (`:1006` and `:1044`)

```ts
export async function runAgentStream(agent, input, settings, overrides = {}) {
  const prepared = /* unchanged */;
  const environment = overrides.sandboxEnvironment ?? collectSandboxEnvironment(settings);

  // OWNED PATH: the per-turn resume path injected a live, NON-OWNED session.
  if (overrides.ownedSandbox) {
    const { client, session, sessionState } = overrides.ownedSandbox;
    const callModelInputFilter = callModelInputFilterForSettings(settings);
    const runOptions: Parameters<typeof run>[2] = {
      stream: true, maxTurns: settings.agentMaxModelCallsPerTurn,
      ...(callModelInputFilter ? { callModelInputFilter } : {}),
    };
    runOptions.sandbox = {
      client, session,                                    // ← externally-owned handle
      ...(sessionState ? { sessionState } : {}),
    } as SandboxRunConfig;
    return await run(agent, prepared.input, runOptions);
  }

  // LEGACY PER-RUN PATH (unchanged): build+wrap+discard. Kept for backends/tests
  // that do not route through the resume path (sandboxOwnerEnabled=false, local dev).
  const rawClient = overrides.sandboxClient ?? createSandboxClient(settings, environment);
  /* … existing :1007-1050 untouched … */
}
```

**Decoration is applied per-turn by the resume path.** The per-turn resume path (sec 3.2) builds the backend client when it resumes the box by id; the `withManifestRefreshOnResume`/`withSandboxFileDownloads`/`withSandboxLifecycleHooks` wrapping (currently `:1007-1027`) is the agent-dependent part. Two options:
- **(A)** the resume path calls a new exported `decorateSandboxClient(rawClient, agent, settings, environment)` that runs the same three wraps; OR
- **(B)** the owned path applies the agent-dependent lifecycle hooks per-run but skips the create/resume-building.

Hooks like `withSandboxLifecycleHooks` (repo-clone-on-start) are **per-turn-agent-dependent** (they read `sandboxRepositoryCloneHooksForAgent(agent)` at `:1021`), so they must be applied per turn. **Spec adopts (B):** the owned path re-applies the agent-dependent decorators around the resumed `client`, while the resumed `session`/`sessionState` carry the live box (no create, no resume re-invocation). The manifest-refresh-on-resume wrap is a no-op when a live `session` is supplied (resume is not invoked). Net: `runAgentStream`'s owned branch becomes:

```ts
if (overrides.ownedSandbox) {
  const { client: ownedClient, session, sessionState } = overrides.ownedSandbox;
  const runAs = sandboxRunAs(settings);
  const fileDownloads = sandboxFileDownloadsForAgent(agent);
  // Re-apply ONLY agent-dependent decorators; the resumed handle is the live box.
  const decorated = withSandboxLifecycleHooks(
    fileDownloads.length > 0 ? withSandboxFileDownloads(ownedClient as SandboxClient, fileDownloads, { /* runAs, onRuntimeEvent */ }) : ownedClient as SandboxClient,
    [ ...sandboxLifecycleHooksForIds(sandboxLifecycleHookIds(settings)), ...sandboxRepositoryCloneHooksForAgent(agent) ],
    { environment, /* onRuntimeEvent, runAs */ });
  const runOptions = { stream: true, maxTurns: settings.agentMaxModelCallsPerTurn, /* filter */ };
  runOptions.sandbox = { client: decorated, session, ...(sessionState ? { sessionState } : {}) } as SandboxRunConfig;
  return await run(agent, prepared.input, runOptions);
}
```

### 7.3 New runtime exports the resume path consumes

```ts
// Split createSandboxClient's per-backend switch into a reusable builder the
// per-turn resume path calls (decoupled from `runAgentStream`).
export function createSandboxClientForBackend(backend, settings, environment): unknown;

// The resume/recovery primitive's runtime half: build a client for the envelope's
// backend, resume() the live box BY ID (Modal fromId — NO LOCK), and ONLY create()
// when the provider reports NotFound (cold session OR box dead). Returns the
// live { client, session, sessionState, instanceId, backendId }.
export type EstablishedSandboxSession = {
  client: unknown; session: unknown; sessionState: unknown;
  instanceId: string; backendId: string;
};
export async function establishSandboxSessionFromEnvelope(
  settings: Settings,
  envelope: Record<string, unknown> | null,
  opts: { sessionId: string; backendOverride?: SandboxBackend; environment?: Record<string,string> },
): Promise<EstablishedSandboxSession> {
  // 1. backend = opts.backendOverride ?? envelope.backendId ?? settings.sandboxBackend
  // 2. client = createSandboxClientForBackend(backend, settings, env)
  // 3. if envelope present:
  //      sessionState = deserializeSandboxSessionStateEnvelope(client, envelope.sessionState) (:1700)
  //      session = await client.resume(sessionState)   // Modal fromId (sandbox.js:77), R4-safe
  //      // resume throws ONLY on box-dead (poll()!==null) / NotFound; on NotFound → step 4
  //    else (cold session): step 4
  // 4. session = await client.create(manifest?, options?)  // ONLY here, never on resume-conflict
  // 5. instanceId = readInstanceId(session.state)  // Modal sandboxId, e2b host id, …
}
```

`establishSandboxSessionFromEnvelope` reuses `deserializeSandboxSessionStateEnvelope` (`:1700`, already backend-generic) and the `backendId` fence (the assertions at `:1654`/`:1694` now correctly pin a session to its original provider — exactly the resume-by-id requirement). The envelope's `exposedPorts` field (`:1714,1723`) round-trips the desktop tunnel so a resumed box keeps its stream port.

---

## 8. Services wiring (`apps/worker/src/activities.ts:30-48`)

**There is no owners Map, no `workerId`, and no `startPerSessionWorker`** — workers hold nothing across turns, so `services()` is unchanged from today plus the (turn + reaper) lease DB functions. The turn activity calls the stateless `resumeBoxForTurn` (sec 3.2) directly, passing the already-resolved services object. Viewer attach and the other non-turn ops do NOT run in the worker at all — they run in `apps/api` (sec 6.3), which wires its own equivalent services object (db + settings + `@opengeni/runtime/sandbox`) and calls `acquireSandboxLease`/`establishSandboxSessionFromEnvelope`/`exposeStreamPort` in-process.

```ts
// activities.ts — services() is UNCHANGED from today. No per-session worker
// starter, no owners registry, no worker id. The lease DB fns (acquire/commit/
// release/heartbeat/reap) are plain imports from @opengeni/db.
async function services(): Promise<ActivityServices> {
  servicesPromise ??= (async () => {
    const settings = dependencies.settings ?? getSettings();
    const dbClient = dependencies.db ? null : createDb(settings.databaseUrl);
    const db = dependencies.db ?? dbClient!.db;
    return {
      settings, db,
      bus: dependencies.bus ?? await createNatsEventBus(settings.natsUrl),
      runtime: dependencies.runtime ?? createProductionAgentRuntime(),
      objectStorage: dependencies.objectStorage ?? createObjectStorage(settings),
      documentServices: dependencies.documentServices ?? createDocumentServices(settings),
      observability: dependencies.observability ?? createObservability(settings, { component: "worker" }),
      wakeSessionWorkflow: dependencies.wakeSessionWorkflow ?? null,
    };
  })();
  return servicesPromise;
}
```

The turn activity calls `resumeBoxForTurn(svc, ids, "turn", activityId)` (sec 9). Viewer attach runs in `apps/api` (sec 6.3), not as a worker activity. No get-or-create-owner indirection exists — the lease + envelope are the only cross-turn state.

The new `createSandboxLeaseActivities(services)` bundle (sec 6.4) is spread into the registry alongside the others (`activities.ts:59-62`), exporting **only `reapSandboxLeases`** (the scheduled reaper). There are no `*ForViewer` Temporal activities — the API does viewer acquire/release/heartbeat in-process.

`startWorker` (`apps/worker/src/index.ts:67`) keeps its single static `Worker.create` on the global queue (unchanged); it only additionally registers the **global reaper Temporal Schedule** (firing `reapSandboxLeases` every `sandboxReaperPeriodMs`). There is no per-session Worker to start and no owners to dispose at shutdown — workers hold nothing, so a graceful shutdown is the existing path unchanged.

---

## 9. Agent-turn activity changes (`apps/worker/src/activities/agent-turn.ts`)

The turn activity resumes the box by id, hands the **non-owned** live handle into `run()`, and releases its turn holder in `finally` — dropping the in-memory handle without touching the box.

```ts
// agent-turn.ts — inside runAgentTurn, after services() and turnId resolution
const svc = await services();   // resolved object; NO owners/workerId fields exist
const { settings, runtime } = svc;
const activityContext = currentActivityContext();
const turnHolderId = activityContext?.info.activityId ?? `turn:${turnId}`;  // unique per scheduled exec (matches producerId discipline :317)

let resolved: ResolvedSandbox | null = null;
if (settings.sandboxOwnerEnabled && turn.sandboxBackend !== "none") {
  // resumeBoxForTurn runs the DB FOR UPDATE + cold→warming CAS; on won-cold it
  // cold-restores-from-envelope / creates, ensures the display stack, exposes the
  // port, commits warm (epoch++). On warm/warming it resumes the box BY ID. ANY
  // worker can run this — nothing is held across turns.
  resolved = await resumeBoxForTurn(svc, {
    accountId: input.accountId, workspaceId: input.workspaceId, sessionId: input.sessionId,
  }, "turn", turnHolderId);
}
```

The live handle is threaded into `runStream` at `agent-turn.ts:473` via the new `ownedSandbox` option (injected **non-owned** — the SDK never reaps it):

```ts
stream = await runtime.runStream(agent, runInput, runSettings, {
  sandboxEnvironment,
  onRuntimeEvent: async (event) => { await publish!([{ type: event.type, payload: event.payload }], true); },
  ...(resolved ? { ownedSandbox: {
    client: resolved.client, session: resolved.session, sessionState: resolved.sessionState,
  } } : {}),
});
```

The turn's existing 30s activity heartbeat (`startActivityHeartbeat`, `:306`) is extended to also call `heartbeatSandboxLease("turn", turnHolderId)` so `expires_at` is refreshed while the turn runs (fixes stress (d): a legit multi-day turn never TTL-reaps). The `reconcileConversationTruth` upsert of the envelope (`:251-258`) is unchanged — it remains the descriptor the next turn's resume-by-id reads.

The `finally` (`agent-turn.ts:855`) releases the turn holder (idempotent delete-my-holder-row) and drops the in-memory handle:

```ts
} finally {
  if (resolved) {
    await releaseSandboxLease(svc.db, {
      accountId: input.accountId, workspaceId: input.workspaceId, sessionId: input.sessionId,
      kind: "turn", holderId: turnHolderId, idleGraceMs: settings.sandboxIdleGraceMs,
    });  // refcount--; warm→draining if 0 && no turns. NEVER stops the box.
    resolved = null;   // drop the in-memory handle; the box survives on the provider idle-timeout
  }
  preparedTools && await preparedTools.close?.();
  heartbeatTimer?.stop();
  /* … existing cleanup … */
}
```

**Crucially, release does NOT stop the box** — it only decrements refcount and (if 0) CASes `warm→draining`. The box survives the turn (on the provider idle-timeout) for the next turn or a viewer; the **reaper** issues the provider `stop()` once the drained lease passes the grace window (sec 2.5/4). Worker-death (the activity never reaches `finally`) is caught by the workflow's `requeueTurnAfterWorkerDeath` path (`session.ts:254`): the requeued turn re-dispatches on the **global queue** and **any** pool worker re-resumes the box by id under the fence (sec 3.6). There is no owner object to die or re-elect — the dead worker held nothing, and the requeued turn's `resumeBoxForTurn` re-validates the lease and resumes from the envelope.

---

## 10. Failure / edge-case matrix (every case, with the resolution)

| # | Scenario | Detector | Resolution |
|---|---|---|---|
| a | Turn + viewer hit idle simultaneously | DB `FOR UPDATE` serializes | One wins cold→warming CAS; loser sees `warming`, waits, resumes the SAME box by id. Concurrent API viewer-attach (in `apps/api`) ‖ `runAgentSegment` (in a worker) is safe ONLY because of the row lock — Temporal never sat between them. |
| b | **Worker restart, VIEWER-ONLY (no turn)** | viewer's app-level API heartbeat goes stale → reaper TTL-reaps the viewer holder | No owner to restart, and a viewer never depended on a worker — viewer attach runs in `apps/api` (sec 6.3). The viewer reconnects (Channel A) and the API re-acquires a viewer holder and resumes the box by id IN-PROCESS. The box meanwhile rode the provider idle-timeout. |
| c | **Split-brain (2nd handle)** | fence: `lease_epoch == myEpoch` re-checked INSIDE the FOR UPDATE txn on every lease write this turn | A stale writer (a re-dispatched turn from a dead worker) fails the epoch CAS and backs off. NEVER `create()` on resume-conflict (only NotFound). Modal `fromId` (sandbox.js:77) is no-lock → a stray 2nd handle never spawns a 2nd box (R4 safe). |
| d | Lease expires during legit multi-day turn | turn 30s heartbeat refreshes `expires_at` (sec 9) | Reaper's `warm→draining` CAS guarded `AND turn_holders=0`; turn holders TTL-exempt. |
| e | Box dies under agent (e1) / lone viewer (e2) | box-exec-failure surfaces through the turn stream / the next API non-turn op | Recoverable box-death → the requeued turn (or the next API viewer-attach / FileSystem / Git op) re-resumes by id via `establishSandboxSessionFromEnvelope` (NOT `failSession`); bounded retry like `requeueTurnAfterWorkerDeath`. One resume primitive (sec 3.6) — no owner to re-elect. |
| f | Closed laptop (viewer) | app-level viewer heartbeat on Channel A; stale `last_heartbeat_at` | Reaper deletes the viewer holder within ~`viewerHolderTtlMs` (90s); release = delete-holder-row; refcount recomputed → drains at 0 → reaper `stop()`s. |
| g | Flapping (rapid attach/detach) | mandatory `draining` grace window | N flaps collapse to 1 box; release-during-`warming` decrements refcount only; optional connect debounce. |
| h | Spawner dies mid-resume | `warming_expires_at < now` reaper edge (sec 4 NEW) | `warming→cold`; next acquire re-CASes. |
| i | Security | scoped token enforced at data-plane edge (websockify); READ-ONLY desktop; grant-revocation tied to holder reap | Pixel plane un-redacted → shared-live is OPT-IN. (Out of THIS module's core scope; the lease's holder reap is the revocation hook.) |

---

## 11. File-by-file change list

| File | Change |
|---|---|
| `packages/db/src/schema.ts` (after :370) | Add `sandboxLeases` + `sandboxLeaseHolders` tables (sec 1.3); mirror `sandboxSessionEnvelopes:360`. |
| `packages/db/migrations/00NN_sandbox_leases.sql` (NEW) | Drizzle-generated DDL for the two tables (sec 1.1-1.2). No enum migration. |
| `packages/db/src/index.ts` (NEW fns) | `acquireSandboxLease`, `commitSandboxLeaseWarm`, `rollbackSandboxLeaseToCold`, `releaseSandboxLease`, `heartbeatSandboxLease`, `reapStaleSandboxLeaseHolders` (now issues provider `stop()` at refcount-0/past-grace), `getSandboxLease`, `mapSandboxLease`, `SandboxLeaseSupersededError` (sec 2). Mirror `claimNextSessionExecution:3077` FOR UPDATE pattern (swap SKIP LOCKED → plain FOR UPDATE). |
| `apps/worker/src/sandbox-resume.ts` (NEW) | Stateless `resumeBoxForTurn(svc, ids, kind, holderId)` + `ensureDisplayStack`/`exposeStreamPort` (idempotent, any worker) + `DESKTOP_STREAM_PORT` (sec 3). No class, no timers — a plain per-turn helper. |
| `packages/runtime/src/index.ts` | `RunAgentStreamOptions.ownedSandbox` (:968); owned branch in `runAgentStream` (:1003/:1044); export `createSandboxClientForBackend`, `establishSandboxSessionFromEnvelope`, `EstablishedSandboxSession` (sec 7). |
| `apps/worker/src/activities.ts` (:29-63) | `services()` UNCHANGED (no owners/workerId/per-session-worker); spread `createSandboxLeaseActivities(services)` into the registry — **only `reapSandboxLeases`** (sec 8). |
| `apps/worker/src/activities/sandbox-lease.ts` (NEW) | **`reapSandboxLeases` ONLY** (the global scheduled reaper) (sec 6.4). No `*ForViewer` activities (the API does viewer acquire/release/heartbeat in-process), no `ownerHeartbeat`, no `resolveOwnerTaskQueue`. |
| `apps/worker/src/activities/agent-turn.ts` | `resumeBoxForTurn(svc, ids, "turn", activityId)` (:294 area); thread `ownedSandbox` into `runStream` (:473); `heartbeatSandboxLease` in the 30s heartbeat (:306); `releaseSandboxLease("turn")` + drop handle in `finally` (:855) (sec 9). |
| `apps/worker/src/index.ts` (:33, :67-90) | UNCHANGED static `Worker.create` on the global queue. Add only the global reaper Temporal Schedule registration; no per-session worker factory, no dispose-owners step. |
| `apps/worker/src/workflows/session.ts` (:215, :254) | `patched("sandbox-owner-lease")`: turn dispatch stays on the **global queue** (no taskQueue override); worker-death path (:254) re-dispatches the turn (any worker re-resumes by id). **No `openStreamRequest`/`closeStreamRequest` signals** (viewer attach is API-direct, sec 6.3), no `resolveOwnerTaskQueue`, no `ownerHeartbeat`. |
| `apps/api/src/index.ts` + sandbox-access wiring (NEW) | `attachViewer`/`detachViewer`/viewer-heartbeat + FileSystem list/read + Git status/diff + capability-negotiation handlers, all **in-process** (sec 6.3): import `createSandboxClient`/`establishSandboxSessionFromEnvelope`/`exposeStreamPort` from `@opengeni/runtime/sandbox` (the extracted module, `03-providers.md` §3.5), call the `@opengeni/db` lease fns directly. **No `signalWithStart`, no `SessionWorkflowClient.openStream`.** Add `@opengeni/runtime` to `apps/api/package.json` and plumb the Modal token into the API's Modal-client construction (`03-providers.md` §3.5). |
| `packages/config/src/index.ts` (:244, :481, :986) | 8 new `sandbox*` settings (no keepAliveInterval/urlRotationLead) + `OPENGENI_*` env maps + the `reaperPeriod < viewerHolderTTL < providerIdleTimeout` boot invariant (sec 5). |

**Patched-gate ordering (non-determinism safety):** `runAgentSegment` keeps its legacy name (`session.ts:215`). All lease workflow changes are introduced behind NEW `patched()` keys (`sandbox-owner-lease`) at new call-site positions so multi-day in-flight histories replay deterministically on their original (lease-less) path. `sandboxOwnerEnabled` (config flag, default false) gates the activity-side resume-by-id acquisition so the feature ships dark and is enabled per-deployment.

---

## Key load-bearing facts verified against code

- `SandboxRunConfig` already has `session?: SandboxSessionLike` + `sessionState?` — core `sandbox/client.d.ts:60-64`. The inversion is additive, no SDK change.
- Modal `resume` reconnects via static `fromId` (`agents-extensions/.../modal/sandbox.js:77`) with no lock; `running()` is `poll()===null` (`:255`) → R4 (2nd handle) safe; re-establish never spawns a 2nd box.
- `resolveExposedPort(port): Promise<ExposedPortEndpoint>` is real on Modal (`modal/sandbox.d.ts:173`) and via `RemoteSandboxSessionBase` (`shared/sessionBase.d.ts:48`); cloudflare throws → `exposeStreamPort` returns null → headless-tier capability value.
- `claimNextSessionExecution` (`packages/db/src/index.ts:3077`) is the exact `withWorkspaceRls → transaction → SELECT … FOR UPDATE` precedent; the lease swaps `SKIP LOCKED` → plain `FOR UPDATE`.
- `upsertSandboxSessionEnvelope` (`:2609`) + `getSandboxSessionEnvelope` (`:2628`) + `sandboxStateEntryFromRunState` (`runtime:1665`) are the existing per-turn descriptor the resume-by-id path reads each turn.
- The API control plane is API-DIRECT: `ModalSandboxClient.resume()` is a per-call static `fromId` with no pool/singleton/lock (R4-safe), `apps/api` already makes outbound HTTPS (Stripe/OpenAI/GitHub) and owns Postgres, and the sandbox-access fns have ZERO coupling to the agent-loop/Temporal code (`packages/runtime` has no `@temporalio` dep) — so the API can `resume()`-by-id + `session.exec/readFile/resolveExposedPort` + run the cold→warming CAS as a Postgres txn it owns, all in-process. No `signalWithStart` precedent is needed because no non-turn op routes through a workflow.
- No per-process owners registry exists — `services()` (`activities.ts:30`) holds no handles across turns.
- `modalTimeoutSeconds` (`config/src/index.ts:241`, default 900s) is the **existing** provider idle-timeout the box rides between turns — no new idle config is introduced; the reaper's provider `stop()` at refcount 0 is the only proactive cost-stop.

---

## Adversarial Review

## Adversarial Review: stateless resume-by-id + ownership inversion + Temporal integration

Findings are grouped by severity. Line/symbol citations are against HEAD. Each has a concrete fix.

> **SUPERSEDED-by-the-stateless-ruling note.** Several original findings targeted machinery that the stateless-workers ruling **removes entirely**, so they no longer apply: **B1/B2** (per-session `Worker.create` non-viable, cold-spawn co-location circular) and **B3** (per-session-queue cancellation/determinism) are **SUPERSEDED** — there is no per-session worker, no per-session/per-group task queue, and turns run on the existing global queue. **B5** (`ownerHeartbeat` cadence vs 30s timeout) and **C3/C4/E4** (rotate-URL via `commitWarmingToWarm`, owner self-holder, owner-keepalive-as-viewer-holder) are **MOOT** — there is no `ownerHeartbeat`, no keepalive loop, and no owner self-holder (the box rides the provider idle-timeout; the reaper `stop()`s at refcount 0). **A5** (`startActivityHeartbeat().stop()`) survives only for the turn-heartbeat path (the keep-alive/`ownerHeartbeat` instances are deleted). **A4** drops the `keepAliveInterval` clause (no keepalive loop). The RLS/reaper findings **A1/A2/B4** still apply — the stateless reaper still needs the SECURITY-DEFINER cross-workspace path + a Temporal Schedule driver. The SDK/refcount findings **A3/A6/A7/C1/C5/C6/C7/C8/D1–D4/E-series** still apply (re-stated against the resume-by-id path where wording changed).

---

### A. BLOCKERS — won't compile / won't run / breaks a settled invariant

**A1. The reaper cannot run cross-workspace — RLS will return zero rows (silent no-op), defeating the entire liveness/GC design.**
The spec says `reapStaleSandboxLeaseHolders` "runs under a SUPERUSER/service RLS context like the other system sweeps." There is **no such precedent and no bypass role**. All workspace tables have `FORCE ROW LEVEL SECURITY` + a `workspace_isolation` policy whose predicate is `opengeni_private.workspace_rls_visible(account_id, workspace_id)` (`packages/db/drizzle/0001_workspace_auth_billing.sql:423-429`), which requires **both** `account_id = current_setting('opengeni.account_id')` AND `workspace_id = current_setting('opengeni.workspace_id')` to match. `withRlsContext`/`withWorkspaceRls` only ever set a single concrete workspace (`packages/db/src/index.ts:85-116`). `FORCE ROW LEVEL SECURITY` applies RLS even to the table owner, and `opengeni_app` is granted only DML — there is no `BYPASSRLS` role anywhere in the migrations. A cross-workspace `SELECT * FROM sandbox_leases` under any single-workspace context returns only that workspace's rows; under an empty/null context it returns **nothing**. The reaper as specified is a silent no-op, so stale viewer holders never get reaped, `warming`-died-mid-resume never resets to cold, and viewer-only boxes leak. Fix: either (a) introduce a dedicated `BYPASSRLS` system role + a `withSystemRls`/`withoutRls` helper and a matching policy exception, or (b) make the reaper a per-workspace sweep iterated over an unscoped index that *is* readable (none today), or (c) add a `reaper`-specific policy `USING (current_setting('opengeni.reaper', true) = 'on')` plus a `SECURITY DEFINER` function. This must be designed explicitly; "like the other system sweeps" describes a capability the codebase does not have.

**A2. The two new tables need hand-written RLS migrations; "Drizzle-generated DDL, no enum migration" is wrong and would ship tables with no isolation.**
The spec claims the migration is "Drizzle-generated" and only the two tables are needed. Drizzle generates `CREATE TABLE`/indexes but **does not generate** `ENABLE/FORCE ROW LEVEL SECURITY`, the `workspace_isolation` `CREATE POLICY`, or the `GRANT ... TO opengeni_app` block — all of those are hand-authored in every prior migration (e.g. `0007_session_history_items.sql:46-58` for the very table the spec says it mirrors). The spec's DDL in §1.1/§1.2 omits all of it. As written, `sandbox_leases`/`sandbox_lease_holders` would have **no RLS policy at all**, so either every workspace sees every lease (if RLS is off) or no one can read them (if `ENABLE` is set with no policy). Fix: write the migration by hand including `ENABLE`+`FORCE ROW LEVEL SECURITY`, the `workspace_isolation` policy on `(account_id, workspace_id)`, and the `opengeni_app` grant, mirroring `0007` exactly. Also: the migration directory is `packages/db/drizzle/`, not `packages/db/migrations/` (drizzle.config.ts `out: "./drizzle"`), and the next number is `0017_*`, not `00NN`.

**A3. `z.coerce.boolean()` for `sandboxOwnerEnabled` is a real correctness bug — `OPENGENI_SANDBOX_OWNER_ENABLED=false` evaluates to `true`.**
`z.coerce.boolean()` does JS `Boolean(value)`, so any non-empty string — including `"false"`, `"0"`, `"no"` — coerces to `true`. The codebase already solved this with a custom `EnvBoolean` preprocessor (`packages/config/src/index.ts:15-27`) precisely to avoid this footgun. The feature flag that's supposed to keep this shipping dark would be **on** the moment anyone sets the env var to disable it. Fix: `sandboxOwnerEnabled: EnvBoolean.default(false)`.

**A4. The boot invariant is written as a Zod `.refine()`, but config validation is an imperative `if`-throw block, not a refined `z.object()`.**
Cross-field validation lives in an imperative function body (`packages/config/src/index.ts:985-1000`, `if (Boolean(a) !== Boolean(b)) throw ...`), not a `.refine()` on a schema. Appending `.refine(s => ...)` "after `:986`" attaches to nothing. Fix: add an `if (!(reaperPeriodMs < viewerHolderTtlMs && viewerHolderTtlMs < modalTimeoutSeconds*1000)) throw new Error(...)` in that block. (The `keepAliveInterval` clause is **gone** — there is no keepalive loop. Also: the invariant hardcodes `modalTimeoutSeconds` as "the provider idle timeout," but for daytona/e2b/runloop/blaxel the idle timeout is a different setting — the invariant is Modal-specific and will be wrong for other backends.)

**A5. `startActivityHeartbeat(...)` returns a bare timer, not an object with `.stop()` — every `heartbeatTimer?.stop()` in the spec is a runtime TypeError.** (Narrowed by the stateless ruling — the §3 keep-alive and §6.4 `ownerHeartbeat` instances are **deleted**; this now applies only to the turn-heartbeat path in §9.)
`startActivityHeartbeat` returns `ReturnType<typeof setInterval> | null` (`apps/worker/src/activities/streaming.ts:50`); the real cleanup is `clearInterval(heartbeatTimer)` (`agent-turn.ts:872-874`). The §9 turn path's `heartbeatTimer?.stop()` assumes a `.stop()` method that does not exist. Fix: capture the timer and `clearInterval(timer)`; or introduce a real wrapper, but then say so.

**A6. `isUnsupportedFeatureError(err)` (used in `exposeStreamPort`) does not exist in the SDK.**
The SDK exports the **class** `SandboxUnsupportedFeatureError` (`@openai/agents-core/sandbox/errors.d.ts:32`) but no `isUnsupportedFeatureError` type-guard. Fix: `if (err instanceof SandboxUnsupportedFeatureError) return null;` and import the class. (Note it's thrown by the cloudflare client, but cloudflare is gated out of desktop by `backendSupportsDesktop` already, so this branch is mostly belt-and-suspenders.)

**A7. `establishSandboxSessionFromEnvelope` relies on `isProviderSandboxNotFoundError` / `assertResumeRecreateAllowed`, which live in `@openai/agents-extensions/sandbox/shared` — NOT a public export subpath.**
`@openai/agents-extensions@0.11.6`'s `package.json` `exports` map only exposes the seven `./sandbox/<provider>` subpaths; `./sandbox/shared` is not exported, so `import { isProviderSandboxNotFoundError } from "@openai/agents-extensions/sandbox/shared"` fails module resolution under exports enforcement. The spec asserts these are the gate for "never create() on resume-conflict." Fix: the runtime cannot import the shared helper directly. Either re-implement the NotFound discrimination in OpenGeni (inspect the thrown error shape per provider), or rely on each provider client's own internal `resume()` behavior (which already calls `assertResumeRecreateAllowed` internally and only recreates on NotFound) and treat any `resume()` throw as "do not create — back off and re-fence." Do not assume the helper is importable.

---

### B. ARCHITECTURE / DESIGN GAPS — specified behavior is unimplementable or contradicts grounding

**B1. [SUPERSEDED] Per-session `Worker.create` is not viable at session scale — each one bundles the entire workflow + activities worker.** This finding *drove* the stateless ruling: per-session workers are **removed entirely**, turns run on the existing global queue, and the box is resumed by id per turn. The analysis below is retained as the justification, not an open issue.
§6.1's (now-deleted) `startPerSessionOwnerWorker` called `Worker.create({ workflowsPath, activities, ... })` per `sandbox-owner::<sessionId>`. `Worker.create` with `workflowsPath` builds/loads a workflow bundle and spins a full polling worker (`apps/worker/src/index.ts:33` is the *single* static one today). Thousands of concurrent sessions ⇒ thousands of workers, each with its own poller, sticky-queue cache, and (if `workflowsPath` is set) bundling. This will exhaust memory/file handles and Temporal poller slots. The spec hand-waves "Bounded: one session's turns are sequential." That bounds concurrency *within* a queue, not the number of queues/workers. Fix options that need to be chosen explicitly: (a) do **not** register workflows on the per-session worker — only `activities`, since workflows always run on the global queue; that removes the bundling but still leaves N pollers; (b) use a small fixed pool of workers each polling a hashed subset of per-session queues (Temporal doesn't support wildcard queue subscription, so this needs a routing scheme); (c) reconsider whether a per-session *queue* is needed at all vs. routing by `owner_worker_id` through a worker-affinity mechanism. As written it does not scale and the cost is unaddressed.

**B2. [SUPERSEDED] The cold-spawn co-location story contradicts the per-session-queue routing and the FOR-UPDATE serialization.** Resolved by the stateless ruling exactly as this finding's own fix recommended: the cold turn dispatches onto the **global queue**, the activity that runs it wins the CAS and resumes-or-creates the box, and subsequent turns/viewers also run on the global queue and resume the same box by id. There is no `owner_task_queue` field and no per-session queue. Retained for provenance.
The original deadlock: §6.2 resolved between "the owner must live on the worker that runs the turn" and "the workflow routes to `owner_task_queue`" by having `resolveOwnerTaskQueue` return the canonical queue name *without spawning*, then "the FIRST `runAgentSegment` dispatched onto that queue is picked up by whichever worker first polls it, and THAT worker wins the cold→warming CAS." But for that to work, a per-session Worker polling `sandbox-owner::<sessionId>` **must already exist before any worker is warm** — which is the chicken-and-egg the spec acknowledges ("started lazily: every worker process runs a small bootstrap that, on seeing a `sandbox-owner::*` task, ensures a `SandboxOwner` exists"). Temporal workers cannot subscribe to a wildcard `sandbox-owner::*` queue; there is no "see a task on a queue I'm not polling" mechanism. So no worker ever polls the per-session queue until one is started, and none is started until a turn is dispatched onto it, which never gets picked up. This is circular and unbuildable as described. Fix: dispatch the cold turn onto the **global** queue; the activity that runs it (on whatever worker picks it up) wins the CAS, becomes the owner, *then* starts the per-session worker and writes `owner_task_queue`; subsequent turns/viewers route to it. The spec's "resolveOwnerTaskQueue returns the queue name without spawning, first segment lands there" must be replaced with "first segment runs on global queue and self-elects."

**B3. [RESOLVED] Temporal control and activity cancellation stay on the global task queue.** `runTurn` cancels the exact activity handle and delegates authoritative state changes to the fenced session-control transaction. There is no dynamic per-session activity queue and therefore no cross-queue or non-deterministic-taskQueue replay risk.

**B4. [STILL APPLIES] The reaper has no scheduler/driver — it's a DB function with nothing calling it periodically.**
§2.5 defines `reapStaleSandboxLeaseHolders` and §5 validates `sandboxReaperPeriodMs`, but nothing *runs* it on a period unless the driver is specified. Under the stateless ruling the reaper is now the **sole liveness/GC/cost-stop driver**, so this is more load-bearing than before. Fix: a single global Temporal Schedule firing a `reapSandboxLeases` activity every `sandboxReaperPeriodMs`, running under the system-RLS context from A1 (sec 6.4 calls this out).

**B5. [MOOT] Viewer-only liveness via `ownerHeartbeat` long-poll contradicts the 30s heartbeat-timeout config and the `sleepCancellable`/loop shape.** There is **no `ownerHeartbeat` activity and no keepalive loop** under the stateless ruling — viewer-only liveness is the viewer's app-level API heartbeat refreshing its holder plus the provider idle-timeout, and the reaper `stop()`s at refcount 0. The original long-poll/cadence bug cannot occur because the code is gone. (Below retained for provenance: §6.4's old `ownerHeartbeat` did `while(true){ heartbeatSandboxLease(...); await sleepCancellable(ctx, keepAliveIntervalMs); }` with a 60s loop vs a 30s heartbeat timeout — a real bug in the removed design.)

**B6. [STILL APPLIES, restated] Who pays for a viewer-only warm box?**
Today every turn calls `ensureRunAllowed` (billing/limits, `agent-turn.ts:294`). A viewer-only warm box (surviving on its viewer holder's heartbeat + the provider idle-timeout) consumes provider compute with **no turn and no billing check**. The grounding's "per-call billing checks" memory implies this matters — and warm-time is metered per group (a viewer-held box still costs; see 10-crosscut warm-meter). Fix: add a billing/limit gate to the **API's `attachViewer`** path (§6.3) — the API already owns Postgres and the billing reads, so the gate is a synchronous in-process check before `acquireSandboxLease("viewer", …)`, not a worker activity — or a max-viewer-idle policy, or explicitly rule it out of scope with a cost cap. (The cost-stop itself is the reaper's provider `stop()` at refcount 0.)

---

### C. CORRECTNESS BUGS in the SQL / TS as written

**C1. `acquireSandboxLease` step (1) INSERT under RLS sets `expires_at` from `leaseTtlMs` but the row may already exist with a different liveness — the `ON CONFLICT DO NOTHING` means the inserted `expires_at`/`'cold'` is discarded, which is correct, but the subsequent unconditional `refcount: lease.refcount + 1` double-counts on holder re-acquire.** The holder upsert in step (3) is idempotent (`onConflictDoUpdate` on the unique holder key), so re-acquiring the *same* `(lease_id, kind, holder_id)` does **not** insert a new holder — but step (4) still does `refcount: lease.refcount + 1` unconditionally. A retry of the same activity (Temporal *can* re-run an activity; `maximumAttempts: 1` reduces but heartbeat-timeout re-dispatch creates a new `activityId`, however a client-level retry or at-least-once delivery can replay) will increment refcount without adding a holder, permanently desynchronizing `refcount` from `COUNT(holders)`. The spec itself says "refcount recomputed from holders (source of truth)" but step (4) computes it as `lease.refcount + 1`, NOT `COUNT(holders)`. Fix: compute `refcount`/`turnHolders`/`viewerHolders` as `SELECT count(*)` over `sandbox_lease_holders` after the upsert, never as `prev + 1`. This is the spec's own stated invariant and step (4) violates it.

**C2. [STILL APPLIES] `draining → warm` re-arm in `acquireSandboxLease` step (4) sets `liveness='warm'` but leaves `instance_id`/`lease_epoch` from the draining lease — if the box was already `stop()`ed (draining finalize raced the reaper), the re-armed "warm" lease points at a dead box.** `nextLiveness` maps `draining → warm` and returns `disposition: "warm"` ⇒ caller "resumes the existing box by id, does not cold-restore." But `draining` means refcount hit 0 and the **reaper** may have already issued provider `stop()` and CAS'd toward cold. Re-arming to `warm` without confirming the box is live yields a warm lease whose resume-by-id will NotFound. Fix: `draining → warm` re-arm must either (a) only be allowed before the reaper's terminate (guard the terminate with a CAS that checks refcount is still 0 and `expires_at < now-grace`), or (b) the resume path treats a NotFound on re-arm as the normal cold-restore (NotFound→create). The latter is the natural stateless behavior: a re-armed turn just resumes-by-id and, if the box is gone, cold-restores from the snapshot — no special case needed.

**C3. [MOOT] rotate-URL via `commitSandboxLeaseWarm`.** There is **no URL-rotation timer and no `rotateUrl`** under the stateless ruling — minting/rotating the data-plane URL is an event-driven `exposeStreamPort`/`resolveExposedPort` re-resolve recorded in the lease under the epoch fence (sec 3.5), not a reuse of `commitSandboxLeaseWarm`. The "always throws `SandboxLeaseSupersededError`" bug cannot occur. (If a stateless `updateSandboxLeaseDataPlane(...)` helper is wanted for the event-driven re-resolve write, it should update `data_plane_url`/`expiry` under `FOR UPDATE` without the warming gate and without bumping `lease_epoch` — a clean small helper.)

**C4. [MOOT] owner self-holder / epoch-stamp window / `holderId: owner:${workerId}` self-evict.** There is **no owner, no keep-alive tick, and no owner self-holder.** The per-turn resume path stamps `leaseEpoch` on its in-memory handle synchronously inside `resumeBoxForTurn` before the turn runs, and the only holders are the turn holder (`activityId`) and viewer holders (grant ids) — no `owner:${workerId}` viewer holder pollutes the count. The original self-evict-on-first-tick bug is removed with the keep-alive loop.

**C5. [STILL APPLIES, restated] §9 `finally` release must be awaited cleanly.** The rewritten §9 uses an explicit `if (resolved) { await releaseSandboxLease(...); resolved = null; }` block (no `await X && Y` precedence trap). Keep it that way: the release must be a real `await` inside the guard, and the in-memory handle dropped by going out of scope — never a provider-delete.

**C6. [STILL APPLIES, restated] Pass the resolved services object, not the `services` function.** The rewritten §9 obtains `const svc = await services()` and passes `svc` to `resumeBoxForTurn(svc, …)` — do not spread the `services` *function*. (The old `getOrCreateOwner({ ...services } …)` footgun is gone with the owner Map.)

**C7. [SUPERSEDED] `services()` adds `workerId` via `crypto.randomUUID()`/`hostname()` not imported.** Moot — `services()` is **unchanged** and adds no `workerId` (workers hold nothing across turns), so there is no new import to add.

**C8. [STILL APPLIES] `bigint("lease_epoch", { mode: "number" })` with `$type<number>` will silently lose precision past 2^53.** Epochs bump on every warm/re-establish so this won't realistically overflow, but `bigint` + `mode:"number"` is inconsistent with comparing `leaseEpoch` as a JS number on the fence check. Fix: use `integer` for `lease_epoch` (matches refcount, no precision risk) unless there's a reason for 64-bit.

---

### D. SDK / RUNTIME-INTEGRATION CORRECTNESS

**D1. The owned path passing BOTH `client` AND `session` triggers the SDK's end-of-run owned-session serialization, which is what the inversion is trying to avoid.** Verified in the SDK: when `config.session` is provided, `ensureSession` registers it via `registerSessionForAgent(agent, session)` **without `{owned:true}`** (`manager.js:419-424`), so it is NOT closed/deleted — good, the box survives. BUT `serializeSessionState` still runs at end-of-run because `shouldRunForOwnedSessions = Boolean(this.sandboxConfig?.client?.serializeSessionState)` (`manager.js:283`) keys off the *client* being present, and the spec's owned path passes a decorated client. The provided (non-owned) session won't be in `ownedSessionAgentKeys`, so it won't be closed, but the run will still attempt serialization passes against the client. This is probably benign but the spec's claim that the owned path is a clean "thread session, skip everything" is imprecise — verify the serialization pass against a provided-but-not-owned session is a no-op, or pass the session **without** the client (the SDK allows `session` with no `client` for pure provided-session runs; `requireClient()` is only hit on the resume/create paths, not the provided-session path). Fix: in the owned branch, pass `{ session, sessionState }` and **omit `client`** unless a mid-run sub-agent needs create/resume — which contradicts §7.2's decision to re-apply decorators to the client. Resolve this: either the resumed live `session` is authoritative (omit client) or the client is needed (then accept the serialization pass and the agent-dependent decorator re-wrap, and document why the non-owned box still survives).

**D2. `applyManifestToProvidedSession` will throw if the agent's manifest declares a different `root`/env than the live box.** The SDK applies only an *additive* manifest delta to a provided session and **throws** `UserError` on any `root`/env/users/groups/mounts change (`providedSessionManifest.js:42-60`). Across turns with different agents (sub-agents, goal continuations) whose `defaultManifest` differs from the box that was cold-restored, the owned run will throw mid-turn. The legacy per-run path avoided this by creating/resuming a fresh session per run with the right manifest. Fix: pin the box's manifest to a canonical session manifest and require all agents sharing a session to use a compatible manifest (same root/env), or handle the `UserError` as a "manifest-incompatible, cannot share box" degrade. This is unaddressed and will surface as runtime throws.

**D3. §7.2 option (B)'s decorator re-application reads `sandboxFileDownloadsForAgent`/`sandboxRepositoryCloneHooksForAgent` but the repository-clone hook re-runs the clone on every turn against a box that already has the repo.** `withSandboxLifecycleHooks` with `sandboxRepositoryCloneHooksForAgent(agent)` runs repo-clone-on-start (`runtime/src/index.ts:1018-1027`). On the resume-by-id path the box persists across turns, so a "clone on start" hook fires every turn against an already-cloned workspace. The legacy path created a fresh box per run, so clone-once was correct. Fix: the clone hook must become idempotent (skip if repo present), or run once only on the cold-restore branch (won-cold), not on every warm resume. The spec acknowledges hooks are "per-turn-agent-dependent" but doesn't resolve the re-clone semantics.

**D4. `DESKTOP_STREAM_PORT = 6080` must be in the provider client's `exposedPorts`/`ports` at *construction* time, but the resume path calls `resolveExposedPort(6080)` on a box built by `createSandboxClientForBackend` without the spec wiring 6080 into the constructor options.** Per the grounding, `exposedPorts` flows from config into the constructor (`runtime/src/index.ts:767/774`). The base `resolveExposedPort` asserts the port is configured (`assertConfiguredExposedPort`) unless `allowOnDemandExposedPorts()` (only blaxel). For modal/daytona/e2b/runloop, `resolveExposedPort(6080)` throws if 6080 wasn't in the create options. The spec never adds 6080 to the backend constructor. Fix: `createSandboxClientForBackend` must include `6080` in `exposedPorts` for desktop-capable backends (or merge it with config ports), else `exposeStreamPort` throws on every cold-restore.

---

### E. SMALLER GAPS / INCONSISTENCIES

- **E1.** `acquireSandboxLease` returns `disposition: "warming"` for "another worker is mid cold-restore," but a concurrent arrival that *blocked* on `FOR UPDATE` and then sees `liveness='warming'` cannot distinguish "cold-winner alive" from "cold-winner died and warming_expires_at passed but reaper hasn't run." The `waitForWarmOrRetry` poll could spin until `warmingTtlMs` (120s) before the reaper (15s period) resets it. Acceptable, but document the up-to-120s worst case.
- **E2.** `getSandboxSessionEnvelope(db, workspaceId, sessionId)` is called in `resumeBoxForTurn`/`establishSandboxSessionFromEnvelope` (§3) but `getSandboxSessionEnvelope` is workspace-RLS-scoped (`packages/db/src/index.ts:2628` per grounding) — fine in the per-turn activity (has workspaceId), just confirm it's imported; the spec imports lease fns but not `getSandboxSessionEnvelope`.
- **E3.** [MOOT under the API-direct ruling] The old §6.3 `openStream` `signalWithStart` (hardcoded `workflowId: \`session-${input.sessionId}\``) is **deleted** — viewer attach is API-direct (§6.3) and never signals or starts `sessionWorkflow`. There is no `openStream` workflow-id to keep in sync. (Should a non-attach reason to wake the turn workflow ever arise, reuse `workflowIdForSession(sessionId)` (`apps/api/src/domain/sessions.ts:219`) — but the viewer path does not.)
- **E4.** [MOOT] The "`owner:${workerId}` viewer self-holder pollutes `viewer_holders`" hazard is removed — there is **no owner self-holder.** The only holders are turn holders (`activityId`) and viewer holders (grant ids); `warm → draining` correctly gates on `viewer_holders=0 AND turn_holders=0`. (Turn `holder_id` = `activityId`, viewer `holder_id` = grant id, as before.)
- **E5.** §1.1 declares `data_plane_expires_at` and `warming_expires_at` but the reaper index `sandbox_leases_reap_idx (liveness, expires_at)` doesn't cover the `warming_expires_at < now` scan in §2.5 step (4) — that scan will seq-scan or need its own index. Add `(liveness, warming_expires_at)` partial index or include it.
- **E6.** `SandboxLeaseSupersededError` and `mapSandboxLease` are listed as net-new in the file table but their definitions/exports are never shown; ensure `SandboxLeaseSupersededError` carries the observed `liveness` (the constructor in §2.2 passes `lease.liveness`) and is exported from `@opengeni/db` (the resume path imports it from there).
- **E7.** [RESOLVED] §3.1's old `SandboxOwnerHandle.client` "already decorated, must NOT re-wrap" comment is gone — the §3.1 sketch and §7.2 now agree: the per-turn resume path builds the client and the owned branch re-applies ONLY the agent-dependent decorators (option B, correct given D3).
- **E8.** `ProductionRuntimeOverrides.runStream` does `{ ...options, sandboxClient: overrides.sandboxClient }` (`runtime/src/index.ts:192-195`), unconditionally setting `sandboxClient` (to `undefined` in prod). With `ownedSandbox` in `...options` this is fine, but if both `sandboxClient` and `ownedSandbox` are ever set, the owned branch must take precedence in `runAgentStream`; the spec's branch ordering (owned first) handles it, just make the mutual-exclusion explicit/asserted.

---

### Summary of must-fix before this is implementation-grade
Under the **stateless-workers ruling**, **B1/B2/B3** are resolved (per-session workers and per-session queues are removed; turns run on the global queue and resume by id). The remaining blockers of the core invariant: **A1** (reaper cannot read cross-workspace under RLS → liveness GC silently dead — now the *sole* GC/cost-stop driver, so more critical), **A2** (tables ship with no RLS policy), **B4** (the reaper needs a Temporal Schedule driver), and **C1** (refcount must be `COUNT(holders)`, not `prev+1`). The SDK-resolution blockers **A6/A7/D2/D4** will fail to compile or throw at runtime as written. The MOOT/SUPERSEDED findings (**B5/C3/C4/E4** owner-keepalive/rotate-URL/self-holder; **C7** worker-id import) need no fix — the machinery is gone. Everything else in C/D/E is a concrete, localized fix.

The spec's load-bearing claims that I *verified correct*: `SandboxRunConfig.session`/`sessionState` exist and a **provided session is registered non-owned (the SDK never reaps it; the keystone)**, `.for("update")` is a real codebase pattern, `urlForExposedPort(ep,'ws')` exists with the right scheme type, `activityContext.info.activityId` is available for turn holder ids, and `session-${sessionId}` is the correct workflow id for the *turn* (`sessionWorkflow`). **The API-direct control plane is also verified:** `ModalSandboxClient.resume()` is per-call with no pool/singleton/lock, `apps/api` already does outbound HTTPS + owns Postgres, and the sandbox-access fns have no `@temporalio`/agent-loop coupling — so the API runs the cold→warming CAS + resume-by-id + `session.exec/readFile/resolveExposedPort` in-process with no `signalWithStart`/worker RPC/NATS-request-reply. The inject-non-owned-session keystone, the lease (singleton + refcount + CAS + epoch fence + holders), the group-keyed envelope as the resume source, and warm-time billing all **stand** — the stateless + API-direct rulings only remove the in-worker owner / per-session-queue / keepalive machinery and the Temporal-routed viewer-attach, leaving Temporal hosting exactly the turn + the reaper Schedule.

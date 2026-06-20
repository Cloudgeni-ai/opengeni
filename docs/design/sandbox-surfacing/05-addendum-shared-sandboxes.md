# ADDENDUM — Shared Sandboxes: One Agent Spawning Another Full Session in the Same Box

> Slots into the master spine (`00-master-spine.md`) as an addendum to PART B (the singleton narrative), PART C.2 (the lease row), and PART G (open decisions + spikes). It does **not** introduce a new layer — it generalizes the **key** the existing five-layer machine is keyed on. Read alongside the data-model and surface design notes that back it; this is the consolidated, code-cited delta.
>
> **Scope:** a session may spawn another *full session* (its own conversation, history, agent) that runs inside the **same** provider sandbox — same filesystem, same repo checkout, same `:0` desktop — instead of getting its own fresh box. The box stays alive while **any** sharing session has a running turn or an attached viewer.

---

## (A) The idea — and why it is a generalization, not a rewrite

A session can spawn another full session that runs **inside the same box** (one provider sandbox, one filesystem/repo/desktop, N independent conversations) rather than in a fresh sandbox of its own. The box's liveness is already a **refcount over a holder set keyed by `lease_id`** (`sandbox_lease_holders`, master-spine C.2); the *only* change that makes sharing work is moving the lease's **identity** from `session_id` to a `sandbox_group_id` (the box's identity), so holders of N sessions fan into **one** lease row and the existing refcount/CAS/epoch machinery counts them for free. Every per-session key that means "box identity / liveness / ownership / meter" becomes `sandbox_group_id`-keyed; everything that means "conversation identity" (history, RunState, the `sessionWorkflow`, the per-viewer token) legitimately stays per-session.

**Why it is a generalization.** Define the **singleton-group invariant**: a session that founds its own box has `sandbox_group_id == id` (group ≡ session). Under that default every re-keyed query is **byte-for-byte behavior-preserving** vs. today's 1:1 world — the lease's `FOR UPDATE` still serializes arrivals on one row (now N sessions instead of 1), the `cold→warming` CAS still elects one spawner, the `lease_epoch` fence still gates re-establishment, the meter still accrues once per box. Sharing is purely the case where N>1 sessions point at one group; nothing in the state machine, the stateless resume-by-id path, the SDK injection, or the desktop stack is rewritten. The verified spike mechanics — CAS *inside* `FOR UPDATE` (`spikes/lease-epoch/lease.ts:121-129`), the single `lease_epoch++` site (`lease.ts:157`), TTL-exempt turn holders (`lease.ts:235`), release keyed `(lease_id, kind, holder_id)` (`lease.ts:180-186`) — all transfer mechanically. Note: under stateless workers there was **never** a per-session worker to begin with (workers are a stateless pool; any worker resumes the box by id per turn), so the per-group re-key fans refcount in across sessions but does **not** change worker cardinality — it was already independent of session/box count.

---

## (B) Data-model change — `sandbox_group_id` + the re-keying migration (exact DDL)

### B.1 The group identity — a column on `sessions`, no join table, no `sandbox_groups` table

A session belongs to **exactly one** group, immutably, for its whole life. That is a 1:1 (session→group) relationship → a **column**, never a join table. A standalone `sandbox_groups(id, account_id, workspace_id, …)` parent table buys nothing functional: the group has no attribute the lease row doesn't already carry (account, workspace, backend, os, instance, data-plane URL all live on `sandbox_leases`). **The live lease row IS the materialization of "this group has a box."** So: `sandbox_group_id` is a bare `uuid` that defaults to the founding session's own `id` (guaranteeing uniqueness with no sequence and no parent row), and is overridden to the parent's `sandbox_group_id` when spawned shared.

```sql
-- packages/db/drizzle/00XX_sandbox_group.sql
-- (drizzle-kit generate; _journal.json + snapshot REQUIRED — hand-append the
--  backfill UPDATE; drizzle won't emit a data backfill. Mirrors the 0017 note.)

-- 1. The group column. NULLable transiently for the backfill, then NOT NULL.
ALTER TABLE sessions ADD COLUMN sandbox_group_id uuid;

-- 2. Backfill: every existing session is its OWN singleton group (group ≡ session).
--    This is the behavior-preserving identity that makes the whole change a no-op
--    for today's 1:1 world.
UPDATE sessions SET sandbox_group_id = id WHERE sandbox_group_id IS NULL;

-- 3. Enforce. NOT an FK: the value is either this row's id or an ANCESTOR session's
--    id in the same workspace. Deliberately no FK to sessions(id) — see (F)/stress (b)#1.
ALTER TABLE sessions ALTER COLUMN sandbox_group_id SET NOT NULL;

-- 4. Routing index: resolve session_id -> sandbox_group_id at every lease entry
--    point (turn resume-by-id, viewer attach), and enumerate "all sessions in a
--    group" for attribution/disclosure.
CREATE INDEX sessions_sandbox_group_idx ON sessions (workspace_id, sandbox_group_id);
```

Drizzle (`packages/db/src/schema.ts`, inside the `sessions` pgTable near `parentSessionId`, schema.ts:117):

```ts
  // The shared-sandbox group this session's box belongs to. Defaults to the
  // session's OWN id (a singleton group: group ≡ session — today's 1:1 behavior).
  // When spawned shared via the create-session MCP, set to the PARENT's
  // sandboxGroupId so both run in ONE box. Immutable once set. NOT an FK (value is
  // this row's id or an ancestor session's id in the same workspace; the live
  // lease row, not a sandbox_groups table, materializes the group).
  sandboxGroupId: uuid("sandbox_group_id").notNull(),
  // ...and in the table's index closure:
  sandboxGroup: index("sessions_sandbox_group_idx").on(table.workspaceId, table.sandboxGroupId),
```

> The app sets it explicitly at insert — it **cannot** default to `id` in SQL (`id` is `defaultRandom()`, unknown at default-eval time). Generate the uuid in app code and use it for both `id` and `sandbox_group_id` in one insert (see (D)).

### B.2 Re-key `sandbox_leases` / `sandbox_lease_holders` (the delta to master-spine C.2)

Two changes to the leases table, **and nothing else in it**: the column `session_id → sandbox_group_id`, and the UNIQUE constraint `(workspace_id, session_id) → (workspace_id, sandbox_group_id)`. The holders FK is *already* the right shape (it keys on `lease_id`), so once the lease is one-per-group, all holders of all sessions in the group attach to that one row and `refcount = COUNT(*)` becomes the generalized liveness for free. The one holder addition is `session_id`, for per-session attribution/disclosure within a shared group. (The box-resume fields `resume_backend_id`/`resume_state` are promoted onto the lease — see (E)/the envelope split.)

```sql
-- Delta to packages/db/drizzle/0017_sandbox_leases.sql (master-spine C.2):
CREATE TABLE sandbox_leases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id)       ON DELETE CASCADE,
  sandbox_group_id uuid NOT NULL,                 -- ← WAS session_id (and WAS an FK). The BOX's identity. NOT an FK.
  liveness         text NOT NULL DEFAULT 'cold'
                     CHECK (liveness IN ('cold','warming','warm','draining')),
  refcount         integer NOT NULL DEFAULT 0 CHECK (refcount >= 0),
  turn_holders     integer NOT NULL DEFAULT 0 CHECK (turn_holders >= 0),    -- TTL-EXEMPT
  viewer_holders   integer NOT NULL DEFAULT 0 CHECK (viewer_holders >= 0),  -- TTL-reapable
  instance_id      text,
  backend          text NOT NULL,
  os               text NOT NULL DEFAULT 'linux',
  data_plane_url   text,                          -- tunnel URL viewers connect to directly; any worker re-resolves via resolveExposedPort under the epoch fence
  lease_epoch      integer NOT NULL DEFAULT 0,    -- THE FENCE (unchanged)
  resume_backend_id text,                         -- ← box-resume promoted from the per-session envelope (E)
  resume_state     jsonb,                         -- ← client.resume() payload (fromId, exposedPorts, …)
  last_meter_at    timestamptz,                   -- warm-time accrual cursor (per BOX — see (E) billing)
  last_meter_tick  integer NOT NULL DEFAULT 0,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sandbox_leases_group_uq UNIQUE (workspace_id, sandbox_group_id)  -- ← WAS (workspace_id, session_id). ONE box per GROUP.
);
CREATE INDEX sandbox_leases_reaper_idx ON sandbox_leases (expires_at)
  WHERE liveness IN ('warming','warm','draining');

CREATE TABLE sandbox_lease_holders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id      uuid NOT NULL REFERENCES workspaces(id)       ON DELETE CASCADE,
  lease_id          uuid NOT NULL REFERENCES sandbox_leases(id)   ON DELETE CASCADE,
  session_id        uuid NOT NULL REFERENCES sessions(id)         ON DELETE CASCADE,  -- ← ADDED: attribute holder→session within a shared group
  kind              text NOT NULL CHECK (kind IN ('turn','viewer')),
  holder_id         text NOT NULL,            -- turn: activityId; viewer: viewerId
  subject_id        text,                     -- for revocation reap
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sandbox_lease_holders_uq UNIQUE (lease_id, kind, holder_id)  -- unchanged
);
CREATE INDEX sandbox_lease_holders_stale_idx   ON sandbox_lease_holders (kind, last_heartbeat_at);
CREATE INDEX sandbox_lease_holders_lease_idx   ON sandbox_lease_holders (lease_id);
CREATE INDEX sandbox_lease_holders_session_idx ON sandbox_lease_holders (session_id);  -- ← ADDED
-- RLS / FORCE RLS / workspace_isolation policy / opengeni_app GRANT / SECURITY DEFINER
-- reaper sweep: UNCHANGED (all workspace_id-keyed).
```

> **Migration ordering.** `00XX_sandbox_group.sql` (add the column to `sessions` + backfill) lands **first and independently** — it is a behavior-preserving no-op (every session becomes its own singleton group) and can ship ahead of any lease code (crosscut PART 4.1 rollout). The lease re-key rides *with* the promotion of `0017` from the spike into `main`; it does **not** get its own migration if `0017` hasn't shipped yet — it is authored re-keyed from the start. If `0017` already shipped session-keyed, a follow-on migration renames the column + swaps the UNIQUE + adds `holders.session_id` + folds `resume_*` (a single transaction).

---

## (C) Lifecycle — refcount across sessions, per-group re-key (stateless), envelope-per-group

**Refcount across sessions (the headline correctness win, automatic).** `refcount = COUNT(holders for this lease)` over the group's one row now counts **any turn or viewer of any session in the group** (`recomputeAndStamp` counts by `lease_id`, `lease.ts:59-63`). The `warm→draining` guard `refcount=0 AND turn_holders=0` (`lease.ts:186`) now means *"no session in the group has a live turn AND no viewer is attached to any session in the group"* — i.e. **the box stays alive while ANY sharing session has a turn or viewer, and drains only at group-wide quiescence.** No formula changes; the row simply fans in N sessions. The creator session ending/dying while a spawned session is still running therefore does **not** reap the box — `releaseLeaseHolder` deletes only the creator's holder and recomputes; the spawned session's holder keeps `refcount>0` (stress (b)).

**Per-group re-key under stateless workers (no owner actor).** The headline lifecycle generalization — and under stateless workers it is purely a re-key of the **lease + envelope + meter + the resume-by-id path**, not of any owner actor:
- There is **no `SandboxOwner` actor, no `Map<…, SandboxOwner>`, and no per-group (or per-session) Temporal task queue** to re-key — workers are a stateless pool. The re-key keys the **lease row, the group envelope, the meter, and the resume-by-id path** on `sandbox_group_id`.
- On each turn, **any** pool worker resolves the group lease, `resume()`s the box **by id** from the group envelope (warm reattach if alive, else cold-restore from snapshot), and injects it as `RunConfig.sandbox.session` (non-owned). **One live box = one group**, the **one** provider handle that all sessions in the group multiplex. Turns of session A and session B both ride the **same** resumed `RunConfig.sandbox.session` — the ride-the-rails keystone (`03-sdk-rails-ride-or-bypass.md`, proven against `@openai/agents-core@0.11.6`) is per-handle, not per-conversation, so it is unaffected.
- `instance_id`, `data_plane_url`, `ensureDisplayStack`/`exposeStreamPort` (idempotent, any worker), and `establishSandboxSessionFromEnvelope` all already live on the lease row / are stateless functions → automatically per-group. The desktop framebuffer (`:0`), the recording, and the filesystem/repo are therefore **shared** across the group's sessions — the intended "same box, same desktop." Between turns the box survives on the provider's existing idle-timeout; the stateless reaper issues the provider's existing `stop()` at refcount 0.
- The cold-spawn self-election (first turn dispatches on the **global** queue, wins the `cold→warming` CAS under the held row lock, spawns the box) is unchanged in mechanism — there is no per-group worker to start; the box id is recorded on the group lease/envelope and any subsequent worker resumes it.

**Envelope-per-group (the one genuine split, see (E)).** Box-resume → group; conversation-recovery → session.

**No per-session worker existed (the reframed "win").** There was **never** any per-session worker — workers are a stateless pool, so cardinality is already independent of session/box count. The per-group re-key simply fans refcount in across sessions; worker cardinality is unaffected. The `sessionWorkflow` (`workflowId: session-<sessionId>`, `modules/02-owner.md`) stays per-session; its turns dispatch on the existing **global** queue.

---

## (D) The create-session MCP default + SDK injection + the concurrency policy recommendation

### D.1 The MCP surface — one optional `sandbox` field

Add **one** optional field to `session_create` (`apps/api/src/mcp/server.ts:518`) and `CreateSessionRequest` (`packages/contracts/src/index.ts:1319`):

```ts
sandbox: z.union([
  z.literal("shared"),                        // share the CREATOR's box (DEFAULT when spawned via MCP)
  z.literal("new"),                           // mint a fresh singleton box (today's behavior)
  z.object({ groupId: z.string().uuid() }),   // join a SPECIFIC sibling group in this workspace
]).optional(),
```

A **three-way union, not a boolean.** `"shared"|"new"` cover child↔parent and explicit-private; `{ groupId }` costs nothing (the group is just a uuid) and is the only way a **manager** can fan two **siblings** it spawns into one box (spawn child A → read `A.sandboxGroupId` off the response → spawn child B with `sandbox:{groupId:A.sandboxGroupId}`). Without it, "two workers in one box" is only expressible as a chain, never a fan-out.

### D.2 The default rule (context-dependent, resolved server-side from the trusted claim)

| How `session_create` was called | `sandbox` omitted ⇒ default | Why |
|---|---|---|
| **From inside a session** (`grant.metadata.sessionId` present ⇒ `parentSessionId != null`, `sessions.ts:407`) | **`"shared"`** — join the creator's group | The requirement: a session-spawned session shares the creator's box by default. |
| **Top-level** (workspace API key / non-delegated grant; `parentSessionId == null`) | **`"new"`** — own singleton group | No creator box to share; a user-created session is private. |

Explicit values win. `"new"` from inside a session opts out; `"shared"` from a top-level grant is a **422** (no creator to share with). The parent is **never** caller-supplied — it stays auto-inferred from the worker-signed `sessionId` claim (`server.ts:536-540`), the same trust model that already governs `parentSessionId`.

### D.3 The wiring (one new RLS-scoped read, in `createSessionForRequest`)

Inserted right after `parentSessionId` is derived (`apps/api/src/domain/sessions.ts:407`). Today the parent row is **not** loaded — this adds exactly one workspace-scoped read:

```ts
// sessions.ts — after: const parentSessionId = ... (line 407)
const sandboxChoice = req.sandbox ?? (parentSessionId ? "shared" : "new");
let sandboxGroupId: string | null = null;   // null => createSession defaults it to the new row's own id (singleton)
let inheritedBackend: string | undefined;   // a shared spawn MUST inherit the box's backend (same box)

if (sandboxChoice === "shared") {
  if (!parentSessionId) throw new HTTPException(422, { message: "sandbox:'shared' requires a parent session; use 'new'." });
  // getSession is RLS-WORKSPACE-SCOPED: a parent in another workspace returns null -> 404,
  // structurally forbidding cross-workspace sharing. No extra workspace check needed.
  const parent = await getSession(db, workspaceId, parentSessionId);
  if (!parent) throw new HTTPException(404, { message: `parent session not found in workspace: ${parentSessionId}` });
  sandboxGroupId  = parent.sandboxGroupId;
  inheritedBackend = parent.sandboxBackend;
} else if (typeof sandboxChoice === "object") {
  // sandbox:{groupId} — join a SPECIFIC sibling group. getAnySessionInGroup MUST take
  // workspaceId (mandatory) and filter inside RLS: WHERE workspace_id=$ AND sandbox_group_id=$.
  const member = await getAnySessionInGroup(db, workspaceId, sandboxChoice.groupId);
  if (!member) throw new HTTPException(404, { message: `sandbox group not found in workspace: ${sandboxChoice.groupId}` });
  sandboxGroupId  = sandboxChoice.groupId;
  inheritedBackend = member.sandboxBackend;
}
// else "new": leave sandboxGroupId null -> own singleton group (group ≡ id), today's behavior.
```

Then thread `sandboxGroupId` + `inheritedBackend ?? req.sandboxBackend` into `createAndStartSession` → `createSession`/`createSessionWithIdempotencyKey` (db/index.ts:1967-2061), which generate `id` up front and insert `sandboxGroupId ?? id`. A shared spawn **inherits the box's `(backend, os)`** (it is literally the same box; the child cannot pick its own); everything else (`goal`, `tools`, `resources`, `model`, `environmentId`, history) stays per-session and is chosen freely.

**Cross-workspace sharing is forbidden by construction**, no new authz code: (1) the RLS-scoped read returns `null`→404 for a foreign parent/group; (2) the lease UNIQUE is `(workspace_id, sandbox_group_id)`, so a foreign group id would only ever mint a *new empty* lease in the caller's own workspace, never attach to the foreign box; (3) `parentSessionId` is already workspace-trusted from the signed claim. **Hard requirement:** `getAnySessionInGroup` takes `workspaceId` as a **mandatory** parameter — the group uuid is *not* an access boundary, the workspace filter is (stress (e)).

### D.4 SDK injection — confirmed "it just works"

Each turn resumes the group's box by id and injects that live handle as `RunConfig.sandbox.session` (non-owned). **The SDK never learns the box is shared** — it receives one handle and rides it; sharing is a provider-side fact (one Modal/Docker sandbox, one filesystem, one `:0`). Injecting the **same** box into a turn of session A and a turn of session B is, from the SDK's view, indistinguishable from injecting it into two turns of one session. Concurrent turns from different sessions are just activities on the existing **global** queue; each resolves the group lease, acquires a `turn` holder (now stamping `session_id`), resumes-by-id, injects the shared non-owned handle → runs against the shared box → releases its holder and drops the in-memory handle. The **conversation** each turn loads is still per-session (A's RunState/history vs B's); only the box is shared. Clean separation: shared **box**, independent **conversations**. No SDK-layer change.

### D.5 Concurrency policy — unlimited concurrency, last-writer-wins

> The question: session A and session B both want a turn **in the same box** at once.

**Multiple sessions sharing one box run turns concurrently** — **no serialization, no turn-mutex, no FIFO queue, no "one active turn per box."** Two or more agent loops edit one filesystem/desktop **live**. Conflicts are **last-writer / OS-implicit** (Jørgen's standing no-explicit-conflict ruling) — the same model as a single agent's concurrent tool-calls. *"This is how all other agent harnesses work."* Viewers attach concurrently as before (read-only, §E).

Rationale:
- **Two independent agent loops editing one box is the normal collaboration mode** — shared boxes exist precisely so multiple agents work on one repo/desktop together. Letting both loops run is exactly the intended behavior; there is no single-active-turn restriction.
- **There is no machinery to serialize on** — workers are a stateless pool, not a single in-worker owner actor; turns are independent activities on the **global** queue. The lease's `FOR UPDATE` serializes lease *arrivals* (the CAS that elects the spawner), **not** turn execution.
- **Conflicts are governed by last-writer-wins** — concurrent FS writes, port binds, and `:0` desktop input race exactly as a single agent's concurrent tool-calls do. We do **not** build merge semantics or locking; the standing no-explicit-conflict ruling holds.
- **Envelope-serialization races are fenced, not serialized** — two concurrent turns can both serialize the group resume-state at turn end; the `lease_epoch` fence prevents a *stale* (superseded-epoch) writer from clobbering, and two *current-epoch* concurrent turns race **last-writer-wins** on the group resume-state (acceptable per the no-explicit-conflict ruling; see stress h·2).

---

## (E) Viewer / desktop + billing

### E.1 Viewer / desktop — one screen, N watchers; grant stays per-session, add a disclosure

A shared box is **one** `:0` framebuffer → a viewer sees **whatever any session's agent is currently doing**, and with concurrent turns may see two agents acting on the one screen at once. N humans watch concurrently (N viewer holders on the group lease). This "multiple agents + humans on one desktop" falls out of the box being one resource — no compositing, no per-session view.

**Keep `stream:view` per-session; do NOT add a group-scoped grant.** A principal requests `stream:view` on a *specific session* `:sid` (crosscut 1.3; `StreamTokenPayload {workspaceId, sessionId, viewerId, leaseEpoch}`, master-spine C.3). The grant authorizes watching *that conversation*; the box being shared is a property of the box, not a different grant. The holder it creates props up the **group** lease (correct liveness), but the *authorization* stays session-scoped (the unit a user understands).

**But there is a real disclosure gap → consent, not authz.** When the box is shared, watching A's desktop *also shows B's agent's* file edits/terminal/browser on the one screen. A principal authorized on A but **not** on B nonetheless sees B's agent operate. You **cannot** redact one agent from a shared framebuffer, so this is a *transparency* requirement, handled by extending the existing un-redacted acknowledgment gate (crosscut 1.6 / CR17):
- `SessionCapabilities.DesktopStream` gains **`shared: boolean`** (true when the group has >1 session) and **`sharedSessionIds: string[]`** (ids of the other sessions whose agents may appear). The client surfaces "this desktop is shared with N other sessions; their agents' activity is visible here."
- The acknowledgment body gains **`acknowledgeShared`**; when `shared:true`, `POST .../stream-capabilities` returns **409 `shared_acknowledgment_required`** until acknowledged. Reuses the existing acknowledgment machinery — no new endpoint, no new permission.
- `StreamTokenPayload` is **unchanged** (its `sessionId` identifies which conversation the viewer attached through, for holder attribution + revocation; the box it reaches is the group's).
- **`sharedSessionIds` exposes ids ONLY** — never B's goal/metadata/conversation. The viewer watches B's *screen*; the token grants the desktop surface only, and a viewer of A must **not** be able to use "I can see B's id" to subscribe to B's `session_events` (stress (g)).

**Revocation under sharing is unchanged** (crosscut 1.5 / OD-6): `revokeViewer(viewerId)` drops that viewer's holder from the **group** lease (correct refcount). Revoking A-viewers does **not** tear down the box if B still has holders — exactly the group-refcount liveness. A revoked A-viewer who independently holds `stream:view` on B may still watch via B (correct — authorized on B).

### E.2 Billing — one box metered ONCE; attribute, never double-charge

The warm-meter measures **box-seconds**; the accrual cursor (`last_meter_at`/`last_meter_tick`, crosscut 2.2) lives on the lease row and there is exactly one lease row per group → accruing **once per group is automatic and correct** once (B) lands. (Warm-time accrues on stateless ticks — the turn's existing Temporal heartbeat while a turn runs, and the reaper sweep for viewer-only boxes between turns — keyed per group; a viewer-held box still costs.) **Critical, non-deferrable:** the meter idempotency key moves from `(session_id, epoch, tick)` to **`(sandbox_group_id, epoch, tick)`** *in the same change as the lease re-key* — a session-keyed meter over a shared box charges the same box-tick once *per session* (N× over-bill from the first tick, stress (d)#1):

```ts
idempotencyKey: `usage:sandbox.warm_seconds:${sandboxGroupId}:${lease.leaseEpoch}:${tickIndex}`,  // ← WAS ${sessionId}:...
sourceResourceId: `${sandboxGroupId}:${lease.leaseEpoch}`,                                          // ← WAS ${sessionId}:...
```

`recordUsageEvent(...).onConflictDoNothing` (db/index.ts:612) then guarantees one box = one warm-seconds stream regardless of N sessions. **Workspace/account billing is exact and unaffected** — all sessions in a group share one `workspace_id`, the box is charged once. Warm-cap force-drain (crosscut 2.2, `AND turn_holders=0`) is workspace-keyed and unchanged; it now drains the *whole shared box* on balance exhaustion (correct, but flagged operationally: one balance exhaustion drains a multi-session box), ending in the **reaper issuing the provider's existing `stop()` at refcount 0**. **Open attribution ruling (OD-S4 below):** which session is shown as *cost owner* — billing correctness does not depend on it; the `sandbox_lease_holders.session_id` column enables per-holder-session apportionment for *visibility only*, never a second charge.

---

## (F) Stress-test resolutions

Invariant under test — **SINGLETON-PER-GROUP + LIVENESS:** for every `(workspace_id, sandbox_group_id)` at most one live box, alive iff `refcount>0` over the group's one lease row; drains only at group-wide `total==0 AND turn_holders==0`. Every failure below is a "half-done re-key" or a "per-session assumption survived into a shared world" — the verified spike mechanics generalize cleanly; the danger is only in the seams.

| # | Scenario | Severity | Resolution |
|---|---|---|---|
| **a** | A & B cold-start the same group at the same instant | **Critical (double-spawn)** | `INSERT…ON CONFLICT`, the `FOR UPDATE SELECT`, **and** the UNIQUE must **all** be `(workspace_id, sandbox_group_id)`, atomically — leaving any one on `session_id` double-spawns. `sandbox_group_id` is assigned once at insert and read-only thereafter, so two concurrent resolutions are bit-identical and race on the **same** row. Plain `FOR UPDATE` (block, not skip-locked) preserved (`lease.ts:105`). |
| **b·1** | Creator session hard-deleted while spawned session runs | **High (cascade kills box)** | Keep `sandbox_group_id` a **bare uuid with no FK to sessions**. The cascade deletes only the founder's `session_id`-stamped holders (correct), never B's holders, never the lease. Call out the no-FK in the migration so review can't "tidy" it into an FK to the founder. |
| **b·2 / f** | Founder *crashes* mid-turn → leaked turn holder pins the box (and bill) forever | **High (immortal box + bill)** | Bind turn-holder lifecycle to **Temporal activity liveness**, not session liveness: the turn releases its holder in a `finally`/cancellation handler when the activity dies, and a turn holder whose activity is confirmed dead becomes reapable (the stateless reaper TTL-reaps it). TTL-exemption (`lease.ts:235`) means "a *live* turn is never idle-reaped," **not** "a turn holder is immortal." (No mutex queue exists — turns run concurrently, §D.5.) |
| **c** | Epoch fence + re-establishment with holders spanning sessions | **Medium (livelock)** | Source `expectedEpoch` from **the group lease at acquire time**, never from a session's prior-turn memory (else B is spuriously fenced every time A bumps the epoch). **Fence only re-establishment; a plain attach passes no `expectedEpoch`** (`lease.ts:134` skips the fence) and just attaches — the common shared case, no livelock. A stale re-dispatched turn (from a dead worker) fails the CAS on its superseded epoch and backs off. The fence is keyed on `lease_epoch` (a box attribute) so it generalizes cleanly. |
| **d·1** | Meter left on `session_id` over a shared box | **Critical (N× over-bill)** | Meter idempotency key → `(sandbox_group_id, epoch, tick)` in the **same** change as the lease re-key (§E.2). Non-deferrable — a shared box with a session-keyed meter over-charges from the first tick. |
| **e** | `{groupId}` cross-workspace join attempt (the one caller-supplied id) | **High (security)** | `getAnySessionInGroup` takes a **mandatory** `workspaceId` and filters inside RLS (`WHERE workspace_id=$ AND sandbox_group_id=$`) → foreign group returns null→404. The group uuid is **not** an access boundary; the workspace filter is. Assert in a test. Layers 2/3 (lease UNIQUE per-workspace; signed parent claim) reinforce. |
| **g** | Viewer of A sees B's agent on the shared screen | **Medium (disclosure)** | Keep `stream:view` per-session; add `DesktopStream.{shared,sharedSessionIds}` + `acknowledgeShared` gate (409 `shared_acknowledgment_required`). `sharedSessionIds` exposes **ids only**, never B's conversation surface; the viewer token grants the desktop only (§E.1). |
| **h·1** | Half-done envelope split orphans the box | **Critical (leaked box)** | Promote box-resume state (`resume_backend_id`/`resume_state`, ports, tunnel, `data_plane_url`) to the **group** (lease row) in the **same** change as sharing. If left on the founder's per-session `sandbox_session_envelopes`, deleting the founder cascade-deletes the only pointer to the live provider sandbox → an un-reattachable, un-bill-stoppable leaked box. Verify `agent-turn.ts:250-256` (write) and `run-input.ts:106` (read) move box-resume to `session.sandboxGroupId`; conversation-recovery half stays `session_id`. |
| **h·2** | Two sessions' turns race writing the group resume-state | **Medium** | **Concurrent turns can both serialize the group resume-state** (turns run concurrently, §D.5 — there is no turn-mutex). Gate the resume-state write on `lease_epoch = expectedEpoch` (same fence as heartbeat, `lease.ts:221-223`): the fence prevents a *stale* (superseded-epoch) writer from clobbering the current epoch's resume state, but two *current-epoch* concurrent turns race **last-writer-wins** on the group resume-state — acceptable per the no-explicit-conflict ruling. The fence also covers the draining-finalize ⇄ re-establish interleave. |

The three **Critical**s (meter key, CAS keys, envelope split) must land **together** — none can be deferred behind the others.

---

## (G) The EXACT delta to the existing module specs + which migrations

| Module spec | Changes? | Exact delta |
|---|---|---|
| **`modules/01-lease.md` (lease)** | **Yes — core re-key** | §1.1 DDL: `session_id → sandbox_group_id` + `UNIQUE(workspace_id, session_id) → (workspace_id, sandbox_group_id)`; fold in `resume_backend_id`/`resume_state` (E). §1.2: add `sandbox_lease_holders.session_id` (+ FK + `_session_idx`). §4 query fns (4.1 `acquireLease`, 4.2 `commitWarmingToWarm`, 4.4 `releaseLeaseHolder`, 4.5 `heartbeatLeaseHolder`, 4.6 `reapStaleLeaseHolders`, 4.7 `reArmDrainingLease`, 4.8 `confirmDrainCold`, 4.9 `readLease`): every `WHERE … session_id = $` → `sandbox_group_id = $`; the `INSERT…ON CONFLICT` target → `(workspace_id, sandbox_group_id)`; `upsertHolder` gains `sessionId`; the reaper's drainable detector returns `sandbox_group_id`. **Mechanics unchanged** (CAS-in-`FOR UPDATE`, single `lease_epoch++`, `recomputeAndStamp` by `lease_id`, TTL-exempt turns). Callers resolve `sessionId→sandbox_group_id` **once** at the entry point. |
| **`modules/02-owner.md` (stateless resume-by-id)** | **Yes — stateless re-key (no owner actor)** | The §6 per-session/per-group Temporal task queue and the §3/§8 owner `Map` are **deleted** under stateless workers — there is no owner actor or per-group queue to re-key. The re-key applies to the **lease + group envelope (lease `resume_state`) + meter key + the resume-by-id path**. Turns of any session in the group resume the **same** box by id and inject the shared non-owned handle; the per-turn holder stamps `session_id`. **No turn-mutex** — turns run concurrently, last-writer-wins (§D.5); the turn holder's lifecycle is bound to Temporal activity liveness (stress b·2/f). `establishSandboxSessionFromEnvelope` resumes from the **group** box-envelope (lease `resume_state`), epoch-fenced write (stress h·2). Turn + viewer activities run on the existing **global** queue (no per-session queue). The warm-meter key → `(sandbox_group_id, epoch, tick)`. Cold-spawn self-election mechanism unchanged. `sessionWorkflow` id stays `session-<id>`. |
| **`modules/03-providers.md` (providers)** | **Minimal** | No registry/descriptor/config change. One new constraint (§5.2 backend selection): a **shared spawn inherits the group's `(backend, os)`** — it does not select its own; the create-session path (D.3) sets `inheritedBackend` and a caller-supplied `sandboxBackend` on a shared spawn is ignored (optionally 422 on disagreement). `exposedPorts` desktop-port ownership (§3.4) is now per-group (shared box). |
| **`modules/07-channel-b.md` (channel-b)** | **Yes — disclosure only** | §1.1 `SessionCapabilities.DesktopStream` gains `shared: boolean` + `sharedSessionIds: string[]`. §6 the `stream-capabilities` handshake: capabilities builder populates `shared`/`sharedSessionIds` from the group's session set (ids only, no conversation join); acknowledgment requires `acknowledgeShared` when `shared`, else **409 `shared_acknowledgment_required`**. The in-box stream stack (§3), websockify edge (§5), token rotation (§4) are **unchanged** — one box, one `:0`, N viewer holders (already supported). `StreamTokenPayload` unchanged. |
| **`modules/10-crosscut.md` (crosscut)** | **Yes — billing + auth disclosure + tests** | PART 1: `stream:view` stays per-session (no new permission); add the `acknowledgeShared` disclosure (1.6) + the shared-exposure note (1.7); revocation (1.5) unchanged (per-`viewerId` holder on the group lease). PART 2: warm-meter idempotency/`sourceResourceId` → `sandbox_group_id` (2.2) — the no-double-meter fix; force-drain (2.2) now group-wide. PART 3: add the shared-box stress cases (a/b/d/e/h above) to the lease race tests (3.1) and an `acknowledgeShared` auth test (3.5). PART 4: add `00XX_sandbox_group.sql` to the migration list (4.1); feature-gate sharing behind the existing `sandboxOwnershipEnabled` posture (4.2). |
| **`modules/04-desktop-image.md`, `05-computer-use.md`, `06-os.md`, `08-channel-a.md`, `09-client.md`** | **No** | Untouched. The desktop image, computer-use input plane (read-only in v1 regardless), OS seam, Channel-A FS plane, and the client SDK are all provider-blind / per-handle and don't observe sharing. (Channel-A's OD-4 FS-write concurrency stands as **last-writer-wins** for shared boxes — FS writes are **not** serialized; there is no turn-mutex, so concurrent turns on one box race exactly like a single agent's concurrent tool-calls, D.5.) |

**Migrations:**
1. **`packages/db/drizzle/00XX_sandbox_group.sql`** — NEW, ships first/independently: `ALTER TABLE sessions ADD COLUMN sandbox_group_id uuid` + backfill `= id` + `SET NOT NULL` + `sessions_sandbox_group_idx`. Behavior-preserving no-op (every session its own singleton group); hand-append `_journal.json` + snapshot.
2. **`0017_sandbox_leases.sql`** — authored **re-keyed from the start** when promoted from `spikes/lease-epoch/` into `main` (`sandbox_group_id` column + `UNIQUE(workspace_id, sandbox_group_id)` + `holders.session_id` + `resume_backend_id`/`resume_state`). If `0017` already shipped session-keyed, a **follow-on migration** does the rename + UNIQUE swap + holder column + resume-field fold in **one transaction**.

Contracts/MCP/DB surface (all **additive**, omitted `sandbox` ⇒ today's behavior): `CreateSessionRequest.sandbox` + `Session.sandboxGroupId` echo (`contracts/index.ts:1319`); `session_create.sandbox` input (`server.ts:518`); `createSession`/`createSessionWithIdempotencyKey` `sandboxGroupId` param + `getAnySessionInGroup` helper + `mapSession` maps the column (`db/index.ts:1967-2061`); `createSessionForRequest` resolution (`sessions.ts:407`); envelope read/write by `sandboxGroupId` (`run-input.ts:106`, `agent-turn.ts:250-256`).

---

## (H) Open decisions for Jørgen + new spike

Slots into master-spine PART G (same OD-N / SPIKE table style).

| # | Decision | Options | Recommendation | Blocks |
|---|---|---|---|---|
| **OD-S1** | Default-share scope | (a) default `"shared"` only on MCP spawn from inside a session; (b) also default-share for the API "fork session" path; (c) never default, always require explicit `"shared"` | **(a)** — share-by-default exactly where the requirement asks (agent-spawns-agent); top-level/API creates stay private; explicit `"shared"`/`{groupId}` always available | Surface (D); the create-session default rule |
| **OD-S2** | Concurrency policy | (a) serialize turns per box (one active turn, FIFO-queue the rest); (b) **allow concurrent agent loops with last-writer-wins**; (c) configurable per-group | **(b)** — two independent agent loops editing one box is the *normal* collaboration mode and is governed by the standing no-explicit-conflict ruling (same as a single agent's concurrent tool-calls); no turn-mutex, no FIFO, no one-active-turn-per-box. *"This is how all other agent harnesses work."* OD-4 is **not** superseded — last-writer-wins stands for FS writes | Concurrent turns; epoch fence + last-writer-wins (D.5) |
| **OD-S3** | Viewer auth model under sharing | (a) keep `stream:view` **per-session** + a shared-exposure **disclosure/acknowledgment**; (b) introduce a group-scoped `stream:view` grant | **(a)** — the grant is to a *conversation* (the unit users understand); you can't redact one agent from a shared `:0`, so the right fix is consent (`acknowledgeShared`), not a new grant shape | Channel-B (E.1); crosscut auth |
| **OD-S4** | Shared-box cost **attribution** (correctness is settled — workspace charged once) | (a) attribute to the founding/creator session + workspace; (b) even split across holder-sessions; (c) workspace-only, no per-session breakdown | **(a)** with optional per-holder-session apportionment from `holders.session_id` for **visibility only** — never a second charge. Do not let "split the cost" become "charge each session" (reintroduces the double-meter via reporting) | Billing reporting (E.2); none block GA |
| **OD-S5** | `{ groupId }` explicit-join affordance in v1 | (a) ship the three-way union incl. `{groupId}` (enables manager fan-out); (b) ship only `"shared"\|"new"` (chain-only), add `{groupId}` later | **(a)** — `{groupId}` costs nothing (a uuid), is the only way to express sibling fan-out from one manager, and is fully workspace-scoped by the mandatory-`workspaceId` `getAnySessionInGroup` (stress e) | Surface (D.1) |

**New spike** (same SPIKE table style):

| Spike | Question | Method | Gate |
|---|---|---|---|
| **SPIKE-5 — shared-box group-refcount liveness + founder-crash holder reap** | Under two full sessions sharing one box: does **group-refcount** keep the box alive across the creator's exit and drain only at group-wide quiescence (ending in the reaper's provider `stop()`), and does a founder mid-turn **crash** get its leaked turn holder reaped (box not immortal)? | Spawn A→B shared on real postgres + a real provider box; run A/B turns **concurrently** hammering the shared repo **last-writer-wins** (no serialization assertion); assert one warm-seconds meter stream on `sandbox_group_id`, box survives A's exit while B runs, and a killed-A activity releases its holder so the box drains. Extends `spikes/lease-epoch/` (CAS-in-`FOR UPDATE` + epoch-fence already proven there). | **GA gate for sharing** — proves the three Criticals (CAS keys, meter key, envelope split) land correctly together and the activity-liveness holder cleanup (stress b·2) actually fires |

---

## Net

The load-bearing per-session keys — the lease `UNIQUE(workspace_id, session_id)`, the `(session_id, epoch, tick)` meter key, and the resume-by-id envelope — all become `sandbox_group_id`-keyed. Under stateless workers there is **no owner actor and no per-session/per-group Temporal queue** to re-key; the re-key applies to the lease + envelope + meter + the resume-by-id path. Holders already key by `lease_id`, so refcount-liveness generalizes for free (add `session_id` only for attribution/disclosure). The envelope is the sole genuine split (box-resume → group lease; conversation → session). History, the `sessionWorkflow`, turn/holder identity, and the per-viewer token stay per-session. For a default singleton group (`sandbox_group_id == id`) every change is a behavior-preserving no-op — generalization, not rewrite. Concurrency is **unlimited** (concurrent turns, last-writer-wins; no turn-mutex). The stateless pool means worker cardinality never depended on session/box count, so the per-group re-key just fans refcount in across sessions. The three Criticals (CAS keys, meter key, envelope split) must land together; SPIKE-5 gates them.

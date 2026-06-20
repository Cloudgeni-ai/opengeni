# IMPLEMENTATION PLAN — Sandbox Surfacing (PR-by-PR autonomous build plan)

> **For Jørgen.** This is the executable build plan: the ordered PR graph that turns the design-of-record into shipped code. It is the missing planning artifact — readiness (`06`) cleared the shape gates, the credentialed live-fire (`07`) held R-A1..R-A4 on real Modal, and this sequences PART F of `00-master-spine.md` into shippable PRs.
>
> **Authoritative model (folded in; supersedes any contradicting passage in the module specs):**
> - **CONTROL PLANE = API-DIRECT.** `client → API → box`. The `apps/api` process itself does `resume()`-by-id from the group lease envelope + `session.exec`/`readFile` + `resolveExposedPort`, **in-process**, for ALL non-turn ops (viewer attach, mint/rotate tunnel URL, FS list/read for Pierre tree, git status/diff, capability negotiation). The cold→warming lease CAS is a Postgres transaction the API runs. **NO Temporal, NO worker, NO NATS request/reply in the synchronous control path.**
> - **ENABLING REFACTOR.** Extract a thin shared module `@opengeni/runtime/sandbox` (`createSandboxClient` + `deserializeSandboxSessionStateEnvelope` + `restoredSandboxSessionStateFromEntry` + `sandboxStateEntryFromRunState`) so `apps/api` imports it WITHOUT the `@openai/agents` agent-loop graph; add the dep to `apps/api`; plumb the Modal token (already parsed by shared `getSettings`, `packages/config`) into the API's Modal-client construction; egress to `api.modal.com` (already exercised for Stripe/OpenAI/GitHub).
> - **TEMPORAL is used for EXACTLY TWO things:** (1) the long-running agent TURN (existing `sessionWorkflow`), and (2) ONE GLOBAL REAPER as a Temporal Schedule (TTL-reap stale viewer holders, reset warming-death, terminate at refcount 0; runs in the worker; reuses `temporalScheduleOptions`). No per-session queue, no per-RPC workflow, no `sandboxOwnerRpcWorkflow`.
> - **SHARED SANDBOXES, re-keyed from the start.** The lease is keyed on `sandbox_group_id` (not `session_id`), `integer` epoch, holders carry `session_id`, `resume_backend_id`/`resume_state` fold onto the lease. The three Criticals (CAS keys, meter key, envelope split) land **together** in the foundation. `sandbox_group_id` defaults to the founding session's own `id` → today's 1:1 world is a behavior-preserving no-op.
> - **UNCHANGED + PROVEN.** Stateless workers (resume-by-id per turn, inject non-owned); the Postgres lease (singleton UNIQUE + refcount + cold→warming CAS + integer `lease_epoch` fence + holders); pixels client→Modal-tunnel direct; events worker→NATS→API-SSE→client (NATS = events only); box stays warm on provider idle-timeout; reaper terminates at refcount 0. R-A5 = `maxViewersPerSession≈5` direct/relay for more.

---

## (A) THE BUILD GRAPH

Legend — **size**: S (≤1 day) · M (a few days) · L (≥1 week incl. integration). **AUTONOMY**: `FULL-AUTONOMY` (no human input beyond review+merge) · `NEEDS-DECISION(I#/OD-#)` (a product/policy ruling must land before this PR opens) · `NEEDS-CREDS(x)` (a live-fire harness needs a credential; build proceeds, the GA-gating test waits). Every PR merges **to `main`** behind its phase flag; the human review+merge gate (C) applies to **all** PRs and is not repeated per-row.

Migration order is forced: **`0017_sandbox_leases` → `0018_sandbox_os` → `0019_session_recordings` → `0020_sandbox_pty_sessions` → `0021_session_stream_acknowledgments`** (master-spine PART F; this supersedes the crosscut module's older `0018_session_stream_acknowledgments` numbering — see (B)).

---

### PHASE 0 — Providers + OS axis + the shared sandbox module
`flag: none (ships Channel-A-headless behavior unchanged on all 10 backends; the extraction is a pure refactor)`

#### **P0.1 — Contracts: backend/OS enums + capability descriptor + handshake skeleton**
- **AUTONOMY:** FULL-AUTONOMY
- **scope:** The single source of truth. Expand `SandboxBackend` to 10 values (additive, existing 4 keep position); add `SandboxOs`; add `CapabilityDescriptor` type + `CAPABILITY_DESCRIPTORS` table (the Part-D matrix, 10 rows); add `SandboxCapabilityName`; add the `SessionCapabilities` Zod doc + `CapabilityUnavailableReason` (master-spine C.1/C.3); mirror enum in `packages/deployment`. Note: descriptor table lives in **contracts**, not runtime (breaks config↔runtime cycle, ledger CR8).
- **files:** `packages/contracts/src/index.ts` (`:13` enum, `~:1425` `SessionCapabilities`/`ClientConfig`); `packages/deployment/src/index.ts:34`; `packages/sdk/src/types.ts:14` (enum + capability-type mirror).
- **migration:** none.
- **tests:** `packages/sdk/test/contract-parity.test.ts` — three-way enum parity (contracts/sdk/deployment) sorted-equality; descriptor-table invariant self-test (`backendId === SDK client.backendId`, `Recording.available == DesktopStream.available && os==linux`, `6080 ∈ exposedPorts` when desktop-capable).
- **acceptance:** parity test green; `bun build` across the three packages clean; no behavior change.
- **flag:** none. **dependsOn:** — **size:** M

#### **P0.2 — Enabling refactor: extract `@opengeni/runtime/sandbox` (the agent-loop-free leaf)**
- **AUTONOMY:** FULL-AUTONOMY ← **the foundation; start here.**
- **scope:** Move `createSandboxClient` + `deserializeSandboxSessionStateEnvelope` + `restoredSandboxSessionStateFromEntry` + `sandboxStateEntryFromRunState` + `collectSandboxEnvironment` + `parseExposedPorts` out of `packages/runtime/src/index.ts` (currently `:763-795`, `:1665`, `:1690`, `:1700`, `:57` import) into a new leaf `packages/runtime/src/sandbox/index.ts` with **zero** `@openai/agents`/`-extensions` agent-loop import (only the per-provider SDK `build()` import). Add the `"./sandbox": "./src/sandbox/index.ts"` exports subpath to `packages/runtime/package.json`; `export * from "./sandbox"` in the barrel so `apps/worker` is unchanged. This is the load-bearing pre-req for the entire API-direct control plane.
- **files (new):** `packages/runtime/src/sandbox/index.ts`. **(edit):** `packages/runtime/src/index.ts` (`:27-31`, `:57`, `:763-795`, `:1665`, `:1690`, `:1700` → re-export from `./sandbox`); `packages/runtime/package.json` (`exports` map).
- **migration:** none.
- **tests:** a build-graph guard test asserting `@opengeni/runtime/sandbox`'s transitive import set contains **no** `@openai/agents`/`-extensions` agent-loop module (grep/dep-cruiser over the resolved graph); existing runtime tests stay green (barrel unchanged).
- **acceptance:** `apps/worker` builds + tests unchanged; the leaf imports clean in isolation; guard test green.
- **flag:** none. **dependsOn:** P0.1 **size:** M

#### **P0.3 — Provider registry: 10 per-provider modules + descriptor-driven `createSandboxClient`**
- **AUTONOMY:** FULL-AUTONOMY
- **scope:** Replace the if/else `createSandboxClient` with a registry: `ProviderRegistration` interface + 10 per-provider modules (each with `validateCredentials` + `build`; **all 7 non-trivial `build()` bodies** — Modal + e2b/daytona/runloop/blaxel/cloudflare/vercel, units/field-names differ per provider; "mirror Modal" is false) + `PROVIDER_REGISTRY` + `selectBackend` + `negotiateCapabilities`. 6080 port-merge inside `createSandboxClient` for every desktop-capable `(backend,os)` (incl. runloop, pre-declared). Boot-validated descriptor invariants.
- **files (new):** `packages/runtime/src/sandbox/capabilities.ts`, `errors.ts`, `providers/types.ts`, `providers/{modal,docker,local,none,daytona,runloop,e2b,blaxel,cloudflare,vercel}.ts` (10), `providers/index.ts`, `select.ts`. **(edit):** `packages/runtime/src/sandbox/index.ts` (registry-driven factory); `packages/runtime/src/index.ts` (`:1481` `objectStorageFileMount` branch on `descriptor.nativeBucketMount`); `apps/worker/src/activities/environment.ts:80` (backend-aware `HOME`/`workspaceRoot`); `apps/worker/src/activities/agent-turn.ts:1059` (`requiresSignedFileResourceDownloads` keyed on `descriptor.nativeBucketMount`).
- **migration:** none.
- **tests:** per-provider `createSandboxClient` matrix construction tests (the crosscut 3.4 matrix); negotiation/degradation unit tests (`available:false` + `reason`, never absent); descriptor-vs-SDK `backendId` assertion.
- **acceptance:** all 10 backends construct (Modal real, others with stub creds); negotiation returns a coherent `SessionCapabilities` per `(backend,os)`; existing docker/modal/local paths unchanged.
- **flag:** none. **dependsOn:** P0.1, P0.2 **size:** L

#### **P0.4 — Config + deployment: per-provider settings, env maps, validation; API gets the sandbox client**
- **AUTONOMY:** FULL-AUTONOMY · **NEEDS-CREDS(Modal)** only for the live API-direct resume smoke (build + unit are non-gated)
- **scope:** ~30 per-provider `sandbox*` settings + `OPENGENI_*` env mappings + backend-gated required-cred validation in `packages/config`. Add `@opengeni/runtime` (`/sandbox` subpath) to `apps/api/package.json`; construct a sandbox client from settings in `apps/api/src/dependencies.ts` (Modal token plumbed via `getSettings`; inject `OPENGENI_MODAL_TOKEN_ID`/`_SECRET`/`OPENGENI_MODAL_APP_NAME` into the API runtime env); add a `resumeBoxById` helper to `deps`. Replace the single modal-if in `packages/deployment` with `SANDBOX_REQUIRED_ENV` table iteration (two sites). A lint/grep guard: `apps/api` imports access symbols ONLY via `@opengeni/runtime/sandbox`.
- **files:** `packages/config/src/index.ts` (`:244`, `:481`, `:986`); `packages/deployment/src/index.ts` (`:863`, `:1419`); `apps/api/package.json:18`; `apps/api/src/dependencies.ts`.
- **migration:** none.
- **tests:** config validation unit tests (backend-gated creds); deployment env-render test; an **API-direct resume smoke** (gated: against real Modal, `deps.resumeBoxById` resumes a box, `session.exec` echoes a marker, in-process, no worker) — this is the first proof the API can touch a box.
- **acceptance:** API boots with the sandbox client; `bun build` clean; (gated) the resume smoke passes against real Modal.
- **flag:** none. **dependsOn:** P0.2, P0.3 **size:** M

#### **P0.5 — DB: `0018_sandbox_os` column + group column on sessions**
- **AUTONOMY:** FULL-AUTONOMY
- **scope:** Two forward-only, behavior-preserving column adds. `0018`: `sessions.sandbox_os text NOT NULL DEFAULT 'linux'` + `session_turns.sandbox_os text` (nullable override) + CHECKs; backfill is the default. **Plus the `sandbox_group_id` column on `sessions`** (addendum B.1): `ADD COLUMN sandbox_group_id uuid`, backfill `= id`, `SET NOT NULL`, `sessions_sandbox_group_idx (workspace_id, sandbox_group_id)` — a no-op (every session its own singleton group). NOT an FK to `sessions(id)` (value is this row's id or an ancestor's; the live lease materializes the group — stress b·1). Drizzle schema edits near `:117`/`:260`. OS stamped into the recovery envelope JSON (`packages/runtime` §4) so re-establish needs no DB join.
- **files:** `packages/db/drizzle/0018_sandbox_os.sql` (NEW); `packages/db/drizzle/meta/_journal.json` + `0018_snapshot.json` (hand-appended — backfill UPDATE + the group-column add); `packages/db/src/schema.ts` (`:117` sessions, `:260` session_turns); `packages/db/src/index.ts` (`mapSession` maps `sandboxOs` + `sandboxGroupId`; read-side cast).
- **migration:** **0018** (second in order; the group-column add piggybacks here — it is behavior-preserving and unblocks the shared-sandbox MCP surface in P1.4 without its own migration).
- **tests:** migration apply/rollback test; `mapSession` round-trips both columns; backfill correctness (existing rows → `linux`, `sandbox_group_id == id`).
- **acceptance:** migration applies clean on a `0017`-less DB; old API builds insert valid rows (defaults apply); rollback safe.
- **flag:** none. **dependsOn:** P0.1 **size:** S

---

### PHASE 1 — Lease + ownership inversion (stateless)
`flag: sandboxOwnershipEnabled (new config bool, default false)`

#### **P1.1 — DB: `0017_sandbox_leases` (group-keyed) + lease query fns + reaper SECURITY-DEFINER fn**
- **AUTONOMY:** FULL-AUTONOMY ← **the foundation migration; the three Criticals land here together.**
- **scope:** The two tables, authored **re-keyed to `sandbox_group_id` from the start** (addendum B.2): `sandbox_leases` UNIQUE `(workspace_id, sandbox_group_id)`, `integer lease_epoch`, single `expires_at` (warming-death == lapse), `resume_backend_id text` + `resume_state jsonb` folded on (the group box-envelope; the Critical "envelope split"), `last_meter_at`/`last_meter_tick`; `sandbox_lease_holders` with `session_id` added (attribution/disclosure) + `(lease_id, kind, holder_id)` UNIQUE + `subject_id`. RLS ENABLE/FORCE + `workspace_isolation` policy + `opengeni_app` GRANT on both tables (verbatim 0005/0007 boilerplate). **The reaper SECURITY-DEFINER cross-workspace sweep fn** in this migration (OD-3): one predicate over the reaper index — stale viewer holders + warming-death + draining-grace in one pass, returning `(workspace_id, sandbox_group_id)`. The 9 query fns: `acquireLease` (plain `FOR UPDATE`, **not** skip-locked — the CAS-inside-`FOR UPDATE`, all keyed `(workspace_id, sandbox_group_id)`), `commitWarmingToWarm` (the only `lease_epoch++` site), `failWarmingToCold`, `releaseLeaseHolder` (idempotent delete-my-row + opportunistic warm→draining guarded `refcount=0 AND turn_holders=0`), `heartbeatLeaseHolder` (epoch-fenced — the C1b fix, **the real split-brain bug**), `reapStaleLeaseHolders` (issues provider `stop()` at refcount-0/past-grace), `reArmDrainingLease`, `confirmDrainCold`, `readLease`. `lease_epoch` is `Number()`-coerced (the C1a int8-string trap — `integer` avoids it but coerce defensively). Meter idempotency key `(sandbox_group_id, epoch, tick)` (the Critical "meter key") — wired in P2.1 but the column shape lands here.
- **files:** `packages/db/drizzle/0017_sandbox_leases.sql` (NEW); `packages/db/drizzle/meta/_journal.json` + `0017_snapshot.json` (hand-appended — RLS GRANT blocks + SECURITY-DEFINER fn won't be emitted by `generate`); `packages/db/src/schema.ts` (after `:370`, mirror `sandboxSessionEnvelopes`); `packages/db/src/index.ts` (after `:2636`, the 9 fns + types `SandboxLeaseLiveness`/`LeaseHolderKind`/`LeaseSnapshot`/`AcquireLeaseInput/Result`/`SandboxLeaseSupersededError`; mirror `claimNextQueuedTurn:3077` `withWorkspaceRls→txn→FOR UPDATE`); `packages/config/src/index.ts` (3 cadence fields `sandboxLeaseReaperPeriodMs`/`sandboxViewerHolderTtlMs`/`sandboxIdleGraceMs` + env + the boot-validated `reaperPeriod < viewerHolderTTL < providerIdleTimeout` refine).
- **migration:** **0017** (first in order — depended on by all of Phase 1+).
- **tests:** `packages/db/test/sandbox-leases.test.ts` (NEW): singleton under N=50 concurrency (exactly one spawner, refcount=50); the `SKIP LOCKED` counterfactual (proves plain `FOR UPDATE` is load-bearing); epoch fence on the **heartbeat** path (stale owner self-evicts); refcount→0 → warm→draining (guarded `turn_holders=0`); stale viewer TTL-reaped while same-age turn holder survives; the SECURITY-DEFINER sweep selects the right rows cross-workspace. Mirrors the proven `spikes/lease-epoch/` harness, ported to real `packages/db` + `withWorkspaceRls`.
- **acceptance:** all lease tests green on real postgres via the package (not ported SQL); RLS isolation asserted; the double-spawn counterfactual fails-closed.
- **flag:** none (DDL is inert until P1.2 wires it). **dependsOn:** P0.5 **size:** L

#### **P1.2 — Worker: ownership inversion + stateless per-turn resume-by-id + the one recovery primitive**
- **AUTONOMY:** FULL-AUTONOMY · **NEEDS-CREDS(Modal)** for the live keystone re-confirm (V5/R4 already HELD — this is regression coverage)
- **scope:** The literal architectural foundation. `RunAgentStreamOptions.ownedSandbox` + the owned/non-owned branch in `runAgentStream` (`:968`, `:1006`, `:1044`) so an injected session is non-owned (never reaped — the proven keystone). A stateless `resumeBoxForTurn(svc, ids, kind, holderId)` helper (no class, no timers): resolve the group lease, `resume()` the box by id from `resume_state` (warm reattach or cold-restore from snapshot), inject as `RunConfig.sandbox.session` non-owned, run, release the holder + drop the handle in `finally`. The **one recovery primitive** `establishSandboxSessionFromEnvelope`-under-CAS (re-establish-from-envelope, epoch-fenced write — stress h·2) + a per-provider **NotFound discriminator** (re-implemented per backend — the agents-extensions helper isn't exported). Turns dispatch on the **existing global queue** (no taskQueue override, no per-session worker, no per-session queue); worker-death re-dispatches the turn (any worker re-resumes by id). Headless rollover branches on tier (I5 — skip `ensureDisplayStack` when tier≠desktop). Re-apply only agent-dependent decorators on resume (V6 — verify `withManifestRefreshOnResume`/`wrapSession` at impl time). Concurrency: unlimited, last-writer-wins, no turn-mutex.
- **files (new):** `apps/worker/src/sandbox-resume.ts` (`resumeBoxForTurn`, `ensureDisplayStack`/`exposeStreamPort` idempotent stubs callable by worker, `DESKTOP_STREAM_PORT`). **(edit):** `packages/runtime/src/index.ts` (`:968` opt, `:1006`/`:1044` branch; export `createSandboxClientForBackend`/`establishSandboxSessionFromEnvelope`/`EstablishedSandboxSession` from the leaf); `apps/worker/src/activities/agent-turn.ts` (`resumeBoxForTurn(...,"turn",activityId)` at `:294`, thread `ownedSandbox` into `runStream` at `:473`, `heartbeatSandboxLease` in the 30s heartbeat at `:306`, `releaseSandboxLease("turn")` + drop handle in `finally` at `:855`); `apps/worker/src/workflows/session.ts` (`patched("sandbox-owner-lease")`: turn stays on global queue at `:215`; worker-death re-dispatch at `:254`; **no** `openStreamRequest`/`closeStreamRequest` signals, **no** `ownerHeartbeat`); `apps/worker/src/activities.ts` (`services()` unchanged — no owners/workerId).
- **migration:** none.
- **tests:** integration — turn dispatches → resume-by-id → inject non-owned → run → drop (E2/E4 stateless slice); the keystone regression (injected non-owned survives `run()` un-reaped; owned is reaped) on the local `unix_local` backend (creds-free) + a gated Modal re-confirm; epoch-fence on the heartbeat path under a forced re-establish (SPIKE-4); rollover re-establish under a new epoch fences the dead URL.
- **acceptance:** with `sandboxOwnershipEnabled=false` the path is byte-for-byte today's build-and-discard; with it `true`, turns resume the one box by id, refcount is liveness, the recovery primitive re-establishes on box death. **Patched-gate:** all changes behind new `patched()` keys so multi-day in-flight histories replay on the original lease-less path.
- **flag:** `sandboxOwnershipEnabled` (gates the activity-side acquisition). **dependsOn:** P1.1 **size:** L

#### **P1.3 — Worker: the one global reaper Temporal Schedule**
- **AUTONOMY:** FULL-AUTONOMY
- **scope:** The **sole** liveness/GC/cost-stop driver (OD-3). One periodic sweep (a Temporal `Schedule`, reusing `temporalScheduleOptions`, running in the worker because the worker carries the runtime) calling `reapStaleLeaseHolders` in one pass: TTL-reap stale viewer holders, reset warming-death rows to `cold`, terminate the box (provider `stop()`) at `refcount=0` past the drain grace. Bind turn-holder lifecycle to Temporal activity liveness (stress b·2/f — a crashed founder's leaked turn holder is reapable; TTL-exemption means "a *live* turn is never idle-reaped," not "immortal"). No per-session timer, no per-RPC workflow, no `ownerHeartbeat`.
- **files (new):** `apps/worker/src/activities/sandbox-lease.ts` (`reapSandboxLeases` ONLY — no `*ForViewer` activities, no `ownerHeartbeat`, no `resolveOwnerTaskQueue`). **(edit):** `apps/worker/src/activities.ts` (`:29-63` spread `createSandboxLeaseActivities` — only `reapSandboxLeases`); `apps/worker/src/index.ts` (`:33`, `:67-90` — register the global reaper Schedule; static `Worker.create` on the global queue unchanged, no per-session worker factory).
- **migration:** none.
- **tests:** integration — the sweep reaps a stale viewer holder, resets a warming-death row, terminates at `refcount=0` past grace; a crashed-turn holder (activity confirmed dead) is reaped; the boot invariant `reaperPeriod < viewerHolderTTL < idleTimeout` rejects a misconfigured cadence.
- **acceptance:** the Schedule registers exactly once per deployment; the sweep is idempotent; provider `stop()` fires only past the drain grace at `refcount=0`.
- **flag:** `sandboxOwnershipEnabled`. **dependsOn:** P1.1, P1.2 **size:** M

#### **P1.4 — API-direct viewer attach + shared-sandbox MCP surface (resume-by-id, in-process)**
- **AUTONOMY:** **NEEDS-DECISION(I10/OD-S1, I13/OD-S5)** for the default-share scope + `{groupId}` affordance · NEEDS-CREDS(Modal) for the live viewer-attach
- **scope:** The first API-direct control-plane wiring (no desktop yet — this proves the seam). In `apps/api`: `attachViewer`/`detachViewer`/viewer-heartbeat handlers, all **in-process** — import `createSandboxClient`/`establishSandboxSessionFromEnvelope` from `@opengeni/runtime/sandbox`, call the `@opengeni/db` lease fns directly, run the cold→warming CAS as a Postgres txn the API owns, acquire a viewer holder, read/record `data_plane_url` under the epoch fence, return inline JSON. **No `signalWithStart`, no `SessionWorkflowClient.openStream`, no worker, no Temporal.** Plus the shared-sandbox create surface (addendum D): one optional `sandbox` field on `session_create` (`apps/api/src/mcp/server.ts:518`) + `CreateSessionRequest` (`contracts:1319`) — the three-way union `"shared"|"new"|{groupId}`; the server-side default rule (from-inside-a-session → `"shared"`, top-level → `"new"`); `createSessionForRequest` resolution (`sessions.ts:407`, one RLS-scoped parent read); `getAnySessionInGroup(db, workspaceId, groupId)` with **mandatory** `workspaceId` (stress e); thread `sandboxGroupId` + `inheritedBackend` into `createSession`/`createSessionWithIdempotencyKey`.
- **files:** `apps/api/src/index.ts` + sandbox-access wiring (NEW handlers); `apps/api/src/mcp/server.ts:518`; `apps/api/src/domain/sessions.ts:407`; `packages/contracts/src/index.ts:1319`; `packages/db/src/index.ts` (`:1967-2061` `sandboxGroupId` param + `getAnySessionInGroup`).
- **migration:** none (uses the `0018` group column).
- **tests:** integration — viewer attach API-direct mints + records `data_plane_url`, acquires a TTL-reapable viewer holder, warm-meter starts; **the control-plane thundering-herd check** (N concurrent API-direct handlers serializing on one `FOR UPDATE` row); shared spawn shares the creator's group (refcount fans in); cross-workspace `{groupId}` join returns 404 (the mandatory-`workspaceId` assertion, stress e); `"shared"` from top-level → 422.
- **acceptance:** a viewer holds a box with zero worker/Temporal involvement; the singleton-per-group invariant holds under the shared-spawn race (stress a — all of `INSERT…ON CONFLICT` + `FOR UPDATE` + UNIQUE on `(workspace_id, sandbox_group_id)`).
- **flag:** `sandboxOwnershipEnabled`. **dependsOn:** P1.2, P0.5 **size:** L

> **── PHASE-1 EXIT GATE ──** Before Phase 2 opens: the **double-spawn detector** must be live and green. Add an `owner.spawn`-count metric and assert it equals the count of distinct `(sandbox_group_id, lease_epoch)` spawn commits over a soak window (master-spine PART F; readiness E.131). New routes get updated metric label patterns or they bucket as `unknown`. A non-zero gap = a split-brain double-spawn = block.

---

### PHASE 2 — Warm-time billing
`flag: sandboxOwnershipEnabled (must exist before any viewer holds a box for cost)`

#### **P2.1 — Warm-meter accrual on the two stateless ticks + caps under the usage lock**
- **AUTONOMY:** FULL-AUTONOMY
- **scope:** No `ownerHeartbeat`. Warm-seconds accrue on **two** stateless ticks: the turn's existing 30s Temporal activity heartbeat (while a turn runs) and the reaper sweep (for viewer-only boxes between turns). Each tick refreshes `expires_at` epoch-keyed and accrues `sandbox.warm_seconds` idempotent on `(sandbox_group_id, epoch, tick)` via `recordUsageEvent(...).onConflictDoNothing` (the Critical meter key — one box = one warm-seconds stream regardless of N sessions; a session-keyed meter N×-over-bills, stress d·1). A stale-epoch writer fails the CAS and backs off. Warm-cap count takes `withWorkspaceUsageLock` (not a bare count); a 0-balance viewer-only box force-drains `AND turn_holders=0` (a paying turn is never killed), ending in the reaper `stop()` at `refcount=0`. Group-wide force-drain on workspace balance exhaustion (operationally flagged: one balance drains a multi-session box).
- **files:** `packages/db/src/index.ts` (warm-meter accrual fn + cap check under `withWorkspaceUsageLock`); `apps/worker/src/activities/agent-turn.ts` (accrue on the 30s heartbeat); `apps/worker/src/activities/sandbox-lease.ts` (accrue on the reaper tick); `packages/contracts/src/index.ts` (the `sandbox.warm_seconds` usage-event enum literal — code-only); `packages/config/src/index.ts` (keep-warm policy + cap settings, the warm-rate table per provider).
- **migration:** none (warm-time reuses `usage_events`; only enum literals change — no new table).
- **tests:** integration — N sessions on one shared box accrue **exactly one** warm-seconds stream (idempotency on the group key); a stale-epoch tick is a no-op; cap exhaustion force-drains a viewer-only box but never a turn-held box; the cap check holds the usage lock.
- **acceptance:** workspace billing is exact for shared boxes (charged once); a viewer-held idle box meters; a turn is never drained out from under the agent.
- **flag:** `sandboxOwnershipEnabled`. **dependsOn:** P1.3, P1.4 **size:** M

---

### PHASE 3 — Security control plane
`flag: per-route (rides sandboxOwnershipEnabled; stream-control input stays off)`

#### **P3.1 — Permissions + scoped token mint/verify + revocation reap**
- **AUTONOMY:** **NEEDS-DECISION(I8/OD-8)** for `delegationSecret`-absent-but-desktop-configured (rec: graceful degrade `DesktopStream.transport:null` + loud warning) · FULL-AUTONOMY otherwise
- **scope:** Append to `Permission` + `KNOWN_PERMISSIONS` mirror: `stream:view` (watch un-redacted pixels — a real, distinct permission, strictly broader than `sessions:read`), `stream:control` (never granted v1), `stream:acknowledge`, `files:write`, `terminal:attach`. The `StreamTokenPayload` HMAC envelope (`signDelegatedAccessToken`, prefix `ogs_`): claims `{workspaceId, sessionId, viewerId, leaseEpoch, mode:"view", port:6080, exp}`; minted + recorded against the holder from day one (so the later `--token-plugin TokenFile` hardening is a config swap); never appended as a URL query param. `verifyStreamToken` **implemented**. `delegationSecret`/`streamTokenSecret` required-when-desktop (graceful-degrade per I8). Revocation reap: a stateless `revokeViewer(viewerId)` activity (any worker, `x11vnc -disconnect`) that disconnects the **live** RFB session, not just blocks reconnect (OD-6/I6) + drops the holder from the group lease.
- **files:** `packages/contracts/src/index.ts` (`Permission` `:57`, mirror); `packages/runtime/src/sandbox/stream-token.ts` (NEW — `mintStreamToken`/`registerEdgeToken`/`revokeEdgeToken`/`buildStreamUrl`/`providerUrlTtl`, under `@opengeni/runtime/sandbox`); `apps/api/src/access/index.ts` (the `requireAccessGrant` mirror for the new perms); `apps/worker/src/activities/sandbox-lease.ts` (`revokeViewer` activity); `packages/config/src/index.ts` (`streamTokenSecret` required-when-desktop validation, `:986`).
- **migration:** none.
- **tests:** `verifyStreamToken` round-trip + epoch-mismatch rejection; revocation disconnects a live RFB session (not just token-file delete); `stream:view` is distinct from `sessions:read`; graceful-degrade when `delegationSecret` absent.
- **acceptance:** the token boundary is real and verifiable; a revoked viewer is disconnected live; desktop-without-secret degrades loudly, doesn't boot-fail.
- **flag:** per-route. **dependsOn:** P1.4 **size:** M

#### **P3.2 — `0021_session_stream_acknowledgments` + the API-direct handshake routes**
- **AUTONOMY:** **NEEDS-DECISION(I11/OD-S3)** for shared-viewer auth (rec: keep `stream:view` per-session + `acknowledgeShared` disclosure) · NEEDS-CREDS(Modal) for the live handshake
- **scope:** The ack table + the handshake. `0021_session_stream_acknowledgments` (the ack table). The routes — `/stream-capabilities` GET/POST/DELETE + `/heartbeat` + `/acknowledge` — all **API-direct handlers** in `apps/api` (resume-by-id in-process via `@opengeni/runtime/sandbox`; capability negotiation + viewer-holder acquisition + URL mint all inside the request handler's Postgres txn; no worker, no Temporal, no NATS req/reply). Un-redacted pixels → explicit acknowledgment mandatory before the URL is handed out. Shared disclosure (addendum E.1, stress g): `DesktopStream.{shared, sharedSessionIds}` (ids only, never B's conversation surface) + `acknowledgeShared` → **409 `shared_acknowledgment_required`** until acknowledged. Error-status rule: explicit `HTTPException(400,…)` on parse failure (not 422), `409` on epoch-fence/ack-required/cap-exceeded; raw `ZodError` → 500 is forbidden (every route parses explicitly). `requireAccessGrant` **before** any Zod parse.
- **files:** `packages/db/drizzle/0021_session_stream_acknowledgments.sql` (NEW); `_journal.json` + `0021_snapshot.json`; `packages/db/src/schema.ts` + `index.ts` (ack insert/read fns); `apps/api/src/routes/sessions.ts` (the handshake routes); `packages/runtime/src/sandbox/stream-control.ts` (NEW — `openStream` API-direct: resume-by-id + viewer-holder acquire + cold→warming CAS + `exposeStreamPort`; `OwnerFencedError`/`DisplayStackError`; epoch fence; **no `SandboxOwner` actor, no Temporal**); `packages/contracts/src/index.ts` (`DesktopStream.{shared,sharedSessionIds}`, `acknowledgeShared`).
- **migration:** **0021** (last in order).
- **tests:** integration — the full handshake resumes the box in-process, negotiates caps, mints a URL inside one txn; un-acknowledged un-redacted desktop → 409; `shared:true` → `409 shared_acknowledgment_required`; `sharedSessionIds` exposes ids only (a viewer of A cannot subscribe to B's `session_events`); 400/409 status rules; the redaction-asymmetry proof (SPIKE-3: a secret is in the un-redacted framebuffer but scrubbed in `sandbox.command.output.delta`).
- **acceptance:** the handshake is fully API-direct end-to-end; the acknowledgment gate is enforced; shared disclosure is consent-not-authz.
- **flag:** per-route. **dependsOn:** P3.1, P1.4 **size:** L

---

### PHASE 4 — Desktop image + pixel plane ⬅ THE HEADLINE (GA gate = SPIKE-1 fan-out)
`flag: sandboxDesktopEnabled (new config bool, default false)`

#### **P4.1 — Desktop image (CI → GHCR) + `ensureDisplayStack` (exec-launched, flock-idempotent)**
- **AUTONOMY:** **NEEDS-CREDS(Modal/runsc)** for the gVisor render + XTEST confirm (V2/SPIKE-2 already HELD — regression) · FULL-AUTONOMY for the image build
- **scope:** The canonical OpenGeni desktop OCI image: `docker/desktop.Dockerfile` (`Xvfb :0` → XFCE → real `google-chrome-stable`/`firefox-esr` — **not** the snap-stub `chromium-browser`; ffmpeg/tesseract/noto; `exposedPorts` includes 6080), built by CI to GHCR (extend `.github/workflows/release.yml`), referenced via `sandboxDesktopImageRef`. **`DEBIAN_FRONTEND=noninteractive` + `TZ=Etc/UTC` on every apt layer** (the carry-into-build finding from `07` — the full xfce4 tree pulls `tzdata` whose interactive debconf blocks the builder forever). `ensureDisplayStack` (`Xvfb→XFCE→x11vnc -viewonly→websockify:6080`, exec-launched under an in-box `flock`, **not** a container CMD — so it re-establishes after rollover; runnable by a worker on a turn OR the API on a viewer op). The down/record scripts. websockify backgrounded so `$!` is the listener PID; XFCE readiness is a probe.
- **files (new):** `docker/desktop.Dockerfile`; `docker/desktop/opengeni-desktop-up.sh`, `opengeni-desktop-down.sh`, `opengeni-record.sh`; `packages/runtime/src/sandbox/display-stack.ts` (`ensureDisplayStack`/`buildDisplayStackScript`/`STREAM_PORT`, under `@opengeni/runtime/sandbox`). **(edit):** `.github/workflows/release.yml`; `apps/worker/src/sandbox-resume.ts` (real `ensureDisplayStack` body); `packages/runtime/src/index.ts:763-795` (ensure 6080 in `exposedPorts` for desktop backends).
- **migration:** none.
- **tests:** image-build CI smoke (the stack comes up, `OPENGENI_DESKTOP_UP` printed); (gated) gVisor render + XTEST read-back on real Modal (SPIKE-2 regression); `ensureDisplayStack` idempotent under concurrent exec (flock).
- **acceptance:** the image builds + publishes to GHCR; the stack boots under gVisor; the agent's XTEST computer-use works under `-viewonly` (viewers can't write back, agent can — the V2 carry-into-build).
- **flag:** `sandboxDesktopEnabled`. **dependsOn:** P0.3 **size:** L

#### **P4.2 — Pixel plane: `exposeStreamPort` + URL mint/rotation (API-direct) + noVNC + rollover**
- **AUTONOMY:** **NEEDS-DECISION(I7/OD-7)** for provider preview-token rotation (rec: fold per-provider URL re-resolution into `resolveExposedPort`) · NEEDS-CREDS(provider) for live pixels
- **scope:** `exposeStreamPort` + URL mint/rotation served **API-direct** (the `/stream-capabilities` handler resumes the box by id and resolves the port in-process — no `sandboxOwnerRpcWorkflow`). Provider-specific `buildStreamUrl` per backend (modal/daytona/runloop/e2b/blaxel; cloudflare stub → headless). Rollover: on a box-death/24h-ceiling, whoever next touches the dead box (the API on a viewer op is the common case) re-establishes — snapshot → new box → `epoch++` → re-`ensureDisplayStack` → re-resolve + record the new URL under the fence → emit `stream.url.rotated` over SSE → client hot-swaps the noVNC socket (open-new-then-close-old). Provider preview-token re-resolution folded into `resolveExposedPort` (I7). The **one global reaper Schedule** also drives rollover-rotation (on a `lease_epoch` advance for a box with live viewer holders, `rotateStreamForHolder` per holder — the only Temporal touch-point for rotation). The 4 Channel-B event types (`stream.url.rotated`/`opened`/`closed`/`revoked`) + `desktop.geometry.changed`.
- **files:** `packages/runtime/src/sandbox/stream-control.ts` (rotation: `rotateStreamForHolder`/`publishStreamRotated`); `apps/api/src/routes/sessions.ts` (`/stream-capabilities` populates the desktop block); `apps/worker/src/activities/sandbox-lease.ts` (reaper drives rollover-rotation); `packages/contracts/src/index.ts` (the 5 event types + payloads); `apps/worker/src/sandbox-resume.ts` (`exposeStreamPort` real body).
- **migration:** none.
- **tests:** integration — viewer gets a tunnel URL API-direct, browser hits it direct (no API in the pixel path); rollover bumps the epoch, re-mints, emits `stream.url.rotated`, the dead URL is fenced; provider preview-token re-resolves with the URL.
- **acceptance:** pixels flow browser→provider-direct; rollover hot-swaps with a brief blink; the dead epoch's URL is rejected.
- **flag:** `sandboxDesktopEnabled`. **dependsOn:** P4.1, P3.2 **size:** L

#### **P4.3 — Computer-use capability + recording loop + `0019_session_recordings`**
- **AUTONOMY:** FULL-AUTONOMY · NEEDS-CREDS(Modal) for the live recording finalize
- **scope:** `SandboxComputer implements Computer` (xdotool/scrot through the externally-owned `session.exec`; screenshots via `readFile` of the scrot PNG, **not** banner-wrapped `execCommand`); `ComputerUseCapability` on `SandboxAgent`, pushed in `buildAgentCapabilities` when `computerUseEnabled && desktopCapableBackend`. The recording loop: `ffmpeg x11grab` on `:0` → mp4/webm → `@opengeni/storage` → `recording.available` event; byte transfer **inside the recording activity** (read + PUT in one invocation on whatever worker holds the box — never a 256 MB Temporal payload); finalize-across-rollover (E5 — flush-to-storage-before-rollover). `0019_session_recordings` table. The 3 recording event types + payloads. First-party MCP tools `opengeni__recording_start`/`_stop` for the "agent films itself proving the fix" UX.
- **files (new):** `packages/runtime/src/sandbox-computer.ts`; `apps/worker/src/activities/recording.ts` (or fold into `activities.ts` — `finalizeRecording`). **(edit):** `packages/runtime/src/index.ts:494` (`buildAgentCapabilities` + `desktopCapableBackend()`); `packages/db/drizzle/0019_session_recordings.sql` (NEW) + `_journal.json` + `0019_snapshot.json`; `packages/db/src/schema.ts` (~`:360`) + `index.ts` (`insertRecording`/`updateRecording`/`listRecordings`/`getRecording`); `apps/worker/src/activities/agent-turn.ts` (`on-turn`/`on-verify` lifecycle: start at trigger, stop+finalize in `finally` at `:855`); `apps/api/src/routes/sessions.ts` (recording routes); `packages/contracts/src/index.ts:1303` (event types + payloads + `Recording`/`ComputerUse` capability blocks); `packages/config/src/index.ts` (geometry/byte-cap settings).
- **migration:** **0019** (third in order).
- **tests:** computer-use action round-trip (xdotool move → readback); recording produces a valid mp4, finalizes via read+PUT in one activity, emits `recording.available`; finalize-before-rollover flushes; box-death → `recording.failed`; the upload-before-delete ordering (no delete before confirmed PUT — the F9 fix).
- **acceptance:** the agent drives the same `:0` humans watch; recordings land in storage and replay; no 256 MB Temporal payload.
- **flag:** `sandboxDesktopEnabled`. **dependsOn:** P4.2 **size:** L

#### **P4.4 — Channel-A structured services + `0020_sandbox_pty_sessions` (API-direct FS/Git/PTY)**
- **AUTONOMY:** **NEEDS-DECISION(I4 residuals a/b)** for FS-write concurrency (rec: last-writer-wins; apply-patch-fail → re-read→retry OR whole-file writes; pair `revision` with `lease_epoch` as `(epoch,revision)`) · FULL-AUTONOMY otherwise
- **scope:** The structured services over two transports. A1 (notifications): `fs.changed`/`git.changed`/`terminal.pty.*` ride the existing SSE event spine (worker emits → NATS → API-SSE → client; reuse `appendAndPublishEvents` verbatim). A2 (reads): the **API-direct** request/response path — `SandboxChannelAService` (`fsList/Read/Write/Delete/Search`, `gitStatus/Diff/Log/Show` → Pierre hunks via porcelain parsing, `ptyOpen/Write/Resize/Close`) operating on a resumed-by-id `{session, db, bus}` triple, called from the 13 routes in `apps/api` (each `requireAccessGrant` → Zod parse → cold→warming CAS/viewer-holder → in-process `sandbox.resume()` by id → service method → inline JSON; **no Temporal, no worker RPC, no NATS round-trip** — reads never ride the bus, which would corrupt SSE gap-fill). `sandbox_pty_sessions` table (the only new persistent state). Built on `session.execCommand` with banner-stripping (the SDK's `exec`/`listDir` shapes). `sandbox.command.output.delta` reused for the agent-command firehose (payload-widening preserves `name`).
- **files (new):** `packages/runtime/src/sandbox/channel-a.ts` (the `SandboxChannelAService`); `packages/db/drizzle/0020_sandbox_pty_sessions.sql` + `_journal.json` + `0020_snapshot.json`. **(edit):** `packages/contracts/src/index.ts` (`Permission` already has `files:write`/`terminal:attach` from P3.1; the 5 Channel-A event types `:1270` + payload schemas + A2 request/response schemas + `SessionStructuredCapabilities`; `ClientConfig.structuredServices`); `packages/db/src/schema.ts` + `index.ts` (`insertPtySession`/`closePtySession`/`listOpenPtySessions`/`reapIdlePtySessions`); `apps/api/src/routes/sessions.ts` (the 13 routes + extend `/stream-capabilities` with the `structured` block); `apps/worker/src/activities/agent-turn.ts` (emit `fs.changed{source:"agent"}` after FS-mutating tools); `apps/worker/src/activities/streaming.ts:8` (add `terminal.pty.output.delta` to the structural set).
- **migration:** **0020** (fourth in order).
- **tests:** integration — FS list/read/write API-direct (resume-by-id, inline JSON, never the bus); git status/diff → structured hunks; PTY open/write/resize/close with reattach; `fs.changed`/`git.changed` debounced + revisioned over SSE; concurrent FS writes race last-writer-wins (no turn-mutex); the `(epoch,revision)` cache-invalidation under an epoch reset.
- **acceptance:** Pierre tree + diff feeds are served fully API-direct; notifications ride the durable SSE spine; reads are synchronous and never sequence-corrupt the bus.
- **flag:** `sandboxDesktopEnabled` (FS/Git ride existing `files:read`; the services advertise via the negotiated descriptor). **dependsOn:** P3.2, P1.4 **size:** L

> **── PHASE-4 GA GATE ──** Desktop ships dark until the **fan-out load test (SPIKE-1/V4)** runs against real providers and `maxViewersPerSession` is frozen. R-A5 is MEASURED at ≈5 viewers/port on Modal direct (`07`); the GA cut sets `maxViewersPerSession=5` (enforced in `acquireLease(viewer)` → typed **429**) and gates >5 on a relay/SFU (a per-provider lever, not an architecture change). The load test also measures the control-plane thundering-herd (N API-direct handlers on one `FOR UPDATE` row). GA-cut only — does **not** gate the Phase-4 build.

---

### PHASE 5 — Client surfacing
`flag: gated on the negotiated descriptor (no separate flag; surfaces only what the deployment advertises)`

#### **P5.1 — SDK mirror (parity-pinned) + noVNC transport helper**
- **AUTONOMY:** FULL-AUTONOMY
- **scope:** Mirror every contracts addition into `packages/sdk`: `SESSION_EVENT_TYPES` (+ all new event types, same order — the parity test asserts sorted equality), `KNOWN_PERMISSIONS` (+ the new perms), `SessionCapabilities`/`StreamCapabilitiesResponse`/`NegotiateStreamRequest` types, the `ClientConfig.sandbox` block (`allowedBackends`, `desktopCapableBackends` = configured ∩ descriptor — **I14**, assigned here). New `OpenGeniClient` methods (`fs.*`, `git.*`, `terminal.*`, `session.capabilities()`, stream negotiate/heartbeat/acknowledge). A zero-dep noVNC transport helper (`packages/sdk/src/desktop.ts`).
- **files:** `packages/sdk/src/types.ts`, `client.ts`, `index.ts`, `desktop.ts` (NEW); `packages/sdk/test/contract-parity.test.ts`.
- **migration:** none.
- **tests:** the parity test (drives the mirror — fails until every type/event/permission is mirrored in order); client-method shape tests.
- **acceptance:** parity green; the SDK exposes the full capability-gated surface; `desktopCapableBackends` = configured ∩ descriptor.
- **flag:** descriptor-gated. **dependsOn:** P3.2, P4.2, P4.4 **size:** M

#### **P5.2 — React hooks + Pierre trees/diff + xterm + noVNC (capability-gated)**
- **AUTONOMY:** **NEEDS-DECISION(I15/OD-?)** for the warming-stall client contract (rec: single `expires_at` TTL + client poll deadline ~30s must agree with lease `warmingTtl`) · FULL-AUTONOMY otherwise
- **scope:** The last mile. React hooks (`useStreamCapabilities`, `useDesktopStream`, `useSandboxTerminal`, `useSandboxFiles`/`useSandboxGit`, `useSessionRecordings`) + components (Pierre file tree + diff, xterm terminal, noVNC `DesktopStream` — Channel-B direct). SSR lazy-import + hydration-placeholder convention; 409 (ack-required/epoch-fence) + 429 (cap-exceeded) handling; surface `stream.url.rotated` as a timeline notice + hot-swap the socket; the warming-stall poll deadline (I15). Web app consumes the hooks; a minimal 3rd-party SDK-consumer wiring example.
- **files:** `packages/react/src/hooks/*` (NEW hooks); `packages/react/src/DesktopStream.tsx`, `useDesktopStream.ts` (NEW); `packages/react/src/timeline.ts` (`:113`/`:163` new cases); `packages/react/src/index.ts` (exports); `packages/react/src/client.ts:8` (`SessionClientLike` extension); the web app's session view; the `ClientConfig.desktopStream.supported` populate site.
- **migration:** none.
- **tests:** hook unit tests (negotiate → connect → rotate → hot-swap); 409/429 handling; SSR lazy-import doesn't break hydration; the warming-stall deadline agrees with the lease TTL.
- **acceptance:** a customer watches the agent's live terminal + file tree + diff, and (where the descriptor allows) the desktop; rotation blinks; caps surface as a typed 429.
- **flag:** descriptor-gated. **dependsOn:** P5.1 **size:** L

---

## (B) MIGRATION ORDER + JOURNAL/SNAPSHOT NOTE

Forced order (master-spine PART F — **this supersedes** the crosscut module's older `0018_session_stream_acknowledgments` numbering; the ack table is renumbered to `0021`):

```
0017_sandbox_leases.sql                  (P1.1) sandbox_leases + sandbox_lease_holders, GROUP-keyed from the start
                                                + RLS/GRANT + the SECURITY-DEFINER reaper sweep fn
0018_sandbox_os.sql                      (P0.5) sessions.sandbox_os + session_turns.sandbox_os (+ CHECKs)
                                                + sessions.sandbox_group_id (add/backfill=id/NOT NULL/index)
0019_session_recordings.sql              (P4.3) session_recordings
0020_sandbox_pty_sessions.sql            (P4.4) sandbox_pty_sessions
0021_session_stream_acknowledgments.sql  (P3.2) session_stream_acknowledgments
```

All in `packages/db/drizzle/` (the `packages/db/migrations/` path several module specs reference **does not exist** — the real dir is `drizzle/`, latest shipped is `0016_session_create_idempotency.sql`).

**Build vs. migration-number ordering note.** The migration *numbers* are forced by the canonical sequence, but PRs land in *build-dependency* order — so `0018` (P0.5, Phase 0) authors its file before `0017` (P1.1, Phase 1) authors its file, even though `0017` sorts first. This is fine: drizzle applies by number at deploy time, not author time, and each migration is independently forward-only and additive. The DB is migrated **before** workers, then API, then web (expand-then-use; new routes 404 harmlessly until the API ships).

**Journal/snapshot hand-append (the load-bearing gotcha).** `drizzle-kit generate` emits the plain `CREATE TABLE`/`ALTER` but will **NOT** emit: (a) the hand-authored RLS `ENABLE/FORCE ROW LEVEL SECURITY` + `workspace_isolation` policy + `opengeni_app` GRANT blocks, (b) the SECURITY-DEFINER reaper sweep function (`0017`), or (c) the data backfills (`0018`'s `UPDATE sessions SET sandbox_group_id = id` and the `os` default). For every migration that includes (a)/(b)/(c), the `_journal.json` entry **and** the `<n>_snapshot.json` must be **manually appended/edited** to match the actual applied DDL, or drizzle's drift detection will fight the next `generate`. Copy the RLS boilerplate verbatim from `0005`/`0007`. The `sandbox_group_id` value is generated in app code (it cannot SQL-default to `id`, which is `defaultRandom()` and unknown at default-eval time) — the same uuid is used for both `id` and `sandbox_group_id` in one insert.

---

## (C) HUMAN GATES

### C.1 Review + merge (every PR)
Every PR in (A) is opened against `main` and requires **your review + merge** — this is the one gate on all 22 PRs and is not autonomous. The autonomous loop (D) takes each PR to green-and-self-reviewed, then stops at the open PR; merge is yours.

### C.2 Batched product DECISIONS (rule these before the dependent PR opens)
The architecture forks (I1/I2/I3) are already RULED (API-direct + the one reaper Schedule). What remains are **product/policy** rulings. Each has my recommended default — ratify or override; none require a spike:

| ID | Decision | Recommended default | Blocks PR |
|---|---|---|---|
| **I8 / OD-8** | `delegationSecret`/`streamTokenSecret` absent but desktop configured | **Graceful degrade** → `DesktopStream.transport:null` + a loud boot warning (not a hard boot-fail) | P3.1 |
| **I10 / OD-S1** | Default-share scope | **(a)** default `"shared"` only on MCP spawn **from inside a session**; top-level/API creates stay `"new"`; explicit `"shared"`/`{groupId}` always available | P1.4 |
| **I11 / OD-S3** | Viewer auth under sharing | **(a)** keep `stream:view` **per-session** + a shared-exposure disclosure/`acknowledgeShared` (409) — consent, not a new group-scoped grant (you can't redact one agent from a shared `:0`) | P3.2 |
| **I13 / OD-S5** | `{groupId}` explicit-join affordance in v1 | **(a)** ship the three-way union incl. `{groupId}` — costs nothing (a uuid), is the only way to express manager sibling fan-out, fully workspace-scoped by the mandatory-`workspaceId` `getAnySessionInGroup` | P1.4 |
| **I7 / OD-7** | Provider preview-token rotation | Fold per-provider URL re-resolution (the **provider** preview token, own TTL) into the `resolveExposedPort` re-resolve, recorded under the epoch fence | P4.2 |
| **I4 (a/b)** | FS-write concurrency residuals | **Last-writer-wins** (policy already settled); apply-patch-diff-fail → re-read→retry OR whole-file writes; pair `revision` with `lease_epoch` as `(epoch, revision)` for cache-invalidation under epoch resets | P4.4 |
| **I15** | Warming-stall client contract | Single `expires_at` TTL; the client poll deadline (~30s) must agree with the lease `warmingTtl` | P5.2 |
| **I12 / OD-S4** | Shared-box cost **attribution** (correctness already settled — workspace charged once) | **(a)** show cost owner = founder, with optional per-holder-session apportionment from `holders.session_id` for **visibility only** — never a second charge | P2.1 (reporting only; not GA-gating) |

Also note the **ownership assignment** ruling: **I14** (the `workspaceRoot`/`nativeBucketMount` descriptor-consumer contract + the `ClientConfig.sandbox` shape, `desktopCapableBackends` = configured ∩ descriptor) was unowned across modules — it is **assigned to P0.3/P0.4 (descriptor consumers) + P5.1 (the `ClientConfig` shape)**. No decision needed; just flagged so it isn't dropped.

### C.3 Fresh CREDS (expect ~none beyond Modal)
The credentialed live-fire already ran against real Modal (`07`: R-A1..R-A4 HELD, R-A5 bounded). The only credential the autonomous build needs is **Modal** (already in `~/.modal.toml [opengeni]`), used for: the P0.4 API-direct resume smoke, the P1.2 keystone re-confirm, the P1.4/P3.2 live viewer-attach/handshake, the P4.1 gVisor regression, and the P4.2/P4.3 live pixels+recording. **No new credentials are expected.** Two **optional** GA-cut extras (not build-gating): a second desktop provider (**Daytona or Runloop**) to widen the SPIKE-1 fan-out measurement beyond Modal, and `runsc` access if the gVisor regression is run outside Modal. If you want the fan-out number on a second provider, drop one of those creds; otherwise Modal-only is sufficient to ship.

---

## (D) AUTONOMOUS EXECUTION PROTOCOL

The build runs as a sequence of per-PR autonomous cycles, ordered by `dependsOn`. Within a phase, PRs with no mutual dependency may run in parallel worktrees; across phases the flag boundary + the exit gates serialize.

### D.1 Per-PR worktree cycle
For each PR `Px.y`, in `dependsOn` order:

1. **Branch + worktree.** Cut a worktree off `main` (or off the dependency PR's branch if it isn't merged yet), named `sandbox/Px.y-<slug>`. Never commit to `main` directly.
2. **Code + tests together.** Implement the scope against the real paths in (A). Author the tests in the same PR (the parity tests and the lease tests are written-to-fail-first where they drive a mirror).
3. **Iterate-until-green.** Loop: `bun install` → `bun run build` (or per-package `tsc --noEmit`) → `bun test` (the PR's tests + the affected package's existing suite). Fix until clean. For migration PRs, additionally apply the migration against a throwaway postgres and assert apply+rollback. For Modal-gated tests, run the gated harness when creds are present; otherwise mark it `skip` with a `NEEDS-CREDS` annotation and proceed (the gated test is not a merge blocker for the non-gated scope).
4. **Adversarial self-review.** Before opening the PR, run an adversarial pass over the diff: re-check the load-bearing invariants for that PR (e.g. for P1.1: plain `FOR UPDATE` not skip-locked, all three keys `(workspace_id, sandbox_group_id)`, the heartbeat-path epoch fence, the meter idempotency key; for any API route: `requireAccessGrant` before Zod parse, explicit `HTTPException(400/409)` not raw `ZodError`→500; for P0.2: the leaf has zero agent-loop imports). Fix findings; re-run step 3.
5. **Open PR.** Title + scope + acceptance from (A); link `dependsOn`; tag the flag and the AUTONOMY level; note any `NEEDS-DECISION` that was ratified (with the chosen value) or any gated test left skipped. Stop. **Merge is the human gate (C.1).**

### D.2 Sequencing + flags
- **Phase 0** (P0.1→P0.2→P0.3→P0.4, P0.5 parallel after P0.1) ships behind **no flag** — pure refactor + additive contracts/columns; safe on `main` immediately.
- **Phase 1** (P1.1→P1.2→P1.3, P1.4 after P1.2) ships behind **`sandboxOwnershipEnabled=false`** — dark until flipped per-environment after staging soak. `RunAgentStreamOptions` injection means `false` is byte-for-byte today's build-and-discard path; cutover is reversible per environment.
- **Phase 2** rides `sandboxOwnershipEnabled` (must exist before any viewer holds a box for cost).
- **Phase 3** is per-route, riding `sandboxOwnershipEnabled`; `stream:control` (input) stays off (`streamControlEnabled=false`).
- **Phase 4** ships behind **`sandboxDesktopEnabled=false`** — the desktop headline lands dark, GA-gated on the fan-out load test.
- **Phase 5** is descriptor-gated — it surfaces only what the deployment advertises; no separate flag.

### D.3 The exit gates (hard serialization points)
- **Phase-1 exit gate (the double-spawn detector).** Phase 2 does **not** open until the `owner.spawn`-count-vs-distinct-`(sandbox_group_id, lease_epoch)` metric is live and reads **zero gap** over a soak window. A non-zero gap is a split-brain double-spawn and **blocks** — fix the lease before metering rides on top of it. New routes must carry updated metric label patterns or they bucket as `unknown` (a silent metric hole that would hide the gap).
- **Phase-4 GA gate (the fan-out load test).** The desktop flag flips to GA only after SPIKE-1/V4 runs against real providers and `maxViewersPerSession` is frozen (≈5 on Modal direct, relay/SFU for more — enforced in `acquireLease(viewer)` → typed 429). This gates the **GA cut**, not the Phase-4 build — P4.1–P4.4 land dark behind `sandboxDesktopEnabled` regardless.
- **Disable-path safety (OD-9/I9).** The `sandboxOwnershipEnabled` rollback is reversible but leaves orphaned `warm`/`draining` lease rows + live boxes; the disable path must trigger a drain-on-disable sweep (the reaper's `stop()`-at-refcount-0 applied across all rows on flip). Verify this in the P1.3 tests (no owner processes to reconcile — the reaper is the sole driver).

---

## Net

Six phases, 22 PRs, one forced migration order. **Start with the FULL-AUTONOMY foundation:** P0.2 (extract `@opengeni/runtime/sandbox` — the agent-loop-free leaf that unblocks the entire API-direct control plane), then P1.1 (the `0017` lease, group-keyed, integer epoch, RLS + SECURITY-DEFINER reaper, the three Criticals together), then P1.2/P1.4 (stateless resume-by-id + the API-direct resume-by-id viewer wiring). Temporal does exactly two things (the turn, the one reaper Schedule); every non-turn op is `client → API → box`, in-process. The architecture is proven where it's load-bearing (R-A1..R-A4 HELD on real Modal) and decided where it forks (I1/I2/I3 RULED) — the remaining human input is review+merge on every PR, eight batched product DECISIONS (all with recommended defaults above), and the one credential we already have (Modal).

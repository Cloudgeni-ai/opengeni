<!-- docs-refs: record -->

> **Point-in-time design record.** Written against the tree at authoring time; paths and names may have moved. Code wins.

# MASTER SPINE — OpenGeni Multi-Provider, Headless + Desktop, OS-Selectable Sandbox Surfacing

**For:** Jørgen (lead engineer) · **Status:** top-level design of record · **Date:** 2026-06-19
**Companions:** 10 module specs (lease, owner, providers, desktop-image, computer-use, os, channel-a, channel-b, client, crosscut) + the integration spec (canonical interfaces + the 20-conflict ledger) + the completeness critique (44 gaps). This spine ties them together, defines the shared interfaces **once**, and is the single page you read first. It does not re-inline module detail; it points.

---

## PART A — EXECUTIVE SUMMARY + THE SHAPE

### A.0 The shape in five sentences

OpenGeni today builds a fresh provider sandbox client **per agent run** and throws it away; we are inverting that so a session owns **exactly one** long-lived sandbox, governed by a Postgres lease, served by a **stateless worker pool** (any worker resumes the one box by id per turn, injects it non-owned, drops the handle at turn end), and multiplexed across all turns **and** all human viewers. That sandbox is reachable two ways: **Channel A** — structured services (FileSystem, Terminal-as-events, Git) where durable broadcast notifications ride the existing SSE event spine and every read/diff/negotiation is served **API-direct** (the API process resumes the box by id in-process and returns inline JSON — no worker, no Temporal in the read path); and **Channel B** — raw desktop pixels (noVNC) over a short-TTL provider tunnel the browser hits **directly**, never through our API. Any of 10 backends can host it, any of 3 OSes can be selected (only Linux is reachable in v1), and a static `CapabilityDescriptor` per backend says truthfully what each can surface, so the client negotiates a `SessionCapabilities` document and degrades **as a value, never silently**. The singleton is enforced by one row (`UNIQUE(workspace_id, session_id)` + `FOR UPDATE` + a `cold→warming` CAS + a `lease_epoch` fence), and every death (box rollover, worker loss) is recovered by **one** primitive: re-establish-from-envelope-under-CAS by whoever next touches the dead box (any worker on a turn, or the API on a viewer op). **Temporal is used for exactly two things: the long-running agent turn, and one global reaper Schedule** — nothing else. The desktop is the headline and it lands **last**, on a foundation of lease + ownership-inversion + warm-time billing + a security control plane, gated for GA on an empirical fan-out load test.

### A.1 Why this exists (the vision in one paragraph)

The agent and the human should look at the **same** running machine. A customer watches the agent fix their infra in a live terminal and file tree (Pierre trees + diff UI), and — when the work is visual — watches its actual desktop, or replays a recording where the agent **filmed itself proving the fix**. This is SDK-generic: any client (our web app, a 3rd-party SDK consumer) negotiates capabilities and connects. It is multi-provider because no single sandbox vendor wins on price × lifetime × desktop-support × OS, so OpenGeni owns the abstraction over all of them.

### A.2 What changes vs. today (the delta table)

| Dimension | Today | After this work |
|---|---|---|
| Sandbox lifetime | per-run, build-and-discard | per-session singleton, multi-day, multi-holder |
| Who holds the client | each `runAgentStream` invocation | a **stateless worker pool**; any worker resumes-by-id per turn and drops the handle (non-owned injection) |
| Singleton guarantee | none (runs don't overlap by luck) | lease row: `UNIQUE` + `FOR UPDATE` + CAS + epoch fence |
| Surfaces | agent-only; command output already streams | FileSystem, Terminal (events + PTY), Git, **Desktop pixels**, **Recording** |
| OS | implicit Linux | first-class `linux\|macos\|windows` dimension (Linux reachable v1) |
| Backends | the configured one | 10, with a truthful capability descriptor each |
| Billing | model tokens per turn | model tokens **+** warm-box seconds (viewer-held boxes meter) |
| Recovery | restart the run | one re-establish-from-envelope-under-CAS primitive |

---

## PART B — INTEGRATED ARCHITECTURE NARRATIVE

### B.1 The five layers (the mental model)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ L1  Postgres: sandbox_leases (1/session) + sandbox_lease_holders (N/session)    │  SOLE singleton enforcer
│       UNIQUE(workspace_id, session_id) · FOR UPDATE · cold→warming CAS · lease_epoch fence
└──────▲────────────────────────────────────────────────────────▲─────────────────┘
       │ acquire / release / heartbeat / drain / re-arm (turn)   │ acquire viewer-holder /
       │                                                          │ re-arm / mint URL / FS+Git reads (CONTROL PLANE)
┌──────┴───────────────────────────────────────┐  ┌──────────────┴───────────────────────────┐
│ L2  apps/worker  Stateless pool (TURNS ONLY): │  │ L2′ apps/api  CONTROL PLANE = API-DIRECT: │
│   per turn, ANY worker resumes-by-id from the │  │   for EVERY non-turn op (viewer attach,    │
│   group envelope → injects RunConfig.sandbox  │  │   mint/rotate desktop URL, FS list/read,   │
│   .session (non-owned) → runs → drops handle. │  │   Git status/diff, capability negotiation) │
│   refcount over the lease is the liveness.    │  │   the API itself resume()s the box by id   │
│   reestablishFromEnvelope ← the ONE recovery  │  │   IN-PROCESS (no worker, no Temporal, no   │
│   primitive (any worker, OR the API on a      │  │   NATS req/reply), runs the cold→warming   │
│   viewer op). ensureDisplayStack/exposeStream │  │   CAS as a Postgres txn it owns, and       │
│   Port idempotent (worker OR api).            │  │   returns inline JSON. client → API → box. │
└──────▲────────────────────────────────────────┘  └──────────────▲────────────────────────────┘
       │ emit → NATS (EVENTS ONLY)                                 │ client HTTP (sync)
┌──────┴──────────────────────────────────────────┐               │
│ L4 Channel A: SSE event spine                    │   ┌───────────┴────────────────────────────────┐
│   appendAndPublishEvents (verbatim) — worker →   │   │ Both L2 and L2′ import the SAME shared module │
│   NATS → API-SSE → client. NOTIFICATIONS ONLY    │   │ @opengeni/runtime/sandbox (createSandboxClient│
│   (fs.changed, git.changed, stream.url.rotated). │   │ + envelope (de)serialize) — NO agent-loop dep │
└──────────────────────────────────────────────────┘   └─────────────────────────────────────────────┘
                                                    L5 Channel B: browser ─wss→ provider tunnel
                                                       (noVNC pixels, DIRECT, never via API/worker)
```

**Temporal (durable orchestration) is used for EXACTLY TWO things:** (1) the long-running agent **turn** (the existing `sessionWorkflow`), and (2) **one global reaper** as a Temporal **Schedule** (the periodic sweep — see §B.2). Nothing else routes through Temporal. There is **no `sandboxOwnerRpcWorkflow`, no per-session/per-RPC workflow, no per-session queue, no NATS request/reply.** NATS carries **events only** (worker → NATS → API-SSE → client). Every synchronous non-turn op is **API-direct**: the API process owns Postgres already, already makes outbound HTTPS (Stripe/OpenAI/GitHub), and (after the enabling refactor in §B.2) imports the thin shared sandbox module so it can `resume()` a box by id without pulling in the `@openai/agents` agent-loop graph.

### B.2 Lease + stateless resume — the singleton

The Postgres **lease row** (`@opengeni/db`) is the **only** thing that makes the singleton true. There is **no in-worker `SandboxOwner` actor, no `Map<id, SandboxOwner>`, no per-session/per-group Temporal task queue, no per-session/per-live-box worker, and no server-side poller-stream scaling concern.** Workers are a **stateless pool, exactly as today.** On **each turn**, *any* worker resolves the group lease, **`resume()`s the box by id** from the group envelope (warm reattach if the box is still alive, else cold-restore from snapshot — the same resume-or-create-on-NotFound path as today), **injects it as `RunConfig.sandbox.session` (non-owned — the SDK never reaps it, proven by the `sdk-keystone` spike)**, runs the agent, lets the SDK serialize the updated envelope at turn end, and then **drops the in-memory handle when the turn returns.**

A holder is either a **turn** (an agent segment; TTL-exempt — a paying turn is never reaped) or a **viewer** (a human watching; TTL-reapable in ~90s). `refcount = COUNT(holders)`, recomputed from the holder table on every mutation — never `prev+1` (that desyncs; see ledger CR7) — and the refcount is the **only** liveness signal, unchanged. When `refcount` hits 0 the box goes `warm→draining` with a short drain grace, then the **one global reaper (a Temporal Schedule, see below) issues the provider's existing `stop()`/terminate** for a prompt cost-stop; it is **not** torn down inline. Between turns the box survives on the **provider's existing idle-timeout** (`modalTimeoutSeconds`, `config/src/index.ts:241`) — there is **no keepalive polling loop and no `ownerHeartbeat`**; the provider idle-timeout is the backstop for a leaked/missed box. Turn TTL is refreshed by the turn's existing 30s Temporal activity heartbeat (turns are still activities — unchanged); viewer TTL is refreshed by app-level viewer heartbeats hitting the API directly.

**The reaper is one global Temporal Schedule.** A single periodic sweep (a Temporal `Schedule`, reusing the existing `temporalScheduleOptions` pattern, running in the worker because the worker carries the runtime) does all of the liveness GC in one pass: TTL-reap stale viewer holders, reset warming-death rows back to `cold`, and at `refcount=0` (past the drain grace) terminate the box. It is the **sole** GC/cost-stop driver now that `ownerHeartbeat` is deleted. It is **not** a per-session timer and **not** a per-RPC workflow — exactly one Schedule for the whole deployment.

The `lease_epoch` (an `integer`, bumped exactly once per successful spawn/rollover commit) is the **fence**: a stale writer (e.g. a re-dispatched turn from a dead worker) that tries to heartbeat or expose a port with a stale epoch fails the CAS and backs off. This is what defeats split-brain after a worker partition. Viewers connect **directly** to the tunnel URL stored in the lease (`data_plane_url`); minting/rotating it is a `resolveExposedPort` call the **API process makes in-process on the viewer-attach request** — it resumes the box by id, resolves the port, and records the URL in the lease under the epoch fence, then returns it inline. No persistent owner, no worker, no Temporal in that path.

**The enabling refactor (so the API can resume a box in-process).** Today `createSandboxClient` + the envelope (de)serializers live inside `packages/runtime` alongside the `@openai/agents` agent-loop import graph; `apps/api` cannot import them without dragging in that graph. We extract a **thin shared module** — `@opengeni/runtime/sandbox` — containing `createSandboxClient` + `deserializeSandboxSessionStateEnvelope` + `restoredSandboxSessionStateFromEntry` + `sandboxStateEntryFromRunState`, with **zero coupling** to the agent-loop / model-provider / Temporal code (verified: `packages/runtime` has no `@temporalio` dep, and these functions don't touch it). `apps/api` adds the dep to its `package.json` and imports that module only. The Modal token is already parsed by the shared `getSettings` (`packages/config`); it is plumbed into the API's Modal-client construction, and the API's egress is confirmed to reach `api.modal.com`. `ModalSandboxClient.resume()` is already **per-call** (no pool, no singleton handle), so the API resuming a box per request is the same access pattern the worker uses per turn — nothing new is invented.

**Concurrency:** multiple sessions sharing one box run turns **concurrently** — no serialization, no turn-mutex, no FIFO queue, no "one active turn per box." Two+ agent loops edit one filesystem/desktop live; conflicts are **last-writer / OS-implicit** (the standing no-explicit-conflict ruling), the same model as a single agent's concurrent tool-calls. "This is how all other agent harnesses work." The `lease_epoch` fence + last-writer-wins govern any envelope-serialization race; FS writes are **not** serialized.

### B.3 Channel A vs Channel B — the two planes

| | **Channel A — structured** | **Channel B — pixels** |
|---|---|---|
| Carries | FileSystem, Terminal (events + PTY), Git | desktop framebuffer only |
| Transport | **two halves**: (notifications) SSE event spine, durable/sequenced/gap-filled; (reads) **API-direct** request/response — the API resumes the box by id in-process and returns inline JSON | direct browser→provider tunnel (noVNC over wss) |
| Path | reads + negotiation: client → API → box (no worker, no Temporal). Notifications: worker emits → NATS → API-SSE → client | **bypasses** OpenGeni entirely after URL handoff |
| Auth | per-read on the access grant; `files:read`/`files:write`/`terminal:attach` | short-TTL provider tunnel URL handed only to an acknowledged `stream:view` viewer |
| Redaction | **redacted** (secrets scrubbed in `sandbox.command.output.delta`) | **un-redacted** (literal pixels) → requires an explicit acknowledgment |
| Durability | notifications durable + replayable; reads are synchronous (not durable, by design) | ephemeral; only `stream.url.rotated` rides Channel A |

The load-bearing rule: **request/response results never ride the event bus.** `SessionEvent.sequence` is DB-assigned and required; a sequence-less bus reply corrupts SSE gap-fill. FS reads, Git diffs, and the capability negotiation are served **API-direct** — the API process resumes the box by id and returns inline JSON synchronously; they do **not** route through a worker, a Temporal workflow, or a NATS request/reply. The bus (NATS) carries **only** durable broadcast notifications (`fs.changed`, `git.changed`, `stream.url.rotated`, `recording.*`).

### B.4 Provider registry — what each backend can do

`createSandboxClient` (the factory) + a static `CAPABILITY_DESCRIPTORS` table (hosted in `@opengeni/contracts`, **not** runtime — this breaks the config↔runtime import cycle, ledger CR8). The descriptor is pure data: tier (`desktop`/`headless`/`dev`/`none`), OS support, per-capability availability + transport, lifetime ceilings (Modal 24h, Vercel 5h), snapshot kind, port-exposure mechanism, `nativeBucketMount`, `supportsRunAs`. Everything downstream (config boot-validation, OS image selection, capability negotiation, the env/mount branch) reads **data**, never a hard-coded backend name.

### B.5 OS dimension — Linux now, mac/win seam

The SDK has **no** OS concept. OS is an OpenGeni-owned axis on `CreateSessionRequest` that maps down to `(backend, image/template)` at create-time and to the computer-use `Environment` hint at tool-bind-time. It is **session-immutable once warm** (dropped from `session_turns`; ledger CR18). v1 ships only the Linux rows for the 10 real backends; the mac/win/scrapybara/orka rows are commented seam placeholders.

### B.6 End-to-end flows (the four canonical paths — summarized; full step lists in the integration spec Part D)

| Flow | Trigger | Path | Key invariant exercised |
|---|---|---|---|
| **(a) cold start** | a turn dispatches | turn activity (any worker, existing dispatch) → CAS `cold→warming` → `createSandboxClient` (6080 merged into exposed ports) → `ensureDisplayStack` → CAS `→warm` + `epoch++`; no per-session worker, no per-session queue | exactly-one spawner under the held row lock |
| **(b) viewer connects to idle box** | browser POST `/stream-capabilities` | **client → API → box, all in-process**: API acknowledges → opens a Postgres txn → acquires the viewer holder → re-arms `draining→warm` (or runs the `cold→warming` CAS + resumes/spawns the box by id itself) → `resolveExposedPort(6080)` mints the tunnel URL, records it under the epoch fence → returns it inline → browser noVNC **direct**. No worker, no Temporal, no NATS req/reply. | viewer holder is TTL-reapable; warm-meter starts; API owns the CAS txn |
| **(c) viewer opens desktop mid-turn** | browser POST during a live turn | **client → API → box**: API resumes the live box by id (lock-free, R4), attaches on the **same** `:0`, acquires a viewer holder, **no** epoch bump → both meters run (tokens + warm-seconds), zero double-count → returns URL inline | `-viewonly` VNC: agent drives, viewer watches the same `:0`; lock-free reattach |
| **(d) Modal 24h rollover** | lifetime-ceiling timer | whoever next touches the dead box (a turn on a worker, OR the API on a viewer op) re-establishes: snapshot → new box from snapshot → `epoch++` → re-`ensureDisplayStack` → re-mint per viewer (API re-resolves on the next viewer request) → `stream.url.rotated` over SSE → client hot-swaps socket | the ONE recovery primitive; epoch fences the dead URL |

---

## PART C — CANONICAL SHARED INTERFACES (defined ONCE)

These are declared exactly once and consumed everywhere. They are reproduced verbatim from the integration spec (which already reconciled all module divergences); the spine restates them so there is a single authoritative copy. Where a module's own spec disagrees, **this wins.**

### C.1 The capability set + the descriptor (in `@opengeni/contracts`)

```ts
// packages/contracts/src/index.ts
export const SandboxCapabilityName = z.enum([
  "FileSystem",     // Channel A: list/read/write/search (Pierre tree)
  "Terminal",       // Channel A: command-output firehose (+ future pty-ws)
  "Git",            // Channel A: status/diff/log/show (Pierre diff)
  "DesktopStream",  // Channel B: noVNC pixels over a scoped tunnel URL
  "Recording",      // ffmpeg x11grab → object storage
]);
export type SandboxCapabilityName = z.infer<typeof SandboxCapabilityName>;

export const SandboxBackend = z.enum([   // 10 values; 3-way parity (contracts/sdk/deployment)
  "docker","modal","local","none",
  "daytona","runloop","e2b","blaxel","cloudflare","vercel",
]);
export const SandboxOs = z.enum(["linux","macos","windows"]); // only "linux" reachable v1

// Static per-backend metadata. Lives in contracts (NOT runtime) to break config↔runtime cycle.
export type CapabilityDescriptor = {
  backend: SandboxBackend;
  backendId: string;                 // asserted === SDK client.backendId at registry build
  tier: "desktop" | "headless" | "dev" | "none";
  os: { supported: SandboxOs[]; default: SandboxOs };
  capabilities: {
    FileSystem:    { available: boolean; readOnly: boolean };
    Terminal:      { available: boolean; transport: "sse-events" | "pty-ws" | null; pty: boolean };
    Git:           { available: boolean };
    DesktopStream: { available: boolean; transport: "vnc-ws" | "rdp-ws" | "webrtc" | null };
    Recording:     { available: boolean };  // feasibility only (== DesktopStream && os==linux); NOT a request
  };
  lifetime: {
    hardLifetimeMs?: number;          // modal 24h, vercel 5h
    requiresSnapshotRollover: boolean;
    hasIdleKiller: boolean;
    supportsSuspendResume: boolean;   // runloop/e2b/vercel/modal true
    resumeIsLockFree: boolean;        // modal true (fromId, no lock)
    idleKillDisableHint?: string;
  };
  snapshot: { kind: "native-fs" | "native-dir" | "native-snapshot-id" | "tar-only" | "none"; hasTarFallback: boolean };
  portExposure: { kind: PortExposureKind; supportsOnDemandPorts: boolean }; // runloop=false; blaxel only true
  workspaceRoot: string;             // os-overridable; per-backend default (providers owns; os defers)
  nativeBucketMount: boolean;        // modal true → mount/signed-download branch
  persistable: boolean;
  supportsRunAs: boolean;
};
export const CAPABILITY_DESCRIPTORS: Record<SandboxBackend, CapabilityDescriptor> = { /* 10 rows; matrix in Part D */ };
```

### C.2 The lease row + holders (in `@opengeni/db`, migration `0017`)

```sql
-- packages/db/drizzle/0017_sandbox_leases.sql   (drizzle-kit generate; journal+snapshot REQUIRED)
CREATE TABLE sandbox_leases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,  -- REQUIRED for RLS
  workspace_id     uuid NOT NULL REFERENCES workspaces(id)       ON DELETE CASCADE,
  session_id       uuid NOT NULL REFERENCES sessions(id)         ON DELETE CASCADE,
  liveness         text NOT NULL DEFAULT 'cold'
                     CHECK (liveness IN ('cold','warming','warm','draining')),
  refcount         integer NOT NULL DEFAULT 0 CHECK (refcount >= 0),
  turn_holders     integer NOT NULL DEFAULT 0 CHECK (turn_holders >= 0),    -- TTL-EXEMPT
  viewer_holders   integer NOT NULL DEFAULT 0 CHECK (viewer_holders >= 0),  -- TTL-reapable
  instance_id      text,
  backend          text NOT NULL,            -- canonical name; pins resume provider
  os               text NOT NULL DEFAULT 'linux',  -- pins resume image
  data_plane_url   text,                      -- current Channel-B scoped URL; any worker re-resolves + records it under the epoch fence
  lease_epoch      integer NOT NULL DEFAULT 0,     -- THE FENCE. integer (not bigint → no string-compare bug)
  last_meter_at    timestamptz,              -- warm-time accrual cursor
  last_meter_tick  integer NOT NULL DEFAULT 0,
  expires_at       timestamptz NOT NULL,      -- SINGLE TTL (warming-death == lapse; no warming_expires_at)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sandbox_leases_session_uq UNIQUE (workspace_id, session_id)  -- THE singleton hardware
);
CREATE INDEX sandbox_leases_reaper_idx ON sandbox_leases (expires_at)
  WHERE liveness IN ('warming','warm','draining');

CREATE TABLE sandbox_lease_holders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,  -- REQUIRED
  workspace_id      uuid NOT NULL REFERENCES workspaces(id)       ON DELETE CASCADE,
  lease_id          uuid NOT NULL REFERENCES sandbox_leases(id)   ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('turn','viewer')),
  holder_id         text NOT NULL,            -- turn: activityId; viewer: viewerId
  subject_id        text,                     -- for revocation reap
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sandbox_lease_holders_uq UNIQUE (lease_id, kind, holder_id)
);
CREATE INDEX sandbox_lease_holders_stale_idx ON sandbox_lease_holders (kind, last_heartbeat_at);
CREATE INDEX sandbox_lease_holders_lease_idx ON sandbox_lease_holders (lease_id);
-- + ENABLE/FORCE ROW LEVEL SECURITY + workspace_isolation policy + opengeni_app GRANT on BOTH tables
--   (verbatim 0007 boilerplate). + the SECURITY DEFINER cross-workspace sweep fn (see Part G OD-3).
```

**Acquire critical section (the precedent + the deviation):** the existing `claimNextQueuedTurn` (`packages/db/src/index.ts:3083`) uses `for update skip locked` — that is correct for a *work queue* (skip a busy row, grab the next). The lease is the **opposite**: it uses plain **`for update`** (block, do not skip) so concurrent acquirers serialize on the one session row and exactly one wins the `cold→warming` CAS. Both the lease and owner specs note this; it is the single most important query-level distinction in the system.

### C.3 The negotiated handshake document + events + token (in `@opengeni/contracts`)

```ts
// packages/contracts/src/index.ts — ONE shape; collapses 4 parallel module definitions
export const CapabilityUnavailableReason = z.enum([
  "backend_unsupported","os_unsupported","not_provisioned",
  "disabled_by_policy","lease_cold","tier_headless",
]);
export const SessionCapabilities = z.object({
  sessionId: z.string().uuid(),
  backend: SandboxBackend,
  os: SandboxOs,
  liveness: z.enum(["cold","warming","warm","draining"]),
  leaseEpoch: z.number().int().nonnegative(),               // echoed on viewer heartbeats (split-brain fence)
  viewerHeartbeatIntervalMs: z.number().int().positive().default(30_000),
  FileSystem: z.object({ available: z.boolean(), readOnly: z.boolean(), root: z.string(),
    pathSep: z.enum(["/","\\"]), treeMode: z.enum(["lazy","snapshot"]),
    reason: CapabilityUnavailableReason.nullable() }),
  Terminal: z.object({ transport: z.enum(["sse-events","pty-ws"]).nullable(), ptyCapable: z.boolean(),
    shell: z.string(), url: z.string().url().nullable(), token: z.string().nullable(),
    reason: CapabilityUnavailableReason.nullable() }),
  Git: z.object({ available: z.boolean(), repos: z.array(z.string()),
    reason: CapabilityUnavailableReason.nullable() }),
  DesktopStream: z.object({ transport: z.enum(["vnc-ws","rdp-ws","webrtc"]).nullable(),
    client: z.enum(["novnc","web-rdp"]).nullable(), mode: z.enum(["read-only","interactive"]).default("read-only"),
    url: z.string().url().nullable(), token: z.string().nullable(), expiresAt: z.string().nullable(),
    resolution: z.tuple([z.number().int().positive(), z.number().int().positive()]).default([1024,768]),
    unredacted: z.boolean(),                                  // REQUIRED, no default (server must assert)
    requiresAcknowledgment: z.boolean(), acknowledged: z.boolean(),
    reason: CapabilityUnavailableReason.nullable() }),
  Recording: z.object({ available: z.boolean(),
    modes: z.array(z.enum(["manual","on-turn","on-verify"])),
    codecs: z.array(z.enum(["h264-mp4","vp9-webm"])),
    reason: CapabilityUnavailableReason.nullable() }),
  negotiatedAt: z.string(),
});
export type SessionCapabilities = z.infer<typeof SessionCapabilities>;
```

**Event taxonomy** (appended to the single `SessionEventType` enum; mirrored in SDK `SESSION_EVENT_TYPES` **same order, same PR** — the parity test asserts sorted equality):

```
stream.url.rotated · stream.opened · stream.closed · stream.revoked        # Channel B (owns)
fs.changed · git.changed                                                    # Channel A (owns; debounced/revisioned)
terminal.pty.started · terminal.pty.output.delta · terminal.pty.exited      # Channel A PTY (modal/cloudflare/daytona)
recording.started · recording.available · recording.failed                  # Recording (owns)
desktop.geometry.changed                                                    # Desktop image (owns)
```

**Payload rule:** `SessionEvent.payload` is `z.unknown().default({})` — it is **NOT** discriminated by type (several modules wrongly claimed it was). Each module defines standalone payload Zod schemas and parses them **manually** at producer and consumer; the wire stays `z.unknown()`. `sandbox.command.output.delta` is **reused** for the agent-command firehose and any payload-widening must **preserve `name`** (the timeline correlation breaks otherwise).

**Scoped token** (`StreamTokenPayload`, one HMAC envelope, reuses `signDelegatedAccessToken`, prefix `ogs_`): claims `{workspaceId, sessionId, viewerId, leaseEpoch, mode:"view", port:6080, exp}`. v1 honesty: the in-box websockify runs `-nopw`; the **real** auth boundary is the short-TTL provider tunnel URL handed only to an acknowledged `stream:view` viewer. The token is minted + recorded against the holder from day one so the later `--token-plugin TokenFile` hardening is a config swap. It is **never** appended to the URL as a query param (the provider's own scoped token is already in the URL). `verifyStreamToken` must be **implemented**, and `delegationSecret` becomes **required when desktop is enabled**.

**Permissions** (appended to `Permission` + `KNOWN_PERMISSIONS` mirror): `stream:view` (watch un-redacted pixels — a real, distinct permission, strictly broader than `sessions:read`), `stream:control` (raw input; never granted v1), `stream:acknowledge`, `files:write`, `terminal:attach`. FS/Git reads ride existing `files:read`.

**Error-status rule:** raw `ZodError` and untyped throws become **500** via the existing pipeline. Every route must explicitly `throw new HTTPException(400, …)` on parse failure (not 422) and `HTTPException(409, …)` on epoch-fence / acknowledgment-required / cap-exceeded.

---

## PART D — THE PROVIDER × CAPABILITY × OS MATRIX

**OS (v1):** every reachable cell is **Linux**. macOS/Windows are seam placeholders (no enum members shipped; commented rows in `PROVIDER_OS_SUPPORT`).

**Capability availability per backend** (Linux):

| backend | tier | FileSystem | Terminal (transport / pty) | Git | DesktopStream (transport) | Recording | onDemandPorts | resumeLockFree | runAs | hardLifetime |
|---|---|---|---|---|---|---|---|---|---|---|
| **modal** | desktop | yes (rw) | sse-events / **pty** | yes | **vnc-ws** | yes | **no** (pre-declare 6080) | **yes** | yes | 24h |
| **daytona** | desktop | yes (rw) | sse-events / **pty** | yes | **vnc-ws** | yes | no | no | yes | — |
| **runloop** | desktop | yes (rw) | sse-events / **no pty** | yes | **vnc-ws** | yes | **no** ← CR9 fix | no | no | — |
| **e2b** | desktop | yes (rw) | sse-events / pty-until-proven=**no** | yes | **vnc-ws** | yes | no | no | no | — |
| **blaxel** | desktop | yes (rw) | sse-events / pty-until-proven=**no** | yes | **vnc-ws** | yes | **yes** (only on-demand backend) | no | no | — |
| **cloudflare** | headless | yes (rw) | sse-events / **pty** | yes | **null** | no | no | no | yes | — |
| **vercel** | headless | yes (rw) | sse-events / **no pty** | yes | **null** | no | no | no | no | **5h** |
| **docker** | dev | yes (rw) | sse-events / pty | yes | null (local) | no | no | yes | yes | — |
| **local** | dev | yes (rw) | sse-events / pty | yes | null | no | no | yes | no | — |
| **none** | none | — | — | — | — | — | — | — | — | — |

Reading rule: a cell is `available:false` + `reason` in the negotiated doc, never absent. `Recording.available == DesktopStream.available && os=="linux"` (x11grab is X11-only) — static feasibility, decoupled from whether a viewer requested desktop. The **6080 port-merge** happens inside `createSandboxClient` for every desktop-capable `(backend,os)` (including runloop, which is *not* on-demand, so 6080 must be pre-declared in `exposedPorts`); boot-validation asserts `6080 ∈ exposedPorts` when desktop-capable.

---

## PART E — WHAT DESKTOP / HOW (one crisp section)

**What the agent draws on:** `Xvfb :0` (headless X server, default 1024×768) → **XFCE** window manager → real browsers `google-chrome-stable` / `firefox-esr` (**not** the snap-transitional `chromium-browser`, which is broken on jammy). One canonical OpenGeni desktop OCI image (`docker/desktop.Dockerfile`, built by CI to GHCR, referenced by `createSandboxClient` via `sandboxDesktopImageRef`), composed per-provider into each provider's template.

**How pixels leave the box:** `x11vnc -viewonly` (the viewer plane is **read-only** — the agent drives via `xdotool`/`scrot` over the exec channel, the human only watches) → **websockify** on port **6080** → the provider's `resolveExposedPort(6080)` tunnel → the browser hits `wss://<provider-host>/vnc.html?path=websockify` (the `/vnc.html` + `?path=websockify` is appended **client-side**; the helper returns no path) → **noVNC** renders. This is **Channel B**: the browser talks **directly** to the provider; OpenGeni's API/worker are never in the pixel path.

**How it's launched:** by whatever worker holds the box for the current turn, via `exec` (idempotent under an in-box `flock`), **not** a container CMD — precisely so `ensureDisplayStack()` re-establishes after a box rollover (any worker can run it). websockify is backgrounded so `$!` is the listener PID; XFCE readiness is a probe, not a `dbus-launch` PID guess.

**How the agent uses it:** a `ComputerUseCapability` on `SandboxAgent` exposes a `computerTool` backed by `xdotool`/`scrot` issued through the externally-owned session. Screenshots are taken by `session.readFile` of the scrot PNG (**not** `execCommand`, which returns a banner-wrapped string). The agent and the human watch the **same** `:0` framebuffer — zero projection.

**How it's recorded:** `ffmpeg x11grab` on `:0` → mp4/webm → `@opengeni/storage` → `recording.available` event → client watch/replay. The "agent films itself proving the fix" UX. Byte transfer happens **inside the recording activity** (read + PUT in one invocation, on whatever worker holds the box) — never a 256 MB Temporal payload.

**How rollover survives:** on Modal's 24h ceiling (or any box death) whoever next hits the dead box re-establishes from the envelope under the epoch fence — a worker on a turn, **or the API on a viewer op** (the common desktop case, since the viewer's URL re-mint is what triggers it). The re-establisher snapshots, creates a new box, re-runs `ensureDisplayStack` idempotently, bumps the epoch, re-resolves + records the new URL, and emits `stream.url.rotated` over SSE; the client hot-swaps the noVNC socket (open-new-then-close-old → a brief "desktop blink").

**v1 boundaries:** desktop is **always read-only** (`stream:control` never granted, `stream-input` returns 403); **Linux only** (RDP/Windows is a seam); pixels are **un-redacted** so an explicit acknowledgment is mandatory before the URL is handed out.

---

## PART F — V1 BUILD ORDER (ordered checklist)

The order is forced by the dependency graph (topological sort). **Desktop is a headline and lands LAST**, on a complete foundation, GA-gated on the fan-out load test. Each phase is behind a flag; the data layer migrates forward-only.

- [ ] **Phase 0 — Providers + OS axis + the shared sandbox module** (`flag: none; ships Channel-A-only on all 10 backends`)
  - Contracts: `SandboxBackend`/`SandboxOs` enums, `CAPABILITY_DESCRIPTORS` table, `SandboxCapability` set — all in `@opengeni/contracts`.
  - Runtime: `createSandboxClient` registry with **all 7 non-trivial `build()` bodies** (Modal + e2b/daytona/runloop/blaxel/cloudflare/vercel — units & field-names differ per provider; "mirror Modal" is false).
  - **Enabling refactor (unblocks API-direct control plane):** extract the thin `@opengeni/runtime/sandbox` module — `createSandboxClient` + `deserializeSandboxSessionStateEnvelope` + `restoredSandboxSessionStateFromEntry` + `sandboxStateEntryFromRunState` — with **no `@openai/agents` agent-loop import** in its graph. Add the dep to `apps/api/package.json`; plumb the Modal token (already parsed by the shared `getSettings`, `packages/config`) into the API's Modal-client construction; confirm API egress to `api.modal.com`. This is what lets `apps/api` `resume()` a box by id in-process for every non-turn op.
  - DB: `0018_sandbox_os` (column add, CHECK, backfill `'linux'`).
  - Migration: drizzle-kit `generate`; **journal + snapshot** appended.

- [ ] **Phase 1 — Lease + ownership inversion (stateless)** (`flag: sandboxOwnershipEnabled=false`)
  - DB: `0017_sandbox_leases` (Part C.2) + the SECURITY-DEFINER cross-workspace sweep fn.
  - Worker: stateless lease + ownership inversion. **Turns** dispatch via the **existing turn-dispatch path** (the `sessionWorkflow` / its activities — unchanged); the running activity resolves the lease, **resumes the box by id**, injects it non-owned, and releases its holder in `finally` (dropping the in-memory handle). No `SandboxOwner` actor, no per-session worker, no per-session task queue. **Non-turn ops do not touch the worker at all** — they are API-direct (see Phase 3).
  - The reaper (**one global** Temporal **Schedule** in `apps/worker`, fully stateless — reuses the existing `temporalScheduleOptions` pattern): one periodic sweep TTL-reaps stale viewer holders, resets warming-death rows to cold, and at `refcount=0` (past the drain grace) issues the provider's existing `stop()`/terminate for a prompt cost-stop. The provider idle-timeout is the backstop. Not a per-session timer; not a per-RPC workflow.
  - The ONE recovery primitive: `reestablishFromEnvelope`-under-CAS (any worker on a turn, OR the API on a viewer op — both import the shared sandbox module) + a per-provider **NotFound discriminator** (the `@openai/agents-extensions` helper is not exported — OpenGeni must re-implement per backend).
  - The owned-session decoration contract (re-apply only agent-dependent decorators; idempotent repo-clone; 6080 in the constructor).

- [ ] **Phase 2 — Warm-time billing** (`must exist before any viewer holds a box`)
  - Warm-meter accrual on **two stateless ticks** (no `ownerHeartbeat`): the **turn's** existing 30s Temporal heartbeat (while a turn runs) and the **reaper sweep** (for viewer-only boxes between turns). Each tick refreshes `expires_at` epoch-keyed and accrues `sandbox.warm_seconds` idempotent on `(epoch, tick)` via `recordUsageEvent … onConflictDoNothing`; a stale-epoch writer fails the CAS and backs off.
  - Warm-cap count takes `withWorkspaceUsageLock` (not a bare count); 0-balance viewer-only box force-drains `AND turn_holders=0` (a paying turn is never killed), ending in the reaper `stop()` at `refcount=0`.

- [ ] **Phase 3 — Security control plane** (`flag: per-route`)
  - Perms (`stream:view` et al.) appended to `Permission` + mirror.
  - `0021_session_stream_acknowledgments` (the ack table) + the handshake routes (`/stream-capabilities` GET/POST/DELETE + `/heartbeat` + `/acknowledge`) — all **API-direct handlers** in `apps/api` (resume-by-id in-process via the shared sandbox module; the capability negotiation + viewer-holder acquisition + URL mint all run inside the request handler's Postgres txn; no worker, no Temporal, no NATS req/reply).
  - Token mint/verify; `delegationSecret` required-when-desktop; revocation reap (`reapViewerHoldersForSubject` + live-socket disconnect, not just token-file delete).

- [ ] **Phase 4 — Desktop image + pixel plane** ⬅ **THE HEADLINE; GA gate = the fan-out load test** (`flag: sandboxDesktopEnabled`)
  - `docker/desktop.Dockerfile` (CI → GHCR); `ensureDisplayStack` (`Xvfb→XFCE→x11vnc -viewonly→websockify:6080`, exec-launched, flock-idempotent — runnable by a worker on a turn OR the API on a viewer op).
  - `exposeStreamPort` + URL mint/rotation served **API-direct** (the `/stream-capabilities` handler resumes the box by id and resolves the port in-process — **no** `sandboxOwnerRpcWorkflow`); noVNC client.
  - DB: `0019_session_recordings`, `0020_sandbox_pty_sessions`.
  - Computer-use capability + recording loop.

- [ ] **Phase 5 — Client surfacing** (`gated on negotiated descriptor`)
  - SDK `ClientConfig` mirror (+ `sandbox` block: `allowedBackends`, `desktopCapableBackends` = configured ∩ descriptor); parity-pinned.
  - React hooks + Pierre trees/diff + xterm + noVNC; SSR lazy-import + hydration-placeholder convention; 409/429 handling.

**Migration order:** `0017_sandbox_leases` → `0018_sandbox_os` → `0019_session_recordings` → `0020_sandbox_pty_sessions` → `0021_session_stream_acknowledgments`. All in `packages/db/drizzle/` (the `db/migrations/` path several modules referenced **does not exist**). Hand-authored RLS GRANT blocks + the SECURITY-DEFINER fn must **manually append** `_journal.json` + a snapshot (drizzle-kit `generate` won't emit them).

**Feature-gating + rollback:** flags are independent and forward-default-off. The `sandboxOwnershipEnabled` rollback is reversible **but** leaves orphaned `warm`/`draining` lease rows + live boxes — the disable path must drain-on-disable (OD-9). New routes need updated metric label patterns or they bucket as `unknown`; the Phase-1 exit gate **requires** an `owner.spawn`-count-vs-distinct-`(session,epoch)` metric (the double-spawn detector).

---

## PART G — OPEN DECISIONS (for Jørgen) + EMPIRICAL SPIKES

### G.1 Open decisions — Jørgen must rule

These are genuine forks the modules left tri-defined or punted; each needs a call before the dependent phase ships.

| # | Decision | Options | Recommendation | Blocks |
|---|---|---|---|---|
| **OD-1** ✅ **RULED — API-direct** | Viewer/RPC dispatch mechanism (formerly tri-defined: RPC workflow vs `signalWithStart` vs claim loop) | — | **DISSOLVED: there is no RPC dispatch.** All non-turn ops are served **API-direct** — the `apps/api` route handler resumes the box by id in-process (via the shared `@opengeni/runtime/sandbox` module) and returns inline JSON. No workflow, no worker, no NATS req/reply. The long-lived loop concern is moot because nothing queues behind a turn. | (resolved) |
| **OD-2** ✅ **RULED — none** | RPC-activity lifecycle | — | **DISSOLVED with OD-1.** No `sandboxOwnerRpcWorkflow` exists. The "acquire-then-release a transient viewer-equivalent holder that re-arms a draining/cold box" logic survives, but it runs **inside the API request handler's Postgres txn**, not a workflow. | (resolved) |
| **OD-3** | Reaper SECURITY-DEFINER sweep | the exact DDL + selection predicate (stale viewer holders + warming-death + draining-grace in **one** pass) + which migration | land in `0017`; one predicate over the reaper index; Temporal **Schedule** driver in `apps/worker` | Phase 1 (liveness GC) |
| **OD-4** | FS write concurrency | last-writer-wins vs optimistic `revision`-gated writes | **last-writer-wins** — concurrent turns on one box race exactly like a single agent's concurrent tool-calls (the standing no-explicit-conflict ruling); FS writes are **not** serialized and there is **no turn-mutex**. The `lease_epoch` fence still prevents a *stale-epoch* writer from clobbering | Phase 4 (channel-A) |
| **OD-5** | Headless rollover (Vercel 5h) | only Modal-desktop rollover is specced; generalize the lifetime-ceiling path for headless (no displayStack, same envelope/epoch/URL-rotation) | generalize in the re-establish-from-envelope path (any worker); skip `ensureDisplayStack` when tier≠desktop | Phase 1 |
| **OD-6** | Live-VNC revocation teardown | token-file delete only blocks reconnect; a revoked viewer keeps watching | a stateless `revokeViewer(viewerId)` activity (any worker) disconnects the live RFB session in the box | Phase 3 |
| **OD-7** | Blaxel/Daytona provider-token rotation | when the data-plane URL is re-resolved (by the API on a viewer op, or a worker on a rollover) it must re-resolve the **provider** preview token (own TTL), not just re-mint the OpenGeni token | fold per-provider URL re-resolution into the `resolveExposedPort` re-resolve (recorded in the lease under the epoch fence) | Phase 4 (channel-B) |
| **OD-8** | `delegationSecret` absent but desktop configured | hard boot-fail vs graceful `DesktopStream.transport:null` | **graceful degrade** + a loud warning | Phase 3 |
| **OD-9** | `sandboxOwnershipEnabled` disable semantics | orphan-lease + live-box cleanup on flip-back | drain-on-disable sweep | Phase 1 rollout |

### G.2 Empirical spikes — measure, don't reason

| Spike | Question | Method | Gate |
|---|---|---|---|
| **SPIKE-1 — fan-out load test** | How many simultaneous noVNC viewers can one box's provider tunnel + one websockify sustain before pixel latency degrades? | N synthetic noVNC clients against one warm box per backend; measure frame latency + the **control-plane** cost of N simultaneous negotiations (N API-direct `/stream-capabilities` handlers + N holders serializing on **one** `FOR UPDATE` row — the thundering-herd risk) — all served in-process by `apps/api` (no worker, no workflow per op) | **GA gate for Phase 4**; sets `maxViewersPerSession` (enforced in `acquireLease(viewer)` → typed 429) |
| **SPIKE-2 — desktop-on-gVisor** | Does `Xvfb`/`x11vnc`/`xdotool` run under gVisor-isolated backends (e2b/runloop syscall-filtered runtimes)? | Boot the desktop image on each desktop-tier backend; verify the full stack comes up + pixels flow | Confirms/prunes the desktop-tier rows in Part D before Phase 4 invests |
| **SPIKE-3 — redaction asymmetry proof** | Does a secret `cat`'d to the terminal appear in the **un-redacted** framebuffer but **redacted** in `sandbox.command.output.delta`? | Inject a known secret; assert it's in the noVNC pixels and scrubbed in the event | Security invariant the whole acknowledgment gate rests on |
| **SPIKE-4 — epoch-fence on the heartbeat path** | Does a stale writer (a re-dispatched turn from a dead worker) that keeps heartbeating actually get fenced (the exact split-brain bug)? | Force a re-establish-from-envelope under a new epoch; assert the stale turn's `heartbeatLeaseHolder` is rejected on epoch mismatch and backs off | Integration test, Phase 1 — unit tests cover turn-arrival fence, **not** the heartbeat path where the real bug lives |

---

## PART H — THE 10 MODULES (abstract + pointer each)

| # | Module | Layer | One-paragraph abstract | Pointer |
|---|---|---|---|---|
| 1 | **lease** | `@opengeni/db` | The Postgres lease layer that is the **sole** enforcer of the strict-singleton-sandbox-per-session invariant: two tables (`sandbox_leases`, `sandbox_lease_holders`), the exact acquire/release/heartbeat/reap/drain/re-arm queries (plain `FOR UPDATE`, **not** skip-locked), the 4-state machine with the spawner-death and split-brain `lease_epoch` fence, and the boot-validated `reaperPeriod < viewerHolderTTL < idleTimeout` cadence. | mirrors `claimNextQueuedTurn` (`db/src/index.ts:3077`); migration `0017` |
| 2 | **owner** | `apps/worker` + `apps/api` + runtime | **Stateless resume-by-id**: any pool worker resumes the one box by id per turn (warm reattach or cold-restore), injects it non-owned, and drops the handle at turn end — turning the per-run build-and-discard client into a strict singleton governed by the lease, recovered by one re-establish-from-envelope-under-CAS primitive (any worker on a turn, OR the API on a viewer op — both via the shared `@opengeni/runtime/sandbox` module). No owner actor, no per-session queue, no keepalive/rotation timers. Owns the ownership inversion, `ensureDisplayStack`/`exposeStreamPort` (idempotent, runnable by worker or API), and the **one global** stateless reaper Schedule (warm-meter tick + `stop()` at `refcount=0`). | `apps/worker/src/sandbox-resume.ts` (stateless; was `sandbox-owner.ts`) + the API-direct handlers in `apps/api`; `SandboxRunConfig.session` (core `sandbox/client.d.ts:60`) |
| 3 | **providers** | runtime + contracts | `createSandboxClient` (the factory), the `SandboxBackend` enum across 3 packages, the static `CapabilityDescriptor` registry (hosted in **contracts** to break the config↔runtime cycle), per-provider config/secret wiring, and the backend+capability selection/negotiation/degradation function. Pure construction + static metadata + selection; owns no runtime state. | `createSandboxClient`; `CAPABILITY_DESCRIPTORS` in `@opengeni/contracts` |
| 4 | **desktop-image** | `docker/` + runtime | The canonical OpenGeni desktop OCI image (Dockerfile, package list — real Chrome/Firefox not the snap stub, geometry/DPI), the `ensureDisplayStack` launch procedure (`Xvfb→XFCE→x11vnc -viewonly→websockify/noVNC`) over the externally-owned client, per-provider image composition, and the ffmpeg recording sidecar. Exec-launched + flock-idempotent so it survives rollover. | `docker/desktop.Dockerfile`; `runtime desktop/stack.ts` |
| 5 | **computer-use** | runtime | The agent drives the **same** X display humans watch: a `Computer` impl backed by `xdotool`/`scrot` through the externally-owned session (screenshots via `readFile` of the scrot PNG, not banner-string exec), exposed via a `ComputerUseCapability` on `SandboxAgent`; plus the `ffmpeg x11grab` recording loop → storage → `recording.*` events, and the "agent films itself proving the fix" UX. Byte transfer stays inside the recording activity (no 256 MB Temporal payload). | `runtime desktop/computer.ts`; `buildAgentCapabilities()` (`runtime:494`) |
| 6 | **os** | contracts + runtime | OS (`linux\|macos\|windows`) as a first-class OpenGeni-owned dimension (the SDK has none): threads `session → backend+image/template selection → capability negotiation → desktop Environment hint`, session-immutable once warm, with a free-text DB column (no enum migration) and the 7-provider × OS support table. v1 ships Linux only; mac/win are commented seams. | `selectOsImage` in runtime; `sessions.sandbox_os` (`0018`) |
| 7 | **channel-a** | `apps/api` + `apps/worker` + contracts | The structured services (FileSystem / Terminal-as-events + interactive PTY / Git) over **two** transports: A1 the durable SSE event broadcast (terminal output, `fs.changed`/`git.changed` notifications — worker emits → NATS → API-SSE) and A2 the **API-direct** request/response path (FS reads, Git diffs — the API resumes the box by id in-process and returns inline JSON; **never** the bus, which would corrupt SSE gap-fill, and **never** a worker/Temporal/NATS-req-reply). Built on `session.execCommand` with banner-stripping (the SDK's `exec`/`listDir` don't exist). NOT pixels. | `appendAndPublishEvents` (`events:30`); `apps/api/src/http/sse.ts:5` |
| 8 | **channel-b** | `apps/api` + `apps/worker` + contracts | The desktop **data plane**: everything from "the agent draws to `:0`" to "N browsers render those literal pixels," plus the **control-plane handshake (API-direct)** that authorizes + addresses the transport. The `/stream-capabilities` handshake route lives in `apps/api` and resumes the box by id in-process to run `exposeStreamPort` + token mint/rotation (no worker, no Temporal); the websockify edge + the desktop stack run in the box; the noVNC client in the browser. Rides Channel A for one signal only (`stream.url.rotated`); the pixel path bypasses OpenGeni entirely. | `resolveExposedPort(6080)`; `runtime desktop/stack` |
| 9 | **client** | sdk + react + web | The capability-gated last mile: declare-once-in-contracts → mirror-in-sdk (parity-gated) → fold-into-react (timeline/hook/component) → consume-in-web. Negotiates `SessionCapabilities`, then connects terminal (xterm), file browser + diff (Pierre), and desktop (noVNC, Channel B direct). Split-plane aware; SSR lazy-import + hydration-placeholder convention; 409/429 handling. | `ClientConfig` mirror in `@opengeni/sdk`; React hooks/components |
| 10 | **crosscut** | api + db + worker | The cross-cutting layer: security/auth/multi-tenancy (every new route through `requireAccessGrant` **before** any Zod parse; `stream:view` is real and distinct because the plane is un-redacted), cost/billing/lifecycle (warm-box second metering, caps under the usage lock, lifetime-ceiling rollover), and testing/rollout (the flag phasing, the fan-out GA gate, the redaction-asymmetry security test). | `apps/api/src/access/index.ts:31`; `recordUsageEvent`; `withWorkspaceUsageLock` |

---

**Bottom line for Jørgen.** The system is one coherent build, not 10. The spine is: **one** capability set (5 PascalCase names) · **one** descriptor table (in contracts, breaking the config↔runtime cycle) · **one** lease row (`account_id`-bearing, `integer` epoch, single `expires_at`, plain `FOR UPDATE`) · **one** `SessionCapabilities` handshake · **one** event taxonomy (`z.unknown()` payloads; **reads are API-direct, never on the bus**) · **one** token/permission set · **one** recovery primitive. **The control plane is API-direct**: every non-turn op (viewer attach, URL mint/rotate, FS/Git read, capability negotiation) is `client → API → box`, the API resuming the box by id in-process via the shared `@opengeni/runtime/sandbox` module — no worker, no Temporal, no NATS req/reply. **Temporal runs exactly two things: the agent turn, and one global reaper Schedule.** Workers are a **stateless pool** (no owner process): any worker resumes the one box by id per turn and injects it non-owned. Build order is forced: providers (+ the shared-module extraction) → lease+inversion → warm-billing → security → **desktop (headline, last, gated on SPIKE-1)** → client. Before you start: OD-1/OD-2 are now **resolved** (API-direct, no RPC workflow); OD-3 the reaper sweep is the **sole** liveness/GC/cost-stop driver — one global Temporal Schedule, no `ownerHeartbeat`. Then schedule the 4 spikes (SPIKE-1 fan-out is the GA gate; SPIKE-2 desktop-on-gVisor de-risks Part D before Phase 4 spends).

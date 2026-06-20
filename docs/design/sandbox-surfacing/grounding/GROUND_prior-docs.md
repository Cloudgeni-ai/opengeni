# DISTILLATION — Implementation-relevant specifics already settled

This is the concrete-detail extract from `briefing.md` (singleton-owner+lease architecture) and `provider-survey.md` (R1–R7 per-provider). Every item below is **already worked out** — downstream modules build on it, do not re-derive. Codebase anchors verified against HEAD (line numbers are approximate, ±a few lines from the docs; the named symbols are exact).

---

## A. DDL — the two NEW Postgres tables

Both mirror the EXISTING singleton pattern at `packages/db/src/schema.ts` `sandboxSessionEnvelopes` (table `sandbox_session_envelopes`, `uniqueIndex("sandbox_session_envelopes_session_idx").on(workspaceId, sessionId)`, ~line 360). FK chain to copy: `accountId→managedAccounts`, `workspaceId→workspaces`, `sessionId→sessions`, all `onDelete:"cascade"`.

### `sandbox_leases` — 1 row/session (the logical-singleton enforcer)
Unique index `(workspace_id, session_id)`. Columns settled:
- `liveness` — enum: **`cold` | `warming` | `warm` | `draining`** (the 4 states)
- `refcount` (int, starts 0)
- `turn_holders` (int) — TTL-EXEMPT (released by activity lifecycle only)
- `viewer_holders` (int) — TTL-reapable
- `instance_id` — provider sandbox id (the live box)
- `owner_worker_id` — which worker process holds the handle
- `owner_task_queue` — the per-session queue name `sandbox-owner::<sessionId>`
- `data_plane_url` — current scoped stream URL
- `lease_epoch` (int) — the fence; bumped on every `warming→warm` commit / re-election
- `expires_at` (timestamptz) — heartbeat-TTL; refreshed on turn 30s heartbeat AND on `acquire`

### `sandbox_lease_holders` — N rows/session (makes release idempotent)
One row per holder: `(lease_id, kind, holder_id, last_heartbeat_at)`. `kind ∈ {turn, viewer}`. Release = **delete-my-holder-row** (idempotent), never blind decrement. Reaper recomputes `refcount = COUNT(holders)`.

---

## B. The get-or-create critical section (verbatim, do not relax)

One Postgres txn, the **SOLE** singleton enforcer:
```sql
BEGIN;
  INSERT INTO sandbox_leases (...) VALUES (..., 'cold', 0)
    ON CONFLICT (workspace_id, session_id) DO NOTHING;
  SELECT * FROM sandbox_leases WHERE ... FOR UPDATE;   -- serializes concurrent arrivals
  UPDATE sandbox_leases SET refcount = refcount+1,
    turn_holders   = turn_holders   + (kind='turn'),
    viewer_holders = viewer_holders + (kind='viewer'),
    expires_at = now() + lease_ttl
   WHERE id = $lease RETURNING liveness, instance_id, lease_epoch;
COMMIT;
```
Then branch on `liveness`: **warm**→attach(no spawn); **warming**→wait for warm; **cold**→win conditional `UPDATE … WHERE liveness='cold'` (cold→warming CAS, exactly one winner per epoch because row is `FOR UPDATE`-held)→resume-from-envelope→build owner→start stream-server→commit `warming→warm` **and bump `lease_epoch`**.

**CRITICAL CORRECTION (carry this):** The per-session **Temporal workflow does NOT serialize the two `acquireLease` activities** — Temporal serializes signal handling + command emission, NOT activity executions. The viewer's `exposeStreamPort` runs CONCURRENTLY with `runAgentSegment`. The `(workspace_id, session_id)` unique index + `SELECT … FOR UPDATE` is the **only** thing preventing double-spawn. Any "fast path" skipping the row lock reintroduces double-spawn.

---

## C. State machine — 4 states + all transitions

States: `cold`, `warming`, `warm`, `draining`. Transitions:
- `cold → warming` : CAS on acquire (one winner)
- `warming → warm` : spawner commits after resume+owner+stream-server, `lease_epoch++`
- `warming → cold` : spawn fails AND spawner catches it
- **`warming` lease-TTL → cold** : spawner *dies* mid-resume (NEW — base design only covered caught failures; uncaught spawner death needs its own TTL)
- `warm → draining` : refcount→0, CAS guarded `AND turn_holders = 0`
- `draining → warm` : late arrival re-arms (closes drain-vs-arrive double-spawn window)
- `draining → cold` : confirmed idle after MANDATORY grace window → persist envelope, **drop (never delete) handle**, stop keep-alive, evict from Map
- **Release during `warming`** : decrement refcount ONLY, never touch liveness (spawner owns `warming→warm` exclusively, then re-checks refcount).

---

## D. SandboxOwner — in-worker actor

- Lives in `Map<sessionId, SandboxOwner>` added to the existing `servicesPromise` registry at `apps/worker/src/activities.ts` (the `servicesPromise ??=` IIFE at ~line 33, alongside `runtime`/`objectStorage`/`workflowClient`).
- Holds exactly ONE `{client, sessionState}`. Exposes refcount lease (`acquire()`/`release()`), NOT N handles.
- New file: **`apps/worker/src/sandbox-owner.ts`**.
- Owner methods (NEW, net-new vs codebase): `ensureDisplayStack`, `exposeStreamPort`, `startRecording`.
- Addressed via per-session Temporal task queue **`sandbox-owner::<sessionId>`**; a per-session `Worker.create` polls it (currently one static `Worker.create` in `apps/worker/src/index.ts` ~line 33). Worker writes its queue name into `owner_task_queue`; workflow routes BOTH legs (turns via own dispatch, viewers via API→`signalWithStart`→workflow) onto it.

### THE central refactor — "ownership inversion"
At `packages/runtime/src/index.ts`, `runAgentStream` (~line 1003) currently builds the handle PER CALL: `createSandboxClient(settings, environment)` at ~1006, wrapped through `withManifestRefreshOnResume`/`withSandboxFileDownloads`/`withSandboxLifecycleHooks`, then handed into `run()` as `runOptions.sandbox = { client, sessionState }` (`SandboxRunConfig`) at ~1044-1050. There is ALREADY an override seam: `overrides.sandboxClient` (used at line 1006: `overrides.sandboxClient ?? createSandboxClient(...)`) and `prepared.sandboxSessionState`. **The inversion = make `runStream`/`runAgentStream` accept an externally-owned `{client, sessionState}` and stop building+discarding per run.** This is the one non-trivial change everything depends on. The override hook already half-exists.

---

## E. Heartbeats, keep-alive, reaper — exact cadences & invariants

- **Box keep-alive:** owner timer (mirrors `startActivityHeartbeat` in `streaming.ts:50`) issues cheap `session.exec` (`runtime/src/index.ts:1242`) at **≪ 900s** to reset Modal idle clock. `modalTimeoutSeconds=900` (`config/src/index.ts:241`, also surfaced via `settings.modalTimeoutSeconds * 1000` in `createSandboxClient`). Re-mints data-plane URL before expiry; pushes `stream.url.rotated` SSE on Channel A.
- **Turn holders:** released by Temporal activity lifecycle (`finally` / worker-death requeue) — NEVER TTL.
- **Viewer holders:** clean disconnect OR `reapStaleLeaseHolders` (deletes stale-`last_heartbeat_at` rows, recomputes refcount, drains at 0).
- **Activity config (reuse exactly):** `heartbeatTimeout: "30s"`, `startToCloseTimeout: 30 days` (`apps/worker/src/workflows/activities.ts:8-9`). The NEW `ownerHeartbeat` activity reuses these EXACT values (30s heartbeat / 30-day STC).
- **Boot-validated invariant:** `reaperPeriod < viewerHolderTTL < modalIdleTimeout`.
- **Default param targets:** `idleGraceMs` 30–60s, `viewerHolderTTL` ~90s, `keepAliveIntervalMs` ~60s.
- `expires_at` refreshed on the turn's 30s activity heartbeat (not only on acquire) so the reaper can't kill a live multi-day turn.

---

## F. Data path — Channel A vs Channel B (exact anchors)

| | Channel A (structured) | Channel B (pixels) |
|---|---|---|
| Carries | agent msgs, tool calls, `sandbox.command.output.delta` (terminal bytes-as-events), file/git ops | raw framebuffer/encoded video of X display + cursor |
| Producer | `appendAndPublishEvents(db, bus, workspaceId, sessionId, events)` — `packages/events/src/index.ts:30` | in-box stream-server on an `exposedPort` |
| Transport | Postgres (sequenced/replayable) → NATS → N SSE subs via `sseSessionStream(db, bus, workspaceId, sessionId, after, signal)` — `apps/api/src/http/sse.ts:5`, `bus.subscribe` at :33 | direct viewer → provider scoped URL → in-box port |
| Fan-out | one producer → N SSE subs (BUILT, reuse as-is) | stream-server's own multi-client accept loop (NET-NEW) |

**Boundary is durable/sequenced/auth-per-read (rides OpenGeni, includes terminal-as-events) vs ephemeral/opaque/interactive-latency (direct-to-provider, framebuffer).** Control plane negotiates+authorizes both, carries only A.

### In-box display stack (v1 transport settled)
`Xvfb :0` → `x11vnc` reads framebuffer → `websockify` → ONE `exposedPort` → native VNC fan-out. **v1 = VNC-over-WebSocket (x11vnc + websockify + noVNC), one port.** WebRTC is the later latency upgrade. Agent draws to :0, VNC reads same :0 → viewers see literal agent pixels, no projection, cursor co-presence free.

`exposedPorts` is ALREADY first-class: config → both backend constructors (`runtime/src/index.ts` ~767/774, `parseExposedPorts(settings.dockerExposedPorts)` in the modal+docker branches) → envelope serialize/resume round-trip (~1714/1723). **Missing: turning an exposed port into a scoped URL (zero tunnel/VNC hits in codebase today).**

---

## G. Control-plane handshake (exact sequence)
```
1. CLIENT → API   GET /sessions/:id/stream-capabilities   (requireAccessGrant, routes/sessions.ts ~216)
2. API → WORKER   signalWithStart("sessionWorkflow"=S, openStreamRequest{viewerGrantId})  → acquireLease(viewer)
3. WORKFLOW → schedule exposeStreamPort on sandbox-owner::S → ensureDisplayStack, mint streamToken, epoch++
4. API → CLIENT   200 { capabilities, dataPlaneUrl, streamToken, expiresAt }
5. CLIENT → PROVIDER (direct)  WS dataPlaneUrl?token → noVNC; CLIENT → API (SSE /events) → Channel A
```
`signalWithStart`/`openStreamRequest` wiring sits with the existing client at `apps/api/src/index.ts` ~49-69. API holds NO sandbox client today (`dependencies.ts` = `{db, bus, workflowClient, objectStorage}`) and must continue to hold none — it signals the owner ONLY by scheduling an activity; the pixel socket lives solely inside the activity invocation, never traverses the workflow.

---

## H. Capability interface (settled TypeScript shape)
```ts
interface SessionCapabilities {
  FileSystem:    { available; readOnly };
  Terminal:      { transport: "sse-events" | "pty-ws" | null; url?; token? };
  Git:           { available };
  DesktopStream: { transport: "vnc-ws" | "webrtc" | null; url?; token? };
  Recording:     { available; mode? };
}
```
`FileSystem`/`Git`/event-`Terminal` need NO new provider methods (ride `session.exec` + `filesystem`/`gitRepo` helpers). Only `exposeStreamPort`/`ensureDisplayStack`/`startRecording` are new, added per-backend behind the `createSandboxClient` switch. **Degradation is always a handshake value, never silent:** `none`→`DesktopStream:{transport:null}`; deployed `local`→`reachable:false`→client falls back to Channel-A-only.

`SandboxBackend = z.enum(["docker","modal","local","none"])` (`packages/contracts/src/index.ts` ~13, verified). OpenGeni today only wires modal+docker+local in `createSandboxClient` (verified ~763-795).

---

## I. File-by-file change table (settled)

| File | Change |
|---|---|
| `packages/db/src/schema.ts` | add `sandbox_leases` (unique `(workspaceId,sessionId)`) + `sandbox_lease_holders`, mirror envelope at ~360 |
| `apps/worker/src/activities.ts` | add `owners: Map<sessionId, SandboxOwner>` to `servicesPromise` registry (~33) |
| `apps/worker/src/sandbox-owner.ts` (NEW) | the `SandboxOwner` — holds `{client,sessionState}`, `acquire/release`, keep-alive+URL-rotation timer, `ensureDisplayStack`/`exposeStreamPort` |
| `packages/runtime/src/index.ts` | ownership inversion: `runStream`/`runAgentStream` accept externally-owned `{client,sessionState}` instead of building at ~1006/~1044 |
| `apps/worker/src/index.ts` | per-session `Worker.create` on `sandbox-owner::<sessionId>` (currently one static at ~33); start on spawn, stop on cold |
| `apps/worker/src/workflows/session.ts` | read `owner_task_queue` off lease, pass as `taskQueue` for `runAgentSegment`(~215)+viewer/release/reap; `acquireLease(turn)` before dispatch, `releaseLease(turn)` in `finally`; worker-death requeue (~254) also triggers spawner re-election |
| `apps/worker/src/activities/agent-turn.ts` | turn activity calls `owners.get(sessionId)`, hands live handle into `run()`, inc/dec turn holder |
| `apps/api/src/routes/sessions.ts` + `apps/api/src/index.ts` | `GET /sessions/:id/stream-capabilities` behind `requireAccessGrant`(~216) → `signalWithStart(openStreamRequest)`(~49-69); SSE `stream.url.rotated` push |
| `packages/contracts/src/index.ts` | `SessionCapabilities` + per-backend stream methods behind `SandboxBackend`(~13) |

The `while(true)` claim-one-turn loop (`session.ts:82`) is untouched in shape; turns stay sequential. Existing recovery refs: `requeueTurnAfterWorkerDeath` (~254), `failSession` (~268/278).

---

## J. Stress-test resolutions (the fixes the design MUST carry)

- **(a) Turn+viewer hit idle simultaneously:** DB `FOR UPDATE`+`cold→warming` CAS is sole enforcer; loser waits on `warming`, attaches to SAME box. Add `warming` lease-TTL for a spawner that *dies* mid-resume (existing `warming→cold` only covers caught failures).
- **(b) Owner/worker restart, VIEWER-ONLY (no turn) — REAL LIVENESS HOLE:** nothing heartbeats the box, Temporal never learns owner died, lease stuck `warm`, box idles out under a live viewer. **Fix: turn-independent `ownerHeartbeat` activity (30s heartbeat / 30-day STC) scheduled whenever `refcount>0`.**
- **(c) Split-brain — #1 unproven assumption:** `lease_epoch` fences Postgres writes; superseded owner self-evicts on next lease write. Make epoch check **pre-emptive** — re-validate `lease_epoch == myEpoch` INSIDE the `FOR UPDATE` txn that increments `turn_holders`. **NEVER fall back to `create()` on resume-conflict** (the ONLY path to a genuine 2nd box) — back off until old handle fenced/force-detached.
- **(d) Lease expires during legit multi-day turn:** refresh `expires_at` on turn's 30s heartbeat; reaper's `warm→draining` CAS guarded `AND turn_holders = 0` (only viewer_holders TTL-reapable).
- **(e) Box dies under agent (e1)/lone viewer (e2):** reclassify recoverable box-death → re-resume-from-envelope (NOT `failSession` at session.ts:278); bounded retry like `requeueTurnAfterWorkerDeath`. **Unify (b)/(e1)/(e2) into ONE recovery primitive — "re-establish-singleton-from-envelope-under-CAS" — with 3 detectors: turn-heartbeat-death (have), owner-heartbeat-death (add per b), box-exec-failure (route through CAS).**
- **(f) Closed laptop:** client→server app-level viewer heartbeat on Channel A (TCP half-open / SSE keepalive does NOT prove client alive); stale→reaper drops within ~90s; release = delete-holder-row.
- **(g) Flapping:** MANDATORY `draining` grace window collapses N flaps→1 box; release-during-`warming` decrements refcount only; optional 500ms connect debounce.
- **(h) Security v1:** READ-ONLY desktop, disable raw-pty write (a writer bypasses `approvalQueue`/`interrupt`). Enforce scoped token at data-plane edge (websockify validates on connect+expiry, not URL secrecy). Pixel plane is UN-REDACTED (can show live cloud creds) → shared-live is OPT-IN/acknowledged, not silent default. Tie grant-revocation to holder reap.

**The two findings most threatening the invariants:** (c) the `create`-fallback (only path to a 2nd box, depends on unverified Modal behavior) and (b) the viewer-only owner-death blind spot.

---

## K. Modal facts (the load-bearing R4 detail) + provider survey

### Modal R4 resolves SAFE (the single most load-bearing fact, verified favorable)
- `libmodal` `Sandbox.fromId` = zero-timeout existence check then constructs a LOCAL handle. **No exclusivity mechanism — no locks/leases/ownership checks** against multiple simultaneous handles to one sandbox.
- Control plane is **per-RPC** (`exec`/`tunnels`/`poll` independent gRPC) → no single exclusive control socket to contend on.
- SDK `resume()` reconnects via `modal.sandboxes.fromId(sandboxId)`, throws **only if `exitCode !== null`** (box already dead) — NEVER on concurrency conflict. `ownsSandbox` gates only whether `close()` terminates, NOT concurrency.
- **Conclusion:** re-elected owner can `fromId`-reattach; a stray 2nd handle NEVER spawns a 2nd box and is NEVER rejected. The dangerous hard-reject mode does NOT occur on Modal. Residual = app-level (two simultaneous `exec` writers = OpenGeni's coordination problem, no provider single-writer lock). This SAFE "allow" is exactly what re-election needs.

### Modal structural facts
- **Hard 24h sandbox lifetime** → snapshot-rollover (new `sandboxId`, brief desktop blink); R5 native fs/dir snapshots already wired.
- Runs arbitrary registry OCI image at runtime, SDK pins entrypoint to `sleep infinity` (OpenGeni owns root process launch via `exec`) — NO prebuild-template step (unlike e2b/runloop/blaxel).
- Tunnels = raw **L4 TLS-TCP passthrough**, carries HTTP+WebSocket, `tls` always true, no documented per-port client cap.
- gVisor (not full VM) → validate exact desktop image. SDK omits connect-token minting + region selection (both exist on platform; need raw-handle/patch).

### Desktop gate = R1+R2+R3+R6 (all four non-negotiable)
R1 custom-image-root · R2 port→WS URL · R3 hold-open+kill · R6 concurrent-port fan-out. R4/R5/R7 = quality, not gating.

### Per-provider verdicts (desktop-capable = clears all 4)
- **Modal** (primary): clears every gate; R4 safe; 24h cap.
- **Daytona**: clears gate; ships first-class VNC Access + Computer Use (Xvfb/xfce4/x11vnc/novnc, root); cleanest R2 (signed tokenable WS preview URL, token in URL, 24h-max, re-mintable/revocable); `autoStopInterval:0` disables idle-kill; ~27-90ms cold start. Soft: tar-only snapshot; 4 vCPU/8GB/10GB ceiling; ports pre-declared.
- **Runloop**: clears gate; best lifecycle (`keep_alive_time_seconds`, opt-in idle-kill, native suspend/resume, Tunnels v2 = WS+SSE, one tunnel all ports, bearer-token). Soft: GPU undocumented; blueprint prebuild; `supportsPty()=false`; suspend/resume gated behind $250/mo Pro.
- **E2B**: clears gate; official `e2b-dev/desktop` image (Xvfb+x11vnc+noVNC+Xfce) = R1 PROVEN; R4 documented multi-client connect-by-id, no exclusive lock; native fs+process snapshot; ~150ms cold start. Soft: 24h (Pro)/1h (Hobby); no GPU; US/EU; prebuilt template; R2 token TTL undocumented.
- **Blaxel**: clears gate; official `blaxel/xfce-vnc` root template; most flexible R2 (on-demand ANY port, no pre-declare, public OR `bl_preview_token`-tokened, re-mintable); `fromSession` mints scoped frontend tokens (closest to one-box-many-viewers). Soft: R5 native snapshot = confirmed NO (tar-only); R4 concurrent-2nd-handle UNDOCUMENTED; prebuilt with `sandbox-api` binary; no GPU; US/EU.

### Headless-only (desktop-DISQUALIFIED)
- **Cloudflare**: SDK client `resolveExposedPort()` = hard `SandboxUnsupportedFeatureError` stub (no viewer-reachable port through abstraction); `manifest.root` locked to `/workspace`; `keepAlive`/`sleepAfter` not exposed by SDK; fresh-disk-after-sleep.
- **Vercel**: hard **5h** cap (`extendTimeout` only raises to plan cap); no custom base image (node/python3.13 runtimes only); no PTY (`supportsPty()=false`); single-session, 2nd handle SHARES the one VM, "cannot serve commands from two processes at once" (422). Client built against OLD v1 surface. **GREAT for a future headless tier**, wrong shape for desktop.

### Biggest empirical risk (ALL providers)
**R6 per-port viewer fan-out has NO published cap or guarantee on any provider.** SDK never models fan-out (its only WS is the PTY socket against the provider control plane). Architecturally all fan out (L4/HTTP passthrough + in-box websockify) but **must be load-tested with many concurrent noVNC viewers** before betting the headline. This is the single biggest unvalidated risk for the whole feature.

SDK provider client dist tree confirmed present: `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/{modal,e2b,daytona,cloudflare,vercel,runloop,blaxel,shared}/` (each with `index`/`sandbox`/`mounts` `.d.ts`+`.js`+`.mjs`).

### Net product shape (CONFIRMED)
Headless (terminal+files+git) on EVERY provider that allows it; full-desktop stream where supported = v1 HEADLINE (lands with foundation, not behind a flag). Client connects to terminal+file-browser+diff (Pierre trees + Pierre diff) wherever headless, noVNC desktop where supported. OS eventually selectable (Linux now). In-worker owner accepted for v1. Recommendation: stay on Modal primary, add Daytona OR Runloop as 2nd provider for resilience.

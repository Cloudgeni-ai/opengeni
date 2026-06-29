# Module: Security/auth/multi-tenancy + cost/billing/lifecycle + testing/rollout  (crosscut)

## Specification

# MODULE: Security/Auth/Multi-Tenancy + Cost/Billing/Lifecycle + Testing/Rollout

Implementation-grade spec for the cross-cutting layer of the OpenGeni sandbox-surfacing vision. Builds on the settled stateless-pool/lease architecture (the Postgres lease row is the sole singleton; workers are a stateless pool that resume the box by id per turn and drop the handle at turn end — there is no in-worker owner actor), the two-channel data path (A=event-bus SSE, B=direct-to-provider pixels), and the 7-provider matrix. Every artifact below is anchored to real code; line numbers are HEAD-accurate at time of writing (±a few lines on large files, symbol names exact).

---

## PART 1 — SECURITY / AUTH / MULTI-TENANCY

### 1.1 The auth invariant every new route MUST mirror

Every existing session route calls `requireAccessGrant(c, deps, workspaceId, <permission>)` (`apps/api/src/access/index.ts:31`) which: (1) resolves an `AccessContext` (401 if none), (2) finds the workspace grant or 403s, (3) `requirePermission` 403s on missing perm, where `hasPermission` treats `workspace:admin` as a super-permission (`access/index.ts:54-56`). The SSE read route uses `sessions:read`; client→agent control uses `sessions:control`.

**RULING: every new sandbox-surfacing route is workspace+session-scoped and MUST go through `requireAccessGrant` first, before any Zod parse, lease op, or box operation.** Per the AUTHORITATIVE CORRECTED MODEL the **control plane is API-direct**: every non-turn stream op (viewer attach, mint/rotate the desktop tunnel URL, FS list/read for the Pierre tree, Git status/diff, capability negotiation) is served **client → API → box** *in the `apps/api` process itself*. The API holds a sandbox client of its own (the prior "API holds no box client" invariant is intentionally relaxed for the control plane — `dependencies.ts` adds one field, a sandbox/Modal client built from settings, on top of `{db, bus, workflowClient, objectStorage}`). For these ops the API resolves the lease, runs the `cold→warming` CAS as a **Postgres transaction it owns**, `resume()`s the box **by id** from the group lease envelope in-process, calls `session.exec`/`readFile`/`resolveExposedPort` directly, and drops the handle on return — **no `signalWithStart`, no `openStreamRequest` signal, no viewer-attach activity, no `sandboxOwnerRpcWorkflow`, no worker RPC, and no NATS request-reply** in the synchronous control path. (Verified: `ModalSandboxClient.resume()` is per-call with no pool/singleton; the API already makes outbound HTTPS to Stripe/OpenAI/GitHub and owns Postgres; the sandbox-client functions have zero coupling to the agent-loop/Temporal code — `packages/runtime` has no `@temporalio` dep. The enabling refactor is the thin `@opengeni/runtime/sandbox` sub-export and the Modal token plumbed into the API's client construction — see `02-owner.md` §6.3 / `08-channel-a.md` §5.) **Temporal hosts exactly two things:** the long-running agent **turn** (`sessionWorkflow`) and **one global reaper Temporal Schedule** (Part 2.2/Part 4). Agent events still ride **worker → NATS → API-SSE → client** (NATS = events only); that async event bus is unchanged and is NOT a request-reply control-plane call.

### 1.2 New permissions (extend `Permission` enum)

`packages/contracts/src/index.ts:57-81`. Add three, and mirror in `packages/sdk/src/types.ts` `KNOWN_PERMISSIONS` (`:249`):

```ts
// packages/contracts/src/index.ts — append inside z.enum([...])
  "stream:view",          // open desktop/terminal viewer (Channel B negotiate + Channel A read)
  "stream:control",       // SEPARATE from view: send input to the desktop (raw write). v1: NEVER granted by default.
  "stream:acknowledge",   // accept the pixel-plane secret-leak acknowledgment (see 1.6)
```

Rationale for splitting `stream:view` from `sessions:read`: a viewer of pixels sees an UN-REDACTED live framebuffer (can show cloud creds in a terminal), which is a strictly broader exposure than the redaction-passed Channel-A event log. `sessions:read` ≠ permission to watch raw pixels. `stream:control` is its own permission because a raw-pty/input writer bypasses `approvalQueue`/`interrupt` (settled finding (h)) — it is **disabled in v1** and gated behind this permission for later hardening.

Route→permission map (all new routes):

| Route | Permission |
|---|---|
| `GET /workspaces/:wid/sessions/:sid/stream/capabilities` | `stream:view` |
| `POST /workspaces/:wid/sessions/:sid/stream/open` | `stream:view` |
| `POST /workspaces/:wid/sessions/:sid/stream/heartbeat` | `stream:view` |
| `DELETE /workspaces/:wid/sessions/:sid/stream/:viewerId` | `stream:view` |
| `POST /workspaces/:wid/sessions/:sid/stream/input` (v1: 403 always) | `stream:control` |
| `POST /workspaces/:wid/sessions/:sid/stream/acknowledge` | `stream:acknowledge` |

### 1.3 Scoped data-plane token (mint, claims, verify)

Reuse the existing HMAC envelope (`signDelegatedAccessToken`/`verifyDelegatedAccessToken`, `packages/contracts/src/index.ts:171-197`) — do NOT invent a second crypto. Add a sibling **stream token** payload with the same `ogd_`-style construction but a distinct prefix `ogs_` and a hard-narrow claim set:

```ts
// packages/contracts/src/index.ts — NEW, alongside DelegatedAccessTokenPayload (:158)
export const StreamTokenPayload = z.object({
  workspaceId: z.string().uuid(),
  sessionId:   z.string().uuid(),
  viewerId:    z.string().uuid(),       // identifies the sandbox_lease_holders row
  leaseEpoch:  z.number().int().nonnegative(),  // fence: token dies when the box is re-elected
  mode:        z.enum(["view", "control"]),     // v1 always "view"
  port:        z.number().int().positive(),     // 6080 (noVNC); pins the token to ONE exposed port
  exp:         z.number().int().positive(),     // short TTL: 120s default; URL rotation is event-driven (re-resolve recorded under the epoch fence), not on a keepalive clock
});
export type StreamTokenPayload = z.infer<typeof StreamTokenPayload>;

export async function signStreamToken(secret: string, p: StreamTokenPayload): Promise<string> {
  const enc = base64UrlEncode(JSON.stringify(StreamTokenPayload.parse(p)));
  return `ogs_${enc}.${await hmacSha256Base64Url(secret, enc)}`;
}
export async function verifyStreamToken(
  secret: string, token: string, now = Math.floor(Date.now() / 1000),
): Promise<StreamTokenPayload | null> { /* mirror verifyDelegatedAccessToken:177; reject if exp < now */ }
```

**Token boundaries (settled split-plane, finding (h)):**
- The token is a CLAIM the OpenGeni control plane mints; it is **not** the provider's tunnel secret. The browser receives `{ providerUrl, streamToken }`. The provider tunnel URL (Modal `tunnels()` → `{host,port,tls}`, Blaxel scoped-preview-token query, e2b `getHost(port)`) is the transport; the `streamToken` is what websockify/the in-box edge validates **on connect AND on TTL** — auth is enforced at the data-plane edge, not by URL secrecy.
- v1 reality: x11vnc runs `-nopw` (settled desktop-stack), and websockify in v1 is `-nopw`/no-token. **So in v1 the real auth boundary is (a) the short-TTL provider tunnel URL + (b) OpenGeni only handing that URL to a `stream:view`-authorized + acknowledged viewer.** The `streamToken` is minted, returned, and recorded against the holder row from day one so the later-hardening step (websockify `--token-plugin TokenFile --token-source`, re-read per connection, mapping `streamToken`→backend) is a config swap, not a redesign. **Document this gap explicitly in v1**: the box edge does not yet cryptographically verify the token; the URL's TTL + provider tunnel are the v1 boundary.
- `leaseEpoch` in the claim is the fence: when the box is re-elected (`warming→warm` bumps `lease_epoch`, settled), the new data-plane URL is re-minted with `epoch+1`; the old token is logically dead because its URL points at a torn-down tunnel. Reaping a holder also invalidates its viewer URL.

### 1.4 Read-only default (the input plane is OFF in v1)

Settled finding (h): READ-ONLY desktop, raw-pty write disabled. Concrete enforcement:

1. The in-box stream stack runs x11vnc in **view-only fan-out** for viewers. v1 ships `x11vnc -shared` (viewers see pixels) but the agent is the SOLE input source via `xdotool` over the exec channel (the `Computer` interface). No viewer input path exists in v1.
2. `POST /stream/input` is registered but returns `403 { code: "stream_control_disabled" }` **unconditionally in v1** (even with `stream:control`), behind a `settings.streamControlEnabled` flag defaulting `false`. This makes the later-hardening enablement a flag flip + websockify input-routing change, with the permission already in place.
3. `mode: "control"` in `StreamTokenPayload` is rejected by the mint endpoint in v1 (`if (mode === "control" && !settings.streamControlEnabled) throw 403`).

### 1.5 Revocation → reap (grant loss must kill the box link)

The existing revocation primitives: `revokeApiKey` (`packages/db/src/index.ts:500`) sets `revokedAt`; grants resolve live per-request via `getWorkspaceGrant` (`:438`), and delegated/stream tokens are short-TTL HMAC (not DB-checked per use). **Therefore revocation must actively reap, not wait for token expiry.** Wiring:

- A new DB op `reapViewerHoldersForSubject(db, workspaceId, sessionId, subjectId)` deletes matching `sandbox_lease_holders` rows of `kind='viewer'` and recomputes `refcount` (the settled reaper recompute). It is called from:
  - the `DELETE /stream/:viewerId` route (explicit close),
  - `revokeApiKey` and any grant-mutation path (when a subject loses `stream:view`, sweep its viewer holders),
  - the stale-heartbeat `reapStaleLeaseHolders` reaper (settled, ~90s TTL).
- When `refcount→0` with `turn_holders=0`, the settled `warm→draining→cold` path: the per-turn handle was already dropped at the last turn's end (workers are stateless — no held handle to release), the envelope is already upserted per turn, and at refcount 0 (after the short drain grace) the **stateless reaper issues the provider's existing `stop()`/terminate** (prompt cost-stop); the provider idle-timeout (`modalTimeoutSeconds`, `config:241`) is the backstop for any leaked/missed box. **Revocation thus collapses to the existing reap primitive** — finding (h) "tie grant-revocation to holder reap" is satisfied by routing revocation through `reapViewerHoldersForSubject`.
- Token short TTL (120s) bounds the worst case where a viewer keeps a *cached* URL after revocation: an event-driven `resolveExposedPort` re-resolve (run in-process by whichever holds the lease for the op — the **API** for a non-turn mint/rotate, a worker for a turn; recorded in the lease under the epoch fence) re-mints with a new epoch and the old tunnel is torn down.

### 1.6 Pixel-plane secret-leak risk + opt-in acknowledgment

Settled: the pixel plane is **un-redacted** (Channel A passes redaction at `apps/worker/test/redaction.test.ts`; Channel B does not — the agent can `cat` a secret into a terminal the viewer sees). Therefore desktop view is **opt-in/acknowledged, never a silent default.**

Mechanism:
- New column on `sessions` (or a new `session_stream_acknowledgments` row keyed `(workspaceId, sessionId, subjectId)`) recording acknowledgment. Prefer the separate table for per-subject granularity:

```sql
CREATE TABLE session_stream_acknowledgments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id)       ON DELETE CASCADE,
  session_id    uuid NOT NULL REFERENCES sessions(id)         ON DELETE CASCADE,
  subject_id    text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, session_id, subject_id)
);
```
- `POST /stream/open` checks for an ack row; if absent, returns `409 { code: "acknowledgment_required" }`. The client surfaces the warning ("Live desktop shows un-redacted screen contents, including any secrets the agent displays"), the user accepts → `POST /stream/acknowledge` (perm `stream:acknowledge`) inserts the row → retry open.
- `GET /stream/capabilities` returns `DesktopStream.requiresAcknowledgment: true` and `acknowledged: <bool>` so the client can pre-gate the UI.

### 1.7 v1-pragmatic vs later-hardening list

| Concern | v1 (pragmatic) | Later hardening |
|---|---|---|
| Box-edge token verify | URL TTL + provider tunnel are the boundary; websockify `-nopw` | websockify `--token-plugin TokenFile`, re-read per connection; KasmVNC `-PasswordFile` |
| Input/control | `stream:control` exists but `/stream/input`→403; read-only fan-out | flip `streamControlEnabled`; route input through websockify; single-writer arbitration vs agent |
| Multi-viewer isolation | single-tenant box, x11vnc `-shared`, all viewers see same display | per-viewer cursor namespacing / view-only RFB per connection |
| Secret redaction on pixels | acknowledgment gate; un-redacted | optional on-box redaction overlay / blur-on-secret-pattern |
| Token rotation | epoch-fenced, 120s TTL, event-driven re-resolve under the epoch fence | push `stream.url.rotated` SSE (NEW `SessionEventType` literal — see H1) so viewer reconnects seamlessly |
| Tenant cross-talk | unique `(workspace_id, session_id)` lease + RLS on all reads | provider-level network policy (vercel `networkPolicy`, e2b `allowInternetAccess:false`) |
| Audit | usage events (Part 2) record open/close | full per-frame access log if compliance demands |

---

## PART 2 — COST / BILLING / LIFECYCLE METERING

### 2.1 The structural problem: viewer-held compute has no billable turn

Today every cent is metered inside the agent-turn activity: `recordModelUsageAndDebitCredits` (`apps/worker/src/activities/agent-turn.ts:948`) and `ensureRunAllowed` (`:913`) fire per model response. **A warm box held open by a viewer with NO agent turn running emits ZERO usage events** — the box bills the provider by wall-clock but OpenGeni meters nothing. This is the headline cost hole the lease design opens (viewer-only liveness is the lease refcount over the group lease, refreshed by app-level viewer heartbeats; a viewer-held box still costs and so must still be metered).

### 2.2 Warm-time metering (new usage event types)

Extend `UsageEventType` (`packages/contracts/src/index.ts:249`) and mirror in `packages/sdk/src/types.ts`:

```ts
// packages/contracts/src/index.ts — append to UsageEventType enum
  "sandbox.warm_seconds",   // wall-clock seconds the box was warm (the billable warm-time meter)
  "sandbox.warm_cost",      // usd_micros, warm-seconds × per-provider per-second rate
  "sandbox.spawned",        // count: a cold→warm spawn (provider create cost, e.g. cold-start)
  "sandbox.snapshot",       // count: a snapshot-rollover (Modal 24h) or suspend/resume cycle
```

**Metering mechanism — stateless-tick accrual.** Warm-time accrues on **two stateless ticks** (there is no `ownerHeartbeat` activity and no keepalive loop): (1) the **turn's** existing 30s Temporal activity heartbeat, while a turn runs; and (2) the **reaper sweep** — the **ONE global reaper Temporal Schedule** (period `sandboxReaperPeriodMs`, the same single Schedule that does the refcount-0 terminate + viewer-TTL reap + warming-death reset), for viewer-only boxes between turns. Each tick records the warm-seconds delta since the last tick, idempotent on a monotonic `(group, epoch, tick)` index:

```ts
// in the turn-heartbeat path and the reaper sweep (apps/worker/src/activities, stateless)
const elapsedS = Math.round((now - lease.lastMeterAt) / 1000);
if (elapsedS > 0) {
  await recordUsageEvent(db, {
    accountId, workspaceId,
    eventType: "sandbox.warm_seconds",
    quantity: elapsedS, unit: "seconds",
    sourceResourceType: "sandbox_lease",
    sourceResourceId: `${sandboxGroupId}:${lease.leaseEpoch}`,   // group-keyed (shared-sandboxes re-key); one meter stream per group
    idempotencyKey: `usage:sandbox.warm_seconds:${sandboxGroupId}:${lease.leaseEpoch}:${tickIndex}`,
  });
  // cost = elapsedS × providerWarmRateMicrosPerSecond(backend); same shape as model.cost (:983)
  if (shouldDebit) await recordUsageEvent(db, { /* sandbox.warm_cost, usd_micros */ });
  // update lease.lastMeterAt / lease.lastMeterTick in the same FOR UPDATE write
}
```

`recordUsageEvent` (`packages/db/src/index.ts:588`) is `onConflictDoNothing` on `idempotencyKey` (`:612`) — so a re-dispatched tick (turn-heartbeat retry or an overlapping reaper sweep) cannot double-bill the same `(group, epoch, tick)`. Crediting reuses `applyCreditDebitUpToBalance` (`:695`) exactly as model cost does (`agent-turn.ts:994`).

**`ensureRunAllowed` gating extends to warm-time:** a viewer-only box that has exhausted credits must drain. Add to the warm-meter tick (turn-heartbeat / reaper sweep): if `billingMode==="stripe"||usageLimitsMode==="managed"` and `getBillingBalance(db, accountId).balanceMicros <= 0`, force `warm→draining` (CAS-guarded `AND turn_holders=0` so a paying agent turn is never killed); the reaper then issues the provider's existing `stop()` at refcount 0. This mirrors `ensureRunAllowed` (`agent-turn.ts:913-919`) but on the warm-time path.

### 2.3 Keep-warm policy + caps (new settings)

`packages/config/src/index.ts` — add after the modal block (`:241`), with `OPENGENI_*` env mappings after `:481` and validation after `:986`:

```ts
// Settings schema additions
  streamControlEnabled: z.coerce.boolean().default(false),               // 1.4
  sandboxKeepWarmMs:    z.coerce.number().int().nonnegative().default(0), // idle grace after refcount→0 before drain; 0 = drain immediately
  sandboxViewerHolderTtlMs: z.coerce.number().int().positive().default(90_000),
  sandboxReaperPeriodMs:    z.coerce.number().int().positive().default(30_000),
  sandboxMaxWarmSecondsPerSession: z.coerce.number().int().nonnegative().default(0), // 0 = unbounded; cap → force drain
  sandboxMaxConcurrentWarmPerWorkspace: z.coerce.number().int().nonnegative().default(0), // 0 = unbounded
  sandboxWarmRateMicrosPerSecondJson: z.string().default("{}"),          // per-backend usd_micros/sec, like modelPricingJson (:192)
  modalIdleTimeoutSeconds: z.coerce.number().int().positive().optional(), // the unmapped Modal idleTimeoutMs gap (GROUND:wiring)
  // NOTE: there is NO sandboxKeepAliveIntervalMs — workers are stateless, there is no keepalive loop. Between turns the box
  // survives on the provider's existing idle-timeout (modalTimeoutSeconds, config:241); the reaper stop()s it at refcount 0.
```

**Boot-validated invariant** (settled): `reaperPeriod < viewerHolderTTL < modalIdleTimeout`. (No keepalive clause — there is no keepalive interval to bound; the box rides the provider idle-timeout between turns.) Add a cross-field check (mirror the Modal token both-or-neither at `:985`):

```ts
if (settings.sandboxReaperPeriodMs >= settings.sandboxViewerHolderTtlMs) throw new Error("reaperPeriod must be < viewerHolderTTL");
const modalIdleMs = (settings.modalIdleTimeoutSeconds ?? settings.modalTimeoutSeconds) * 1000;
if (settings.sandboxViewerHolderTtlMs >= modalIdleMs) throw new Error("viewerHolderTTL must be < modalIdleTimeout");
```

**Caps enforcement:**
- `sandboxMaxWarmSecondsPerSession`: the warm-meter tick (turn-heartbeat / reaper sweep) checks `SUM(warm_seconds for this group)` (reuse `sumUsageQuantity`, `db/index.ts:640`) and forces `warm→draining` past the cap; the reaper then `stop()`s at refcount 0.
- `sandboxMaxConcurrentWarmPerWorkspace`: enforced in the **acquire** critical section — inside the `FOR UPDATE` txn for a *new* spawn (`cold→warming`), count `sandbox_leases WHERE workspace_id=$w AND liveness IN ('warming','warm')`; if `>= cap`, reject the spawn with a typed error surfaced to the route as `429 { code: "warm_sandbox_cap_reached" }`. Existing-warm attaches are never blocked.

### 2.4 Per-provider cost shape (the warm-rate table)

`sandboxWarmRateMicrosPerSecondJson` carries the per-backend rate; the warm-cost meter multiplies. Cost shapes (drives the rate config and the keep-warm/suspend policy per provider):

| Provider | Warm cost shape | Suspend/resume savings | Spawn cost | Notes |
|---|---|---|---|---|
| **modal** (primary) | per-second running compute; **hard 24h lifetime → snapshot-rollover** (`snapshotFilesystem`, `modal/sandbox.d.ts`) | No cheap suspend; the idle clock is the provider's own `modalTimeoutSeconds` (`config:241`) — **no exec keep-alive**; between turns the box rides the provider idle-timeout and the reaper `stop()`s it at refcount 0. Snapshot-rollover = stop billing the old box, new `sandboxId` (brief desktop blink) | container create (cold-start) | **24h rollover is a recurring cost+UX event**: meter `sandbox.snapshot` per rollover; the rollover is a *lifetime ceiling*, not an idle knob — re-resume the box *before* 24h |
| **runloop** | per-second running | **native `suspend()`** (`runloop/sandbox.d.ts:72`, `suspendTimeoutMs:93`) → billed-suspended (disk only) → `resume()`. **The biggest warm-time saver.** Suspend gated behind Pro tier | devbox create | keep-warm policy on runloop should **suspend, not drain**, when idle-but-likely-to-return |
| **e2b** | per-second; 24h(Pro)/1h(Hobby) | `pause()` (`timeoutAction:'pause'`) → paused state, cheaper; `autoResume` | template instantiate | pause is the e2b analog of suspend |
| **daytona** | per-second; `autoStopInterval` idle-kill (set `0` to disable) | `stop()` then restart (slower than suspend) | ~27-90ms cold start (cheapest spawn) | tar-only snapshot |
| **blaxel** | per-second; `ttl`/`pauseOnExit` | tar-only, no native suspend | template instantiate | |
| **cloudflare/vercel** | headless-only; no warm desktop | n/a | n/a | warm-time metering still applies to headless boxes held by terminal viewers |

**Policy ruling:** keep-warm is `drain | suspend` per provider. Define `sandboxIdlePolicy(backend): "drain" | "suspend"`:
- runloop/e2b → `"suspend"` (cheap, native) when idle past `sandboxKeepWarmMs`; resume on next viewer/turn.
- modal/daytona/blaxel → `"drain"` (persist envelope, drop handle) past `sandboxKeepWarmMs`; cold-resume from envelope on return.
- The `draining→cold` path already upserts the envelope per turn (settled); the suspend path is a stateless `suspendBox(services, ids)` helper (any worker, invoked from the reaper at the idle threshold) calling `session` suspend/pause, recording `sandbox.snapshot`, and writing lease `liveness='cold'` with the suspended `instance_id` retained for fast resume.

**Modal 24h rollover cost (explicit):** the rollover is driven off the box's create-time (a lifetime ceiling, not an idle clock): the reaper (or the next turn that observes the box is near its 24h lifetime) calls `snapshotFilesystem()` → new box → re-resume-from-envelope → re-run the desktop chain (settled re-establish primitive, any worker) → bump `lease_epoch` → push `stream.url.rotated`. Meter `sandbox.snapshot` (count) + the new box's spawn. This is a *guaranteed* recurring cost for any session living >24h on Modal.

### 2.5 Lifecycle accounting summary

- **turn-time** (existing): metered by model tokens/cost in agent-turn (`:948`). Unchanged.
- **warm-time** (new): metered by the stateless warm-meter tick (turn-heartbeat while a turn runs / reaper sweep for viewer-only boxes) into `sandbox.warm_seconds`/`sandbox.warm_cost`. Covers viewer-only liveness.
- **Overlap is correct**: a box warm during an agent turn bills BOTH model tokens AND warm-seconds — they are orthogonal (model API cost vs provider compute cost), both real.
- **No double-count within warm-time**: idempotency `usage:sandbox.warm_seconds:<group>:<epoch>:<tick>` (group-keyed under the shared-sandboxes re-key) guarantees one accrual per tick per epoch even under re-dispatch (turn-heartbeat retry or an overlapping reaper sweep).

---

## PART 3 — TESTING / SPIKES

Test tiers exist already (root `package.json:30-34`): `bun test` (unit), `test:integration` (`test/integration/*.integration.ts` with `@opengeni/testing` `startTestServices` — real Temporal+NATS+pg+object-storage), `test:e2e` (`test/e2e/sandbox.e2e.ts` builds a real Docker sandbox image), `test:live` (`test/live/providers.live.ts` — real provider SDKs). The harness (`@opengeni/testing`) gives `startTestServices`, `migrate()`, `freePort`, `startProcess`, `buildSandboxImage`, `waitFor` (cited `test/e2e/sandbox.e2e.ts:1-25`). All new tests slot into these tiers.

### 3.1 Lease race tests (unit + integration — the singleton invariant)

The lease is the SOLE singleton enforcer; these are the highest-value tests. New file `test/integration/sandbox-lease.integration.ts` (real pg, mirrors `db.integration.ts`):

```
T1  concurrent-acquire-cold:      N parallel acquire(turn) + acquire(viewer) on a cold lease →
                                  EXACTLY ONE cold→warming winner; all others observe warming then attach
                                  same instance_id. Assert single spawn (spy on the resume-by-id/spawn count == 1).
T2  acquire-vs-drain race:        viewer acquires while refcount→0 drain in flight → draining→warm re-arm,
                                  NO second box (closes the drain-vs-arrive window, finding (g)).
T3  release idempotency:          release the same holder twice → refcount unchanged after first (delete-my-row).
T4  warming-spawner-death TTL:    set liveness='warming', advance clock past warming-TTL → reaper resets
                                  warming→cold; next acquire wins clean (finding (a) uncaught-death).
T5  epoch fence:                  hold a stale handle at epoch E; bump lease to E+1; stale write with
                                  WHERE lease_epoch=E affects 0 rows → the stale (re-dispatched) writer backs off (finding (c)).
T6  reap-stale-viewer:            insert viewer holder with old last_heartbeat_at → reapStaleLeaseHolders
                                  deletes it, recomputes refcount, drains at 0 (finding (f) closed laptop).
T7  turn-holder-TTL-exempt:       long turn, expires_at refreshed on 30s heartbeat → reaper's
                                  warm→draining CAS (AND turn_holders=0) never fires (finding (d)).
T8  revocation reap:              reapViewerHoldersForSubject drops the subject's viewer holders → refcount
                                  recompute → drain (Part 1.5).
T9  warm-cap reject:              acquire a new spawn at sandboxMaxConcurrentWarmPerWorkspace → 429-typed
                                  error; an attach to existing warm still succeeds (Part 2.3).
```

The unit-level subset (no DB) tests the state-machine transition function in isolation (`cold→warming→warm→draining→cold`, all settled transitions incl. `warming→cold`, `draining→warm`, release-during-warming) as a pure reducer, the way `agent-turn.test.ts` tests `historyRowsToAppend` purely.

### 3.2 The fan-out load test (many noVNC viewers / one port — THE headline risk)

Settled: **R6 per-port viewer fan-out has no published cap on any provider** — the single biggest unvalidated risk. New file `test/live/desktop-fanout.live.ts` (live tier, real provider). Methodology:

```
1. Spawn ONE real desktop box (Modal primary, then daytona/e2b/runloop/blaxel).
2. resolveExposedPort(6080) → tunnel URL.
3. Ramp synthetic RFB-over-WS clients (headless ws clients speaking the noVNC handshake,
   NOT full browsers — use a minimal RFB client to keep the load-gen cheap) from 1 → 200.
4. For each step measure: connect-success rate, first-framebuffer latency, per-frame update
   latency p50/p95/p99, in-box CPU (x11vnc -shared cost), and the point where the PROVIDER
   tunnel (not x11vnc) starts dropping/throttling connections.
5. Record the empirical per-port cap per provider → feeds a `maxViewersPerSession` config cap.
```

Companion controlled run in CI-able form: `test/e2e/desktop-fanout.e2e.ts` against a **local Docker** desktop image (the v1 Dockerfile from GROUND:desktop-stack) to validate x11vnc `-shared` + websockify fan-out behavior deterministically (no provider), ramping to e.g. 50 viewers, asserting all connect and frame-latency stays bounded. This isolates "is it x11vnc or is it the provider tunnel" — the local run proves x11vnc `-shared` scales; the live run measures the provider ceiling.

**Knobs the test sweeps** (from GROUND:desktop-stack): x11vnc `-wait` (50ms default = 20fps ceiling, the single biggest latency knob), `-noxdamage` under Xvfb, `-speeds lan`. Output: a per-provider fan-out cap + recommended `-wait` value.

### 3.3 Desktop-on-gVisor render spike (does the image actually draw under gVisor?)

New file `test/e2e/desktop-render.e2e.ts` and a live variant. This is a SPIKE (validate-or-kill), not a regression test. Steps:

```
1. Build the v1 desktop image (Xvfb :0 24-bit → XFCE4+dbus → x11vnc -shared → websockify+noVNC :6080).
2. On the target runtime (gVisor: Modal/E2B), via the externally-owned client.exec, run the
   startup chain (NOT container CMD — settled: the per-turn resume path runs it post-create/post-resume, idempotently).
3. Gate xdpyinfo -display :0 == exit 0 (Xvfb up).
4. Launch Chromium with --no-sandbox --disable-dev-shm-usage --use-gl=angle --use-angle=swiftshader
   (gVisor: no GPU, restricted /dev/shm — these flags are REQUIRED, settled).
5. scrot --pointer /tmp/s.png → assert non-black, non-trivial PNG (e.g. byte-entropy or a known
   XFCE pixel signature). This is the "does it actually render" gate.
6. Drive the SDK Computer interface (environment:'ubuntu', dimensions:[1024,768]):
   click/move(--sync)/type/keypress → screenshot → assert the screen changed.
7. ffmpeg -f x11grab -draw_mouse 1 ... → assert a playable MP4 (the verification-video path).
```

Pass criteria = the four desktop gates (R1 custom-image-root, R2 port→WS URL, R3 hold-open+kill, R6 fan-out — the latter handed to 3.2). Run per desktop-capable provider in the live tier; **Cloudflare/Vercel are asserted to THROW on `resolveExposedPort`** (negative test confirming headless-only, `cloudflare/sandbox.js:264`).

### 3.4 Per-provider integration tests (the createSandboxClient matrix)

New file `test/live/providers-sandbox.live.ts` (extends `test/live/providers.live.ts`). For each of the 7 backends, parametrized:

```
P1  construct:        createSandboxClient({sandboxBackend:<p>, ...creds}) → defined, backendId===<p>.
P2  exec round-trip:  session.exec("echo hi") → "hi" (all 7).
P3  file round-trip:  createEditor → write → read → delete (all 7; the RemoteSandboxEditor primitive).
P4  envelope:         serializeSessionState → deserializeSessionState → resume by id (backendId assertion
                      at runtime/src/index.ts:1654 fences cross-provider). Modal: fromId no-lock (R4).
P5  port resolve:     desktop-capable → resolveExposedPort(6080) returns {host,port,...};
                      cloudflare/vercel → throws SandboxUnsupportedFeatureError (negative).
P6  pty:              supportsPty() matches the matrix (modal/cloudflare true; runloop/vercel false;
                      e2b/daytona/blaxel runtime-conditional → terminal-as-events tier check).
P7  resume-no-create: kill the box, resume → recreate ONLY on provider NotFound (assertResumeRecreateAllowed,
                      shared/session.js:76); transient error → NO create (the "never create on conflict" rule).
P8  warm-meter:       hold box, run the warm-meter tick (reaper sweep / turn-heartbeat) twice → exactly 2
                      sandbox.warm_seconds events, idempotent on (group, epoch, tick); cost = seconds × rate.
P9  suspend/resume:   runloop/e2b only → suspend() → resume() → state intact; sandbox.snapshot metered.
```

These are gated by per-provider credentials (skip if env unset, like the existing live tier). Modal is non-skippable in CI-live (primary).

### 3.5 Cross-cutting auth/billing tests (unit + integration)

New `apps/api/test/stream-routes.test.ts` and `test/integration/stream-auth.integration.ts`:

```
A1  every new route 401s without auth, 403s without stream:view (mirror app.test.ts).
A2  /stream/open 409 acknowledgment_required without ack row; 200 after /stream/acknowledge.
A3  /stream/input → 403 stream_control_disabled in v1 (streamControlEnabled=false).
A4  stream token: signStreamToken→verifyStreamToken round-trip; expired→null; tampered→null;
    wrong epoch claim rejected at the (future) edge.
A5  warm-time billing: ensureRunAllowed-equivalent on warm tick drains a 0-balance viewer-only box
    but NEVER a box with turn_holders>0 (CAS guard).
A6  workspace isolation: a viewer of workspace A cannot open/heartbeat a session in workspace B
    (extend workspace-isolation.integration.ts).
```

---

## PART 4 — ROLLOUT

### 4.1 Migrations (drizzle-kit; `bun src/migrate.ts`)

Migration tooling: `drizzle-kit generate` then `bun src/migrate.ts` (`packages/db/package.json:9-10`); numbered files in `packages/db/migrations/` (latest `0016_session_create_idempotency.sql`) with a `meta/_journal.json`. The `SandboxBackend` enum needs **no** migration (free-text columns, GROUND:wiring §2). New migrations, in dependency order:

```
0017_sandbox_leases.sql              CREATE TABLE sandbox_leases (uniqueIndex (workspace_id, session_id))
                                     + sandbox_lease_holders (one row/holder). [Module: lease — depended on by all]
0018_session_stream_acknowledgments.sql  CREATE TABLE session_stream_acknowledgments. [Module: security 1.6]
                                     (No new usage_events table — warm-time reuses usage_events; only enum
                                      literals in contracts change, which is code-only.)
```

`sandbox_leases` / `sandbox_lease_holders` DDL (mirrors `sandbox_session_envelopes` FK chain, `schema.ts:360`; settled DDL in GROUND:prior-docs §A — reproduced as the migration target):

```sql
CREATE TABLE sandbox_leases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id)       ON DELETE CASCADE,
  session_id      uuid NOT NULL REFERENCES sessions(id)         ON DELETE CASCADE,
  liveness        text NOT NULL DEFAULT 'cold',   -- cold|warming|warm|draining
  refcount        integer NOT NULL DEFAULT 0,
  turn_holders    integer NOT NULL DEFAULT 0,     -- TTL-exempt
  viewer_holders  integer NOT NULL DEFAULT 0,     -- TTL-reapable
  instance_id     text,
  data_plane_url  text,                           -- viewers connect directly; re-resolved event-driven under the epoch fence
  backend         text,                           -- pins provider for envelope re-resume
  lease_epoch     integer NOT NULL DEFAULT 0,
  last_meter_at   timestamptz,                    -- warm-time accrual cursor (Part 2.2)
  last_meter_tick integer NOT NULL DEFAULT 0,
  expires_at      timestamptz,                    -- heartbeat-TTL
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sandbox_leases_session_uq UNIQUE (workspace_id, session_id)  -- THE singleton enforcer
);
CREATE TABLE sandbox_lease_holders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id         uuid NOT NULL REFERENCES sandbox_leases(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id)     ON DELETE CASCADE,
  kind             text NOT NULL,                 -- 'turn' | 'viewer'
  holder_id        text NOT NULL,                 -- turn: turnId; viewer: viewerId
  subject_id       text,                          -- for revocation reap (Part 1.5)
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sandbox_lease_holders_uq UNIQUE (lease_id, kind, holder_id)
);
CREATE INDEX sandbox_lease_holders_lease_idx ON sandbox_lease_holders(lease_id);
CREATE INDEX sandbox_lease_holders_stale_idx ON sandbox_lease_holders(kind, last_heartbeat_at);
```

RLS: both tables get the workspace RLS policy every workspace-scoped table has (mirror `sandbox_session_envelopes`); all lease ops go through `withWorkspaceRls`/`withRlsContext` like `claimNextQueuedTurn` (`db/index.ts:3078`).

**Migration safety:** all additive (new tables, new enum literals, new nullable columns, new settings with defaults). No backfill, no column drops, forward-compatible — old workers ignore the new tables; the feature is dark until the worker code paths are deployed. **Deploy DB migration first, then workers, then API, then web** (standard expand-then-use ordering; the new routes 404 harmlessly until the API ships, and the API gracefully degrades `DesktopStream:{transport:null}` until workers populate `data_plane_url`).

### 4.2 Feature gating

| Gate | Mechanism | Default |
|---|---|---|
| Whole feature (lease + stateless resume-by-id active) | `settings.sandboxOwnershipEnabled` (new config bool; the rollout knob) → when false, `runAgentStream` keeps building per-run client (current behavior); when true, the stateless lease + resume-by-id + inject-non-owned path runs (any pool worker resumes the box by id per turn, drops the handle at turn end) | `false` initially, flip to `true` per environment after staging soak |
| Desktop stream (headline) | NOT behind a flag (settled: lands with the foundation). Gated only by provider capability (`resolveExposedPort` real) + acknowledgment | on where supported |
| Stream control (input) | `settings.streamControlEnabled` | `false` (v1) |
| Suspend-vs-drain | `sandboxIdlePolicy(backend)` + per-provider | per matrix (2.4) |
| New providers | `SandboxBackend` enum + `createSandboxClient` branch; per-session/per-turn override already flows (`turn.sandboxBackend`, GROUND:wiring §2) | added incrementally |

The ownership-inversion seam is backward-compatible: `RunAgentStreamOptions.sandboxClient`/`.session` injection means `sandboxOwnershipEnabled=false` is exactly today's code path (build+discard per run). This makes the cutover reversible per environment.

### 4.3 The v1 build ORDER (desktop is the headline → it lands, but on a correct foundation)

The dependency graph forces this order. Desktop is the headline but it sits on top of the lease + stateless resume-by-id + inversion; building desktop first would have nothing to attach to. Strict order:

```
PHASE 0 — Provider registration (no behavior change, fully shippable alone)
  [contracts/deployment SandboxBackend enums] → [config per-provider settings + env + validation]
  → [createSandboxClient branches + peer-dep SDKs] → [environment.ts backend-aware HOME]
  → [storage×backend mount/signed-download matrices]. Unit + P1-P3 provider tests.
  Outcome: all 7 providers constructible; headless terminal/file/git works on each (Channel A only).
  Ships independently; de-risks the provider matrix before any lease work.

PHASE 1 — Lease + stateless resume-by-id + ownership inversion (the load-bearing foundation; NO user-visible change yet)
  [migration 0017 sandbox_leases/_holders] → [db lease ops: acquireLease/releaseLease/reap, the
   FOR UPDATE + cold→warming CAS + epoch fence, modeled on claimNextQueuedTurn:3077]
  → [stateless resumeBoxForTurn helper (any pool worker): resume-by-id from the group envelope
     (warm reattach or cold-restore), ensureDisplayStack/exposeStreamPort, returns the live handle]
  → [OWNERSHIP INVERSION in runtime/src/index.ts: RunAgentStreamOptions accepts {client,session,
     sessionState}; runOptions.sandbox prefers injected over createSandboxClient:1006/1044 — inject NON-OWNED]
  → [turns dispatch on the EXISTING global queue; the activity resolves the lease, resumes-by-id, injects
     non-owned, runs runAgentSegment, releases the turn holder AND drops the in-memory handle in finally]
  → [stateless reaper (Temporal Schedule): TTL-reap viewer holders, reset warming-death, warm-meter tick,
     and at refcount 0 issue the provider's existing stop() — the box rides the provider idle-timeout between turns]
  → [recovery primitive: re-establish-from-envelope-under-CAS, any worker, 3 detectors].
  Gate behind sandboxOwnershipEnabled. Lease race tests (3.1), worker-restart integration.
  Outcome: singleton box correctly shared by turns (concurrently, last-writer-wins); refcount lifecycle correct; STILL no viewer.

PHASE 2 — Cost/billing for warm-time (must precede opening boxes to viewers, or warm-time bills nothing)
  [contracts UsageEventType: sandbox.warm_seconds/warm_cost/spawned/snapshot]
  → [warm-meter accrual on the two stateless ticks (turn-heartbeat + reaper sweep), idempotent on (group,epoch,tick)]
  → [keep-warm settings + caps + boot invariant validation]
  → [suspend-vs-drain policy + stateless suspendBox for runloop/e2b]
  → [warm-time ensureRunAllowed gating (drain 0-balance viewer-only)].
  Billing tests (A5, P8-P9). Outcome: every warm second is metered before viewers can hold boxes warm.

PHASE 3 — Security/auth control plane (must precede exposing pixels)
  [Permission: stream:view/control/acknowledge + sdk mirror]
  → [StreamTokenPayload + sign/verifyStreamToken]
  → [migration 0018 session_stream_acknowledgments]
  → [stream routes behind requireAccessGrant: capabilities/open/heartbeat/close/input(403)/acknowledge]
  → [reapViewerHoldersForSubject wired into revokeApiKey + reaper + DELETE route]
  → [SessionCapabilities contract + ClientConfig desktop/headless advertisement].
  Auth tests (A1-A6). Outcome: the control plane can authorize, acknowledge, mint, and revoke — but no
  pixels flow yet (no desktop image).

PHASE 4 — Desktop image + pixel plane (THE HEADLINE; everything above is now its foundation)
  [v1 desktop Dockerfile: Xvfb/XFCE4/x11vnc/websockify/noVNC/xdotool/scrot/ffmpeg, GROUND:desktop-stack]
  → [ensureDisplayStack/exposeStreamPort (stateless, any worker): run the chain post-create + post-resume/rollover,
     idempotently under the lease (part of envelope replay)]
  → [resolveExposedPort(6080) → urlForExposedPort → data_plane_url; per-provider tunnel path
     (Modal tunnels / Blaxel scoped-preview-token / e2b getHost); viewers connect DIRECTLY to data_plane_url]
  → [Computer interface impl (environment:'ubuntu') for agent input; stream.url.rotated SSE push]
  → [Modal 24h snapshot-rollover (lifetime ceiling, reaper/next-turn driven) + sandbox.snapshot metering].
  Render spike (3.3), fan-out load test (3.2 — THE risk gate before GA). 
  Outcome: full-desktop noVNC viewer lands as the v1 headline.

PHASE 5 — Client surfacing (React) — rides Channel A spine + the negotiated capability
  [react timeline/hooks: useStreamCapabilities, noVNC viewer component, Pierre file-tree + diff for
   terminal/file/git tier] → [web wiring]. (Channel A needs no transport changes — GROUND:capability-pattern.)
```

**Gate between phases (checklists):**

- **Exit Phase 1**: lease race tests T1-T9 green; worker-restart integration shows a requeued turn re-resumes the box by id on any pool worker, and a viewer-only box survives on the provider idle-timeout until the reaper `stop()`s it at refcount 0 (finding (b)); `sandboxOwnershipEnabled=true` in staging soaks 48h with no double-spawn (assert via a metric on resume-by-id/spawn count vs distinct group-epochs).
- **Exit Phase 2**: `sandbox.warm_seconds` accrues exactly once per tick under induced worker restart; 0-balance viewer-only box drains; caps reject at the limit.
- **Exit Phase 3**: all stream routes 401/403 correctly; acknowledgment gate works; revocation reaps within `viewerHolderTTL`.
- **Exit Phase 4 (GA gate)**: render spike passes on Modal + ≥1 second desktop provider; **fan-out load test establishes a real per-port cap and `maxViewersPerSession` is set below it with margin** (this is the single biggest unvalidated risk — do NOT GA the headline without it); Modal 24h rollover re-establishes the desktop chain and re-mints the URL with no manual intervention.

### 4.4 Deployment package touch-points (per-provider env rendering)

`packages/deployment/src/index.ts`: extend the per-backend required-env blocks at `:863` (`requiredRuntimeEnvVars`) and `:1419` (`buildRuntimeEnv`) — currently a single `if (backend === "modal")`. Add analogous blocks for daytona/runloop/e2b/blaxel/cloudflare/vercel pushing each provider's required secret env (per the GROUND:wiring config table) and the new sandbox/keep-warm/cap settings. Add `sandbox-readiness` style deploy check coverage for the new desktop-capable profiles. Helm `config.OPENGENI_SANDBOX_BACKEND` unchanged; new `OPENGENI_SANDBOX_*` / `OPENGENI_STREAM_*` keys rendered through the same `valueEnv`/`requiredEnv` machinery.

### 4.5 Agent distribution for deployed envs — "the agent ships inside the control-plane" (OWNED DECISION)

The self-hosted/BYO-compute `opengeni-agent` (the Rust binary a customer machine runs to enroll into a workspace; dossier §17 / §23.x agent-distribution) needs a download source the install scripts can pull. The ruling for **deployed** envs (preview / staging / managed-prod):

- **The per-SHA API image BAKES the signed agent.** Every deployed-env API image is already built per-SHA by GitHub Actions from the PR branch. A pre-build CI step (`scripts/bake-agent.sh`, wired into the API image build) compiles the static `opengeni-agent` for `x86_64-`/`aarch64-unknown-linux-musl`, signs + sha256s each, and stages them into `agent/install/baked/` so they ride into the image via the Dockerfile's existing `COPY . .`. The API serves them from the existing `/agent/*` routes (`apps/api/src/routes/install.ts`) — exactly as it already serves the committed `install.sh`. A machine that `curl … | sh`s against a deployed env thus installs an agent **in lockstep with the exact control-plane SHA it enrolls against** — zero version drift, zero new artifact store, no extra hop.
- **Signing key never enters the Docker build.** The minisign signing key (`OPENGENI_AGENT_MINISIGN_KEY`) is used ONLY in the pre-build CI step, which writes already-signed public artifacts into the build context. An absent key fails the bake loud (no unverifiable binary ships).
- **Fallback is unchanged.** Any asset this image did NOT bake (macOS universal, Windows, an un-built arch) falls through to the existing GitHub-Releases 302 redirect. When `agent/install/baked/` holds only its placeholder (a plain `docker build`, a source checkout, CI image smoke), every `/agent/*` request 302s — the build is unaffected; switching between baked and fallback is purely whether the files are present, no Dockerfile branch.
- **GitHub Releases REMAINS the public archive + self-update channel + install.sh's documented fallback.** The `agent-v<semver>` tags from `.github/workflows/agent-release.yml` are untouched: they are the durable public archive, the source the agent's self-update path (`opengeni-agent-update`, pinned to the same minisign key) pulls from, and the mirror `install.sh` documents (`OPENGENI_INSTALL_BASE_URL` → the GitHub release).
- **Why GitHub-coupling is a non-issue here.** Deployed envs are already 100% GitHub-Actions / per-SHA driven (the image itself is a GH-Actions build output keyed on the control-plane SHA). Baking the matching agent into that same build adds no new coupling — it removes a moving part (no cross-referencing a separately-versioned release at install time).
- **Ingress routing is declarative.** The install paths must reach the API service, not the web SPA. The `/install.sh`, `/install.ps1`, `/uninstall.sh`, and `/agent/` paths are added to the `opengeni` ingress → `opengeni-api` backend declaratively in the ops-repo env ingress values (alongside the existing `/v1`/`/healthz`/`/metrics`), reusable across preview/staging/prod. No ad-hoc kubectl.

**Minisign-key precondition + status.** This whole chain's trust root is the pinned minisign key. As of this decision the GH secret `OPENGENI_AGENT_MINISIGN_KEY` is **ABSENT** and the previously committed pinned pubkey had no confirmable matching secret. A fresh passwordless keypair was therefore generated; the new pubkey is pinned in `agent/install/{install.sh,install.ps1,opengeni-agent-minisign.pub}` and `agent/crates/opengeni-agent-update/src/verify.rs`, and the secret key was handed to the coordinator out-of-band to store as `OPENGENI_AGENT_MINISIGN_KEY`. **Until that secret is stored, the bake (and the agent-release signing) will fail closed — no unsigned binary ships.** Local end-to-end proof (build → serve baked → install.sh sha256 + minisign verify → install, plus a tamper-rejection negative test) is in `docs/design/sandbox-surfacing/evidence/agent-baked-install-verify.md`.

---

## FILE-BY-FILE CHANGE LIST (this module's surface)

| File | Change |
|---|---|
| `packages/contracts/src/index.ts` | `Permission` +`stream:view`/`stream:control`/`stream:acknowledge` (`:57`); `UsageEventType` +`sandbox.warm_seconds`/`sandbox.warm_cost`/`sandbox.spawned`/`sandbox.snapshot` (`:249`); NEW `StreamTokenPayload`+`signStreamToken`/`verifyStreamToken` (alongside `:158-197`); NEW `SessionCapabilities` shape; `ClientConfig` +desktop/headless+`requiresAcknowledgment` advertisement (`:1425`) |
| `packages/sdk/src/types.ts` | mirror `KNOWN_PERMISSIONS` (`:249`), `SESSION_EVENT_TYPES`/`UsageEventType`, new payloads (contract-parity test pins these) |
| `packages/sdk/src/index.ts` | re-export new types |
| `packages/config/src/index.ts` | new settings (`:241`+): `streamControlEnabled`, `sandboxKeepWarmMs`, `sandboxViewerHolderTtlMs`, `sandboxReaperPeriodMs`, `sandboxMaxWarmSecondsPerSession`, `sandboxMaxConcurrentWarmPerWorkspace`, `sandboxWarmRateMicrosPerSecondJson`, `modalIdleTimeoutSeconds`, `sandboxOwnershipEnabled` (NO `sandboxKeepAliveIntervalMs` — no keepalive loop); env mappings (`:481`+); boot invariants `reaperPeriod<viewerTTL<modalIdle` + both-or-neither (`:986`+) |
| `packages/db/migrations/0017_sandbox_leases.sql` (NEW) | `sandbox_leases` + `sandbox_lease_holders` + indexes + RLS |
| `packages/db/migrations/0018_session_stream_acknowledgments.sql` (NEW) | acknowledgment table + RLS |
| `packages/db/src/schema.ts` | drizzle defs for the 3 new tables (mirror `sandbox_session_envelopes` `:360`) |
| `packages/db/src/index.ts` | NEW: `acquireLease`/`releaseLease` (FOR UPDATE + cold→warming CAS + epoch fence, modeled on `claimNextQueuedTurn` `:3077`), `reapStaleLeaseHolders` (also issues the provider's existing `stop()` at refcount 0 past the drain grace, then CAS `draining→cold`), `reapViewerHoldersForSubject`, `recordStreamAcknowledgment`/`hasStreamAcknowledgment`; warm-meter helpers reuse `recordUsageEvent` `:588`/`sumUsageQuantity` `:640`/`applyCreditDebitUpToBalance` `:695`; wire `reapViewerHoldersForSubject` into `revokeApiKey` `:500` |
| `apps/api/src/routes/sessions.ts` | NEW stream routes (capabilities/open/heartbeat/close/input(403)/acknowledge), each `requireAccessGrant(...,"stream:view"/...)` first; **served API-direct** — the handler runs the `cold→warming` CAS + viewer-holder acquire, `resume()`s the box **by id** in-process, calls `resolveExposedPort`/`session.exec`, records `data_plane_url` under the epoch fence, and returns `{providerUrl, streamToken}` inline (NO `signalWithStart`, NO worker RPC); `stream.url.rotated`/`stream.opened`/`stream.closed` are NEW `SessionEventType` literals fanned out on Channel A (H1) |
| `apps/api/src/dependencies.ts` | Construct a sandbox/Modal client from settings (Modal token plumbed via the shared `getSettings`, `packages/config`) and add it (or a `resumeBoxById` helper) to `deps`. **This is the API-direct seam — the API now holds a sandbox client of its own.** Imports the thin `@opengeni/runtime/sandbox` sub-export (`createSandboxClient` + the envelope (de)serializers) WITHOUT the `@openai/agents` agent-loop graph |
| `apps/api/src/index.ts` | stream-token mint helper using `settings.delegationSecret` (boot-gated: if the desktop-stream feature is enabled, `delegationSecret` MUST be set — C4). **No new `signalWithStart`/`openStreamRequest` signal** — the stream routes do not touch Temporal; only the existing turn/interrupt signals remain |
| `apps/api/src/access/index.ts` | no change to `requireAccessGrant`; new perms flow through `hasPermission` `:54` automatically |
| `apps/worker/src/sandbox-resume.ts` (NEW; was `sandbox-owner.ts`) | stateless `resumeBoxForTurn` helper (any worker resumes by id, injects non-owned, caller drops the handle in `finally`) + `ensureDisplayStack`/`exposeStreamPort`/`suspendBox`/`startRecording` (idempotent, stateless); warm-meter tick body. NO owner actor, NO `Map`, NO per-session worker |
| `apps/worker/src/activities.ts` | `servicesPromise` (`:30`) unchanged from today plus the lease DB fns (no `owners` Map); register the stateless reaper activity (Temporal Schedule) — NO `ownerHeartbeat` |
| `apps/worker/src/activities/agent-turn.ts` | turn-holder acquire/release around the run + the warm-meter tick on the turn's 30s heartbeat; drop the in-memory handle in `finally` (box NOT stopped here — reaper does that at refcount 0); `ensureRunAllowed` `:913` unchanged for turns |
| `apps/worker/src/workflows/session.ts` | turns dispatch on the EXISTING global queue (no per-session/per-group task queue); warm-cap reject surfaced on the turn spawn path. **No viewer-attach activity** — viewer attach + `data_plane_url` resolve/record is API-direct (handled in `apps/api`, not this workflow) |
| `apps/worker/src/index.ts` | unchanged — stateless worker pool exactly as today (NO per-session `Worker.create`) |
| `packages/runtime/src/index.ts` | ownership inversion (`RunAgentStreamOptions` `:968` accepts `{client,session,sessionState}`; `runOptions.sandbox` `:1044` prefers injected); gated by `sandboxOwnershipEnabled` |
| `packages/runtime/src/sandbox/index.ts` (NEW barrel) | the **API-direct enabling refactor**: re-export `createSandboxClient` + `deserializeSandboxSessionStateEnvelope` + `restoredSandboxSessionStateFromEntry` + `sandboxStateEntryFromRunState` under `@opengeni/runtime/sandbox`, so `apps/api` imports the provider registry WITHOUT the `@openai/agents` agent-loop import graph (verified zero coupling; `packages/runtime` has no `@temporalio` dep). Extracted in `03-providers.md` §3.5; consumed by the API-direct control plane |
| `packages/deployment/src/index.ts` | per-provider required-env blocks (`:863`,`:1419`); new `OPENGENI_SANDBOX_*`/`OPENGENI_STREAM_*` value/required env; desktop-profile deploy checks |
| `docker/desktop.Dockerfile` (NEW) | the v1 Xvfb/XFCE4/x11vnc/websockify/noVNC/xdotool/scrot/ffmpeg image (GROUND:desktop-stack) |
| `apps/api/src/routes/install.ts` | §4.5: `/agent/<ver>/<asset>` serves the BAKED per-SHA `agent/install/baked/<asset>` (+`.sha256`/`.minisig`, correct content-type) when present, else 302→GitHub Releases; auth-exempt unchanged |
| `scripts/bake-agent.sh` (NEW) | §4.5: pre-build CI step — compile static musl agent (cargo-zigbuild) + sign (rsign2) + sha256 into `agent/install/baked/`; minisign key used HERE only, never in the Docker build |
| `agent/install/baked/` (NEW) | §4.5: committed placeholder dir the API serves baked binaries from; per-SHA binaries are build outputs (gitignored), not committed |
| `.github/workflows/release.yml` | §4.5: bake+sign step before the API image build (`OPENGENI_AGENT_MINISIGN_KEY`) |
| `docker/opengeni.Dockerfile` (`api`) + `.dockerignore` | §4.5: doc the bake-via-`COPY . .`; exclude `agent/target/` from the build context |
| `agent/install/{install.sh,install.ps1,opengeni-agent-minisign.pub}` + `agent/crates/opengeni-agent-update/src/verify.rs` | §4.5: rotated pinned minisign pubkey (secret was absent — fresh keypair) |
| `test/integration/sandbox-lease.integration.ts` (NEW) | T1-T9 lease race tests |
| `test/live/desktop-fanout.live.ts` + `test/e2e/desktop-fanout.e2e.ts` (NEW) | fan-out load test (THE risk gate) |
| `test/e2e/desktop-render.e2e.ts` (NEW) | gVisor render spike |
| `test/live/providers-sandbox.live.ts` (NEW) | P1-P9 per-provider integration |
| `apps/api/test/stream-routes.test.ts` + `test/integration/stream-auth.integration.ts` (NEW) | A1-A6 auth/billing tests |

---

### Key load-bearing facts carried from grounding (do not re-derive)
- **Control plane is API-direct:** all non-turn ops (viewer attach, mint/rotate the tunnel URL, FS list/read, Git status/diff, capability negotiation) are served **client → API → box** in the `apps/api` process — the API holds its own sandbox client (one field added to `dependencies.ts`, imported from `@opengeni/runtime/sandbox` without the agent-loop graph), runs the `cold→warming` CAS as a Postgres transaction it owns, `resume()`s the box by id in-process, and drops the handle on return. **No `signalWithStart`, no `openStreamRequest`, no viewer-attach activity, no `sandboxOwnerRpcWorkflow`, no worker RPC, no NATS request-reply.** Temporal hosts exactly two things: the agent turn (`sessionWorkflow`) and one global reaper Temporal Schedule.
- The lease is the SOLE singleton enforcer via `UNIQUE(workspace_id,session_id)` + `SELECT…FOR UPDATE` + `cold→warming` CAS + `lease_epoch` fence — and Temporal does NOT serialize the concurrent acquirers: the viewer's `exposeStreamPort` runs **in the API process**, concurrently with the worker's `runAgentSegment` for a turn. Two different processes contending for one lease row → the Postgres `FOR UPDATE` + CAS is the only serializer, exactly as intended.
- Warm-time is the cost hole: viewer-held compute emits no model usage; the stateless warm-meter tick (turn-heartbeat while a turn runs / reaper sweep for viewer-only boxes) is the meter, idempotent on `(group, epoch, tick)` via `recordUsageEvent` `onConflictDoNothing` (`db/index.ts:612`). A viewer-held box still costs and is still metered; the reaper `stop()`s it at refcount 0 and the provider idle-timeout is the backstop.
- Pixel plane is un-redacted → opt-in acknowledgment is mandatory, not silent.
- Read-only in v1: `/stream/input`→403, `streamControlEnabled=false`; `stream:control` permission exists for later.
- Revocation must actively reap (short-TTL tokens aren't DB-checked per use) → route through `reapViewerHoldersForSubject`.
- Build order: providers → lease+inversion → warm-billing → security → desktop → client. Desktop is the headline but lands LAST on a correct foundation; the GA gate is the fan-out load test (the one unvalidated per-port-cap risk).
- `sandboxOwnershipEnabled=false` ≡ today's build-and-discard-per-run path → reversible per-environment cutover.

---

## Adversarial Review

# Adversarial Review — Security/Auth/Multi-Tenancy + Cost/Billing/Lifecycle + Testing/Rollout

I verified the spec's cited anchors against HEAD. Most symbol names are accurate, but several load-bearing claims are wrong, and there are concrete correctness/compile bugs. Findings ordered by severity.

> **STATELESS-WORKERS + API-DIRECT NOTE (reconciliation).** Any finding that assumed a per-session worker, a per-session/per-group Temporal queue, an in-worker `SandboxOwner` actor, an `ownerHeartbeat` activity, or a `keepAlive` loop is **superseded** — the stateless-workers ruling removes that machinery entirely (turns run on the existing global queue and resume the box by id; warm-meter accrues on the turn-heartbeat + the reaper sweep; the box rides the provider idle-timeout between turns and the reaper `stop()`s it at refcount 0). **And any finding that routed a non-turn op through a Temporal signal (`signalWithStart`/`openStreamRequest`), a viewer-attach activity, a `sandboxOwnerRpcWorkflow`, a worker RPC, or a NATS request-reply is ALSO superseded** — per the AUTHORITATIVE CORRECTED MODEL the **control plane is API-direct**: the `apps/api` process resolves the lease, runs the `cold→warming` CAS as a Postgres transaction it owns, `resume()`s the box by id in-process, and operates the live `session` handle directly for ALL non-turn ops (viewer attach, mint/rotate the tunnel URL, FS list/read, Git status/diff, capability negotiation). NATS carries events only. In particular **H4** (the `exp ≤ keepAliveIntervalMs` contradiction) is **moot** — there is no `sandboxKeepAliveIntervalMs` and no keepalive clock; URL rotation is event-driven under the epoch fence. **H2's "wire revocation into `revokeApiKey`/grant-mutation"** is satisfied API-direct (the reap helper runs in-process; revocation is a DB op the API already owns). The **RLS reaper findings C1/C2 STILL APPLY** — the one global reaper still needs the `account_id` column and a SECURITY-DEFINER (or BYPASSRLS) cross-workspace path (it is a scheduled global sweep, not workspace-scoped); its driver is the **single global Temporal Schedule** (the one and only reaper, Part 2.2/Part 4 — NOT a per-session/per-RPC workflow).

## CRITICAL — won't compile / won't run

**C1. `sandbox_lease_holders` has no `account_id` column but the spec applies the standard workspace RLS policy to it — the table will be unwritable.**
The repo's RLS policy is `USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))` with `WITH CHECK (...)` and `FORCE ROW LEVEL SECURITY` (verified `packages/db/drizzle/0007_session_history_items.sql:28-30,57-59`). It references an `account_id` column on *every* RLS-protected table. The spec's `sandbox_lease_holders` DDL (Part 4.1) has only `lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at, created_at` — **no `account_id`**. The migration text "both tables get the workspace RLS policy" + the standard `GRANT ... TO opengeni_app` will produce a policy that references a non-existent column → migration error, or (if RLS is added separately) every INSERT fails the `WITH CHECK`. **Fix:** add `account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE` to `sandbox_lease_holders` (and confirm it on `session_stream_acknowledgments`, which already has it), exactly mirroring `sandbox_session_envelopes`.

**C2. The reaper (`reapStaleLeaseHolders`) and revocation sweep (`reapViewerHoldersForSubject`) cannot run under the existing RLS helpers — they are per-workspace-scoped, but the reaper sweeps across all workspaces.**
`withWorkspaceRls`/`withRlsContext` set a single `{accountId, workspaceId}` per transaction (`packages/db/src/index.ts:89-117`); `setRlsContext` pins one workspace. The settled reaper (`~90s TTL`, Part 1.5/2.2) must scan stale holders across every session/workspace in the process — there is no workspace context for a global sweep, and `FORCE ROW LEVEL SECURITY` will hide rows outside the set context. The spec hand-waves "all lease ops go through `withWorkspaceRls`/`withRlsContext` like `claimNextQueuedTurn`" but `claimNextQueuedTurn` is *always invoked with a known `(workspaceId, sessionId)`* (`index.ts:3077`); the reaper is not. **Fix:** the reaper needs either (a) a dedicated privileged path (BYPASSRLS role / `opengeni_private` SECURITY DEFINER function) that selects stale `(workspace_id, session_id, lease_id)` tuples globally, then loops per-workspace through `withWorkspaceRls` to delete + recompute refcount; or (b) explicitly state the reaper runs as table owner outside RLS. Spec must specify this; it currently doesn't.

**C3. `signStreamToken`/`verifyStreamToken` reuse module-private helpers that are not exported.**
`base64UrlEncode`, `base64UrlDecode`, `hmacSha256Base64Url`, `constantTimeEqual` are all declared `function ...` with **no `export`** (`packages/contracts/src/index.ts:1444-1475`). The spec's new `signStreamToken` calls `base64UrlEncode(...)` and `hmacSha256Base64Url(...)` — fine *if* the new functions live in the same module (they're specced "alongside `:158`" in the same file, so this compiles). But the spec also says websockify's later-hardening "maps `streamToken`→backend" and the **box edge** validates the token; the in-box websockify is a Python process that cannot call these TS helpers. More importantly, `verifyStreamToken` body is `/* mirror ... */` — left unimplemented. **Fix:** keep `signStreamToken`/`verifyStreamToken` in `contracts/index.ts` (same module, helpers in scope — this is the only place they work without an export change), and write the actual `verifyStreamToken` body (prefix `ogs_`, `lastIndexOf('.')`, `constantTimeEqual`, `StreamTokenPayload.safeParse`, `exp < now` → null), mirroring `verifyDelegatedAccessToken:177-197` exactly.

**C4. `delegationSecret` is optional — minting a stream token "using `settings.delegationSecret`" can be `undefined`.**
`delegationSecret: z.string().optional()` (`packages/config/src/index.ts:125`). The spec's mint helper (file-by-file: "stream-token mint helper using `settings.delegationSecret`") and `signStreamToken(secret, ...)` will pass `undefined` as the HMAC key → `crypto.subtle.importKey` over an empty/undefined key, or a runtime throw. There's an existing precedent that `delegationSecret` gates a whole feature (`config:918` throws when a delegation path is configured without it). **Fix:** add a boot invariant — if the desktop-stream feature is enabled, `delegationSecret` MUST be set — and have the mint route 500/feature-disable when absent. Spec must state this; it silently assumes the secret exists.

## HIGH — settled-architecture / grounding contradictions

**H1. The spec claims `stream.url.rotated` "already flows on Channel A" / "already in design" — it does not exist in `SessionEventType`.**
Verified the full enum (`packages/contracts/src/index.ts:1270-1303`): no `stream.url.rotated`, `stream.opened`, or `stream.closed`. The spec asserts in three places (1.7 table, 2.4, file-by-file "stream.url.rotated SSE already flows on Channel A", Part 4 PHASE 4) that this event is already wired. It is net-new. **Fix:** add `stream.url.rotated` (and likely `stream.opened`/`stream.closed`) to `SessionEventType` (contracts), mirror in `SESSION_EVENT_TYPES` (sdk/types.ts:100), and define its payload; this is a contracts+sdk change with a parity-test impact, not a no-op. Remove every "already flows/already in design" claim.

**H2. Wiring revocation through `revokeApiKey` is the wrong reap trigger and over-reaches.**
`revokeApiKey(db, workspaceId, apiKeyId)` (`packages/db/src/index.ts:500`) sets `revokedAt` on a single API key. The spec (1.5) says "when a subject loses `stream:view`, sweep its viewer holders" and wires `reapViewerHoldersForSubject` into `revokeApiKey`. Problems: (1) an API key's `subjectId` is not necessarily the viewer's `subject_id` — grants resolve per-request via `getWorkspaceGrant` (`:438`) and a subject may hold multiple keys; revoking one key does not mean the subject lost the permission. (2) The real "subject loses `stream:view`" event is a **grant mutation** (role/permission change), which the spec admits ("any grant-mutation path") but never identifies a function for — because grants are computed, not a single revoke call. **Fix:** define the actual permission-loss surface (member role change / grant deletion), reap there; and in `revokeApiKey`, only reap holders whose `subject_id` maps to *that* key's subject AND that subject has no other live grant to `stream:view`. As written it both misses the real case and risks reaping a still-authorized viewer.

**H3. Warm-time billing gating reads `usageLimitsMode==="managed"` as a balance gate, but `ensureRunAllowed` gates balance on `billingMode==="stripe" || usageLimitsMode==="managed"` AND separately enforces static limits.**
Spec (2.2) writes `if (billingMode==="stripe"||usageLimitsMode==="managed") && balance<=0 → drain`. That matches `ensureRunAllowed:914-919` for the balance branch — OK. But `ensureRunAllowed` *also* has a `usageLimitsMode==="static"||"managed"` run-count branch (`:920-927`) that the warm-time path silently drops. A static-limits deployment with `billingMode!=="stripe"` will meter warm-seconds (recording usage) but never gate it. That's defensible (warm-seconds isn't an agent-run count) but the spec claims it "mirrors `ensureRunAllowed`" — it only mirrors half. **Fix:** state explicitly that warm-time gating covers only the credit-balance branch and intentionally does not participate in static run-count limits, or add a warm-seconds cap to the static path.

**H4. `StreamTokenPayload.exp` rotation math — SUPERSEDED (moot under stateless workers).**
The original finding flagged that `exp` 120s "≤ keepAliveIntervalMs" contradicted the 60s keepalive default. Under the stateless-workers ruling **there is no `sandboxKeepAliveIntervalMs` and no keepalive clock** — the setting and the loop are removed. URL rotation is event-driven: whichever process holds the lease for the op re-resolves the exposed port and records the new `data_plane_url` in the lease under the `lease_epoch` fence — the **API in-process** for a viewer/non-turn mint-or-rotate (API-direct), or the **turn-resuming worker** for a turn — and the old tunnel is torn down. So there is no `exp`-vs-keepalive inequality to satisfy. **Residual:** keep `exp` a short, fixed TTL (120s default) independent of any rotation cadence; the epoch fence (not a timer relation) is what invalidates a stale token's URL. No keepalive comment remains to fix.

## MEDIUM — gaps / unspecified behavior

**M1. Migration directory is wrong: it's `packages/db/drizzle/`, not `packages/db/migrations/`.**
The spec (Part 4.1, file-by-file) names `packages/db/migrations/0017_...` and `0018_...` and "numbered files in `packages/db/migrations/`". Verified: migrations live in `packages/db/drizzle/` with `drizzle/meta/_journal.json`; latest is `0016_session_create_idempotency.sql` (correct number). The `migrate` script is `bun src/migrate.ts` (`packages/db/package.json:10`) — correct. **Fix:** path is `packages/db/drizzle/0017_*.sql`. Also: drizzle-kit `generate` writes `_journal.json` entries; hand-authored SQL (as the spec implies with raw DDL) must also append a journal entry or `bun src/migrate.ts` won't apply it. The spec never mentions the journal — a real gap.

**M2. `usd_micros` warm-cost stored in `usage_events.quantity` (bigint) — the unit semantics collide with `sumUsageQuantity`.**
`quantity` is `bigint mode:number` (`schema.ts:434`) so it holds micros fine. But the spec stores BOTH `sandbox.warm_seconds` (seconds) and `sandbox.warm_cost` (usd_micros) as separate event types in the same `quantity` column, and caps use `sumUsageQuantity(eventType:"sandbox.warm_seconds")` (2.3) — that's consistent. However `sandbox.warm_cost` is never the credit debit; the actual debit is `applyCreditDebitUpToBalance` (`:695`). The spec records a `sandbox.warm_cost` usage event AND debits credits — two writes that can diverge if the debit is clamped by `applyCreditDebitUpToBalance` (it debits `min(requested, balance)`, `:712`). So `sandbox.warm_cost` will overstate actual credits removed when balance is low. **Fix:** specify that `sandbox.warm_cost` records *requested* cost and the ledger records *actual* debited (they legitimately differ), or record `debitedMicros` from the return value — the spec conflates them.

**M3. `model.cost`/`model.tokens` precedent recorded inside the agent-turn activity, but warm-meter idempotency key uses `tickIndex` whose monotonicity under re-dispatch is unproven.**
`recordUsageEvent` is `onConflictDoNothing` on `idempotencyKey` (`:612`) — verified, so `usage:sandbox.warm_seconds:<session>:<epoch>:<tick>` is double-bill-safe *only if `tickIndex` is deterministic per `(epoch, tick)`*. The spec stores `last_meter_tick` in the lease row and increments it "in the same FOR UPDATE write." But on worker death mid-tick, the heartbeat re-dispatches; if `last_meter_tick` was committed but the usage insert wasn't (separate statements), the next tick computes `elapsedS` from `lastMeterAt` and a *new* tick index — no double-bill (good), but a *gap* in metered seconds is possible if `lastMeterAt` advanced without the insert. **Fix:** make the `lastMeterAt`/`last_meter_tick` update and the `recordUsageEvent` insert atomic (same txn), and specify the recovery semantics on partial failure. The spec asserts idempotency but the cross-statement atomicity is unspecified.

**M4. `POST /stream/input` returns 403 "unconditionally in v1" but is mapped to `stream:control` permission — dead, but the route still runs `requireAccessGrant(..., "stream:control")` which 403s first for everyone since `stream:control` is "NEVER granted by default."** That's two 403s with different codes (`requireAccessGrant` generic 403 vs `stream_control_disabled`). The spec wants the `stream_control_disabled` body, but no one will ever have `stream:control`, so they hit the access 403 first. **Fix:** clarify ordering — either skip the grant check and return `stream_control_disabled` directly (contradicts the 1.1 invariant "go through `requireAccessGrant` first"), or accept that v1 input always yields the generic access 403 and drop the `stream_control_disabled` code as unreachable.

**M5. Caps enforcement `sandboxMaxConcurrentWarmPerWorkspace` counts `sandbox_leases WHERE workspace_id=$w AND liveness IN ('warming','warm')` inside the acquire `FOR UPDATE` txn — but that `FOR UPDATE` only locks the *one* session's lease row, not the others being counted.** Two concurrent new-spawns in different sessions of the same workspace can each read `count < cap` and both proceed → cap breached by races. **Fix:** the count must take a workspace-level advisory lock (precedent exists: `withWorkspaceUsageLock`, `index.ts:119`) or `SELECT ... FOR UPDATE` the counted rows. The spec's "inside the FOR UPDATE txn" does not serialize cross-session counting.

## LOW — accuracy nits

- **L1.** The spec cites `UsageEventType` at `packages/contracts/src/index.ts:249` for both the enum and "mirror in sdk types.ts `:249`" — the contracts enum is at `:249` (correct), but `KNOWN_PERMISSIONS` in the SDK is at `types.ts:249`, and `UsageEventType` mirror is `KNOWN_USAGE_EVENT_TYPES` near `:950`. Minor mis-citation; the SDK has `KnownUsageEventType | (string & {})` open union (`types.ts:952`) so new usage types are non-breaking — the spec's parity claim holds.
- **L2.** `recordUsageEvent.eventType` is typed `string` (`index.ts:592`), not the `UsageEventType` enum, so new literals work without the contracts change strictly being required for the DB write — but the contracts enum gate is still needed for `UsageEvent` parsing on read (`:267`). Spec is right to add them; just note the DB layer is already permissive.
- **L3.** The original "No route may hold a sandbox client (API holds none today — `dependencies.ts` = `{db, bus, workflowClient, objectStorage}`)" claim is **superseded by the AUTHORITATIVE CORRECTED MODEL**: the control plane is API-direct, so `dependencies.ts` gains ONE field — a sandbox/Modal client built from settings (verified sound: `ModalSandboxClient.resume()` is per-call/no-pool, the API already does outbound HTTPS + owns Postgres, and `packages/runtime` has no `@temporalio` dep, so the API can `resume()`-by-id and operate the box in-process without dragging in the agent-loop graph). The existing `signalWithStart("sessionWorkflow", ...)` at `apps/api/src/index.ts:50,69` stays for the **turn/interrupt** signals only; non-turn stream ops do NOT signal Temporal.
- **L4.** Modal `idleTimeoutMs` gap claim is correct — config has `modalTimeoutSeconds` (`:241`) but no `modalIdleTimeoutSeconds`; the new field and the `modalIdleMs` boot check are net-new and correctly identified. Note the boot check `viewerHolderTTL < modalIdleMs` uses `modalIdleTimeoutSeconds ?? modalTimeoutSeconds` — fine, but if a deployment runs a *non-Modal* primary backend, this Modal-specific invariant should be skipped, not thrown; spec doesn't gate it on backend.

## Net assessment
The architecture is sound and the high-level anchors (lease pattern via `claimNextQueuedTurn` `FOR UPDATE`, `recordUsageEvent` idempotency, `ensureRunAllowed` billing gate, HMAC envelope reuse) are real and correctly located. The blocking defects are: **C1** (holder table missing `account_id` → RLS-unwritable), **C2** (reaper has no global RLS path), **C3/C4** (token helpers private + unimplemented `verify` + optional secret), and the false "already flows" claims for `stream.url.rotated` (**H1**) and the revocation-via-`revokeApiKey` mismatch (**H2**). Fix those five before this is implementation-grade; the rest are tractable gaps.

Files cited (all absolute): `/home/jorge/repos/Cloudgeni-ai/opengeni/.claude/worktrees/naughty-engelbart-2d3b09/packages/contracts/src/index.ts` (enums 57-82, 249-260, 1270-1303; token helpers 158-197, 1444-1475), `.../apps/api/src/access/index.ts:31-55`, `.../packages/db/src/index.ts` (RLS 89-117, revokeApiKey 500, recordUsageEvent 588, sumUsageQuantity 640, applyCreditDebitUpToBalance 695, claimNextQueuedTurn 3077), `.../packages/db/src/schema.ts:428-447`, `.../packages/db/drizzle/0007_session_history_items.sql:28-66`, `.../apps/worker/src/activities/agent-turn.ts:913-927,948-976`, `.../packages/config/src/index.ts:125,192,235,241-243,985`, `.../apps/api/src/index.ts:50,69`.

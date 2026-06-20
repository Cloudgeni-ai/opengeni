# Decision Briefing — How the Agents SDK sandbox rails work, and how OpenGeni should ride them

**For:** Jørgen · **Date:** 2026-06-18 · **Source:** `@openai/agents-core@0.11.6`, `@openai/agents-extensions@0.11.6`, OpenGeni `packages/runtime` + `apps/worker` (read from the `.js`, not the `.d.ts`)

---

## 0. The corrected mental model (lead with this)

**You were right to push back on "build-and-discard per turn."** The box is NOT rebuilt and thrown away each turn. The Agents SDK and OpenGeni already persist sandbox **identity** (`sandboxId`) across turns:

- Every run ends by **serializing** the session into an envelope (`RunState._sandbox`, written unconditionally at `manager.js:137-140`).
- The next turn **resumes the same box** via `client.resume(sessionState)` → for Modal that is literally `modal.sandboxes.fromId(sandboxId)` then `poll()` (`modal/sandbox.js:896-939`). If the box is still alive in the provider's idle window this is a **warm reattach**; if it died, it's a **cold restore from a filesystem snapshot** (`modal/sandbox.js:367-485`).
- OpenGeni stores this envelope as its "recovery envelope" in `sandbox_session_envelopes` and feeds it back each turn as `RunConfig.sandbox.sessionState` (`packages/runtime/src/index.ts:1028-1048`, `restoredSandboxSessionState` at `:1637`; worker upsert at `apps/worker/src/activities/agent-turn.ts:250-258`).

So the rail you already ride gives you **cross-turn box identity for free.** That is the supported, stable contract.

**The genuinely-new demands of the workspace-surfacing vision are only two**, and neither is served by the existing rail:

1. **Warm-hold between turns** — keep the box deliberately running across the gap between turns (today: serialize at turn-end, let the provider idle-timer decide whether it survives).
2. **Viewer-attach** — let humans watch a running box concurrently with (or without) a turn, and keep the box alive while a viewer watches even when no turn runs; tear down only when **no turn AND no viewer** (refcount 0).

**The reframe that shrinks the scary part:** the prior spec treated this as an "ownership inversion" — wresting the sandbox away from the SDK. It is not. The SDK has a **purpose-built escape hatch** for external ownership (`RunConfig.sandbox.session` — inject a live, non-owned handle), and the viewer path was **never on the SDK rail to begin with** (it's a direct provider tunnel). So the work shrinks to: **keep the already-persistent box warm + add a viewer/tunnel layer beside the SDK.** Much less SDK-fighting than the spec implies.

---

## 1. The precise rails

### 1a. The objects

- **`@openai/agents/dist/sandbox/index.js` is a pure re-export** of `@openai/agents-core/sandbox` (`index.js:17`). All real logic is in **agents-core**. There is no separate "SandboxAgent runtime" in the base package.
- **`SandboxClient`** (`agents-core/dist/sandbox/client.d.ts:50-62`) — the provider factory: `create / resume / delete / serializeSessionState / deserializeSessionState / canPersistOwnedSessionState / canReusePreservedOwnedSession`.
- **`SandboxSession`** (`session.d.ts:103-134`) — a live box handle: `exec / readFile / createEditor / resolveExposedPort / persistWorkspace / stop|shutdown|delete|close`.
- **`SandboxAgent`** (`agent.js:9`) — a real `Agent` subclass branded `[SANDBOX_AGENT_BRAND]=true`, carrying four extra fields: `capabilities / defaultManifest / runAs / baseInstructions`. The guard `isSandboxAgent` (`runtime/agentKeys.js`) is what decides whether the sandbox machinery engages at all. For a plain `Agent`, `prepareAgent` returns it untouched and no session is ever obtained (`manager.js:47-53`).
- **`SandboxRuntimeManager`** (`runtime/manager.js`) — owns the session graph for **one `run()`**. The run loop talks only to this, never to client/session directly.
- **`RunConfig.sandbox` = `SandboxRunConfig`** (`run.d.ts:130,177` → `client.d.ts`): `{ client?, options?, session?, sessionState?, manifest?, snapshot? }`. The dual field is the whole game: **`session` = a LIVE handle; `sessionState` = a serialized descriptor to resume.**

### 1b. The owned / preserved-session model

A session acquired by the manager carries an **ownership bit**:

- **Owned** — sessions the manager `create()`d or `resume()`d itself (`ownedSessionAgentKeys`, set in `registerSessionForAgent`, `manager.js:469-471`). Only owned sessions are eligible for teardown OR preservation.
- **Not owned** — a session injected via `RunConfig.sandbox.session` (`manager.js:410-424`). The manager **never tears these down** (teardown only touches owned sessions, `manager.js:642-670`; provided sessions get only pre-stop hooks, `manager.js:282-304`).
- **Provider-level `ownsSandbox`** — separately, Modal stores `ownsSandbox: !resolvedOptions.sandbox` in its state (`modal/sandbox.js:820,843`): "did the SDK create this Modal box, or was a pre-existing one injected." Governs whether `resume()` reaps/looks-up the Modal app.

### 1c. When the session is obtained — `ensureSession` priority order

The manager is constructed **fresh per `run()`** (`run.js:337` non-stream, `run.js:989` stream). The session is resolved lazily per turn in `prepareAgent → ensureSession` (`manager.js:61`, `manager.js:391-455`), in strict priority:

1. **In-memory cache for this run** (`manager.js:394-409`) — every turn in one run reuses the same live session object.
2. **Injected live `RunConfig.sandbox.session`** (`manager.js:410-424`) — marked **NOT owned**. ("User handed us a running box.")
3. **Resume** via `resumeSessionForAgent` (`manager.js:425-433, 533-569`) — marked **owned** — sub-sources in order: (a) a **live preserved in-process handle** from a prior run of the same RunState (`livePreservedOwnedSession`, `manager.js:542-550`); (b) **`RunConfig.sandbox.sessionState` → `client.resume`** (`manager.js:551-558`) — **this is OpenGeni's path today**; (c) serialized `RunState._sandbox`.
4. **Create** a brand-new box (`manager.js:434-454`) — marked **owned**.

The priority order is load-bearing: **an injected live session (priority 2) strictly short-circuits resume (priority 3)** — so handing the SDK a live handle always wins over the envelope.

### 1d. When the session is used

`prepareAgent` (`manager.js:57-80`) → `getPreparedAgent` (`manager.js:510-532`) clones the agent and `prepareSandboxAgent` **binds the live session** into each capability via `.bind(session).bindRunAs(...).bindModel(...)` (`agentPreparation.js:17-49`, esp. `:24-28`: *"Capabilities are cloned before binding because tools, instructions, and model sampling parameters can depend on the live session for this run"*). The execution agent drives the model call at `run.js:442-467` / `run.js:706-711`. **Capability tools (exec/readFile/editor/computer-use) are closures over the bound session** — that closure is the entire routing mechanism; there is no separate routing layer.

### 1e. When serialize / resume / close fire

Every run ends in a `finally` calling `finalizeSandboxRuntime` (`run.js:555-566` non-stream, `run.js:947-966` stream). The decisive line:

```js
// run.js:556 (identically run.js:956)
const preserveSandboxSessions = state._currentStep?.type === 'next_step_interruption';
```

Then `cleanup → serializeState`:

- **Serialize: ALWAYS** if a live session exists and the client implements `serializeSessionState` → written to `state._sandbox` (`manager.js:137-140`). `RunState.toString()` carries it out (`runState.js:818`); deserialize restores it (`runState.js:1166`).
- **Close: CONDITIONAL on `preserveOwnedSessions`:**
  - **Normal finish** (`preserve=false`): `closeOwnedSessions` runs `stop/shutdown/delete/close` — **the owned box is torn down** (`manager.js:127-134, 642-670`).
  - **Interruption finish** (`preserve=true`): owned sessions are NOT closed; kept in-process via `rememberLivePreservedOwnedSessions` (`manager.js:141-146`) and tagged `preservedOwnedSession:true`.
  - **Provided (non-owned) sessions are never closed by the manager.**

The three gating predicates are all evaluated in **one place** — `serializeSandboxRuntimeState` (`sessionSerialization.js:14-48`), reached only from cleanup:
- `canPersistOwnedSessionState(state)` — on **normal** end; if false the owned session's state is **dropped** from the envelope. **Modal returns `false`** (`modal/sandbox.js:869-871`).
- `canReusePreservedOwnedSession(state)` — on **interruption** end; decides whether the in-process live handle can be reattached next run without a provider reconnect (`livePreservedSessions.js:42-46`, consumed at `manager.js:344-380`).

**Net:** the SDK keeps an owned box alive past a run boundary **only when the run ended in a `next_step_interruption`** — interruption-only, binary, per-`run()`, no public knob. On normal completion the owned box is closed, and (for Modal) no reusable owned entry is even persisted. Between turns, an owned box's actual survival rests **entirely on the provider's `idleTimeoutMs`** (`modal/sandbox.js:806-808, 830`), never on the SDK.

---

## 2. The three strategies, compared — with RECOMMENDATION

| | **A · Ride (idle-window)** | **B · Extend (hold live handle)** ★ | **C · Bypass (own raw client)** |
|---|---|---|---|
| **What changes** | Keep today's `sessionState`/envelope path; bump Modal `idleTimeoutMs` so `resume→fromId→poll` always reattaches warm | Worker holds the live `ModalSandboxSession` between turns; inject it as `RunConfig.sandbox.session` (non-owned); refcount keeper owns `stop` | Stop using `run()`'s sandbox wiring; drive create/keepalive/snapshot/terminate entirely outside the SDK |
| **Box stays owned by SDK?** | Yes — SDK "closes" the owned session object each turn; box survives only on the provider timer | No — injected = non-owned → SDK **never** reaps it | n/a (you own it) |
| **Warm-hold between turns** | Best-effort (races the provider reaper) | **Deterministic** — keeper holds it; nothing underneath can kill it | Deterministic |
| **Refcount-0 (turn AND viewer)** | Not expressible — no SDK signal | **Keeper owns `stop` outright**; SDK's interruption-only logic never consulted | Keeper owns `stop` |
| **SandboxAgent / computer-use** | Untouched | **Untouched** (binds to whatever `ensureSession` yields) | **Must re-create the whole binding layer** |
| **SDK-fight** | Racing close-on-finish vs a timer | **None** — non-owned by construction | High — reimplements `ensureSession`, `prepareSandboxAgent`, computer-use wiring, interrupted-turn rehydration, envelope schema |

### RECOMMENDATION: **Strategy B — inject the live session (a focused extension of the rail you already ride).**

**Why.** The preserved-owned model does **not** support a clean keep-warm-and-reuse (it's interruption-only, and Modal's `canPersistOwnedSessionState===false` turns off even the warm-handle persistence on normal end). So you cannot get warm-hold *from* the SDK. But the SDK gives you the exact seam to **take box lifetime out of its hands without fighting it**: an injected `RunConfig.sandbox.session` is marked **non-owned** (`manager.js:410-424, 469-471`), so `closeOwnedSessions` **never sees it** — the single "no teardown on normal finish" fight **disappears by construction**, not by coercing the interruption flag.

Crucially, B requires **zero changes to the SandboxAgent / capability / computer-use machinery**: `prepareSandboxAgent` binds whatever session `ensureSession` yields, every turn (`agentPreparation.js:17-49`). So exec/readFile/editor/computer-use all stay 100% SDK-driven against your held handle.

**"Ride" (A) and "Bypass" (C) both collapse into B.** A is strictly weaker — the box stays owned and you race the provider reaper, with no refcount expressible. C's instinct (own create/keepalive/exposePort/snapshot/terminate, hand the SDK a thin per-turn session) is **achieved by B** — injecting the live handle *is* the SDK's own escape hatch for external ownership, so the literal bypass (and its large re-creation cost) is unnecessary.

---

## 3. Exact hook points for the recommended approach (B)

1. **The one SDK-facing change** — in `runAgentStream` (`packages/runtime/src/index.ts:1045-1048`), on the warm path pass `sandbox: { client, session: <held live handle> }` instead of `sandbox: { client, sessionState }`. This selects `ensureSession` priority-2 (`manager.js:410-424`) → non-owned → never auto-closed.

2. **Where the owner holds the handle** — a new worker-side `SandboxOwner` (in `apps/worker`, sitting beside the existing envelope upsert at `agent-turn.ts:250-258`) holds the raw provider client + the live `ModalSandboxSession` across turns and viewer-only periods, plus a **refcount = active-turns + active-viewers**. It is the **sole** authority on the final `stop`/`shutdown`, fired only at refcount 0.

3. **How viewers attach (outside the SDK, Channel B)** — viewers resolve the provider tunnel directly: `session.resolveExposedPort(port)` (`session.d.ts:124`) → Modal `sandbox.tunnels(10_000)` → `{host, port, tls:true}` (`modal/sandbox.js:261-303`), cached into `state.exposedPorts` and **already persisted in the envelope** via the `...state` spread (`modal/sandbox.js:866`). The viewer service resolves this for the same `sandboxId` and serves it; viewers never call `run()` and never touch a `SandboxSession` method on their path.

4. **Keep the envelope rail as the cold-recovery fallback** — serialize still fires every run (`manager.js:137-140`), so the DB envelope keeps getting written. On a cross-process turn (different worker, or after a restart) the in-process live handle does not survive, so you fall back to today's `sessionState`/`resume` path. **The real design is a hybrid: live-handle warm-path + envelope-resume cold-path** — not pure-B.

---

## 4. The explicit answer to "how do we handle SandboxAgents if we bypass?"

**You almost certainly do NOT bypass them — and that's the point.** Under B:

- You **still let the SDK construct the per-turn session-binding** that points at your box. It binds to your **persistent** live handle, so this is **not build-and-discard** — only the in-process tool **closures** are re-bound each turn (cheap, correct, stateless against the box).
- **Computer-use is just one capability** bound to that live session (`agentPreparation.js:24-28`). Screenshots/clicks route to your box because the capability tool is a closure over the session you injected. There is nothing SDK-managed about the session you'd need to recreate — the "SDK-managed session" is exactly the object you're now supplying.
- So you **do not re-implement** SandboxAgent tool-binding, the capability system, exec/readFile/editor, manifest application, or the interrupted-turn rehydration (`adoptPreservedOwnedSessions` + `rehydrateInterruptedTurnExecutionTools`, `runner/sandbox.js:18-39`).

**If you literally bypassed** (drop `run()`'s sandbox config, drive the box wholly outside the SDK), the cost is large and pointless: you'd re-create `ensureSession`'s resolution, `prepareSandboxAgent`'s capability cloning + `.bind()`, the computer-use wiring, manifest application, interrupted-turn rehydration, and the envelope schema. There is no reason to — the live-session injection seam gives you full lifetime ownership while keeping all of it.

---

## 5. How this changes the singleton-owner + lease design from the prior spec

**Yes — the scary "ownership inversion" shrinks to "keep the preserved box warm + add a viewer/tunnel layer."** The spec's premise that we must wrest the sandbox away from the SDK is wrong on two counts:

- **The SDK already persists box identity across turns** (serialize/resume) — that half is done and stays done.
- **The SDK provides a first-class non-owned-session seam** (`RunConfig.sandbox.session`) — so taking over lifetime is **opt-in via one config field**, not a fight. The interruption-only preservation sub-system (`preserveOwnedSessions` / `canPersistOwnedSessionState` / `canReusePreservedOwnedSession`) is **never even consulted** for a non-owned box, so there's nothing fragile to fight.

**What in the 932KB spec must be revised:**

- **Drop the "build-and-discard per turn" premise** wherever it appears — it's factually wrong; identity persists via serialize/resume.
- **Recast the "ownership inversion" section** as: (i) supply the box to each turn as a **non-owned live session** so the SDK never reaps it; (ii) a worker-side **`SandboxOwner` + refcount(turns + viewers)** is the sole shutdown authority. This replaces any machinery that tries to coerce the SDK's interruption flag or override `close()`/`canReuse*` on a custom client wrapper — both of those *fight* the owned-session path; the non-owned path *steps out of it*.
- **Move the viewer path entirely off the SDK rail** in the spec — it's `resolveExposedPort`/`tunnels` (Channel B), already persisted in the envelope; the spec should not route viewers through any `SandboxSession` method or through `run()`.
- **Keep the singleton-owner / lease concept**, but re-scope it: the lease is over **a Modal box the worker holds**, not over an SDK-internal session. The SDK is a *consumer* of the leased box (via injected `session`), not the lessor.
- **Retain serialize/resume as the documented cold-recovery fallback**, not as the warm-path mechanism.

Net: the spec's hard part shrinks from "invert ownership against the SDK" to "hold the (already-persistent) box warm + bolt on a tunnel viewer layer." Far less SDK-fighting.

---

## 6. Honest residual risks + the live spikes to confirm the hook

**Residual risks (all consequences of taking ownership, none blocking):**

1. **You become the sole owner of liveness** — the SDK's close-on-finish safety net is gone (by design). A leaked handle = a Modal box billing forever. Mitigation: the refcount keeper must be crash-durable; keep upserting the envelope so a lost `sandboxId` is findable/reapable; set a generous provider `idleTimeoutMs` as a backstop reaper.
2. **In-process handle doesn't survive cross-process/worker-restart** — hence the mandatory hybrid (live-handle warm path + `sessionState` cold path). And the cold path is genuinely cold: if a keeper crashes and the box is reaped, `resume()` **throws "no longer running"** (`modal/sandbox.js:937`) and recovery requires the separate `snapshot_filesystem`/`snapshot_directory` rebuild (`:367-485`) — a *new* box from an image. Warm is never guaranteed across a keeper crash; snapshot identity is the floor.
3. **Client decorators run on `create`/`resume`, not on inject** — OpenGeni's `withManifestRefreshOnResume` and friends (`packages/runtime/src/index.ts:1090`, `wrapSession`) wrap `resume`/`create`. When you inject a live `session`, the SDK skips `client.resume`, so any per-turn re-decoration is bypassed. The handle keeps its original decoration, but **verify nothing in the decorator chain expects to re-run every turn**; if it does, re-apply it on inject (the injection branch already supports an additive manifest delta, `manager.js:410-424`).

**The 1–2 live spikes that would confirm the hook behaves as the source suggests:**

- **Spike 1 — non-owned no-teardown + cross-turn reuse (the load-bearing claim).** Inject a live `ModalSandboxSession` as `RunConfig.sandbox.session`, run a normal turn to completion (NOT an interruption), and assert: (a) the Modal box is **still running** after `run()` returns (no `terminate` fired — confirms `closeOwnedSessions` skipped it, `manager.js:642-670`); (b) a second turn injecting the same handle binds capability tools to the **same `sandboxId`** and exec hits the same filesystem state. This directly tests `manager.js:410-424` (non-owned) + `:469-471` + the close gate at `run.js:556`.
- **Spike 2 — concurrent viewer tunnel with no turn in flight.** With no `run()` active, resolve `resolveExposedPort` for the held box, hit the Modal tunnel URL from outside, confirm it serves; then verify the keeper holds the box at refcount ≥1 (viewer) and only `terminate`s once **both** turn-count and viewer-count reach 0. This tests Channel B (`modal/sandbox.js:261-303`) and the refcount keeper end-to-end, including the "alive while viewer watches, no turn" demand the SDK has no concept of.

If both spikes pass, the recommended hook is confirmed against the source and the spec can be revised to the shrunken-scope design above.

---

**Bottom line:** ride the rails for everything agent-facing and for cross-turn identity (already done); extend exactly one rail — inject the box as a **non-owned live session** so the SDK never reaps it — and own the two things the rails deliberately omit: a **refcount(turns + viewers)** keeper for lifetime, and a **Channel-B tunnel** for viewers. No SandboxAgent or computer-use code is reimplemented. The "ownership inversion" was never the real shape; "keep the persistent box warm + add a viewer layer" is.

Key files: `agents-core/dist/sandbox/{client.d.ts:50-62, session.d.ts:103-134, agent.js:9}`; `agents-core/dist/sandbox/runtime/{manager.js:61,127-146,344-380,391-455,469-471,510-569,642-670, agentPreparation.js:17-49, sessionSerialization.js:14-48, livePreservedSessions.js:42-46}`; `agents-core/dist/runner/sandbox.js:18-74`; `agents-core/dist/run.js:337,442,556,706,956,989`; `agents-core/dist/runState.js:539,818,1166`; `agents-extensions/dist/sandbox/modal/sandbox.js:261-303,367-485,806-830,866-944`; OpenGeni `packages/runtime/src/index.ts:763,1003-1051,1090,1637-1725` and `apps/worker/src/activities/agent-turn.ts:250-258`.

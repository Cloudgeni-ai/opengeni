# READINESS & RUNWAY — Sandbox Surfacing (pre-planning)

> **For Jørgen.** This is the runway *before* the full planning cycle opens — not the plan itself. It answers one question: **what must be true, proven, or ruled before sequencing the build into milestones/PRs is worth doing?** Everything here is re-evaluated against the reconciled **stateless-workers** design-of-record (no `SandboxOwner` actor, no per-session/per-group queue, no `ownerHeartbeat`; any pool worker resumes the box by id per turn, injects it non-owned — PROVEN; lease/envelope/meter keyed by `sandbox_group_id`; unlimited concurrency / last-writer-wins; viewers hit the lease-stored tunnel URL directly). The authoritative doc is `00-master-spine.md`; where this disagrees, that wins.
>
> Source register: the deduplicated open-item register (VERIFY V1–V6 · EXPERIMENT E1–E5 · ITERATE I1–I15 · MOOT-NOW). Source feasibility: `04-spike-results.md` (4/5 local spikes PASS, 1 SUPERSEDED-by-removal, 3 credential-gated harnesses authored + statically validated).

---

## (A) DEFINITION OF READY

Planning may open when **all** of the following hold. The bar is deliberately narrow: it lists *only* the things whose failure would change the plan's **SHAPE** — its phase graph, its provider headline, or whether a headline capability exists at all. Anything that only changes a *number*, a *body of code*, or a *Phase-4+ detail* is **not** a readiness gate; it is planned-around.

| # | Ready-bar (must be TRUE before opening planning) | Why it changes the SHAPE if false |
|---|---|---|
| **R-A1** ✅ **HELD** | **The keystone holds on a real provider session** — an injected non-owned `Modal`/`E2B`/`Runloop` session survives `run()` un-reaped (V5 confirms what V1's keystone proved against `unix_local`). | If a *real* provider session reaps differently from agents-core's provider-blind branch, the entire "ride-the-rails, OpenGeni owns lifecycle" premise collapses and the architecture is rebuilt around an owner that reaps explicitly. *(Expected to transfer — PROVEN provider-blind; this is a fast confirm, not a research item.)* |
| **R-A2** ✅ **HELD** | **Modal tunnel passes a `wss://` Upgrade → 101 full-duplex** (V1). | If Modal drops `Upgrade`, the Channel-B vnc-ws desktop transport is **non-viable on Modal** and the *headline provider must change*. This re-shapes Part D (the provider×capability matrix) and the Phase-4 plan's default backend. |
| **R-A3** ✅ **HELD** | **gVisor permits XTEST synthetic input read-back** on at least one desktop-tier backend (V2). | Pixels streaming is necessary-not-sufficient. If `runsc` blocks XTEST, **computer-use is dead even with a perfect pixel stream** — the desktop headline ships *view-only*, which is a different Phase-4 scope and a different product claim. |
| **R-A4** ✅ **HELD** | **Modal lock-free resume (R4) holds** — a second live control handle on a still-alive box opens without throwing; a dead box is the *sole* rejection (V3). | Under stateless resume-by-id, *every* turn (and *every* concurrent shared-box turn) opens a fresh handle on the same live box. If R4 is false, the resume-by-id core needs a **hand-off lock** instead of lock-free reattach — a fundamentally different concurrency primitive that re-shapes Phase 1. |
| **R-A5** ⚠️ **MEASURED** | **The provider tunnel sustains the GA-gate fan-out** — ≥25 concurrent viewers, p95 frame <400 ms, zero provider disconnects, on Modal + one of {Daytona, Runloop} (V4 live half). | Sets the *real* `maxViewersPerSession`. The in-box layer is PROVEN flat to 50/50; only the provider tunnel number is open. This is the **sole remaining Phase-4 GA-gate number** — if the ceiling is low, the desktop multi-viewer plan (and its 429 contract) re-shapes. *(Gates the GA cut, not the start of Phase-4 build — see runway.)* **MEASURED on real Modal (V4, see `07-credentialed-verification.md`): tunnel ≈5 viewers/port direct (frame p95 6405 ms at N=25; in-box plane proven flat to 50/50). Remedy is the `maxViewersPerSession` parameter + relay/SFU for more — a per-provider lever, NOT an architecture change.** |
| **R-A6** ✅ **CLEARED** | **The two load-bearing rulings are made.** **I1/I2 — RULED: the control plane is API-direct.** Every non-turn op (viewer attach, URL mint/rotate, FS list/read, Git status/diff, capability negotiation) is `client → API → box`: the `apps/api` route handler resumes the box by id **in-process** (via the new thin `@opengeni/runtime/sandbox` module — no `@openai/agents` agent-loop import) and returns inline JSON. **No worker, no Temporal, no NATS request/reply** in the synchronous control path; the API owns the `cold→warming` CAS as a Postgres txn. **I3 — RULED: the reaper is one global Temporal Schedule** (periodic sweep — TTL-reap stale viewer holders, reset warming-death rows, terminate at `refcount=0`; runs in the worker, reuses `temporalScheduleOptions`), the *sole* liveness/GC/cost-stop driver. **Temporal is used for exactly two things: the agent turn, and this one reaper Schedule — nothing else.** | (Resolved.) The three modules that ride this seam (Channel-A FS/Git, Channel-B negotiation, recording control) are now grounded: they are API-direct route handlers, not RPC-workflow consumers. Phase-1 liveness has its shape (the one Schedule). The decisions are made; this gate no longer blocks. |

**Explicitly NOT in the Definition of Ready** (planned-around, not gated): every I4–I15 surface/policy/reporting ruling (recommendations already stand); E1–E5 build slices (they *are* the early plan, not a precondition for writing it); V6 (implementation-time source read); all MOOT-NOW items.

---

## (B) THE THREE BUCKETS

Legend — **effort**: S (≤1 day) · M (a few days) · L (≥1 week incl. integration). **blocks-planning?**: *gate* (DoR — planning waits) · *parallel-ok* (run during planning) · *defer* (to implementation). **cred?**: credential-gated (needs absent `MODAL`/`E2B`/`RUNLOOP` creds and/or `runsc`).

### B.1 — VERIFY (confirm a fact; harnesses authored + statically validated, waiting on creds)

| id | what it confirms | effort | blocks-planning? | cred? | dependsOn |
|---|---|:--:|---|:--:|---|
| **V1** | Modal `sandbox.tunnels()` passes `wss://` Upgrade → 101 + full-duplex (harness `modal-tunnel-ws`) | M | **gate (R-A2)** | yes (MODAL) | — |
| **V2** | gVisor `runsc` permits `xdotool` XTEST synthetic-input read-back (harness `desktop-on-gvisor` = SPIKE-2) | M | **gate (R-A3)** | yes (creds + `runsc`) | V1, E3 |
| **V3** | Modal second-handle resume is lock-free; dead box is sole rejection (harness `modal-resume-second-handle`, R4) | S–M | **gate (R-A4)** | yes (MODAL) | — |
| **V4** | Provider tunnel per-port WS fan-out ceiling: ≥25 viewers, p95 <400 ms, 0 disconnects, Modal + 1 of {Daytona,Runloop} (R6 live half) | M | **gate-for-GA-cut, parallel-ok-for-planning** | yes (provider) | V1 |
| **V5** | A *real* provider session (not `unix_local`) survives `run()` non-owned/non-reaped | S | **gate (R-A1)** — but low-risk, expected to transfer | yes (provider) | — |
| **V6** | Which agent-dependent decorators (`withManifestRefreshOnResume`/`wrapSession`) must be re-applied per resume-by-id (skipped on inject path) | S | defer (impl-time source read) | no | E2 |

### B.2 — EXPERIMENT (build/prototype to learn; all buildable now, no creds)

| id | what it builds | effort | blocks-planning? | cred? | dependsOn |
|---|---|:--:|---|:--:|---|
| **E1** | Lease → `packages/db` with real RLS (`withWorkspaceRls`) + drizzle `0017`, **re-keyed to `sandbox_group_id` from the start** (lease UNIQUE `(workspace_id, sandbox_group_id)`, `holders.session_id`, `resume_backend_id`/`resume_state` folded onto lease) + SECURITY-DEFINER cross-workspace sweep fn | L | parallel-ok (foundation for Phase 1) | no | — |
| **E2** | Ownership-inversion runtime edit on real OpenGeni: per-turn resume-by-id + inject-non-owned + drop-handle-in-`finally`; stateless reaper Schedule issuing provider `stop()` at refcount 0; per-provider NotFound discriminator (re-impl per backend) | L | parallel-ok (the literal architectural foundation) | no | E1 |
| **E3** | Desktop image with a **real** Chrome/Chromium deb — fix `docker/desktop.Dockerfile` (swap snap-stub `chromium-browser` → `google-chrome-stable`/`firefox-esr`); CI → GHCR | S–M | parallel-ok (**gates V2/V8** — a usable image must publish first) | no | — |
| **E4** | E2E stateless slice: turn dispatches on global queue → resume-by-id → inject → run → drop; viewer attaches **API-direct** (the `apps/api` handler resumes the box by id in-process, runs the cold→warming CAS as a Postgres txn it owns, acquires a viewer holder, reads/records `data_plane_url` on the lease) → browser hits tunnel **direct**; warm-meter on the two stateless ticks; folds in the control-plane thundering-herd check (N concurrent API-direct handlers serializing on one `FOR UPDATE` row) | L | parallel-ok (integration confidence for Phases 1–4) | partial (viewer-tunnel half wants a provider; DB/API-direct half is non-gated) | E1, E2 |
| **E5** | Recording finalize-across-rollover slice: flush-to-storage-before-rollover, read+PUT in one activity on the holding worker (no 256 MB Temporal payload); rides the re-establish-from-envelope path | M | defer (Phase 4 recording) | no | E2 |

### B.3 — ITERATE (design decision needing a ruling)

| id (former) | the ruling | effort | blocks-planning? | cred? | dependsOn |
|---|---|:--:|---|:--:|---|
| **I1** (OD-1/A1) | Non-turn dispatch *mechanism* — **RULED: API-direct** (the old tri-definition is fully dissolved; there is no RPC dispatch, no owner, no long-lived loop). Every non-turn op is `client → API → box`: the `apps/api` handler resumes the box by id **in-process** (via the thin `@opengeni/runtime/sandbox` module — no `@openai/agents` agent-loop import), runs the cold→warming CAS as a Postgres txn it owns, and returns inline JSON. No worker, no Temporal, no NATS request/reply. | S | **gate (R-A6)** — three modules ride this seam | no | — |
| **I2** (OD-2/A2) | Non-turn op lifecycle — **RULED with I1**: the op runs entirely inside the API request handler (auth-per-call → cold→warming CAS / acquire a transient viewer-kind holder that re-arms a draining/cold box → resume-by-id → operate the live `session` → release the holder + drop the handle on return). No `sandboxOwnerRpcWorkflow`, no per-session task queue, no RPC id — the reply is just the HTTP response. | S | **gate (R-A6)** | no | I1 |
| **I3** (OD-3/A3/A4) | Reaper SECURITY-DEFINER sweep — **promoted to SOLE liveness/GC/cost-stop driver**; exact one-pass predicate (stale viewer holders + warming-death + draining-grace) + DDL in `0017` (group-keyed) + Temporal Schedule wiring | S–M | **gate (R-A6)** — Phase-1 liveness | no | E1 |
| **I4** (OD-S2/OD-4/C1/C2) | Concurrency policy **settled** (unlimited concurrent turns, last-writer-wins, no mutex). Live residuals: **(a)** apply-patch-diff-fail-on-concurrent-edit → re-read→retry OR whole-file writes; **(b)** pair `revision` with `lease_epoch` into `(epoch, revision)` for cache-invalidation under epoch resets | M | partial — policy not a blocker; residuals (a)/(b) gate Channel-A Phase-4 FS writes | no | — |
| **I5** (OD-5/D4) | Headless rollover generalization — re-establish path **branches on tier**; skip `ensureDisplayStack` when tier≠desktop | S | defer (Phase 1, clean generalization) | no | E2 |
| **I6** (OD-6/C6) | Live-VNC revocation — stateless `revokeViewer(viewerId)` activity (any worker, `x11vnc -disconnect`) that disconnects the live RFB session, not just blocks reconnect | S | defer (Phase 3 security) | no | E2 |
| **I7** (OD-7/D2) | Provider preview-token rotation — re-resolving the data-plane URL must re-resolve the *provider* preview token (own TTL); fold per-provider URL re-resolution into event-driven `resolveExposedPort` under the epoch fence | S | defer (Phase 4 Channel-B) | no | — |
| **I8** (OD-8/G2) | `delegationSecret` absent but desktop configured → **graceful degrade** (`DesktopStream.transport:null` + loud warning) vs hard boot-fail | S | defer (Phase 3 boot) | no | — |
| **I9** (OD-9/G3) | `sandboxOwnershipEnabled` disable semantics — **simplified**: no owner processes to reconcile; the reaper's `stop()`-at-refcount-0 applied across all rows on flip is the drain-on-disable sweep; needs the explicit disable-path ruling | S | defer (Phase 1 rollout) | no | I3 |
| **I10** (OD-S1) | Default-share scope — default `"shared"` on MCP-spawn-from-inside-a-session only (rec) vs also API fork vs never | S | defer (shared-sandbox surface) | no | — |
| **I11** (OD-S3) | Viewer auth under sharing — per-session `stream:view` + `acknowledgeShared` 409 disclosure (rec) vs group-scoped grant | S | defer (shared-sandbox Channel-B) | no | — |
| **I12** (OD-S4) | Shared-box cost attribution (correctness auto-settled by `sandbox_group_id` meter-key) — *cost owner* shown as founder + optional per-holder apportionment for visibility, never a 2nd charge (rec) | S | defer (billing reporting; not GA-gating) | no | E1 |
| **I13** (OD-S5) | `{groupId}` explicit-join affordance in v1 — ship the three-way union incl. `{groupId}` (rec, enables manager sibling fan-out) vs `"shared"\|"new"` chain-only | S | defer (shared-sandbox surface) | no | — |
| **I14** (B3/B4/E1/providers) | `workspaceRoot`/`nativeBucketMount` descriptor-consumer contract + deployment-wide `ClientConfig.sandbox` shape (`desktopCapableBackends` = configured ∩ descriptor) — **unowned across modules** | M | defer (Phase 0/5) — but assign an owner | no | — |
| **I15** (C7) | Warming-stall client contract — single `expires_at` TTL + client poll deadline must agree (client ~30s vs lease `warmingTtl`) | S | defer (Phase 4/5 client) | no | — |

---

## (C) THE LOAD-BEARING FEW — do these FIRST

Of everything above, **only these would force an architecture change if they failed.** They are the readiness gates with teeth. Do them before anything else; the rest of the runway can wait behind them.

| rank | item | the failure that re-shapes the architecture | category | how it's de-risked already |
|:--:|---|---|---|---|
| **1** | **V1 — Modal tunnel WS-upgrade** | Modal drops `Upgrade` → no full-duplex over the tunnel → **vnc-ws desktop transport non-viable on Modal → the headline provider must change.** This is the keystone of Channel-B transport. | VERIFY (cred) | Harness `modal-tunnel-ws` authored, statically validated, **provider-independent half self-tested green** (in-box RFC6455 echo round-trips). Only the credentialed tunnel hop is unproven. |
| **2** | **V2 — gVisor + XTEST computer-use** | `runsc` blocks synthetic XTEST input read-back → **computer-use is dead even with pixels** → desktop ships view-only, a different product claim and Phase-4 scope. | VERIFY (cred + `runsc`) | Desktop pixel stack PROVEN (`desktop-stack`: OCR'd `SECRET123` off the framebuffer). XTEST is the *one* unproven layer above the proven pixels. Gated on E3 (publish a usable browser image first). |
| **3** | **V3 — Modal lock-free resume (R4)** | A second live handle throws while the box is alive → resume-by-id-per-turn (and *every concurrent shared-box turn*) needs a **hand-off lock, not lock-free reattach** → Phase-1 concurrency primitive is rebuilt. **More load-bearing under stateless workers, not less** — concurrent turns on a shared box each resume the same live box. | VERIFY (cred) | SDK confirms `resumeIsLockFree=true` is *asserted directly* in the harness (not assumed); Modal state object is serializable + exactly what `resume()` consumes. The credentialed live-fire is the only gap. |
| **4** | **V4 — provider tunnel fan-out ceiling** | Ceiling below the GA bar → the multi-viewer desktop plan + its `maxViewersPerSession`/429 contract re-shape. **The sole remaining Phase-4 GA-gate number.** | VERIFY (cred) | In-box layer **decisively cleared**: `fan-out` spike served 50/50 concurrent viewers off one framebuffer, p95 flat ~410 ms. Only the provider tunnel hop is open. *(Gates the GA **cut**, not the start of Phase-4 build.)* |
| **5** | **I1/I2 + I3 — the control-plane seam + the reaper** | Not an experiment — a *decision*. I1/I2 is the one seam three modules ride (FS/Git, negotiation, recording); I3 is the *only* GC + cost-stop now that `ownerHeartbeat` is deleted. Unmade, Phase-1 liveness and three modules cannot be sequenced. | ITERATE (no cred) | Both are **RULED** by the stateless + **API-direct** rulings (no owner, no long-lived loop, no RPC workflow/queue) — the hard part is gone. I1/I2 = the control plane is API-direct (the `apps/api` handler resumes the box by id in-process and returns inline JSON; the reply is the HTTP response, so there is no id/holder/timeout RPC contract to write — only the in-handler CAS + transient-holder logic); I3 = the one-pass predicate/DDL/Schedule. Recommendations stand in master-spine OD-1/OD-2/OD-3 (now ✅ RULED). |

**Why these and not the rest:** V5 is expected to transfer (provider-blind branch — a confirm, not a discovery). E1/E2 are the *foundation build*, not a precondition for *writing the plan*. Every I4–I15 either has a standing recommendation or only re-shapes a Phase-4+ detail. The four credential-gated VERIFYs + the two rulings are the entire set whose failure forks the architecture.

---

## (D) RECOMMENDED RUNWAY

Three lanes run concurrently. **Lane 1 (the rulings)** has no external dependency and is the literal Definition-of-Ready for shape — close it first, in parallel with everything. **Lane 2 (the credentialed live-fire)** is gated only on creds being dropped — kick it off the moment creds land. **Lane 3 (the foundation build)** can start now and run straight through planning.

### Must finish BEFORE opening planning (the shape gates)

| step | item(s) | lane | runs-with | rationale |
|:--:|---|---|---|---|
| **D1** | **I1/I2 + I3 rulings** (R-A6) | 1 (decision) | everything | No creds, no build dependency. The single highest-leverage move — three modules and Phase-1 liveness unblock the instant these are written. Master-spine already recommends the answers; this is ratification, ~a sitting. |
| **D2** | **V1 (Modal WS), V3 (R4), V5 (real-session non-reap)** | 2 (cred live-fire) | D1 | The three keystone-class confirms that don't depend on the desktop image. Run the moment `MODAL` creds drop. V1 and V3 each independently fork the architecture; V5 is the fast transfer-confirm. **These are the gating live-fires.** |
| **D3** | **E3 (real-browser desktop image) → V2 (gVisor XTEST)** | 2→3 boundary | D1, D2 | V2 needs a *usable* published image; E3 publishes it (non-gated, buildable now). V2 then forks the architecture on the computer-use-vs-view-only axis. E3 starts immediately; V2 fires when creds + `runsc` land. |

> **Planning opens when D1+D2+D3 are green** (i.e. R-A1…R-A4 + R-A6 hold). **R-A5 (V4) is the one exception:** it gates the **GA cut**, not the start of planning — the desktop *plan* can be written with `maxViewersPerSession` as a measured-later parameter, then frozen by V4 before GA. Do not block opening planning on V4.

### Can run DURING planning (parallel-ok)

| item(s) | lane | rationale |
|---|---|---|
| **E1 (lease→db re-keyed `0017`)** | 3 (build) | The foundation; first and most complex migration. Start now; it is the substrate every later phase stands on. The three shared-sandbox **Criticals** (CAS keys, meter key, envelope split) must land *together inside E1*. |
| **E2 (ownership-inversion runtime edit)** | 3 (build) | The literal architectural foundation — everything stands on it compiling/running. Begins as soon as E1's lease + reaper functions exist. |
| **E4 (e2e stateless slice)** | 3 (build) | Integration confidence for Phases 1–4; folds in the thundering-herd check. DB/Temporal half is non-gated (run now); the viewer-tunnel half waits on a provider (run after D2). |
| **V4 (provider fan-out ceiling)** | 2 (cred) | The GA-gate number. Measure during planning; freeze before the GA cut. Depends on V1 passing first. |
| **V6 (decorator-skip consequence)** | — | Impl-time source read against `packages/runtime`; resolves inside E2. |

### Defer to IMPLEMENTATION (do not let these hold the runway)

- **E5** (recording finalize-across-rollover) — Phase 4 recording.
- **I4 (a)/(b)** (apply-patch-diff-fail, `(epoch, revision)` tuple) — Channel-A Phase-4 FS writes.
- **I5, I6, I7** — Phase-1 headless-rollover branch-on-tier; Phase-3 `revokeViewer`; Phase-4 provider-token rotation. Each has a standing recommendation; each is a single-phase detail.
- **I8, I9** — Phase-3 boot graceful-degrade; Phase-1 disable-path sweep (reaper-driven).
- **I10–I13** — shared-sandbox surface/auth/billing-reporting; all worker-agnostic, all with standing recommendations in addendum §H; none GA-gating.
- **I14** — **assign an owner during planning** (unowned across modules today) but the *work* is Phase 0/5.
- **I15** — Phase-4/5 client warming-stall contract.

### The MOOT-NOW set (no action; here so nobody re-opens them)

The stateless ruling **dissolved** these — they need no call: SPIKE-5 (temporal worker-per-session — resolved by *removal*, ~35 MB/worker / 1.9 GB @ N=50 / O(N×6) poller wall all moot); SPIKE-4 (epoch-on-heartbeat — already PROVEN by `lease-epoch`, defect C1b found+fixed); A5 / `ownerHeartbeat` (deleted — warm-time accrues on the turn's existing 30s heartbeat + the reaper tick); A4 (Schedule-driver-vs-reaper — folded into I3); in-worker-vs-gateway placement (void — no owner actor); B5 (per-provider `build()` bodies — Phase-0 build work, not a fork); C3 (PTY scrollback — deferred-by-design, v1 Terminal is sse-events); and all "owner re-election" framing (→ "box rollover handled by any worker via re-establish-from-envelope"; the substantive residuals survive as E5 + I4).

---

## (E) WHAT PLANNING THEN COVERS

Once the runway clears — the I1/I2 + I3 rulings ratified (R-A6), and V1/V3/V5 + E3→V2 green (R-A1…R-A4), with V4 measured-and-pending for the GA freeze (R-A5) — the full planning cycle takes over: it sequences the **now-stateless** PART F build into concrete milestones and PRs. The phase graph is already topologically forced — **Phase 0** providers + OS axis (`0018`, all 7 non-trivial `build()` bodies) → **Phase 1** lease + ownership inversion (`0017`, the stateless reaper Schedule, the one recovery primitive) → **Phase 2** warm-time billing on the two stateless ticks → **Phase 3** security control plane (perms, ack table, token mint/revoke) → **Phase 4** the desktop headline (image, `ensureDisplayStack`, pixel plane, computer-use + recording, GA-gated on V4) → **Phase 5** client surfacing (SDK mirror, React hooks, Pierre trees/diff, xterm, noVNC). Planning's job is to slice each phase into shippable PRs behind its independent forward-default-off flag, wire the forced migration order (`0017`→`0018`→`0019`→`0020`→`0021` with the hand-appended journal+snapshot), fold the deferred ITERATE residuals (I4–I15) into their owning phases, assign the one unowned contract (I14), and pin the Phase-1 exit gate (the `owner.spawn`-vs-distinct-`(session,epoch)` double-spawn detector). The architecture is **proven where it's load-bearing and decided where it forks** — planning is sequencing, not discovery.

---

### Headline read for the runway

1. **Six items gate the shape; nothing else does.** Four credentialed VERIFYs (V1 Modal-WS, V2 gVisor-XTEST, V3 R4, V4 fan-out — and V4 gates the *GA cut*, not the planning start) plus two rulings (I1/I2 + I3). All four harnesses are authored and statically validated; both rulings are recommended-and-ready in the master spine.
2. **The fastest path to "ready" is the rulings** — D1 has no creds and no build dependency, and it unblocks three modules + Phase-1 liveness the moment it's written.
3. **The foundation (E1+E2) can start today and run through planning** — it is the literal architecture, not a precondition for writing the plan. The three shared-sandbox Criticals must land *together* inside E1's `0017`.
4. **V3 is now MORE load-bearing under stateless workers**, not less — concurrent shared-box turns each resume the same live box, so lock-free reattach is the core, not an edge.
5. **The biggest wins are already banked:** the keystone (inject-non-owned never-reaped), the lease/epoch fence on the heartbeat path, the desktop pixel stack (OCR'd), and 50/50 native fan-out are all PROVEN. The pending set is exactly the credentialed provider hops — and the worker-per-session scaling fear is *gone by removal*, not mitigated.

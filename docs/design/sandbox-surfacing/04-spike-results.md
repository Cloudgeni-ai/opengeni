# SPIKE RESULTS — Sandbox-Surfacing Feasibility, Consolidated Briefing

Harness root: `/home/jorge/repos/Cloudgeni-ai/opengeni/.claude/worktrees/naughty-engelbart-2d3b09/spikes/`

## RESULTS MATRIX

| # | Spike | Executed here? | Result | One-line finding |
|---|-------|:--:|:--:|---|
| 1 | `sdk-keystone` | yes | **PASS** | Non-owned injected SDK session survives a full `run()` and is **never reaped**; owned control session **is** reaped — the ride-the-rails hook is confirmed against real `@openai/agents-core@0.11.6`. |
| 2 | `lease-epoch` | yes | **PASS** | Plain `FOR UPDATE` (not `SKIP LOCKED`) upholds the singleton; the **epoch fence must also guard the heartbeat path** (the actual split-brain bug) — both proven on real postgres:16, plus an int8-returns-string defect fixed. |
| 3 | `desktop-stack` | yes | **PASS** | Xvfb/XFCE/x11vnc/websockify/noVNC streams a live framebuffer (OCR read `SECRET123` off the pixels); **`chromium-browser` apt pkg is a snap-stub** — the canonical image needs a real Chrome/Chromium deb. |
| 4 | `fan-out` | yes | **PASS** | One `x11vnc -shared` + one websockify served **50/50 concurrent viewers off one framebuffer**, frame p95 flat ~410 ms — the in-box layer is not the bottleneck; only the provider tunnel ceiling remains. |
| 5 | `temporal-placement` | yes | **PARTIAL → SUPERSEDED** | Per-session **routing works**, but worker-per-session **as written (§6.1 `workflowsPath`) is non-viable** (~35 MB/worker → 1.9 GB @ N=50); activities-only fixes memory but leaves an **O(N×~6) poller-stream** wall. **SUPERSEDED by the stateless-workers ruling — OpenGeni does NOT do worker-per-session at all** (turns run on the existing global queue and resume the box by id); the concern is resolved by *removal*, not mitigation. See §5 below. |
| 6 | `provider-credentialed` (3 sub-harnesses) | **no — credential-gated** | **NOT RUN** | Three complete runnable harnesses authored + statically validated against the real SDK surfaces; everything is blocked solely on absent `MODAL`/`E2B`/`RUNLOOP` creds and `runsc`. |

Net: **4 of 5 locally-runnable spikes PASS outright; 1 is PARTIAL (a real design-changing finding, not a failure); the 6th group is authored and waiting on your credentials.** Nothing failed in a way that breaks the design — one item (Temporal §6.1) failed in a way that **forces a documented design change that was already flagged in the doc's own critique.**

---

## Per-spike detail

### 1. `sdk-keystone` — PASS

**Proven empirically (real `run()`, exit 0, `node:assert/strict`):** This is the load-bearing keystone — that OpenGeni can inject a live sandbox session into the OpenAI Agents SDK and the SDK will **never reap it**, so OpenGeni owns the box lifecycle. The full lifecycle ran with **no provider creds and no OpenAI key.**

- A live session injected as `RunConfig.sandbox.session`, run through a **normal** turn (`lastStep = next_step_final_output`): after `run()` returned, `session.closed === false`, the workspace dir still existed, and the agent-written marker file was present → the non-owned session was **not reaped**.
- A second `run()` on the **same handle** read the exact marker back (`KEYSTONE_TURN1_1781856694`) — same box, same filesystem across runs.
- **Control:** an *owned* session (resumed from `sessionState`) run to the same kind of normal finish **was** reaped (workspace `rm -rf`'d). This proves the "stayed alive" result is a genuine ownership distinction, not a no-op.

**The discovery that made this creds-free:** `@openai/agents-core` ships an in-tree `UnixLocalSandboxClient` (`backendId="unix_local"`) that runs processes on the host. The ownership/teardown logic under test lives entirely in agents-core `manager.js` and is **provider-agnostic**, so the local backend exercises the exact cited code paths — no Docker, no Modal/E2B.

**Source-level confirmation against installed 0.11.6:** `manager.js:422` (injected branch) calls `registerSessionForAgent` **without** `{owned:true}`; create/resume pass `{owned:true}`; `manager.js:469-471` adds to `ownedSessionAgentKeys` only when owned; `closeOwnedSessions` (`:642-643`) filters strictly to that set; `run.js:556` preserves sessions only on `next_step_interruption`. Runtime behavior matches the static source exactly.

**Stubbed:** only the Model (a no-network `ScriptedModel` attached directly as `agent.model`, which bypasses modelProvider/API-key). Everything else is real SDK.

**Credential-gated remainder:** Nothing about the proven claim is gated. Two adjacent items are provider-only and noted as residual risks: (a) confirming a *real* provider session (e.g. `ModalSandboxSession`) is likewise non-owned — but the non-owned branch is in provider-blind agents-core, so the result transfers; (b) Spike-2 of the doc (concurrent viewer tunnel via `resolveExposedPort`) needs a provider with real tunnels.

**Surprise / follow-up:** The doc's residual-risk #3 — OpenGeni's `withManifestRefreshOnResume`/`wrapSession` decorators run on create/resume but are **skipped on inject** — is a real consequence of this seam and should be verified against `packages/runtime` at implementation time.

**Run it:** `cd spikes/sdk-keystone && node keystone.mjs ; echo "exit=$?"` → `exit=0` + `ALL ASSERTIONS PASSED`. No network/Docker/creds, ~1s, self-cleans its tmp dir. Canonical capture: `EXPECTED_OUTPUT.txt`.

---

### 2. `lease-epoch` — PASS

**Proven empirically (real throwaway postgres:16 on :55432, the `lease_leases` + `sandbox_lease_holders` DDL verbatim from master-spine §C.2 / module 01-lease §1, exit 0):**

1. **Serialization on plain `FOR UPDATE`:** two concurrent acquirers on one `(workspace,session)` serialize — exactly one wins the cold→warming CAS (`spawner`), the other **attaches to the same row** (`attached`, refcount=2). Held at **N=50: 1 spawner, 49 attached, refcount=50.** A dedicated `counterfactual.ts` proves this is load-bearing: the same race with `FOR UPDATE SKIP LOCKED` makes the concurrent arrival get **zero rows back** ("skipped-no-row") 8/8 runs — the exact "row vanished" branch that would push an owner into spawning a second box.
2. **Epoch fence on the heartbeat path** (the real split-brain bug): after a re-election bumps the epoch (S1 ep1 → S2 ep2), stale owner S1's heartbeat at its old epoch is **rejected** (returns false → self-evict), does not refresh `expires_at`; live owner S2's heartbeat at the current epoch succeeds.
3. **refcount→0 → warm→draining** (guarded by `turn_holders=0`) → reaper surfaces the session as drainable.
4. **Stale viewer holder TTL-reaped while a same-age turn holder is exempt and survives;** refcount recomputed from `COUNT(holders)`; lease stays warm (a paying turn is never drained out from under the agent).

**Two adversarial-review defects confirmed and fixed in the harness:**
- **C1a:** an `int8` `lease_epoch` returns a JS **string** from postgres-js (`typeof='string'`, `"7"`), so the spec's strict `row.lease_epoch !== expectedEpoch` is **always-true** — the fence must `Number()`-coerce; the spine's choice of `integer` (returns a JS number) also avoids it.
- **C1b:** the spec's `heartbeatLeaseHolder` did **no** epoch check (only the rare turn-arrival path was fenced), so two owners could both keep heartbeating — fixed by adding the epoch+liveness guard to the heartbeat refresh. **This was tested on the heartbeat path, not just acquire, as instructed.**

**Credential-gated remainder:** None — fully executed here. Caveat: the harness ports the module's query functions to runnable postgres-js rather than importing real `packages/db` (Drizzle/RLS-GUC plumbing the spike doesn't need); the SQL semantics tested are identical to spec. **Integrating into `packages/db` with real RLS (`withWorkspaceRls`) and the drizzle 0017 migration is the remaining (non-gated) implementation work.**

**Surprise:** the int8-string trap (C1a) — a silent always-true comparison that would have neutralized the entire fence. Caught only by running against a real driver.

**Run it:** `cd spikes/lease-epoch && bash run.sh` (spins up `ogspike-lease-pg`, runs `run.ts` then `counterfactual.ts`, always `docker rm -f` via EXIT trap). Exit 0 iff every `[PASS]` prints.

---

### 3. `desktop-stack` — PASS

**Proven empirically (built `ogspike-desktop:latest` = Ubuntu 22.04 + Xvfb/XFCE4/x11vnc/websockify/noVNC per 04-desktop-image.md §1 L1-5/7; launched via `docker exec` per §3; all 3 asserts PASS, exit 0):**
- (a) `curl /vnc.html` → HTTP 200, noVNC page.
- (b) WS upgrade to `/websockify` → **101 Switching Protocols** (`sec-websocket-protocol: binary`) and the VNC RFB banner `RFB 003.008\n` (hex `524642203030332e3030380a`) arrived over the socket.
- (c) **Live framebuffer proven:** launched `xterm` on `:0` echoing `SECRET123`, `scrot` captured it, **tesseract OCR read `SECRET123` back**; 682 distinct sampled colors confirm a fully rendered XFCE desktop. Bonus: `ffmpeg x11grab` produced a valid 1280×800 h264 mp4.

The **exec-driven launch model works exactly as §3 describes** (container root stays `sleep infinity`; the stack is not the CMD); `up.sh` printed `OPENGENI_DESKTOP_UP port=6080 geometry=1280x800 dpi=96`, exit 0.

**Carry-into-design findings:**
1. **CRITICAL:** `chromium-browser` on Ubuntu 22.04 is a **snap-transition stub** (a 2.4 KB shell script demanding the chromium snap); with no snapd in the container it installs nothing runnable (`chromium proc: <none>`). **§1 Layer 5 will not yield a working in-box browser as written** — fix the canonical image to install a real `chromium` deb, the Google Chrome deb, or base on Debian. Does **not** affect the streaming stack, only the agent/viewer browser workload.
2. `x11-apps` doesn't include `xterm`, and base has no tesseract; XFCE ships `xfce4-terminal` so prod is fine, but harnesses shelling to xterm/tesseract must add them (I did, solely to make assert (c) OCR-definitive).
3. Lean image is ~899-943 MB (no cloud tools); the full §1 image will be larger — **track cold-pull latency for Modal registry-at-runtime.**
4. One exposed port confirmed: websockify serves both `/vnc.html` and the RFB stream at `/websockify` (subprotocol `binary`) on 6080, matching §0/§7.

**Credential-gated remainder:** None for this spike. The **gVisor isolation** of this same stack is a separate credentialed spike (`runsc` absent here); the provider pixel-path tunnel + per-port fan-out cap (§F11) is the fan-out/provider spike, which reuses this retained image.

**Run it:** `bash spikes/desktop-stack/run.sh` (Docker/node/bun; host :56080→6080; EXIT trap always `docker rm -f`). Artifacts in `artifacts/` (`shot.png`, `recording.mp4`, `ws-probe.out`). Image **intentionally retained** for the fan-out spike.

---

### 4. `fan-out` — PASS

**Proven empirically (reused `ogspike-desktop:latest`, no rebuild; exit 0):** the "native fan-out, no provider multi-attach" claim **holds.** One `x11vnc -display :0 -forever -shared -viewonly -wait 50` + one `websockify` on the single exposed port 6080 served **N=1,5,20,50 fully-handshaked concurrent RFB viewers off the same `:0` framebuffer at 100% success every N** (1/1, 5/5, 20/20, 50/50), per-viewer frame p95 ≤ 412 ms even at 50. Each client completed the **full RFB 3.8 handshake** through to a first `FramebufferUpdate` — real pixels, not just a TCP/WS connect. The running cmdline confirms `-shared` (native multi-viewer) and `-viewonly` (v1 read-only plane) are live; `netstat` confirms **exactly one** x11vnc and **one** websockify listener.

**Findings for design:**
1. The in-box x11vnc/websockify layer is **not** the bottleneck — the remaining R6 risk is purely the provider tunnel ceiling (live half, needs creds).
2. Frame p95 is **flat from 20→50** (412→409 ms); the cost that grows with N is per-connection handshake setup (avg 1.6 s @20 → 3.2 s @50), not steady-state pixels — once attached, viewers are cheap.
3. The ~400 ms p95 is a **pessimistic floor**: the probe forces full uncompressed Raw 1280×800 frames; real noVNC uses Tight/ZRLE incremental and will be lower.
4. **`maxViewersPerSession` default 8 is conservative** vs the in-box reality of 50 — the cap should be driven by provider-tunnel measurement, not by x11vnc.
5. Harness gotchas for the eventual e2e test: `novnc_proxy` is a bash launcher whose lone `python3 -m websockify` child is the only listener (so `pgrep` over-counts — assert on the LISTEN socket); `ss`/iproute2 is **not** in the desktop image, `netstat`/net-tools is.

**Credential-gated remainder:** The **live half of R6** is intentionally not run here. `test/live/desktop-fanout.live.ts` against a real desktop-capable provider (channel-B §9 bar: ≥25 concurrent viewers, p95 frame < 400 ms, zero provider-imposed disconnects on Modal + one of {Daytona, Runloop}) measures the **provider tunnel's per-port WebSocket fan-out ceiling** — the one open R6 number and the only thing blocking the Phase-4 GA gate. Also not exercised: the control-plane thundering-herd (N owner RPCs + N viewer holders on one `FOR UPDATE` row) — that's the DB/Temporal layer, a separate spike.

**Run it:** `bash spikes/fan-out/run.sh` (depends on `ogspike-desktop:latest`; rebuilds from `../desktop-stack` if absent; host :56081→6080; EXIT trap cleans up). Exit 0 = 100% every N **and** singleton confirmed. Real output: `artifacts/results.jsonl`.

---

### 5. `temporal-placement` — PARTIAL (a real design-changing finding, not a failure)

> **SUPERSEDED by the stateless-workers ruling.** OpenGeni does **not** do worker-per-session at all. Workers are a stateless pool exactly as today: each turn, any worker resumes the box by id (warm reattach or cold-restore), injects it non-owned, runs the agent on the **existing global queue**, and drops the handle at turn end. So the "worker-per-session non-viable (~35 MB/worker, 1.9 GB @ N=50)" and "O(N×~6) poller-stream" findings below are now **moot — the concern is resolved by removal, not mitigation**: there is no per-session worker, no per-session/per-group Temporal queue, and no `ownerHeartbeat`/keepalive loop to scale. The empirical numbers are retained below precisely because they justify *why* the ruling abandons per-session workers. The spike's still-load-bearing residual is only that the **lease/epoch concurrency model** (spike 2) and **resume-by-id** are the primitives that actually carry the design.

**Proven empirically (real Temporal Server 1.31.1 dev server on :57233; scaling probe at N=1,10,50 in two modes + an e2e routing proof):**

1. **Per-session routing is viable and correct.** _[SUPERSEDED: the design uses stateless workers + API-direct control, not per-session routing — see 06-readiness / 02-owner]_ The 02-owner.md §6.2 mechanism works end-to-end: a global-queue workflow dispatching `proxyActivities({ taskQueue: 'sandbox-owner::<sid>' })` lands on **exactly** the matching per-session worker — **routing proof 5/5 PASS, exit 0.** Per critique B3, the queue name is derived deterministically in-workflow as `` sandbox-owner::${sessionId} `` — confirmed deterministic.

2. **Worker-per-session as written in §6.1 (`workflowsPath`) is NOT viable — completeness-critique B1 confirmed with numbers.** Each per-session worker that registers a workflow bundle costs **~35 MB RSS**; at just **N=50 the node process hit 1.9 GB.** Startup ~190 ms/worker + a 720 ms one-time bundle. Linear extrapolation blows the memory budget well before thousands of sessions. **The fix (B1 option a) — register only *activities* on the per-session worker (workflows always run on the global queue) — drops per-worker memory to ~0.3-0.6 MB and startup to ~2-3 ms** (SDK logs "No workflows registered, not polling for workflow tasks"). So the per-session-**queue** abstraction is fine; the per-session-`Worker.create` with `workflowsPath` is the part that must change.

3. **New finding the design docs did NOT anticipate:** even activities-only, each per-session worker opens **~5-13 concurrent activity long-poll streams** (SDK autoscaling poller default, min 5), not 1. At N=50, Temporal saw **298 total activity poll streams across the 50 queues** (mean 6.0/queue). **However these multiplex over a single shared TCP connection** (verified: 1 socket system-wide while 50 workers warm; node fd count = 4) — so B1's "exhaust file handles" worry is **overstated.** The real wall is **server-side poller-slot pressure: ~N×6 long-poll streams** (≈6k @ 1k sessions, ≈60k @ 10k sessions from one worker process). Mitigations to choose explicitly (none free): cap `maxConcurrentActivityTaskPolls:1` per worker (298→~50 at N=50, still O(N)); a small fixed worker pool polling hashed queue subsets (B1 option b, needs routing — Temporal has no wildcard queue subscription); or drop per-session queues for an `owner_worker_id` affinity mechanism (B1 option c).

**Verdict on the spike question "is worker-per-session viable?":** viable for **routing**; viable for **memory only if activities-only** (not the §6.1 literal); and **bounded by server-side poller streams that grow O(N×~6)** — quantified, and **needs an explicit poller-cap or pooling decision before session scale.** This is why the spike is PARTIAL: it didn't fail, but it disproved one written mechanism and surfaced a new scaling parameter that needs a design ruling.

**Credential-gated remainder:** None — stood up its own throwaway Temporal dev server, no provider creds. Out of scope (deliberately): real sandbox-provider spawn latency layered on the cold→warm path — the harness uses a trivial ping activity as a stand-in for `runAgentSegment`, sufficient to characterize Temporal worker/poller/routing cost in isolation.

**Surprise:** the multiplexed-single-TCP result (B1's file-handle fear is overstated) *and* the converse — the genuine ceiling is server-side poller slots, a dimension the docs hadn't named.

**Run it:** `cd spikes/temporal-placement && bun install && bash up.sh 57233`, then `HOLD_MS=3000 node --expose-gc ./scale.mjs 50 {activities-only|with-workflows} 127.0.0.1:57233` and `node ./route.mjs 5 127.0.0.1:57233` (→ `## ROUTING ASSERTION: PASS (5/5)`). Always `docker rm -f ogspike-temporal-placement-server`. Full capture: `results.txt` (245 lines). **Use node, not bun — Temporal core-bridge is a native addon.**

---

### 6. `provider-credentialed` (3 sub-harnesses) — NOT RUN (credential-gated)

Three complete, runnable, credential-gated harnesses authored, each with script + README (exact env vars/commands + explicit PASS/FAIL assertions), grounded in the design docs and **verified against the real SDK surfaces** (`@openai/agents-extensions@0.11.6` modal/e2b/runloop clients + `modal@0.7.4` `dist/index.d.ts`).

1. **`modal-tunnel-ws`** — raw Modal SDK: `apps.fromName → images.fromRegistry → sandboxes.create({encryptedPorts:[6080]}) → sandbox.tunnels(10000) → Tunnel{host,port,url}`; then a `wss://` probe asserts HTTP 101 + server banner + full-duplex echo through the tunnel. This is the **exact** provider call `ModalSandboxSession.resolveExposedPort` makes (`sandbox.mjs:241`, `recordResolvedExposedPortEndpoint{tls:true}`). Grounds the Channel-B vnc-ws transport.
2. **`desktop-on-gvisor`** — provider-generic (`SPIKE_PROVIDER=modal|e2b|runloop`) via the agents-extensions clients. Ships the canonical `opengeni-desktop-up.sh` (copied verbatim from the PASSing desktop-stack), runs launch-via-exec, then asserts **under gVisor**: Xvfb `xdpyinfo`, x11vnc:5900 + websockify:6080 listening, **`xdotool` XTEST mousemove read-back (the computer-use path)**, and `scrot` PNG capture.
3. **`modal-resume-second-handle`** — proves Modal **R4 (resumeIsLockFree)**: creates handle A, keeps it **alive**, serializes A's state, and `client.resume()`s it into handle B — asserts B opens without throwing, same `sandboxId`, `B.running()=true`; then A↔B concurrent file ops on the same box; then a negative control: after terminate, a third resume throws "no longer running", pinning that a **dead box is the sole rejection mode.**

**Static validation done here:** `node --check` (3 mjs), `bash -n` (up-script), `py_compile` (in-box listener), JSON-parse (3 package.json) — all OK. Plus a **real local self-test** of harness-1's provider-independent half: the in-box RFC6455 WS echo listener handshakes to HTTP 101 and round-trips banner+echo against a real `ws` client (PASS). The only unproven piece per harness is precisely the credentialed provider behavior.

**Design-relevant facts surfaced from the SDK:** Modal is `supportsOnDemandPorts=false` → **6080 must be in `encryptedPorts` at create** (cannot open a port later); Modal `canPersistOwnedSessionState()=false` but the state object is still serializable and is exactly what `resume()` consumes; `resumeIsLockFree=true` is asserted directly, not assumed.

**Probed env confirms gating:** `runsc` ABSENT; `MODAL_TOKEN_ID`/`E2B_API_KEY`/`RUNLOOP_API_KEY` all unset.

**How to run (each from its own dir after `bun install`, terminates its box in a `finally`):**
- **modal-tunnel-ws:** `export MODAL_TOKEN_ID=ak-… MODAL_TOKEN_SECRET=as-… ; node modal-tunnel-ws.mjs`. **Critical FAIL to watch:** 101 never arrives → Modal tunnel drops `Upgrade` → **vnc-ws desktop transport non-viable on Modal.**
- **desktop-on-gvisor:** publish the canonical desktop image to the provider first (build from `spikes/desktop-stack/Dockerfile`, **swapping the snap-stub `chromium-browser` for `google-chrome-stable`/`firefox-esr`** — finding from spike 3). Then `SPIKE_PROVIDER=modal` + `MODAL_TOKEN_*` + `SPIKE_DESKTOP_IMAGE=…` (or the e2b/runloop equivalents); `node desktop-on-gvisor.mjs`. **Highest-value FAIL:** ASSERT-4 read-back ≠ target → **gVisor blocks XTEST → computer-use dead even if pixels stream.**
- **modal-resume-second-handle:** `export MODAL_TOKEN_ID/SECRET ; node modal-resume-second-handle.mjs`. **Critical FAIL:** ASSERT-2 throws with A alive → **R4 false → warm-keeper + re-elected-owner design needs a hand-off lock, not lock-free reattach.**

Top-level + per-sub READMEs give exact env vars, defaults, expected-output shapes, and FAIL signatures.

---

## UPDATED FEASIBILITY VERDICT

**PROVEN by execution here (no longer assumptions):**

- **The keystone bet — OpenGeni rides the SDK's rails and the SDK never reaps an injected (non-owned) session — is PROVEN** against real `@openai/agents-core@0.11.6`, runtime *and* source. This is the single most load-bearing claim of the whole design, and it stands. (spike 1)
- **The lease/epoch concurrency model is PROVEN** on real postgres: plain `FOR UPDATE` upholds the singleton (with `SKIP LOCKED` empirically shown to break it), and the **epoch fence now correctly guards the heartbeat path** — the real split-brain bug. Two latent defects (int8-string comparison, unfenced heartbeat) were caught and fixed before they shipped. (spike 2)
- **The desktop pixel stack is PROVEN** end-to-end: exec-launched, one exposed port, live framebuffer OCR-verified, recordable. (spike 3)
- **Native viewer fan-out is PROVEN** at 50 concurrent viewers off one framebuffer with flat frame latency — the in-box layer is decisively cleared. (spike 4)
- **Per-session Temporal routing is PROVEN** correct and deterministic — but **now unused**: the stateless-workers ruling routes turns on the existing global queue, so per-session routing is not part of the design. (spike 5)

**Still PENDING your credentials (the design's remaining live-fire unknowns):**

- **Modal tunnel WebSocket transport** (does the provider tunnel pass a `wss://` Upgrade and 101?) — gates the whole Channel-B desktop transport on Modal.
- **gVisor + XTEST computer-use** (does `runsc` permit synthetic input read-back?) — gates computer-use; pixels streaming is necessary but not sufficient.
- **Modal lock-free resume (R4)** — gates the warm-keeper / re-elected-owner hand-off design.
- **The provider tunnel's per-port concurrent-WS fan-out ceiling** — the one open R6 number; sets the real `maxViewersPerSession` and is the only thing blocking the Phase-4 GA gate.
- **Real provider session non-owned/non-reaped confirmation** — expected to transfer from spike 1 (the branch is provider-blind), but worth a live check.

**Did anything fail in a way that changes the design? One thing — and it is now resolved by REMOVAL, not mitigation:**

- **Temporal worker-per-session as literally written in 02-owner.md §6.1 (`workflowsPath` per session) is non-viable** — ~35 MB/worker, 1.9 GB at N=50; and even activities-only it opens an O(N×~6) server-side poller-stream wall. **This is SUPERSEDED by the stateless-workers ruling: OpenGeni does NOT do worker-per-session at all.** Turns run on the existing global queue and resume the box by id; there is no per-session worker, no per-session/per-group queue, and no `ownerHeartbeat`/keepalive loop — so the memory blow-up, the activities-only/poller-cap decision, and the `owner_worker_id`-affinity option are all **moot** (the question is dissolved, not answered). The empirical numbers stand as the *justification* for removing per-session workers. **No other spike failed; the rest of the design is corroborated.**

**Two non-gated implementation tasks the spikes leave behind:**
1. Integrate the lease logic into `packages/db` with real RLS (`withWorkspaceRls`) + the drizzle 0017 migration (spike 2 ran ported SQL, not the real package).
2. Fix the canonical desktop image's browser layer (snap-stub `chromium-browser` → real Chrome/Chromium deb) before the gVisor/provider desktop spikes can publish a usable image (spike 3 → feeds spike 6's `desktop-on-gvisor`).

All harnesses are self-cleaning (EXIT traps `docker rm -f`; no residual containers or `/tmp` litter verified) and live under `/home/jorge/repos/Cloudgeni-ai/opengeni/.claude/worktrees/naughty-engelbart-2d3b09/spikes/`. The two retained Docker images (`ogspike-desktop:latest`) are intentional, shared by spikes 3→4 and the provider desktop harness.

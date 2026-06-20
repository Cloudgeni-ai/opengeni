# CREDENTIALED VERIFICATION — Sandbox Surfacing (real-Modal live-fire results)

> **For Jørgen.** This is the credentialed live-fire record for the readiness gates. The four credential-gated VERIFYs and their supporting build (E3) were run against a **real Modal account** (`~/.modal.toml [opengeni]`, modal SDK `0.7.6`), each under an iterate-until-trustworthy loop. The structured verdicts below are the spike outputs; the evidence is quoted verbatim (sandbox ids, the HTTP 101, the XTEST read-back coordinates, the fan-out latency table — no secrets).
>
> **Cost safety:** every spike attested its own teardown, and a post-campaign account-wide leak sweep (`modal.sandboxes.list()` → `poll()` → `terminate()`) confirmed **$0 ongoing compute**. See [§ Cost-safety sweep](#cost-safety-sweep).
>
> Authoritative design doc: `00-master-spine.md`. Readiness framing: `06-readiness-and-runway.md`. Local feasibility: `04-spike-results.md`. Harness root: `spikes/provider-credentialed/`.

---

## (a) RESULTS MATRIX

| Gate | Spike | Status | One-line evidence-backed finding |
|---|---|:--:|---|
| **AUTH** | `auth` | ✅ PASS | `[opengeni]` creds authenticate, create/exec/terminate an `ubuntu:24.04` box clean — `sb-2TkKqmqMFSri4PnZM6tNwr`, exec echoed `OGSPIKE-AUTH-OK`, 0 leftovers. |
| **R-A1 / V5** | `V5-real-session-nonreap` | ✅ HELD | Non-owned injected `ModalSandboxSession` survives `run()` un-reaped (`poll()=null`, marker re-read across run-2); the **owned** control box IS reaped (`resume` throws "no longer running") — the provider-blind ownership seam transfers to real Modal. |
| **R-A2 / V1** | `V1-modal-tunnel-ws` | ✅ HELD | Modal `encryptedPorts` tunnel passes a real `wss://` Upgrade → **HTTP 101** + bidirectional banner + echo round-trip from an outside client. Channel-B vnc-ws transport is viable on Modal. |
| **R-A3 / V2** | `V2-gvisor-xtest-computeruse` | ✅ HELD | gVisor (`runsc`) permits XTEST synthetic input read-back — `mousemove` reads back `X=137 Y=211`, typed nonce `OGXTEST87ENGT` lands in a real tty, synthetic click moves input focus. Computer-use is **alive under runsc, not view-only**. |
| **R-A4 / V3** | `V3-modal-resume-r4` | ✅ HELD | Resume is lock-free (R4): a 2nd live control handle opens on a still-alive box (same `sandboxId`, no throw), both handles do concurrent file ops on the same box; a **dead box is the sole rejection**. |
| **R-A5 / V4** | `V4-modal-fanout-ceiling` | ⚠️ BOUNDED | Modal tunnel accepts unlimited viewers (25/25, 50/50, all HTTP 101, zero refusals/drops) but **serializes per-port RTT**: frame p95 = **6405 ms at N=25** vs the <400 ms GA bar. Measured ceiling **≈5 viewers/port**; `maxViewersPerSession=5` on Modal direct, relay/SFU for more. |
| **E3** (supports V2) | `E3-real-browser-modal-image` | ✅ PASS | Canonical desktop image with a **real** `google-chrome-stable` (149.0.7827.155, ELF not snap-stub) builds via the Modal JS SDK and boots on gVisor — Xvfb/x11vnc/websockify all up. The prior "env-bug" was a **misdiagnosis** (three harness bugs). |

**Headline:** R-A1–R-A4 **HELD on real Modal** — no gate forced a core architecture change. R-A5 (V4) is a **bounded provider constraint**, not a hidden failure: it re-shapes only the Phase-4 multi-viewer sub-plan (a per-provider parameter), and it gates the **GA cut**, not the start of planning. The only remaining readiness gate is **R-A6** (the I1/I2 + I3 rulings — a decision lane, not a live-fire).

---

## (b) PER-GATE EVIDENCE

### AUTH — credentials are valid (`pass`)

> `[auth] OK — app resolved (appId=ap-13gRjh7LtAbrf3ibkf7zPM)`
> `[create] sandboxId=sb-2TkKqmqMFSri4PnZM6tNwr`
> `[running] poll()=null running=true`
> `[exec] stdout="OGSPIKE-AUTH-OK" execOk=true`
> `[teardown] terminated sandbox sb-2TkKqmqMFSri4PnZM6tNwr`
> Post-run leftover check: `sandboxes checked=0 leftover_running=0`.

The `[opengeni]` profile has **no `environment` line**, so all spikes hit Modal's **default** environment (set `MODAL_ENVIRONMENT` explicitly if a named env is ever required). `new ModalClient({})` relies on the active profile / `MODAL_TOKEN_ID`+`SECRET` env — exactly as the OpenGeni client does.

---

### R-A1 / V5 — keystone holds on a real provider session (`pass` → **HELD**)

A live `ModalSandboxSession` injected as `RunConfig.sandbox.session` (**non-owned**) survives a normal `run()` un-reaped and is reusable across runs; the **owned**-resume control IS reaped. The provider-blind agents-core ownership seam transfers to Modal.

> `SETUP  backendId=modal  sandboxId=sb-dmdafZcz5UVfqmQ7ZNYWUT  manifest.root=/workspace  ownsSandbox=true  running()=true`
>
> **RUN 1** (inject live session NON-OWNED, exec writes `/workspace/keystone-marker.txt`):
> `run1 lastStep = next_step_final_output` (NORMAL finish, not interruption)
> `-> session.closed after run1 : false`
> `-> sandbox.poll() after run1 : null (null === alive)`  ← **UN-REAPED**
> `-> marker file content       : "KEYSTONE_TURN1_1781879765"`
>
> **RUN 2** (SAME handle, exec cat marker):
> `-> tool read back from box   : "KEYSTONE_TURN1_1781879765"` (== run-1 marker)
> `-> sandboxId before/after    : sb-dmdafZcz5UVfqmQ7ZNYWUT / sb-dmdafZcz5UVfqmQ7ZNYWUT`  (SAME box)
>
> **CONTROL** (OWNED session via `sessionState` resume):
> `owned sandboxId = sb-nA2JNNd8GzY4hSwytg84JO`
> `-> owned box reaped probe: resume threw: "Modal sandbox sb-nA2JNNd8GzY4hSwytg84JO is no longer running."`
> `-> owned session reaped  : true`
>
> Teardown sweep: `sb-dmdafZcz5UVfqmQ7ZNYWUT poll()=137`, `sb-nA2JNNd8GzY4hSwytg84JO poll()=137` (both terminated, 137=SIGKILL); live-in-app=0.

**Mechanism** (verified in installed agents-core): a priority-2 `cfg.session` injection is registered **non-owned** (no `{owned:true}`); only owned keys hit `closeOwnedSessions → cleanupSandboxSession → session.shutdown()`, and `ModalSandboxSession.close()` only calls `sandbox.terminate()` when `ownsSandbox`. So the injected handle is never shut down → the Modal box stays running across runs.

**Remaining risk:** this rode the LIVE in-process handle across runs (the keeper-warm path the design uses); it did not exercise the cold cross-process snapshot resume. Pinned to `@openai/agents-core`/`agents-extensions 0.11.6` + `modal 0.7.6` — re-run on a future SDK that could add a provider-specific reap.

---

### R-A2 / V1 — Modal tunnel passes `wss://` Upgrade → 101 full-duplex (`pass` → **HELD**)

> `[setup] creating sandbox with encryptedPorts=[6080]…`
> `[setup] sandboxId=sb-nNoIMvDxWdtXqZ8to4W7x7`
> `OGSPIKE-WS-ECHO listening on 0.0.0.0:6080`
> `[PASS] ASSERT-1 :: url=https://ta-01kvg53apjkgdejct15pjt9rq7-6080-xu0p35546h2qfj9mfq3cpb0ys.w.modal.host host=<same> port=443`
> `[ws] UPGRADE 101 connection=Upgrade upgrade=websocket`
> `[ws] OPEN (handshake complete)`
> `[ws] RECV 16 bytes: "OGSPIKE-WS-READY"`
> `[ws] RECV 17 bytes: "echo:hello-tunnel"`
> `[PASS] ASSERT-2 WS upgrade returned HTTP 101 :: httpStatus=101`
> `[PASS] ASSERT-3 server banner received through tunnel :: banner="OGSPIKE-WS-READY"`
> `[PASS] ASSERT-4 echo round-trips (full duplex) :: echo="echo:hello-tunnel"`
> Cleanup re-check: `running sandbox count for app: 0`.

The raw **101** line proves the tunnel preserved `Upgrade`/`Connection` headers; the two RECV lines prove server→client (banner) and client→server→client (echo) both traverse the upgraded socket = **true full duplex** through Modal's TLS tunnel. `tunnels(10_000)[6080]` resolved to the exact `{host, port:443, url}` shape `ModalSandboxSession.resolveExposedPort()` depends on.

**Remaining risk:** tested with a stdlib WS echo server, not a full websockify/noVNC + Xvfb stack — RFB-over-WS framing/back-pressure is the separate desktop-stack spike's job; this keystone de-risks only the **transport**. Single short-lived connection; idleKiller/reconnect/many-viewer interactions are out of scope here (V4 covers fan-out).

---

### R-A3 / V2 — gVisor permits XTEST synthetic-input read-back (`pass` → **HELD**)

Built the canonical lean desktop image inline (`modal@0.7.6`, `ubuntu:22.04`), booted `sb-GjF6Zbal2c7SAV8rXRWDYY` (image `im-38YGytoDR7r5YSBgvIDFzh`), probed via `sandbox.exec`. All 7 asserts PASS.

> **ASSERT-4a** (mousemove read-back — the riskiest path): pointer pre-move `X=640 Y=400`; after `xdotool mousemove --sync 137 211` → `getmouselocation` read back **`X=137 Y=211`**; after move to 642,488 → read back **`X=642 Y=488`**. Exact match on BOTH distinct targets (rules out a fixed-coordinate fluke).
> **ASSERT-4b** (keystroke read-back — strongest E2E proof): launched `xterm -e "cat >/tmp/typed.txt"`, focused it, `xdotool type` nonce `OGXTEST87ENGT` + Return; `/tmp/typed.txt` read back exactly **`OGXTEST87ENGT`**. Full XTEST keyboard path (keycode synth → server route → focused window → tty) survives gVisor.
> **ASSERT-4c** (button click): moved pointer to xterm center (254,208), `xdotool click 1` rc=0; loc-after read back `X=254 Y=208`; `getwindowfocus` → `focusWID=20971532` == xterm WID, `focusName="typed.txt"`. Synthetic click routed input focus.
> **ASSERT-5**: `scrot -o` → 24665-byte file, PNG magic `89504e470d0a1a0a`.
> Teardown: post-run `sandboxes.list` → `SUMMARY live=0 total_listed=0`.

**Why it works:** XTEST is delivered to Xvfb over a local socket; Xvfb mutates its **own in-process** input/pointer state (no host `/dev/uinput` or evdev), so the synthetic-input path is entirely userspace and survives `runsc`'s syscall re-implementation.

**Carry-into-build (V2):** the up-script uses `x11vnc -viewonly` (the v1 read-only-stream stance). That flag **only blocks VNC-viewer write-back and is irrelevant to the agent-side XTEST injection** — the agent drives the desktop via `xdotool` over `exec`, which fully works. So `-viewonly` is safe to keep: viewers can't write the desktop back, but the agent's computer-use is unaffected.

**Remaining risk:** proven on Modal specifically (E2B/Runloop gVisor use the same XTEST userspace mechanism but are unverified); click read-back leaned partly on input-focus change under openbox — the synthetic click delivery itself (rc=0 + pointer-at-target) is WM-independent.

---

### R-A4 / V3 — Modal resume is lock-free (R4) (`pass` → **HELD**)

> `[setup] handle A sandboxId=sb-ll5gSwwYzFeN3hYhTdJBWk`
> `[PASS] ASSERT-1 handle A created and live :: running=true sandboxId=sb-ll5gSwwYzFeN3hYhTdJBWk`
> `[PASS] ASSERT-2 resume() opens 2nd handle B while A alive (lock-free, R4) :: B.running=true sameSandboxId=true`
> `[PASS] ASSERT-3 A and B operate concurrently on the SAME box :: B read A's token: true; A read B's token: true`
> `[PASS] ASSERT-4 resume of a DEAD box rejects :: Modal sandbox sb-ll5gSwwYzFeN3hYhTdJBWk is no longer running.`
> Independent leak probe (fresh `Sandbox.fromId+poll`): run1 `sb-ll5gSwwYzFeN3hYhTdJBWk poll()=137`; run2 `sb-ysmJxOzGSX0VJ7D0chwR37 poll()=137`. Zero running sandboxes remain.

**Why R4 holds:** Modal's control plane is per-RPC — `fromId()` is a pure id→handle lookup taking **no server-side lock**, so a 2nd owning handle to a live box coexists with the 1st. `resume()`'s only gate is liveness (`poll()` null while alive, exit code once dead); the **sole rejection is a dead box**, never "another handle owns it". The bidirectional A-writes/B-reads round-trip proves B is a real, usable control handle to A's exact filesystem.

This is **more load-bearing under stateless workers, not less** — every turn (and every concurrent shared-box turn) opens a fresh handle on the same live box, so lock-free reattach is the core primitive, not an edge.

**Remaining risk:** tested on the default region/environment, image `python:3.12-slim`, one box. R4 lock-freedom is an architectural property of the per-RPC control plane (corroborated in SDK source), so it should generalize; a different region/plan was not separately exercised.

---

### R-A5 / V4 — provider tunnel fan-out ceiling (`genuine-limitation` → **BOUNDED CONSTRAINT**)

The Modal per-port tunnel **accepts** unlimited concurrent viewers (zero refusals/drops, all HTTP 101) but **serializes per-port RTT**, so RFB frame p95 blows past the 400 ms GA bar above ~5 viewers.

**Main sweep (30s timeout):**

| N | success | frame_p95 | hs_p95 | provDisc | refused | httpStatuses |
|---|---|---|---|---|---|---|
| 1 | 1/1 | 135 ms | 2427 ms | 0 | 0 | `{101:1}` |
| 5 | 5/5 | 137 ms | 10790 ms | 0 | 0 | `{101:5}` |
| 25 | 5/25 | 8392 ms | 22764 ms | 0 | 0 | `{101:25}` ← 20 stalled mid-RFB-handshake, **NO close** |
| 50 | 0/50 | n/a | n/a | 0 | 0 | `{101:50}` ← ALL 50 got HTTP 101, NONE dropped |

**Clean bandwidth-attribution (45s timeout, one box, no restarts):**

| N | success | frame_p95 | total | zeroByteStalls | closeCodes | wall |
|---|---|---|---|---|---|---|
| 1 | 1/1 | 313 ms | 0.1 MB | 0 | `{}` | — |
| 5 | 5/5 | 343 ms | 0.1 MB | 0 | `{}` | — |
| 25 | **25/25** | **6405 ms** | 0.8 MB | 0 | `{}` | 39306 ms |

> `box_health_after: x11vnc=1 ws_listen=1` (x11vnc log: `client_count 7..0` → it served every viewer).

With a 45s timeout **all 25 completed** (vs 5/25 at 30s) → the tunnel never drops, viewers just **serialize**. Aggregate throughput 0.02 MB/s moving 0.8 MB = pure **RTT queueing, NOT bandwidth saturation**. x11vnc sends only ~51 KB first frame even under forced `SetEncodings(Raw)`, so frame size is not the limiter.

**GA bar** (≥25 concurrent, frame p95 <400 ms, 0 disconnects): connections-accepted **PASS**, zero-disconnects **PASS**, frame-p95<400ms **FAIL** (6405 ms at 25; <400 ms only holds to N≈5).

**Why it's the tunnel, not us:** (a) the local-Docker fan-out spike already showed one `x11vnc -shared` + one websockify does **50/50 at p95 ≤412 ms** on loopback; (b) box health after fan-out was healthy and x11vnc served all viewers; (c) Modal returned HTTP 101 for all 50 with zero refusals/closes at every N. The only differing variable between loopback-50/50-pass and the ~5-ceiling is the **Modal tunnel itself** (head-of-line RTT serialization; the RFB 3.8 handshake needs ~5 sequential WS round-trips per viewer, which queue as N rises).

**Design remedy (a parameter, not an architecture change):** `maxViewersPerSession=5` for Modal direct (per-provider lever); for larger audiences, a **relay/SFU** that holds ONE tunnel connection and re-fans to N browsers (the in-box source already has 50/50 headroom). The relay solution itself is unverified by this spike — it proved the problem and the in-box headroom, not the relay.

---

### E3 — real-browser desktop image builds on Modal/gVisor (`pass`; the "env-bug" was a misdiagnosis)

The canonical OpenGeni desktop image with a **real** `google-chrome-stable` builds and boots; the prior "env-bug" (Modal builder degradation) verdict was **wrong** — the real blocker was three harness bugs, now fixed.

> `[build] ALL LAYERS OK final imageId=im-yyIhzG41l0oy08UDhwC4lc in 12.7s` (first full build ~45s, then cached)
> `[PASS] ASSERT-1b desktop stack launches under gVisor :: lastLine="OPENGENI_DESKTOP_UP port=6080 geometry=1280x800 dpi=96"`
> `[PASS] ASSERT-2 Xvfb :0 xdpyinfo :: dimensions: 1280x800 pixels  depth of root window: 24 planes`
> `[PASS] ASSERT-3 x11vnc:5900 + websockify:6080 listening :: VNC_OK WS_OK`
> `[PASS] ASSERT-4 REAL browser :: /opt/google/chrome/chrome: ELF 64-bit … version "Google Chrome 149.0.7827.155" ; snapStub=false`
> `[PASS] ASSERT-5 browser LAUNCHES under gVisor :: headless --dump-dom about:blank -> "<html>…</html>" rc=0 ; windowed proc … (windowedProcs=12-14)`

**Root cause of the misdiagnosis** (proven by streaming the live build-task logs the SDK normally discards):

1. **`DEBIAN_FRONTEND=noninteractive` was never set on the apt layers.** The desktop set pulls in `tzdata`, whose postinst ran an **interactive** debconf "select your geographic area" prompt that blocked on stdin forever inside the builder — the >100s "apt-fetch stall" read as provider degradation. Build log: `Configuring tzdata … Please select the geographic area … Geographic area:` then hung forever.
2. A fragile binary-grep ELF guard `head -c 4 chrome | grep -q $'\x7fELF'` exited 1 (grep against a pattern with the raw `0x7f` byte is unreliable) and `set -e` killed the build even though Chrome installed fine.
3. An L7 heredoc embedding the up-script was shattered by the build loop's `layer.split("\n")` into ~40 bogus Dockerfile directives.

**Carry-into-build (E3) — load-bearing for the production image:** `DEBIAN_FRONTEND=noninteractive` (with `TZ=Etc/UTC`) is **MANDATORY** for the production canonical image. Per `04-desktop-image.md §1` the production image re-adds the full `xfce4` tree (plus ffmpeg/tesseract/noto fonts and the cloud-tool layer) — and the full `xfce4` tree **also pulls `tzdata` and other interactive postinsts**, so the same noninteractive fix is required there too. (The standalone Dockerfile sets it via `ENV`; the Modal SDK build path must replicate it before every `RUN apt` line.)

---

## (c) MAPPING TO THE DEFINITION-OF-READY GATES

From `06-readiness-and-runway.md §(A)`:

| DoR gate | Spike | Verdict | Note |
|---|---|:--:|---|
| **R-A1** | V5 | ✅ **HELD** | Keystone transfers to a real provider session — injected non-owned survives, owned is reaped. |
| **R-A2** | V1 | ✅ **HELD** | Modal tunnel passes `wss://` → 101 full-duplex; Channel-B vnc-ws transport viable on Modal. |
| **R-A3** | V2 | ✅ **HELD** | gVisor permits XTEST read-back; computer-use is alive, **not** view-only. |
| **R-A4** | V3 | ✅ **HELD** | Lock-free resume-by-id confirmed; dead box is the sole rejection. |
| **R-A5** | V4 | ⚠️ **BOUNDED CONSTRAINT** | `maxViewersPerSession≈5` on Modal direct / relay for more. A measured parameter, **not** an architecture change. **Gates the GA cut, not the planning start.** |
| **R-A6** | — (I1/I2 + I3) | ⏳ **OPEN** | The two load-bearing rulings — a decision lane, out of scope for the credentialed live-fire. **The sole remaining readiness gate.** |

**On R-A5 specifically:** the runway already anticipated this — R-A5 was defined as "sets the *real* `maxViewersPerSession`", and the in-box layer was PROVEN flat to 50/50, with only the provider tunnel number open. V4 returned that number (~5/port direct). This re-shapes only the bounded Phase-4 multi-viewer sub-plan and its 429 contract; it does **not** fork the core architecture, and per the runway it gates the **GA cut**, not the opening of planning.

---

## (d) THE TWO CARRY-INTO-BUILD FINDINGS

1. **E3 — `DEBIAN_FRONTEND=noninteractive` is mandatory for the production image.** The full production `xfce4`/`tzdata` image must set `DEBIAN_FRONTEND=noninteractive` (with `TZ=Etc/UTC`) on **every** apt layer of the Modal SDK build path, not just in the standalone Dockerfile's `ENV`. Without it, `tzdata` (and other interactive postinsts the full xfce4 tree pulls) blocks on a debconf prompt inside the builder and looks like provider degradation. This is the single biggest gotcha the campaign surfaced.

2. **V2 — `x11vnc -viewonly` blocks only viewer write-back; agent XTEST is unaffected.** The desktop up-script's `-viewonly` flag (the v1 read-only-stream stance) blocks **only VNC-viewer write-back**. The agent drives the desktop via `xdotool` over `exec` (XTEST injection into Xvfb's own input state), which fully works under `-viewonly`. So the read-only viewer stance and full agent computer-use coexist on the same box — no conflict.

---

## Cost-safety sweep

After the 3-hour spike campaign, an account-wide leak sweep ran against `[opengeni]` (isolated mini-project, `modal@0.7.6`; token_secret extracted from the profile at runtime, never printed):

- `client.sandboxes.list()` (no `appId`, `includeFinished=false` default → running only, all apps) returned **1** sandbox: `sb-UH8FKIxn99U7F5iwqPJctp`, `poll()=null` (**alive**).
- It was **terminated** (`terminate()` OK). An immediate independent re-list returned **0** running; a second independent re-list (fresh client) also returned **0**.

**Found running: 1. Terminated: 1. Leftover running after sweep: 0.** Confirmed **$0 ongoing compute** — the one leftover is reaped and no other box is alive in the account. (The per-spike teardown attestations all reported `poll()=137` terminated; this leftover was a single straggler not caught by its spike's `finally`, now reaped.)

---

## Closing — the only remaining readiness gate is R-A6

R-A1 through R-A4 are **HELD on real Modal**; nothing in the credentialed live-fire forced a core architecture change. R-A5 (V4) returned a **bounded provider constraint** (`maxViewersPerSession≈5` direct / relay for more) that re-shapes only the Phase-4 multi-viewer sub-plan and gates the GA cut — not planning's start. The two carry-into-build findings (E3 noninteractive apt; V2 `-viewonly` ≠ agent-input-block) are folded into the build.

Per the runway's own gate (`06 §(D)`), with R-A1…R-A4 green the credentialed live-fire half is satisfied and V4 is measured-and-pending for the GA freeze. **The only thing still blocking the opening of the full planning cycle is R-A6 — the I1/I2 (non-turn RPC dispatch mechanism) + I3 (reaper as sole liveness/GC/cost-stop) rulings.** These are a *decision* (recommendations already stand in master-spine OD-1/OD-2/OD-3), not an experiment — a ratification, not a discovery.

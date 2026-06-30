# Connected Machines — macOS DISPLAY backend (feasibility + plan)

Status: **proposal / not started.** macOS desktop is a compile-only structured
stub today (Apple's own "M12" deferral marker). This doc grounds *why* it is
headless, *what* a real backend costs, *how* to satisfy the workspace
`unsafe_code = forbid` constraint, the *TCC consent problem* that makes it
fundamentally un-CI-able, and a staged plan with a clear ship/defer call.

Sibling docs: `00-primitives.md` (the managed-sandbox vs connected-machine
split). The desktop stream itself (relay framebuffer pump + computer-use input
plane) is platform-agnostic and already built for Linux — this doc is *only*
about filling in the one missing per-OS backend so a connected Mac can join it.

All citations are `file:line` against this worktree
(`agent/crates/opengeni-agent-platform/...` unless noted).

---

## TL;DR / recommendation

**Defer the live backend; ship the cheap honest fixes now; spike ScreenCaptureKit
behind a feature flag only once we have a dedicated, signed, persistently-logged-in
Mac to verify on.** The blocker is not Rust difficulty — the trait shape is fixed
and the Apple APIs are well-trodden — it is that **Screen Recording + Accessibility
grants are user-interactive, per-code-signing-identity, and cannot be granted by
CI or by the platform on the user's behalf.** Until there is (a) a stable Developer
ID signing identity for the agent binary and (b) a real Mac with a logged-in Aqua
session to click the grant, a "live-verified" macOS desktop is unreachable, and our
whole posture (dossier §10.4) is "no unverified backend lands." See
[Recommendation](#7-recommendation-spike-now-vs-defer) for the precise unblock list.

---

## 1. Why macOS is headless today

There is **no macOS screen-capture or input backend at all** — only a zero-sized
structured seam. The single abstraction is the `DesktopBackend` trait
(`desktop.rs:57-83`): `probe() -> Option<v1::Display>`, `capture()`, `inject()`.
`resolve_desktop()` (`desktop.rs:120-143`) dispatches per-OS; the macOS arm
(`desktop.rs:131-134`) returns `crate::macos::MacosDesktop::new()` — and that type
is a stub whose three methods are hardcoded negatives:

- `probe()` returns `None` — `macos.rs:61-64`, comment *"No display reported until
  ScreenCaptureKit capture is live (M12)."*
- `capture()` returns `PlatformError::Unsupported("macOS desktop capture
  (ScreenCaptureKit) is not yet wired (M12)")` — `macos.rs:66-70`.
- `inject()` returns `PlatformError::Unsupported("macOS computer-use input (CGEvent)
  is not yet wired (M12)")` — `macos.rs:72-76`.

Because `probe()` is `None`, "No display" surfaces through **two** paths:

1. `Platform::desktop_ensure` (`lib.rs:202-229`) runs `desktop.probe()` on the
   blocking pool, gets `None`, and returns `Unsupported("no desktop display
   available on this host (display_unavailable)")` (`lib.rs:216-220`).
2. The heartbeat/connect capability set in `supervisor.rs::capabilities()`
   (`supervisor.rs:364-385`) computes `desktop: has_relay && display.is_some()`
   (`supervisor.rs:380`). On macOS `display` is `None`, so the control plane
   degrades the desktop cell to `display_unavailable` — *a value, never a crash*
   (the contract spelled out at `desktop.rs:5-9`).

**Contrast — Linux is fully real.** `LinuxDesktop::probe()` (`linux.rs:113-123`)
opens the X11 display via the safe `x11rb` crate, reads `screen_geometry`, and
returns a populated `v1::Display { id, width, height, virtual }`. `open_default()`
(`linux.rs:84-99`) even *verifies* a live connection + the `XTEST` extension before
claiming a desktop. Capture is `GetImage` → PNG (`linux.rs:146-169`); input is
`XTEST FakeInput` (`linux.rs:172-339`). All through `x11rb` — **no `unsafe`.**

**No virtual-framebuffer escape hatch on macOS.** The Xvfb opt-in
(`pub mod virtual_desktop`) is `#[cfg(target_os = "linux")]` only (`lib.rs:48-49`).
There is deliberately no "spawn a headless framebuffer" path on macOS — *"a virtual
framebuffer is not the macOS/Windows model"* (`lib.rs:46-47`). A Mac's display is
the real, attached/virtual Aqua session or nothing. That means **a macOS connected
machine can only ever offer a desktop when a human is logged into the GUI session.**
This is the single most important architectural fact for the rest of this doc.

So macOS is headless because the native backend was never written — the Linux-first
design left macOS (and Windows) as compile-only seams with the *exact* trait shape
so dispatch + capability paths don't reshape when the bodies land (`macos.rs:9-20`).

---

## 2. What implementing it entails

The trait shape is already fixed; we fill three method bodies on `MacosDesktop`,
mirroring the Linux split. The relay-side plumbing (framebuffer pump, input
channel, capability gating, `desktop_ensure`) is **done and platform-agnostic** —
it consumes `Arc<dyn DesktopBackend>` and a `v1::Display`, so a correct macOS
backend slots straight in with zero relay/control-plane changes.

| Trait method (`desktop.rs`) | Linux today | macOS to build |
|---|---|---|
| `probe() -> Option<v1::Display>` (`:62`) | `x11rb` connect + RANDR geometry (`linux.rs:113`) | Enumerate the active display via **`SCShareableContent`** (preferred) or **`CGMainDisplayID` / `CGDisplayBounds`**; return `v1::Display { id, width, height, virtual }`. `None` if no Aqua session / no Screen-Recording grant. |
| `capture() -> CapturedFrame` (`:70`) | `GetImage` ZPixmap → RGBA → PNG (`linux.rs:146`) | **ScreenCaptureKit** one-shot: `SCScreenshotManager.captureImage` (macOS 14+) or an `SCStream` frame → `CGImage`/`IOSurface` → RGBA → reuse the existing `image` PNG encoder. |
| `inject(&DesktopInput)` (`:82`) | `XTEST FakeInput` (`linux.rs:172`) | **CGEvent**: `CGEventCreateMouseEvent` / `CGEventCreateKeyboardEvent` / scroll-wheel events, posted with `CGEventPost(kCGHIDEventTap, ...)`. Map `PointerButton`/`PointerAction`/`KeyEvent`/`ScrollEvent` exactly as `inject_pointer`/`inject_key`/`inject_scroll` do for X11. |

Notes that make this concrete:

- **Capture API choice is forced.** `CGDisplayCreateImage` (the old, simple Quartz
  one-call grab) is **deprecated as of macOS 14 and removed/non-functional under
  Sequoia's privacy regime** — Apple actively steers to ScreenCaptureKit. So the
  honest target is `SCScreenshotManager` / `SCStream` (macOS 12.3+; the clean
  `captureImage` convenience is 14.0+). Our self-hosted Macs are modern, so target
  14+ and keep a CoreGraphics fallback only if we must support 12–13.
- **`capture()` must stay off the async runtime**, exactly like Linux runs
  `capture_blocking` on `spawn_blocking` (`linux.rs:125-132`). A `SCStream` callback
  is itself async/dispatch-queue-driven, so the macOS backend will likely hold a
  long-lived stream + a frame channel rather than open-per-call; either way the
  trait's `async fn capture` already accommodates it.
- **Geometry / Retina scaling.** `v1::Display.width/height` should be the *pixel*
  dimensions the viewer canvas needs. macOS reports points; multiply by the
  display's backing-scale factor (`CGDisplayModeGetPixelWidth` or the
  `SCDisplay.frame` × scale). Get this wrong and the computer-use coordinate space
  (which `inject` consumes) won't match the captured frame — the same point-vs-pixel
  footgun the Linux RANDR-vs-root path navigates (`linux.rs:410-429`).
- **`inject` needs a keymap.** X11 resolves keysyms→keycodes off the server keymap
  (`linux.rs:354-368`); CGEvent takes a virtual keycode (`CGKeyCode`) + Unicode via
  `CGEventKeyboardSetUnicodeString`. For text typing prefer the Unicode-string path
  (no per-character keycode table); for named keys (`Enter`/`Tab`/arrows, the set in
  `named_key_to_keysym` `linux.rs:373-403`) keep a small `&str -> CGKeyCode` table.
- **`virtual` flag.** Set `v1::Display.virtual = true` when the display is a virtual
  one (headless Mac with a virtual display / screen-sharing aggregate). Heuristic
  TBD; harmless if wrong (it only labels the UI, same posture as `linux.rs:431-442`).

No new wire types, no `desktop_ensure`/relay changes, no proto bump. This is a
single-module fill-in plus its Cargo deps.

---

## 3. FFI strategy under `unsafe_code = forbid`

The workspace lint is hard: `unsafe_code = "forbid"` (`agent/Cargo.toml:115`), and
the whole agent's selling point is that *every* native capability rides a **safe
binding crate** — `x11rb` for X11, `portable-pty` for PTYs, `nix` (fs feature only)
for statvfs, `minisign-verify`/`self-replace` for updates. `desktop.rs:10-20` states
the posture explicitly: *"Every backend here is built on a safe binding crate …
Wiring [macOS/Windows] through safe crates (or a narrowly-scoped `allow(unsafe_code)`
module) is the M12 task."* The macОS deps would be `[target.'cfg(target_os =
"macos")'.dependencies]`, mirroring how `x11rb` is already linux-gated
(`platform/Cargo.toml:31-32`) so non-mac builds never pull them.

The honest reality: **unlike X11, there is no pure-Rust, zero-FFI binding for
ScreenCaptureKit or CGEvent.** Every option ultimately calls Objective-C / C. The
question is *where the `unsafe` lives and whether we own it.*

**Option A — lean on `objc2` framework crates (recommended).**
The `objc2` project (madsmtm) auto-generates maintained, typed bindings for Apple
frameworks: `objc2-screen-capture-kit`, `objc2-core-graphics`,
`objc2-core-foundation`, `objc2-app-kit`. These expose Rust types over the
Objective-C/C surface; the `unsafe` is *inside the crate*, and most call sites are
ordinary safe Rust, with `unsafe` only at genuine soundness boundaries (raw message
sends, pointer handoff). Pros: actively maintained, comprehensive, the de-facto
modern standard, follows the same "delegate the unsafe to a vetted crate" pattern as
x11rb. Con: objc message sends are *inherently* `unsafe fn`, so a thin layer of our
own `unsafe` blocks at the FFI seam is unavoidable — `forbid` cannot stand at the
crate root.

**Option B — older "safe-ish" wrappers (`core-graphics`, `screencapturekit`/
`screencapturekit-rs`).** The servo `core-graphics` crate wraps Quartz (CGEvent,
CGDisplay) with a mostly-safe API; the `screencapturekit` crate wraps SCK on top of
`objc2`. Pros: higher-level, less boilerplate for capture. Cons: `core-graphics`'s
capture path leans on the *deprecated* CGDisplay route; the SCK wrappers are younger
and thinner than `objc2`'s generated coverage; you still inherit objc `unsafe`
transitively. Net: fine for `inject` (CGEvent is stable), weaker for `capture`.

**Option C — a blanket `allow(unsafe_code)` on the macos module.** Rejected. It
violates the explicit "NOT a blanket relaxation" instruction in both stubs
(`macos.rs:17-20`, `windows.rs` header) and discards the auditability the posture
buys.

### Recommendation

**Use `objc2-screen-capture-kit` + `objc2-core-graphics` (Option A), and confine
all `unsafe` to one narrowly-scoped module with a `#![allow(unsafe_code)]` and a
written justification — not a workspace-wide relax.** Concretely:

- Keep `unsafe_code = "forbid"` at the workspace and on every other crate
  (`agent/Cargo.toml:115` unchanged).
- Add a `#[cfg(target_os = "macos")] #[allow(unsafe_code)] mod macos_ffi;` *inside*
  `opengeni-agent-platform`, holding *only* the SCK/CGEvent calls, with a module
  doc-comment justifying each `unsafe` block (the objc message-send boundary). The
  public `MacosDesktop` impl stays safe and calls into it. This is precisely the
  "narrowly-scoped `allow(unsafe_code)` module with a justification" the stubs
  pre-authorize (`macos.rs:17-20`).
- Prefer `objc2`'s generated crates over hand-rolled `extern "C"` blocks: less of
  *our* `unsafe`, and the soundness-critical parts (selector dispatch, ARC) are the
  crate's problem, mirroring how we never hand-rolled X11 wire framing.
- Optionally use servo `core-graphics` for `inject` only (CGEvent is a small, stable
  surface) if `objc2-core-graphics` ergonomics disappoint — but standardize on one.

This keeps the lint meaningful (one audited module, not a global escape hatch) while
acknowledging the inescapable truth that Apple FFI cannot be fully `unsafe`-free the
way x11rb let Linux be.

---

## 4. The TCC permission problem (the real blocker)

macOS gates both capabilities behind **TCC (Transparency, Consent & Control)**:

- **Screen Recording** (`kTCCServiceScreenCapture`) — required for *any*
  ScreenCaptureKit capture. The first `SCShareableContent`/`SCStream` call triggers
  a one-time system prompt; until the user approves in **System Settings → Privacy
  & Security → Screen Recording**, capture returns empty/black frames or errors.
- **Accessibility** (`kTCCServiceAccessibility`) — required for `CGEventPost` to be
  *delivered* to other applications (synthetic input). Without it, posted events are
  silently dropped for most targets. Granted in **Privacy & Security →
  Accessibility**.

Why this is categorically different from Linux/Windows and **cannot be CI'd**:

1. **User-interactive, by SIP design.** The TCC database is SIP-protected; there is
   no supported API to grant yourself Screen Recording or Accessibility. A human
   must toggle it (or an MDM PPPC profile must — see below). This is exactly the
   constraint `macos.rs:11-15` calls out: grants *"cannot be auto-clicked on an
   ephemeral CI runner."* It is *why* the backend is a compile-only seam and the
   feature is deferred to M12 with a "live-verify on the user's real Mac" gate.
2. **Per-code-signing-identity, and our agent self-updates.** A TCC grant is keyed
   to the binary's code-signing identity (designated requirement / cdhash). The
   agent ships a **self-update** path (M11: `self-replace` + minisign-verified
   artifacts). An ad-hoc-signed or unsigned binary is keyed by cdhash, so **every
   self-update would change the cdhash and silently revoke the grant** → the desktop
   goes dark mid-life with no error the user understands. The *only* fix is a stable
   **Developer ID** signature whose designated requirement is anchored to our Team
   ID (cdhash-independent), so a re-signed update inherits the grant. **This makes
   Apple Developer ID code-signing + notarization a hard prerequisite, not a nicety.**
3. **Requires a live GUI (Aqua) session.** Capture/input only work when a user is
   logged into the graphical session. The agent already chose a **LaunchAgent**
   (not a LaunchDaemon) *for exactly this reason*: `service.rs:16-19` — *"LaunchAgent
   NOT LaunchDaemon deliberately: desktop/computer-use needs the user's GUI Aqua
   session + TCC."* The rendered plist (`service.rs:146-176`,
   `ai.opengeni.agent.plist`, `RunAtLoad`+`KeepAlive`) runs in the user's session.
   But a Mac sitting at the login window (no user logged in) still has **no display
   to offer** — `probe()` must honestly return `None` there.
4. **Sequoia adds periodic re-consent.** macOS 15 re-prompts for Screen Recording
   on a recurring basis (roughly monthly) for non-MDM apps — a recurring interruption
   for an unattended agent. MDM-managed Macs are exempt; self-hosted personal Macs
   typically are not.

### Proposed enrollment-time consent + grant UX

The plumbing for *intent* already exists end-to-end; what's missing is the *grant*
choreography. Today:

- The enrollment offer carries `offers_display` (API `canOfferDisplay`) and
  `requests_screen_control` (API `requestsScreenControl`) — `enrollment.rs:47-62`.
- The user's approval at the consent page is the authoritative
  `allowScreenControl`, persisted as `consented_screen_control` /
  `consented_whole_machine` creds (`config.rs:131-134`), threaded into the relay hub
  (`main.rs:160`) and reported in `capabilities()` (`supervisor.rs:381-382`). The
  `inject` path is gated on the caller having verified `consented_screen_control`
  (contract at `lib.rs:231-236`, `desktop.rs:72-82`).

**The gap:** our `consented_screen_control` is *platform authorization to drive the
machine*; it is **not** the OS-level TCC grant. A Mac can have
`consented_screen_control = true` and still produce black frames because macOS
itself hasn't been told to allow it. So enrollment on macOS needs a second,
*OS-level* grant step that the install flow walks the human through:

1. **Detect, don't assume.** On macOS the agent should report TCC status it *can*
   read without prompting: `CGPreflightScreenCaptureAccess()` (screen recording,
   non-prompting preflight) and `AXIsProcessTrusted()` (accessibility). Surface
   these as a *machine health* signal distinct from `consented_screen_control` —
   e.g. `display: Some(..)` only once Screen Recording is actually granted, so the
   capability stays honest (`supervisor.rs:380` already does the right thing if
   `probe()` returns `None` until granted).
2. **Trigger the prompts intentionally, once, at enrollment.** Right after the user
   approves screen control on the web consent page, the **agent** (running in the
   Aqua session) calls `CGRequestScreenCaptureAccess()` and
   `AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: true})` to fire the
   two system dialogs. These can *only* be triggered by the process itself making
   the protected call — the platform/web side cannot do it remotely.
3. **Deep-link the user to the panes for the toggle.** The prompts only get the user
   *to* the pane; they still flip the switch. Open
   `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`
   and `...?Privacy_Accessibility` and show a short "flip these two toggles for
   *OpenGeni Agent*, then return here" step in the installer.
4. **Verify, then advertise.** After the grants land, the agent re-probes; only then
   does `probe()` return a real `Display` and the desktop capability flips on. If the
   user declines, the machine enrolls fine for exec/fs/git — the desktop cell just
   stays `display_unavailable` (graceful, already the contract). This matches the
   primitives note about an *"enroll dialog zero-click default"* — desktop is opt-in,
   never blocking the core enroll.
5. **Fleet / MDM path (optional, later).** For org-managed self-hosted Macs, a
   **PPPC (Privacy Preferences Policy Control) configuration profile** can pre-grant
   Accessibility and (MDM-supervised) Screen Recording keyed to our Developer ID, so
   no human click is needed. This is the *only* way to "auto-approve," and it
   requires both MDM enrollment and our stable signing identity — out of scope for a
   v1 personal-Mac spike, but the reason §3's Developer ID requirement pays off twice.

Net: the consent *model* is already the right shape (offer → authoritative approve →
creds → capability gate). macOS just inserts a mandatory **OS-grant sub-flow** that
only the on-machine agent can drive, and which depends on a stable code-signing
identity to survive self-update.

---

## 5. Effort estimate + staged plan

Rough order-of-magnitude (one engineer who can test on a real Mac; the long pole is
verification + signing, not Rust):

| Stage | Scope | Est. | Gate |
|---|---|---|---|
| **0. Honest stub stays + groundwork** | Confirm seam; add macOS deps cfg-gated; stand up the `#[allow(unsafe_code)]` ffi module skeleton; decide `objc2` vs servo crates. | 0.5–1 day | builds on mac CI (no runtime) |
| **S1. `probe()` only** | Enumerate display via `SCShareableContent`/CGDisplay, real `v1::Display` with correct pixel geometry + scale. Gates the whole capability (`supervisor.rs:380`). | 2–3 days | desktop cell flips from `display_unavailable` to present on a granted Mac |
| **S2. `capture()`** | SCK one-shot/stream → CGImage → RGBA → existing PNG encoder; off-runtime like Linux. Wire into the framebuffer pump (already generic). | 3–5 days | live frames render in the browser viewer |
| **S3. `inject()`** | CGEvent mouse/key/scroll mapping mirroring `inject_pointer/key/scroll`; Unicode-string typing + named-key table; Accessibility gate. | 3–5 days | live computer-use drives a real Mac |
| **X. Signing + consent UX** | Developer ID signing + notarization of the agent binary (so TCC survives self-update); the §4 grant sub-flow in install + enrollment. | 3–5 days + Apple Developer account/ops | grants persist across an update; enroll walks a human through grants |
| **T. Test strategy** | macOS build/`cargo test` matrix entry already keeps the seam from rotting (`macos.rs:5-7`). Add an *opt-in*, *gated* live smoke that runs only on the self-hosted Mac runner (never ephemeral CI). | 1–2 days | a manual/self-hosted "real Mac" verification recipe |

**Total to a live, signed, verified macOS desktop: ~3 weeks of engineering** plus
the procurement/ops cost of an Apple Developer ID and a dedicated always-logged-in
Mac. The Rust is the cheap part; **signing + a persistent GUI session + the
interactive grant are the schedule risk.**

Staging discipline (mirrors the trait-first design): land **S1 probe-only** first —
it's the smallest change that makes a granted Mac advertise a desktop, it exercises
the full capability/`desktop_ensure` path end-to-end (`lib.rs:202-229`,
`supervisor.rs:380`) with zero streaming risk, and it's independently verifiable.
Capture and inject follow as separable PRs because the pump and input channel are
already generic.

---

## 6. What does NOT block, and a cheap win to take now

Independent of the big backend: the macOS **metrics** bugs in the same brief (CPU/
mem/load report 0; disk inflated ~256×) are unrelated to TCC and unrelated to this
backend. The disk fix in particular is a one-line cross-platform unit bug
(`metrics.rs:262`, `fragment_size().max(block_size())` over-counts on APFS) that
benefits Linux correctness too and should ship on its own track. Mentioned here only
to keep scopes clean: **a Mac can be a perfectly good headless exec/fs/git connected
machine today** — the display backend is the *only* thing this doc gates.

---

## 7. Recommendation: spike now vs defer

**Defer the live macOS desktop backend. Do not start S2/S3 until the unblock list
below is satisfied; an S1 probe-only spike is reasonable *now* only if a signed
binary + a real granted Mac are available to verify it — otherwise it cannot leave
the "unverified" state our posture forbids (`desktop.rs:17-20`, `macos.rs:11-15`).**

Reasoning: every cost in §5 except the Rust is dominated by the TCC reality. We
cannot CI it, we cannot grant it for the user, and without Developer ID signing the
grant evaporates on the next self-update — so a backend "finished" in code but
unverifiable is worse than the honest stub, which at least degrades cleanly to
`display_unavailable` (a value, never a crash). The Linux path earns its keep
precisely because it's safe *and* live-verifiable; macOS isn't there yet.

**What unblocks a real spike (do these first, in order):**

1. **An Apple Developer ID** + a notarization/codesign step in the agent release
   pipeline, with a designated requirement anchored to the Team ID (so a self-update
   re-sign keeps the TCC grant). *Hard prerequisite — nothing below survives an
   update without it.*
2. **A dedicated, always-logged-into-the-GUI Mac** (Apple Silicon, modern macOS 14+)
   reachable as a self-hosted runner for live verification — the equivalent of the
   "interactive Azure VM" the Windows stub assumes (`windows.rs` header), except
   macOS additionally needs the human-clicked TCC grants once.
3. **Pick the FFI crates** (§3 recommendation: `objc2-screen-capture-kit` +
   `objc2-core-graphics`, scoped `allow(unsafe_code)` module) and land the
   cfg-gated dep + ffi-module skeleton — this is safe to do now, builds on mac CI,
   and de-risks S1.
4. **Build the §4 OS-grant sub-flow** in install/enrollment (preflight detect →
   intentional prompt → deep-link → re-probe). Needed before any of this is usable
   by a non-engineer.

If all four exist, start with **S1 (probe-only)** as the first PR. If they don't,
the right move is to **leave the honest stub in place** and revisit when a signed
release + a verification Mac are available — the trait shape guarantees zero rework
when we do.

---

## 8. Open questions for the user

- (a) Is acquiring an **Apple Developer ID** and adding codesign/notarization to the
  agent release pipeline in scope? Without it the TCC grant cannot survive
  self-update — it's the true gate, not the Rust.
- (b) Is there a **persistently-logged-in Mac** we can dedicate as a verification
  host? (No GUI session ⇒ no desktop, by macOS design — `lib.rs:46-47`.)
- (c) Acceptable to add a **single narrowly-scoped `#[allow(unsafe_code)]` ffi
  module** (workspace lint otherwise intact), per §3 and the pre-authorization in
  `macos.rs:17-20`? Confirm we won't insist on a literally-zero-`unsafe` macOS path
  (it doesn't exist for Apple FFI).
- (d) Target macOS floor **14+** (clean ScreenCaptureKit `captureImage`, drop the
  deprecated CGDisplay path)? Or must we support 12–13 with a CoreGraphics fallback?
- (e) Sequoia's recurring re-consent for non-MDM Macs is a real UX papercut for an
  unattended agent — acceptable for v1 self-hosted personal Macs, or do we want the
  MDM/PPPC fleet path (§4.5) sooner?

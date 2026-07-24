// @opengeni/runtime/sandbox — the desktop display-stack launcher (P4.1).
//
// The agent-loop-free home for `ensureDisplayStack`: the exec-launched,
// flock-idempotent procedure that brings up the Channel-B pixel stack
// (Xvfb :0 -> XFCE -> x11vnc -> websockify:6080 -> noVNC) on a live,
// externally-owned box. It is driven over the box's `exec`/`execCommand` channel
// (NOT a container CMD) so it re-establishes after a snapshot rollover / box
// re-election, and it is safe to call from the API on a viewer op OR from the
// agent turn — a second concurrent call serializes on the in-box flock and
// no-ops when the stack is already up.
//
// It lives under @opengeni/runtime/sandbox so the API-direct control plane
// (apps/api) and the worker (apps/worker) both pull it from the same single
// agent-loop-free leaf.
//
// Productionized from the PROVEN spike (spikes/desktop-stack PASSED locally:
// noVNC 200, WS 101 + RFB banner, OCR'd a secret off the framebuffer) + the
// gVisor harness (V2 PASSED live on Modal: XTEST input read-back under runsc).

import { DESKTOP_STREAM_PORT } from "@opengeni/contracts";
import { parseExecResponseBanner } from "./exec-banner";

// Re-export under the canonical name the module spec uses (STREAM_PORT) while
// keeping DESKTOP_STREAM_PORT as the single source of truth (contracts).
export { DESKTOP_STREAM_PORT };
export const STREAM_PORT = DESKTOP_STREAM_PORT;

// The whole-stack launch is bounded by the readiness gates inside the up-script
// (four loops of 50 * 0.1s = ~5s each, ~20s worst case) PLUS the PAINTABLE-FRAME
// gate we append (up to ~30s of scrot probing) PLUS first-boot XFCE/dbus + font-cache
// warm-up on a cold gVisor box. 90s gives headroom over the spike's observed ~5-10s
// warm path AND the cold-box paint warm-up without masking a genuine wedge.
export const DISPLAY_STACK_TIMEOUT_MS = 90_000;

// Provider exec APIs use `yieldTimeMs` as an output-yield window, not a process
// deadline. Poll often enough to surface stage telemetry while the command keeps
// running, but let the in-box `timeout(1)` own termination (see
// `boundedDisplayStackCommand`).
const DISPLAY_STACK_PROVIDER_YIELD_MS = 15_000;
const DISPLAY_STACK_PROVIDER_POLL_MS = 5_000;
const DISPLAY_STACK_TERMINATION_GRACE_MS = 5_000;
// Provider cancellation is transport-level and may never settle. Keep the
// JavaScript-side cleanup/drain bounded as well; a later caller either gets a
// positive in-box quiescence proof or remains fail-closed, but it must never
// wait forever on a provider promise.
const DISPLAY_STACK_CLEANUP_CALL_MS = 250;
const DISPLAY_STACK_DRAIN_GRACE_MS = 100;

// PAINTABLE-FRAME gate: poll scrot up to this many times, this many seconds apart,
// waiting for an actually-PAINTED frame before declaring the stack "up" (~30s worst case).
const PAINT_PROBE_ATTEMPTS = 150;
const PAINT_PROBE_INTERVAL_S = 0.2;

// The paint FLOOR (bytes): a scrot at/above this size is a real painted desktop; below
// it, the root is still unpainted and the frame would read as "blank" to the model.
//
// WHY A SIZE FLOOR, NOT NON-EMPTINESS (the bug this fixes): the old gate only checked
// `[ -s frame.png ]` (non-empty). But an UNPAINTED root is never zero-byte — a fresh
// Xvfb draws either the `-retro` weave stipple or (with `-retro` dropped) solid black,
// and scrot happily encodes that as a small-but-non-empty PNG. So the old gate passed
// the instant the VNC ports bound — MEASURED at ~1.4s (fast runc host) to several
// seconds (cold gVisor) BEFORE xfdesktop finishes its first wallpaper paint — handing
// the model the pre-paint frame. That pre-paint frame is exactly the "blank/black"
// screenshot that 400s the model and blanks the human viewer.
//
// The sizes are unambiguous and were measured on the canonical desktop image (1280x800)
// under runc — both the current staging image and a fresh local build:
//   painted XFCE desktop (blue-gradient wallpaper + panel + icons): ~210-222 KB
//   `-retro` stipple root (unpainted, current image):                ~17 KB
//   solid-black root (unpainted, after we drop `-retro`):            ~13.5 KB
// 60 KB sits ~3.5x above every unpainted state and ~3.5x below a real paint — a wide,
// unambiguous margin. It holds against BOTH the currently-deployed `-retro` image and
// the `-retro`-dropped image this change ships, so the runtime gate is correct before
// AND after the image rebuild lands. (Assumes the default ~1280x800 geometry; a larger
// framebuffer only scales the painted frame further above the floor.)
const PAINT_MIN_BYTES = 60_000;

// SETTLE gate (the gVisor staged-paint fix): crossing the 60 KB floor is necessary but
// NOT sufficient. On a fast runc host the paint is atomic (black 13.5 KB -> full 209 KB
// in one step, panel + icons included). On a STONE-COLD gVisor Modal box it is STAGED:
// the wallpaper gradient paints and crosses 60 KB a beat BEFORE xfdesktop draws the
// panel / launcher icons / logo. A screenshot in that window shows a bare teal wallpaper
// with no panel — which the model correctly reports as "graphical, but the desktop
// hasn't fully loaded" (VERIFIED live on staging: a cold-box turn's first agent
// screenshot caught exactly this). So the gate additionally waits for the frame to
// SETTLE: two consecutive probes both above the floor whose byte-sizes agree within
// PAINT_SETTLE_DELTA_BYTES. A still-painting desktop grows between probes; a fully
// rendered, static one is byte-stable (scrot -o omits the cursor, and the clock is
// minute-precision, so consecutive captures of a settled desktop are near-identical).
// This makes ensureDisplayStack block until the FULL desktop is up, so the turn's first
// screenshot — which runs AFTER this gate — sees the panel, not a bare wallpaper.
const PAINT_SETTLE_DELTA_BYTES = 2_000;

/** Desktop geometry for the framebuffer. v1 has no live RANDR: a resolution
 *  change is a full down -> up restart (a separate op). */
export type DesktopGeometry = {
  width: number; // default 1280
  height: number; // default 800
  dpi: number; // default 96
};

export const DEFAULT_DESKTOP_GEOMETRY: DesktopGeometry = { width: 1280, height: 800, dpi: 96 };

/** Thrown when a stage of the launch script failed. exitCode 11/12/13 map to
 *  Xvfb / x11vnc / websockify respectively (the stage that died); 14 is the
 *  PAINTABLE-FRAME gate (ports listening but scrot still yields an empty frame —
 *  the display is up but not actually painting). Degradation is surfaced as a
 *  value to viewers by the caller; this error is for diagnostics. */
export class DisplayStackError extends Error {
  readonly exitCode: number;
  readonly stage: "xvfb" | "x11vnc" | "websockify" | "paint" | "lock" | "timeout" | "unknown";

  constructor(exitCode: number, output: string) {
    const stage =
      exitCode === 11
        ? "xvfb"
        : exitCode === 12
          ? "x11vnc"
          : exitCode === 13
            ? "websockify"
            : exitCode === 14
              ? "paint"
              : exitCode === 15
                ? "lock"
                : exitCode === 124 || /OPENGENI_DISPLAY_TIMEOUT/u.test(output)
                  ? "timeout"
                  : "unknown";
    super(
      `desktop display stack failed at stage "${stage}" (exit ${exitCode})${output ? `:\n${output}` : ""}`,
    );
    this.name = "DisplayStackError";
    this.exitCode = exitCode;
    this.stage = stage;
  }
}

/** Thrown when the provider session cannot run commands (a headless-only
 *  backend with neither `exec` nor `execCommand`). The desktop tier degrades to
 *  Channel-A-only — the caller maps this to `DesktopStream.transport: null`. */
export class DisplayStackUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisplayStackUnsupportedError";
  }
}

// The structural slice of a provider session we need: run a command (preferring
// `exec` for the structured exit code, falling back to `execCommand`).
type ExecResultLike = {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  sessionId?: number;
  session_id?: number;
};
type ExecCapableSession = {
  state?: unknown;
  exec?: (args: {
    cmd: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }) => Promise<ExecResultLike>;
  execCommand?: (args: {
    cmd: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }) => Promise<string>;
  writeStdin?: (args: {
    sessionId: number;
    chars: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }) => Promise<ExecResultLike | string>;
};

export type DisplayStackCallerKind = "viewer" | "computer" | "unknown";
export type DisplayStackClassification = "cold" | "already_ready" | "contention" | "unknown";
export type DisplayStackTelemetryStatus = "started" | "waiting" | "completed" | "failed";

/** Secret-free, bounded-cardinality stage observation. Provider/sandbox IDs are
 * log correlation fields, never metric labels. */
export type DisplayStackTelemetryEvent = {
  type: "display_stack.stage";
  requestId: string;
  stage: string;
  status: DisplayStackTelemetryStatus;
  elapsedMs: number;
  source: "host" | "sandbox";
  classification: DisplayStackClassification;
  callerKind: DisplayStackCallerKind;
  sandboxId?: string;
  leaseEpoch?: number;
  providerSessionId?: number;
};

export type DisplayStackTelemetryContext = {
  callerKind: DisplayStackCallerKind;
  sandboxId?: string;
  leaseEpoch?: number;
};

export type EnsureDisplayStackOptions = {
  geometry?: DesktopGeometry;
  /** The exposed stream port; defaults to 6080. */
  port?: number;
  /** Whole-operation wall-clock timeout; defaults to DISPLAY_STACK_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Caller correlation. Supplying it enables the default structured log sink. */
  telemetryContext?: DisplayStackTelemetryContext;
  /** Optional non-blocking telemetry sink (tests/embedders may replace logging). */
  onTelemetry?: (event: DisplayStackTelemetryEvent) => void | Promise<void>;
};

export type EnsureDisplayStackResult = {
  /** The exposed port the stack listens on (websockify/noVNC). */
  port: number;
  geometry: DesktopGeometry;
  /** The raw `OPENGENI_DESKTOP_UP …` marker line, for diagnostics. Never
   *  surfaced to viewers. */
  marker: string;
};

/**
 * Build the shell command that runs the idempotent up-script under an in-box
 * `flock`. The script is shipped in the image at /usr/local/bin/opengeni-desktop-up
 * (the canonical desktop image); we set the geometry/port env and wrap the call
 * in `flock` so two concurrent ensureDisplayStack callers (the API viewer op +
 * the agent turn, both racing after a rollover) serialize without a double
 * launch. The up-script's own per-stage PID guards make the second call a no-op.
 *
 * Exported (pure, side-effect-free) so the ensureDisplayStack unit test can
 * assert the exact command sequence without a live box.
 */
export function buildDisplayStackScript(options: EnsureDisplayStackOptions = {}): string {
  const geometry = options.geometry ?? DEFAULT_DESKTOP_GEOMETRY;
  const port = options.port ?? DESKTOP_STREAM_PORT;
  const env =
    `DESKTOP_W=${geometry.width} DESKTOP_H=${geometry.height} ` +
    `DESKTOP_DPI=${geometry.dpi} STREAM_PORT=${port}`;
  // FAST PRE-CHECK (lock-free) before the outer flock: if the exposed port and
  // x11vnc are ALREADY listening, the stack is up — print the marker and short-
  // circuit, so a no-op caller (the agent turn re-ensuring after a viewer attach
  // already brought the stack up) never serializes behind a lock holder and never
  // burns the 45s flock -w timeout. `nc -z` to the two loopback ports is the cheap
  // (sub-millisecond) "already up?" signal; on a miss we fall through to the
  // flock-wrapped up-script (which ALSO pre-checks under its own lock).
  //
  // flock -w bounds the wait so a wedged holder can't deadlock the caller; the
  // up-script itself ALSO takes the same lock (belt + braces) so this works even
  // against an older image that predates the wrapper.
  //
  // PAINTABLE-FRAME GATE (the completion criterion): the up-script's readiness gates
  // only assert that Xvfb answers xdpyinfo and that x11vnc:5900 + websockify:PORT are
  // LISTENING — NOT that the display actually PAINTS. On a stone-cold gVisor box (the
  // machine→sandbox swap-recovery turn always hits one), Xvfb answers and the VNC ports
  // bind ~1.4s (fast host) to several seconds BEFORE xfdesktop finishes its first
  // wallpaper paint. In that window a scrot yields a small UNPAINTED frame (the -retro
  // stipple or a solid-black root) — never zero-byte — which is exactly the "blank/black"
  // screenshot that 400s the model and blanks the human viewer. (VERIFIED locally: the
  // real xfdesktop backdrop window maps at full 1280x800 the whole time; the render is
  // never structurally broken — it is purely this pre-paint capture race.)
  //
  // We therefore chain a real scrot probe as the completion gate: after the up-script
  // reports success, poll scrot until it produces an actually-PAINTED frame — a PNG at or
  // above PAINT_MIN_BYTES, not merely NON-EMPTY (the old `[ -s ]` check passed on the
  // ~17 KB pre-paint stipple immediately; that WAS the bug) — bounded ~30s, and only THEN
  // let the command exit 0. If it never paints we exit 14 so the caller sees a typed
  // DisplayStackError("paint") — an HONEST failure the worker can degrade + log, rather
  // than a false "up" that hands the model an unpainted image. `-ac` on Xvfb disables
  // access control so this root-side scrot reaches :0. Runs on a pre-check hit too (cheap
  // — an already-up display paints on the first probe). Lives in the runtime-built script
  // (not the baked image up-script) so it ships with the worker/api, no image rebuild —
  // and its size floor holds against the currently-deployed image too.
  const lockedLauncher =
    `ds_started=$1; fw=$2; ds_class=cold; ` +
    `ds_stage() { ds_now=$(date +%s%3N); echo "OPENGENI_DISPLAY_STAGE stage=$1 elapsed_ms=$((ds_now-ds_started)) classification=$ds_class"; }; ` +
    `fa=$(date +%s%3N); fd=$((fa-fw)); [ "$fd" -ge 50 ] && ds_class=contention; ` +
    `ds_stage outer_flock_acquired; ds_stage launcher_issued; ` +
    `env ${env} opengeni-desktop-up; urc=$?; ds_stage launcher_complete; exit "$urc"`;
  const bringUp =
    `if nc -z 127.0.0.1 ${port} >/dev/null 2>&1 && nc -z 127.0.0.1 5900 >/dev/null 2>&1; then ` +
    `ds_class=already_ready; ds_stage precheck_ready; ` +
    `echo "OPENGENI_DESKTOP_UP port=${port} geometry=${geometry.width}x${geometry.height} dpi=${geometry.dpi} (precheck)"; ` +
    `else ` +
    `ds_class=cold; ds_stage precheck_miss; ` +
    `mkdir -p /tmp/opengeni-desktop; ` +
    `ds_stage outer_flock_wait; fw=$(date +%s%3N); ` +
    // Command-mode flock is the supervisor: it retains the lock until the launcher
    // exits, while --close prevents Xvfb/XFCE/x11vnc/websockify from inheriting the
    // lock descriptor when the launcher intentionally detaches them.
    `flock --close --conflict-exit-code 75 --wait 45 /tmp/opengeni-desktop/up.outer.lock ` +
    `bash -c ${shellQuote(lockedLauncher)} _ "$ds_started" "$fw"; frc=$?; ` +
    `if [ "$frc" -eq 75 ]; then ds_stage outer_flock_timeout; echo "OPENGENI_DESKTOP_LOCK_TIMEOUT"; exit 15; fi; ` +
    `if [ "$frc" -ne 0 ]; then exit "$frc"; fi; ` +
    `fi`;
  const paintProbe =
    `ds_stage paint_probe_started; p=/tmp/opengeni-desktop/paint-probe.png; prev=0; ` +
    `for i in $(seq 1 ${PAINT_PROBE_ATTEMPTS}); do ` +
    // Capture, then measure the PNG byte-size. `wc -c < "$p"` yields a bare integer; a
    // failed scrot leaves sz=0. A frame at/above PAINT_MIN_BYTES is a real painted desktop.
    `if DISPLAY=:0 scrot -o "$p" >/dev/null 2>&1; then sz=$(wc -c < "$p" 2>/dev/null || echo 0); else sz=0; fi; ` +
    `rm -f "$p"; ` +
    // SETTLE: accept only when THIS probe AND the PREVIOUS one are both above the floor
    // and their sizes agree within PAINT_SETTLE_DELTA_BYTES — i.e., the paint has stopped
    // growing (the full desktop, panel + icons included, is up), not merely crossed the
    // floor mid-paint on a staged gVisor boot. ($sz/$prev/$d are bare shell — no ${}
    // braces — so JS leaves them for bash; ${PAINT_*} ARE JS constants and interpolate.)
    `if [ "$sz" -ge ${PAINT_MIN_BYTES} ] && [ "$prev" -ge ${PAINT_MIN_BYTES} ]; then d=$((sz-prev)); [ "$d" -lt 0 ] && d=$((0-d)); if [ "$d" -le ${PAINT_SETTLE_DELTA_BYTES} ]; then ds_stage paint_ready; break; fi; fi; ` +
    `prev=$sz; ` +
    // NOTE: NOT_PAINTING goes to STDOUT (not stderr): Modal is execCommand-only, so the
    // caller infers the outcome by string-matching the output — stdout is always captured.
    `if [ "$i" = "${PAINT_PROBE_ATTEMPTS}" ]; then ds_stage paint_failed; echo "OPENGENI_DESKTOP_NOT_PAINTING scrot below ${PAINT_MIN_BYTES}B or unsettled after warmup (last=$sz)"; exit 14; fi; ` +
    `sleep ${PAINT_PROBE_INTERVAL_S}; ` +
    `done`;
  const trace =
    `ds_started=$(date +%s%3N); ds_class=unknown; ` +
    `ds_stage() { ds_now=$(date +%s%3N); echo "OPENGENI_DISPLAY_STAGE stage=$1 elapsed_ms=$((ds_now-ds_started)) classification=$ds_class"; }; ` +
    `ds_stage script_entry`;
  return `${trace}; mkdir -p /tmp/opengeni-desktop; { ${bringUp} ; } && { ${paintProbe} ; }`;
}

function execResultOutput(result: ExecResultLike | string): string {
  if (typeof result === "string") {
    return result;
  }
  return [result.output, result.stderr, result.stdout]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join("\n");
}

function execResultExitCode(result: ExecResultLike | string): number | null {
  if (typeof result === "string") {
    const banner = parseExecResponseBanner(result);
    if (banner.kind === "exited") return banner.exitCode;
    // A malformed/truncated SDK response must not fall through to command-body
    // marker inference, because its real terminal status is unknowable.
    return banner.kind === "invalid" ? -1 : null;
  }
  return typeof result.exitCode === "number" ? result.exitCode : null;
}

function execResultSessionId(result: ExecResultLike | string): number | null {
  if (typeof result === "string") {
    const banner = parseExecResponseBanner(result);
    return banner.kind === "running" ? banner.sessionId : null;
  }
  const value = result.sessionId ?? result.session_id;
  return typeof value === "number" ? value : null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The provider yield is not a deadline. Bound the actual lock-owning process in
 * the box, leaving time for TERM/KILL cleanup and the final exit result to reach
 * the caller before the outer JavaScript deadline. */
function boundedDisplayStackCommand(
  command: string,
  timeoutMs: number,
  markerPath: string,
  markerToken: string,
): string {
  const graceMs = Math.min(
    DISPLAY_STACK_TERMINATION_GRACE_MS,
    Math.max(20, Math.floor(timeoutMs / 4)),
  );
  const commandTimeoutMs = Math.max(1, timeoutMs - graceMs);
  const killAfterMs = Math.max(1, Math.floor(graceMs / 2));
  const commandTimeoutSeconds = (commandTimeoutMs / 1_000).toFixed(3);
  const killAfterSeconds = (killAfterMs / 1_000).toFixed(3);
  const managedCommand =
    `marker=${shellQuote(markerPath)}; token=${shellQuote(markerToken)}; ` +
    `cancel="$marker.cancelled"; ` +
    `if [ -e "$cancel" ]; then echo "OPENGENI_DISPLAY_CANCELLED"; exit 124; fi; ` +
    `pid=$$; pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' '); ` +
    `start=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true); ` +
    `printf '%s %s %s %s\\n' "$pid" "$pgid" "$start" "$token" >"$marker"; ` +
    `if [ -e "$cancel" ]; then rm -f "$marker"; echo "OPENGENI_DISPLAY_CANCELLED"; exit 124; fi; ` +
    // Do not install an EXIT trap: GNU timeout may terminate this supervisor
    // while descendants survive. The marker must remain for the independent
    // cleanup command to find and kill that orphaned process group.
    `bash -c ${shellQuote(command)}; rc=$?; rm -f "$marker"; exit "$rc"`;
  return (
    // Do not use timeout --foreground here. The display command contains flock
    // supervisors and launcher children; default process-group mode is required
    // so a deadline cannot leave a waiter alive to acquire the lock and launch
    // after the caller has already failed.
    `timeout --signal=TERM --kill-after=${killAfterSeconds}s ${commandTimeoutSeconds}s ` +
    `bash -c ${shellQuote(managedCommand)}; rc=$?; ` +
    // Exit 137 is also a normal SIGKILL/OOM/provider-termination result. Only
    // attach timeout attribution to the exit code that this wrapper positively
    // knows GNU timeout emitted for its own deadline. A kill-after escalation
    // may still be reported as 137, but it is not safe to infer that here.
    `if [ "$rc" -eq 124 ]; then ` +
    `echo "OPENGENI_DISPLAY_TIMEOUT elapsed_ms=${commandTimeoutMs}"; fi; exit "$rc"`
  );
}

class DisplayStackWallTimeoutError extends Error {}
class DisplayStackOperationFencedError extends Error {}

type PendingDisplayStackCleanup = {
  markerPath: string;
  markerToken: string;
};

type DisplayStackOperationState = {
  /** Incremented before a timed-out operation is reported to its caller. */
  epoch: number;
  /** Raw provider calls from fenced operations; only the in-box proof gates retries. */
  inFlight: Set<Promise<unknown>>;
  /** A bounded advisory drain for provider calls that may never settle. */
  drain: Promise<void> | null;
  /** Timed-out in-box processes that still need an independent kill/verify. */
  pendingCleanup: Map<string, PendingDisplayStackCleanup>;
  /** True only after every timed-out process has a positive quiescence proof. */
  physicallyQuiescent: boolean;
};

const stableDisplayStackOperationStates = new Map<string, DisplayStackOperationState>();
const stableSessionStateOperationStates = new WeakMap<object, DisplayStackOperationState>();
const displayStackOperationStates = new WeakMap<object, DisplayStackOperationState>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readSessionState(session: unknown): unknown {
  try {
    return asRecord(session)?.state;
  } catch {
    return undefined;
  }
}

function stableSandboxIdentity(
  session: unknown,
  options: EnsureDisplayStackOptions,
): string | null {
  const explicit = nonEmptyString(options.telemetryContext?.sandboxId);
  if (explicit) return `sandbox:${explicit}`;

  const sessionRecord = asRecord(session);
  const state = asRecord(readSessionState(session));
  const providerState = state ? asRecord(state.providerState) : null;
  const candidates = [sessionRecord, state, providerState];
  const fields = [
    "sandboxId",
    "instanceId",
    "agentId",
    "hostId",
    "containerId",
    "id",
    "workspaceRootPath",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const field of fields) {
      const value = nonEmptyString(candidate[field]);
      if (value) return `sandbox:${value}`;
    }
  }
  return null;
}

function newOperationState(): DisplayStackOperationState {
  return {
    epoch: 0,
    inFlight: new Set(),
    drain: null,
    pendingCleanup: new Map(),
    physicallyQuiescent: true,
  };
}

function operationState(
  session: unknown,
  options: EnsureDisplayStackOptions,
): DisplayStackOperationState | null {
  if ((typeof session !== "object" || session === null) && typeof session !== "function") {
    return null;
  }
  const stableKey = stableSandboxIdentity(session, options);
  if (stableKey) {
    let state = stableDisplayStackOperationStates.get(stableKey);
    if (!state) {
      state = newOperationState();
      stableDisplayStackOperationStates.set(stableKey, state);
    }
    return state;
  }

  // Modal resumed wrappers share their provider `state` object even when the
  // wrapper instance is reconstructed. This is a useful stable fallback when
  // an older/provider-specific state shape has no named identity field.
  const providerState = readSessionState(session);
  if (providerState && (typeof providerState === "object" || typeof providerState === "function")) {
    const stateKey = providerState as object;
    let state = stableSessionStateOperationStates.get(stateKey);
    if (!state) {
      state = newOperationState();
      stableSessionStateOperationStates.set(stateKey, state);
    }
    return state;
  }

  const key = session as object;
  let state = displayStackOperationStates.get(key);
  if (!state) {
    state = newOperationState();
    displayStackOperationStates.set(key, state);
  }
  return state;
}

function monotonicNow(): number {
  return performance.now();
}

async function waitForFencedOperation(
  state: DisplayStackOperationState,
  deadline: number,
): Promise<boolean> {
  const drain = state.drain;
  if (!drain) return true;
  try {
    await beforeDeadline(drain, deadline);
  } catch {
    return false;
  }
  if (state.drain === drain) state.drain = null;
  return true;
}

function trackProviderCall<T>(
  state: DisplayStackOperationState | null,
  promise: Promise<T>,
): Promise<T> {
  if (!state) return promise;
  state.inFlight.add(promise);
  void promise.then(
    () => state.inFlight.delete(promise),
    () => state.inFlight.delete(promise),
  );
  return promise;
}

function boundedProviderDrain(pending: Promise<unknown>[]): Promise<void> {
  if (pending.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let remaining = pending.length;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(finish, DISPLAY_STACK_DRAIN_GRACE_MS);
    timer.unref?.();
    for (const promise of pending) {
      void promise.then(
        () => {
          remaining -= 1;
          if (remaining === 0) finish();
        },
        () => {
          remaining -= 1;
          if (remaining === 0) finish();
        },
      );
    }
  });
}

function fenceOperation(
  state: DisplayStackOperationState | null,
  epoch: number,
  abortController: AbortController,
  cleanup: PendingDisplayStackCleanup,
): void {
  abortController.abort(new DisplayStackWallTimeoutError());
  if (!state) return;

  state.pendingCleanup.set(cleanup.markerToken, cleanup);
  state.physicallyQuiescent = false;
  if (state.epoch !== epoch) return;

  // Advance the ownership epoch BEFORE the timeout error is surfaced. Any
  // completion from this operation is now stale. A retry is gated by the
  // independent in-box cleanup proof, not by an SDK promise that may hang.
  state.epoch += 1;
  const pending = [...state.inFlight];
  const drain = boundedProviderDrain(pending);
  state.drain = state.drain ? Promise.all([state.drain, drain]).then(() => undefined) : drain;
  // A provider transport can retain an unresolved promise forever. Once the
  // bounded advisory window ends, release those promises from the registry;
  // the tombstone and in-box process-group proof remain the authoritative fence.
  void drain.then(() => {
    for (const promise of pending) state.inFlight.delete(promise);
  });
}

function assertCurrentOperation(state: DisplayStackOperationState | null, epoch: number): void {
  if (state && state.epoch !== epoch) throw new DisplayStackOperationFencedError();
}

async function beforeDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  now: () => number = monotonicNow,
): Promise<T> {
  const remainingMs = deadline - now();
  if (remainingMs <= 0) throw new DisplayStackWallTimeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DisplayStackWallTimeoutError()), remainingMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function displayStackCleanupCommand(markerPath: string, markerToken: string): string {
  const marker = shellQuote(markerPath);
  const token = shellQuote(markerToken);
  // The launcher writes pid, process-group id, /proc start time, and a random
  // token before it starts the lock-owning command. The start-time check keeps
  // a stale marker from killing an unrelated process after PID reuse. The
  // process group is the authority: a provider session can disappear while
  // descendants of the shell continue to hold the display lock.
  const script =
    `marker=${marker}; token=${token}; ` +
    `cancel="$marker.cancelled"; ` +
    `: >"$cancel" || { echo "OPENGENI_DISPLAY_CLEANUP status=invalid"; exit 75; }; ` +
    `if [ ! -r "$marker" ]; then echo "OPENGENI_DISPLAY_CLEANUP status=stopped"; exit 0; fi; ` +
    `read -r pid pgid start actual <"$marker" || { echo "OPENGENI_DISPLAY_CLEANUP status=invalid"; exit 75; }; ` +
    `[ "$actual" = "$token" ] || { echo "OPENGENI_DISPLAY_CLEANUP status=invalid"; exit 75; }; ` +
    `case "$pid" in ''|*[!0-9]*) echo "OPENGENI_DISPLAY_CLEANUP status=invalid"; exit 75;; esac; ` +
    `case "$pgid" in ''|*[!0-9]*) echo "OPENGENI_DISPLAY_CLEANUP status=invalid"; exit 75;; esac; ` +
    `case "$start" in ''|*[!0-9]*) echo "OPENGENI_DISPLAY_CLEANUP status=invalid"; exit 75;; esac; ` +
    `current=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true); ` +
    `if [ -z "$current" ] || [ "$current" != "$start" ]; then rm -f "$marker"; echo "OPENGENI_DISPLAY_CLEANUP status=stopped"; exit 0; fi; ` +
    `kill -TERM -- "-$pgid" 2>/dev/null || true; ` +
    `for i in $(seq 1 10); do ` +
    `if ! kill -0 -- "-$pgid" 2>/dev/null; then rm -f "$marker"; echo "OPENGENI_DISPLAY_CLEANUP status=stopped"; exit 0; fi; ` +
    `sleep 0.05; done; ` +
    `kill -KILL -- "-$pgid" 2>/dev/null || true; ` +
    `for i in $(seq 1 20); do ` +
    `if ! kill -0 -- "-$pgid" 2>/dev/null; then rm -f "$marker"; echo "OPENGENI_DISPLAY_CLEANUP status=stopped"; exit 0; fi; ` +
    `sleep 0.05; done; ` +
    `echo "OPENGENI_DISPLAY_CLEANUP status=alive"; exit 75`;
  return `timeout --signal=TERM --kill-after=0.2s 1.5s bash -c ${shellQuote(script)}`;
}

async function runProviderCommandToDeadline(
  session: ExecCapableSession,
  command: string,
  deadline: number,
): Promise<ExecResultLike | string> {
  const controller = new AbortController();
  let result: ExecResultLike | string = await beforeDeadline(
    Promise.resolve(
      typeof session.exec === "function"
        ? session.exec({
            cmd: command,
            yieldTimeMs: Math.min(500, DISPLAY_STACK_CLEANUP_CALL_MS),
            maxOutputTokens: 4_000,
            signal: controller.signal,
          })
        : session.execCommand!({
            cmd: command,
            yieldTimeMs: Math.min(500, DISPLAY_STACK_CLEANUP_CALL_MS),
            maxOutputTokens: 4_000,
            signal: controller.signal,
          }),
    ),
    deadline,
  );

  let providerSessionId = execResultSessionId(result);
  while (providerSessionId !== null) {
    if (typeof session.writeStdin !== "function") {
      throw new Error("display cleanup provider yielded without writeStdin");
    }
    const remainingMs = deadline - monotonicNow();
    if (remainingMs <= 1) throw new DisplayStackWallTimeoutError();
    result = await beforeDeadline(
      session.writeStdin({
        sessionId: providerSessionId,
        chars: "",
        yieldTimeMs: Math.max(1, Math.min(250, remainingMs - 1)),
        maxOutputTokens: 4_000,
        signal: controller.signal,
      }),
      deadline,
    );
    providerSessionId = execResultSessionId(result);
  }
  return result;
}

async function interruptProviderProcess(
  session: ExecCapableSession,
  providerSessionId: number | null,
  deadline: number,
): Promise<void> {
  if (providerSessionId === null || typeof session.writeStdin !== "function") return;
  try {
    // This is an advisory provider-level interrupt. The marker/PGID cleanup
    // below remains authoritative because Modal 0.13.3 ignores AbortSignal.
    await beforeDeadline(
      session.writeStdin({
        sessionId: providerSessionId,
        chars: "\u0003",
        yieldTimeMs: 100,
        maxOutputTokens: 256,
      }),
      deadline,
    );
  } catch {
    // A hung provider write is not evidence either way; in-box cleanup decides.
  }
}

async function cleanupDisplayStackProcess(
  session: ExecCapableSession,
  pending: PendingDisplayStackCleanup,
  deadline: number,
): Promise<boolean> {
  try {
    const result = await runProviderCommandToDeadline(
      session,
      displayStackCleanupCommand(pending.markerPath, pending.markerToken),
      deadline,
    );
    const output = execResultOutput(result);
    const status = /OPENGENI_DISPLAY_CLEANUP status=(stopped|absent|alive|invalid)/u.exec(
      output,
    )?.[1];
    return status === "stopped";
  } catch {
    return false;
  }
}

async function reconcilePendingCleanup(
  session: ExecCapableSession,
  state: DisplayStackOperationState,
  deadline: number,
): Promise<boolean> {
  const entries = [...state.pendingCleanup.values()];
  if (entries.length === 0) {
    state.physicallyQuiescent = true;
    return true;
  }
  const results = await Promise.all(
    entries.map(async (pending) => ({
      pending,
      stopped: await cleanupDisplayStackProcess(session, pending, deadline),
    })),
  );
  for (const { pending, stopped } of results) {
    if (stopped) state.pendingCleanup.delete(pending.markerToken);
  }
  state.physicallyQuiescent = state.pendingCleanup.size === 0;
  return state.physicallyQuiescent;
}

function requestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function telemetryReporter(
  options: EnsureDisplayStackOptions,
  started: number,
  now: () => number = monotonicNow,
) {
  const id = requestId();
  const context = options.telemetryContext;
  const sink =
    options.onTelemetry ??
    (context
      ? (event: DisplayStackTelemetryEvent) =>
          console.info(`[display-stack] ${JSON.stringify(event)}`)
      : undefined);
  const emittedSandboxStages = new Set<string>();

  const emit = (
    stage: string,
    status: DisplayStackTelemetryStatus,
    fields: {
      source?: "host" | "sandbox";
      elapsedMs?: number;
      classification?: DisplayStackClassification;
      providerSessionId?: number;
    } = {},
  ) => {
    if (!sink) return;
    const event: DisplayStackTelemetryEvent = {
      type: "display_stack.stage",
      requestId: id,
      stage,
      status,
      elapsedMs: fields.elapsedMs ?? now() - started,
      source: fields.source ?? "host",
      classification: fields.classification ?? "unknown",
      callerKind: context?.callerKind ?? "unknown",
      ...(context?.sandboxId ? { sandboxId: context.sandboxId } : {}),
      ...(context?.leaseEpoch !== undefined ? { leaseEpoch: context.leaseEpoch } : {}),
      ...(fields.providerSessionId !== undefined
        ? { providerSessionId: fields.providerSessionId }
        : {}),
    };
    try {
      void Promise.resolve(sink(event)).catch(() => undefined);
    } catch {
      // Telemetry must never affect display readiness.
    }
  };

  const emitSandboxStages = (output: string) => {
    for (const match of output.matchAll(
      /OPENGENI_(?:DISPLAY|DESKTOP)_STAGE stage=([a-z0-9_]+) elapsed_ms=(\d+)(?: classification=(cold|already_ready|contention|unknown))?/gu,
    )) {
      const [line, stage, elapsed, classification] = match;
      if (!stage || !elapsed || emittedSandboxStages.has(line)) continue;
      emittedSandboxStages.add(line);
      emit(stage, "completed", {
        source: "sandbox",
        elapsedMs: Number(elapsed),
        classification: (classification as DisplayStackClassification | undefined) ?? "unknown",
      });
    }
  };

  return { emit, emitSandboxStages };
}

// Parse the exit code the up-script signals via its trailing marker. When we ran
// through `exec` we have the real exitCode; when we only had `execCommand` (a
// bare string), we infer success from the OPENGENI_DESKTOP_UP marker and infer
// the failing stage from the stage-failure message the script prints to stderr.
function inferExitFromOutput(output: string): number {
  if (/OPENGENI_DISPLAY_TIMEOUT/.test(output)) {
    return 124;
  }
  if (/OPENGENI_DESKTOP_LOCK_TIMEOUT/.test(output)) {
    return 15;
  }
  // Check the PAINTABLE-FRAME failure FIRST: on that path the up-script already
  // printed OPENGENI_DESKTOP_UP (bring-up succeeded) and THEN the paint gate failed,
  // so both markers are present — the NOT_PAINTING one is the authoritative outcome.
  // (Modal is execCommand-only, so this string-inference path is the live one.)
  if (/OPENGENI_DESKTOP_NOT_PAINTING/.test(output)) {
    return 14;
  }
  if (/OPENGENI_DESKTOP_UP\b/.test(output)) {
    return 0;
  }
  if (/Xvfb failed to come up/.test(output)) {
    return 11;
  }
  if (/x11vnc failed on/.test(output)) {
    return 12;
  }
  if (/websockify failed on/.test(output)) {
    return 13;
  }
  return -1;
}

/**
 * Idempotently bring up the desktop display stack on the live box. Safe to call
 * N times (the in-box flock + the up-script's PID guards make a second call a
 * no-op). Resolves with the exposed port + geometry on success; throws
 * `DisplayStackError` on a stage failure and `DisplayStackUnsupportedError` when
 * the session cannot run commands.
 *
 * `session` is the externally-owned provider session (the `established.session`
 * from establishSandboxSessionFromEnvelope, or any SandboxSessionLike). We
 * prefer `session.exec` (structured `{exitCode}`) and fall back to
 * `session.execCommand` (bare string), inferring success from the up-script's
 * marker line in the fallback case.
 */
export async function ensureDisplayStack(
  session: unknown,
  options: EnsureDisplayStackOptions = {},
): Promise<EnsureDisplayStackResult> {
  const s = session as ExecCapableSession;
  if (typeof s?.exec !== "function" && typeof s?.execCommand !== "function") {
    throw new DisplayStackUnsupportedError(
      "provider session cannot run commands (no exec/execCommand) — desktop tier unavailable",
    );
  }

  const geometry = options.geometry ?? DEFAULT_DESKTOP_GEOMETRY;
  const port = options.port ?? DESKTOP_STREAM_PORT;
  const timeoutMs = options.timeoutMs ?? DISPLAY_STACK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("ensureDisplayStack timeoutMs must be a positive finite number");
  }
  const started = monotonicNow();
  const deadline = started + timeoutMs;
  const telemetry = telemetryReporter(options, started, monotonicNow);
  const operationToken = requestId();
  const markerPath = `/tmp/opengeni-desktop/display-stack-${operationToken}.pid`;
  const cmd = boundedDisplayStackCommand(
    buildDisplayStackScript({ geometry, port }),
    timeoutMs,
    markerPath,
    operationToken,
  );
  const outputParts: string[] = [];
  const state = operationState(session, options);
  if (state && !state.physicallyQuiescent) {
    const cleanupDeadline = monotonicNow() + DISPLAY_STACK_CLEANUP_CALL_MS;
    const quiesced = await reconcilePendingCleanup(s, state, cleanupDeadline);
    if (!quiesced) {
      // Fail closed. A new session wrapper may share this physical sandbox,
      // but without a positive marker/PGID proof it must not issue overlapping
      // display work merely because the old SDK promise remains unresolved.
      throw new DisplayStackError(
        124,
        "OPENGENI_DISPLAY_TIMEOUT physical cleanup is still pending; retry is fenced",
      );
    }
  }
  const epoch = state?.epoch ?? 0;
  const abortController = new AbortController();
  let activeProviderSessionId: number | null = null;
  telemetry.emit("request_entry", "started");
  telemetry.emit("exec_issued", "started");

  try {
    const initialYieldMs = Math.max(1, Math.min(DISPLAY_STACK_PROVIDER_YIELD_MS, timeoutMs - 1));
    const initialExec: Promise<ExecResultLike | string> = trackProviderCall<
      ExecResultLike | string
    >(
      state,
      Promise.resolve(
        typeof s.exec === "function"
          ? s.exec({
              cmd,
              yieldTimeMs: initialYieldMs,
              maxOutputTokens: 20_000,
              signal: abortController.signal,
            })
          : s.execCommand!({
              cmd,
              yieldTimeMs: initialYieldMs,
              maxOutputTokens: 20_000,
              signal: abortController.signal,
            }),
      ),
    );
    let result: ExecResultLike | string = await beforeDeadline(initialExec, deadline, monotonicNow);
    assertCurrentOperation(state, epoch);
    let chunk = execResultOutput(result);
    outputParts.push(chunk);
    telemetry.emitSandboxStages(chunk);
    telemetry.emit("provider_first_result", "completed");

    let providerSessionId = execResultSessionId(result);
    activeProviderSessionId = providerSessionId;
    while (providerSessionId !== null) {
      telemetry.emit("provider_yield", "waiting", { providerSessionId });
      if (typeof s.writeStdin !== "function") {
        throw new DisplayStackError(
          -1,
          `${outputParts.join("\n")}\nprovider yielded process ${providerSessionId} but exposes no writeStdin poll surface`,
        );
      }
      assertCurrentOperation(state, epoch);
      const remainingMs = deadline - monotonicNow();
      if (remainingMs <= 1) throw new DisplayStackWallTimeoutError();
      const pollYieldMs = Math.max(1, Math.min(DISPLAY_STACK_PROVIDER_POLL_MS, remainingMs - 1));
      result = await beforeDeadline(
        trackProviderCall(
          state,
          s.writeStdin({
            sessionId: providerSessionId,
            chars: "",
            yieldTimeMs: pollYieldMs,
            maxOutputTokens: 20_000,
            signal: abortController.signal,
          }),
        ),
        deadline,
        monotonicNow,
      );
      assertCurrentOperation(state, epoch);
      chunk = execResultOutput(result);
      outputParts.push(chunk);
      telemetry.emitSandboxStages(chunk);
      providerSessionId = execResultSessionId(result);
      activeProviderSessionId = providerSessionId;
    }

    const output = outputParts.join("\n");
    const exitCode = execResultExitCode(result) ?? inferExitFromOutput(output);
    telemetry.emit("process_complete", exitCode === 0 ? "completed" : "failed");
    if (exitCode !== 0) {
      throw new DisplayStackError(exitCode, output);
    }

    const marker = (output.match(/OPENGENI_DESKTOP_UP[^\n]*/) ?? [""])[0];
    telemetry.emit("readiness_complete", "completed");
    return { port, geometry, marker };
  } catch (error) {
    if (
      error instanceof DisplayStackWallTimeoutError ||
      error instanceof DisplayStackOperationFencedError
    ) {
      const pendingCleanup: PendingDisplayStackCleanup = {
        markerPath,
        markerToken: operationToken,
      };
      fenceOperation(state, epoch, abortController, pendingCleanup);
      const cleanupDeadline = monotonicNow() + DISPLAY_STACK_CLEANUP_CALL_MS;
      telemetry.emit("process_cleanup", "started");
      await interruptProviderProcess(
        s,
        activeProviderSessionId,
        Math.min(cleanupDeadline, monotonicNow() + 50),
      );
      let quiesced = false;
      if (state) {
        quiesced = await reconcilePendingCleanup(s, state, cleanupDeadline);
        if (!quiesced) {
          await waitForFencedOperation(
            state,
            Math.min(cleanupDeadline, monotonicNow() + DISPLAY_STACK_DRAIN_GRACE_MS),
          );
        }
      } else {
        quiesced = await cleanupDisplayStackProcess(s, pendingCleanup, cleanupDeadline);
      }
      telemetry.emit("process_cleanup", quiesced ? "completed" : "failed");
      const output = `${outputParts.join("\n")}\nOPENGENI_DISPLAY_TIMEOUT wall_ms=${timeoutMs}`;
      telemetry.emit("wall_deadline", "failed");
      throw new DisplayStackError(124, output);
    }
    telemetry.emit("request_failed", "failed");
    throw error;
  }
}

/** Tear the stack down (down-script). Best-effort; never throws on a missing
 *  process. Used by the geometry-change restart and cold/drain. */
export async function tearDownDisplayStack(session: unknown): Promise<void> {
  const s = session as ExecCapableSession;
  if (typeof s?.exec === "function") {
    await s.exec({ cmd: "opengeni-desktop-down", yieldTimeMs: 10_000, maxOutputTokens: 4_000 });
    return;
  }
  if (typeof s?.execCommand === "function") {
    await s.execCommand({
      cmd: "opengeni-desktop-down",
      yieldTimeMs: 10_000,
      maxOutputTokens: 4_000,
    });
  }
}

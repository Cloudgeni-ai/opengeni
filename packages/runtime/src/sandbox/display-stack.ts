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
  readonly stage: "xvfb" | "x11vnc" | "websockify" | "paint" | "unknown";

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
              : "unknown";
    super(`desktop display stack failed at stage "${stage}" (exit ${exitCode})${output ? `:\n${output}` : ""}`);
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
};
type ExecCapableSession = {
  exec?: (args: { cmd: string; yieldTimeMs?: number; maxOutputTokens?: number }) => Promise<ExecResultLike>;
  execCommand?: (args: { cmd: string; yieldTimeMs?: number; maxOutputTokens?: number }) => Promise<string>;
};

export type EnsureDisplayStackOptions = {
  geometry?: DesktopGeometry;
  /** The exposed stream port; defaults to 6080. */
  port?: number;
  /** Per-exec timeout; defaults to DISPLAY_STACK_TIMEOUT_MS. */
  timeoutMs?: number;
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
  const bringUp =
    `if nc -z 127.0.0.1 ${port} >/dev/null 2>&1 && nc -z 127.0.0.1 5900 >/dev/null 2>&1; then ` +
    `echo "OPENGENI_DESKTOP_UP port=${port} geometry=${geometry.width}x${geometry.height} dpi=${geometry.dpi} (precheck)"; ` +
    `else ` +
    `mkdir -p /tmp/opengeni-desktop && ` +
    `flock -w 45 /tmp/opengeni-desktop/up.outer.lock ` +
    `env ${env} opengeni-desktop-up; ` +
    `fi`;
  const paintProbe =
    `p=/tmp/opengeni-desktop/paint-probe.png; prev=0; ` +
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
    `if [ "$sz" -ge ${PAINT_MIN_BYTES} ] && [ "$prev" -ge ${PAINT_MIN_BYTES} ]; then d=$((sz-prev)); [ "$d" -lt 0 ] && d=$((0-d)); [ "$d" -le ${PAINT_SETTLE_DELTA_BYTES} ] && break; fi; ` +
    `prev=$sz; ` +
    // NOTE: NOT_PAINTING goes to STDOUT (not stderr): Modal is execCommand-only, so the
    // caller infers the outcome by string-matching the output — stdout is always captured.
    `if [ "$i" = "${PAINT_PROBE_ATTEMPTS}" ]; then echo "OPENGENI_DESKTOP_NOT_PAINTING scrot below ${PAINT_MIN_BYTES}B or unsettled after warmup (last=$sz)"; exit 14; fi; ` +
    `sleep ${PAINT_PROBE_INTERVAL_S}; ` +
    `done`;
  return `mkdir -p /tmp/opengeni-desktop; { ${bringUp} ; } && { ${paintProbe} ; }`;
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
    return null; // execCommand returns a bare string — no exit code available.
  }
  return typeof result.exitCode === "number" ? result.exitCode : null;
}

// Parse the exit code the up-script signals via its trailing marker. When we ran
// through `exec` we have the real exitCode; when we only had `execCommand` (a
// bare string), we infer success from the OPENGENI_DESKTOP_UP marker and infer
// the failing stage from the stage-failure message the script prints to stderr.
function inferExitFromOutput(output: string): number {
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
  const cmd = buildDisplayStackScript({ geometry, port });

  const result =
    typeof s.exec === "function"
      ? await s.exec({ cmd, yieldTimeMs: timeoutMs, maxOutputTokens: 20_000 })
      : await s.execCommand!({ cmd, yieldTimeMs: timeoutMs, maxOutputTokens: 20_000 });

  const output = execResultOutput(result);
  const exitCode = execResultExitCode(result) ?? inferExitFromOutput(output);

  if (exitCode !== 0) {
    throw new DisplayStackError(exitCode, output);
  }

  const marker = (output.match(/OPENGENI_DESKTOP_UP[^\n]*/) ?? [""])[0];
  return { port, geometry, marker };
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
    await s.execCommand({ cmd: "opengeni-desktop-down", yieldTimeMs: 10_000, maxOutputTokens: 4_000 });
  }
}

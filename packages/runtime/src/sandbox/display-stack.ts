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

// The whole-stack launch is bounded by the readiness gates inside the script
// (four loops of 50 * 0.1s = ~5s each, ~20s worst case) PLUS first-boot XFCE/dbus
// + font-cache warm-up on a cold gVisor box. 60s gives headroom over the spike's
// observed ~5-10s warm path without masking a genuine wedge.
export const DISPLAY_STACK_TIMEOUT_MS = 60_000;

/** Desktop geometry for the framebuffer. v1 has no live RANDR: a resolution
 *  change is a full down -> up restart (a separate op). */
export type DesktopGeometry = {
  width: number; // default 1280
  height: number; // default 800
  dpi: number; // default 96
};

export const DEFAULT_DESKTOP_GEOMETRY: DesktopGeometry = { width: 1280, height: 800, dpi: 96 };

/** Thrown when a stage of the launch script failed. exitCode 11/12/13 map to
 *  Xvfb / x11vnc / websockify respectively (the stage that died). Degradation is
 *  surfaced as a value to viewers by the caller; this error is for diagnostics. */
export class DisplayStackError extends Error {
  readonly exitCode: number;
  readonly stage: "xvfb" | "x11vnc" | "websockify" | "unknown";

  constructor(exitCode: number, output: string) {
    const stage =
      exitCode === 11 ? "xvfb" : exitCode === 12 ? "x11vnc" : exitCode === 13 ? "websockify" : "unknown";
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
  return (
    `if nc -z 127.0.0.1 ${port} >/dev/null 2>&1 && nc -z 127.0.0.1 5900 >/dev/null 2>&1; then ` +
    `echo "OPENGENI_DESKTOP_UP port=${port} geometry=${geometry.width}x${geometry.height} dpi=${geometry.dpi} (precheck)"; ` +
    `else ` +
    `mkdir -p /tmp/opengeni-desktop && ` +
    `flock -w 45 /tmp/opengeni-desktop/up.outer.lock ` +
    `env ${env} opengeni-desktop-up; ` +
    `fi`
  );
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

// @opengeni/runtime/sandbox — the REAL PTY terminal-server launcher (P5.t).
//
// The agent-loop-free home for `ensureTerminalServer`: the exec-launched,
// flock-idempotent procedure that brings up the ttyd PTY-over-websocket server
// (a live PTY-backed `bash -l` per ws client, listening on 7681) on a live,
// externally-owned box. It is the SYMMETRIC TWIN of ensureDisplayStack (the
// Channel-B pixel stack) — same exec/execCommand channel (NOT a container CMD)
// so it re-establishes after a snapshot rollover / box re-election, same flock
// idempotency so a second concurrent caller (the API viewer op + the agent turn,
// both racing after a rollover) serializes and no-ops when ttyd is already up.
//
// WHY A REAL PTY OVER THE TUNNEL (not the old ptyWrite-over-HTTP): the stateless
// HTTP plane builds a fresh provider session per call, so the in-memory live-PTY
// process handle (Modal's per-call activeProcesses Map) is gone by the next
// write ("session not found: 1"). ttyd holds the live PTY in-box and streams it
// over the SAME Modal raw-TLS tunnel the desktop noVNC already uses, gated by the
// SAME scoped stream-token mechanism (the server records the token; the boundary
// is the unguessable short-TTL tunnel URL + the recorded token — no in-box gate).
//
// It lives under @opengeni/runtime/sandbox so the API-direct control plane
// (apps/api) and the worker (apps/worker) both pull it from the same single
// agent-loop-free leaf.

import { TERMINAL_STREAM_PORT } from "@opengeni/contracts";

// Re-export the canonical terminal port so callers (exposeStreamPort, the API
// mint) pull the single source of truth (contracts) from this leaf.
export { TERMINAL_STREAM_PORT };

// The ttyd launch is bounded by the readiness gate inside the up-script (50 *
// 0.1s = ~5s) PLUS first-boot warm-up on a cold gVisor box. 60s gives headroom
// over the observed warm path (~1-2s; ttyd is a single static binary) without
// masking a genuine wedge. Symmetric with DISPLAY_STACK_TIMEOUT_MS.
export const TERMINAL_SERVER_TIMEOUT_MS = 60_000;

/** Thrown when the ttyd launch failed inside the box. exitCode 14 maps to the
 *  up-script's "ttyd failed to come up" stage; any other non-zero is unknown.
 *  Degradation is surfaced as a value to clients by the caller (Terminal
 *  transport falls back to sse-events / null); this error is for diagnostics. */
export class TerminalServerError extends Error {
  readonly exitCode: number;
  readonly stage: "ttyd" | "unknown";

  constructor(exitCode: number, output: string) {
    const stage = exitCode === 14 ? "ttyd" : "unknown";
    super(
      `terminal server failed at stage "${stage}" (exit ${exitCode})${output ? `:\n${output}` : ""}`,
    );
    this.name = "TerminalServerError";
    this.exitCode = exitCode;
    this.stage = stage;
  }
}

/** Thrown when the provider session cannot run commands (a headless-only backend
 *  with neither `exec` nor `execCommand`). The terminal tier degrades to the
 *  Channel-A sse-events firehose — the caller maps this to a `transport:null`
 *  pty-ws (the read-only firehose still works). */
export class TerminalServerUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalServerUnsupportedError";
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
  exec?: (args: {
    cmd: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => Promise<ExecResultLike>;
  execCommand?: (args: {
    cmd: string;
    yieldTimeMs?: number;
    maxOutputTokens?: number;
  }) => Promise<string>;
};

export type EnsureTerminalServerOptions = {
  /** The exposed terminal port; defaults to 7681 (ttyd default). */
  port?: number;
  /** Per-exec timeout; defaults to TERMINAL_SERVER_TIMEOUT_MS. */
  timeoutMs?: number;
};

export type EnsureTerminalServerResult = {
  /** The exposed port ttyd listens on (PTY-over-websocket). */
  port: number;
  /** The raw `OPENGENI_TERMINAL_UP …` marker line, for diagnostics. Never
   *  surfaced to clients. */
  marker: string;
};

/**
 * Build the shell command that runs the idempotent up-script under an in-box
 * `flock`. The script is shipped in the image at /usr/local/bin/opengeni-terminal-up
 * (the canonical desktop image, alongside opengeni-desktop-up); we set the port
 * env and wrap the call in `flock` so two concurrent ensureTerminalServer callers
 * (the API viewer op + the agent turn, both racing after a rollover) serialize
 * without a double launch. The up-script's own curl readiness probe makes the
 * second call a no-op.
 *
 * Exported (pure, side-effect-free) so the ensureTerminalServer unit test can
 * assert the exact command sequence without a live box. Mirrors
 * buildDisplayStackScript.
 */
export function buildTerminalServerScript(options: EnsureTerminalServerOptions = {}): string {
  const port = options.port ?? TERMINAL_STREAM_PORT;
  // flock -w bounds the wait so a wedged holder can't deadlock the caller; the
  // up-script's curl probe ALSO makes the launch idempotent (belt + braces) so
  // this works even against an older image that predates the wrapper.
  return (
    `mkdir -p /tmp/opengeni-terminal && ` +
    `flock -w 30 /tmp/opengeni-terminal/up.outer.lock ` +
    `env TERMINAL_PORT=${port} opengeni-terminal-up`
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
// bare string), we infer success from the OPENGENI_TERMINAL_UP marker and infer
// the failing stage from the stage-failure message the script prints to stderr.
// Mirrors inferExitFromOutput (display-stack).
function inferExitFromOutput(output: string): number {
  if (/OPENGENI_TERMINAL_UP\b/.test(output)) {
    return 0;
  }
  if (/ttyd failed to come up/.test(output)) {
    return 14;
  }
  return -1;
}

/**
 * Idempotently bring up the ttyd PTY-over-websocket server on the live box. Safe
 * to call N times (the in-box flock + the up-script's curl readiness probe make a
 * second call a no-op). Resolves with the exposed port on success; throws
 * `TerminalServerError` on a launch failure and `TerminalServerUnsupportedError`
 * when the session cannot run commands.
 *
 * `session` is the externally-owned provider session (the `established.session`
 * from establishSandboxSessionFromEnvelope, or any SandboxSessionLike). We prefer
 * `session.exec` (structured `{exitCode}`) and fall back to `session.execCommand`
 * (bare string), inferring success from the up-script's marker line in the
 * fallback case. Mirrors ensureDisplayStack exactly.
 */
export async function ensureTerminalServer(
  session: unknown,
  options: EnsureTerminalServerOptions = {},
): Promise<EnsureTerminalServerResult> {
  const s = session as ExecCapableSession;
  if (typeof s?.exec !== "function" && typeof s?.execCommand !== "function") {
    throw new TerminalServerUnsupportedError(
      "provider session cannot run commands (no exec/execCommand) — terminal pty-ws unavailable",
    );
  }

  const port = options.port ?? TERMINAL_STREAM_PORT;
  const timeoutMs = options.timeoutMs ?? TERMINAL_SERVER_TIMEOUT_MS;
  const cmd = buildTerminalServerScript({ port });

  const result =
    typeof s.exec === "function"
      ? await s.exec({ cmd, yieldTimeMs: timeoutMs, maxOutputTokens: 20_000 })
      : await s.execCommand!({ cmd, yieldTimeMs: timeoutMs, maxOutputTokens: 20_000 });

  const output = execResultOutput(result);
  const exitCode = execResultExitCode(result) ?? inferExitFromOutput(output);

  if (exitCode !== 0) {
    throw new TerminalServerError(exitCode, output);
  }

  const marker = (output.match(/OPENGENI_TERMINAL_UP[^\n]*/) ?? [""])[0];
  return { port, marker };
}

/** Tear the terminal server down (down-script). Best-effort; never throws on a
 *  missing process. Mirrors tearDownDisplayStack. */
export async function tearDownTerminalServer(session: unknown): Promise<void> {
  const s = session as ExecCapableSession;
  if (typeof s?.exec === "function") {
    await s.exec({ cmd: "opengeni-terminal-down", yieldTimeMs: 10_000, maxOutputTokens: 4_000 });
    return;
  }
  if (typeof s?.execCommand === "function") {
    await s.execCommand({
      cmd: "opengeni-terminal-down",
      yieldTimeMs: 10_000,
      maxOutputTokens: 4_000,
    });
  }
}

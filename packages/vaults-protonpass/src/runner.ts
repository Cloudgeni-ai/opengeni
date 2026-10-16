import { spawn } from "node:child_process";

/** One bounded subprocess run. No shell, no inherited environment. */
export interface ProcessRequest {
  file: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  cwd: string;
  stdin?: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  signal?: AbortSignal;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** stdout exceeded its bound; the process was killed and stdout is incomplete. */
  stdoutOverflow: boolean;
  /** The binary could not be started (missing, not executable). */
  spawnError: string | null;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

const KILL_GRACE_MS = 1_000;

/**
 * Runs `file` with an argv array and an explicit environment. stdout is capped
 * (the process is killed past the cap), stderr is truncated, and the process
 * group is terminated on timeout or abort, so a hung CLI cannot outlive the call.
 */
export const runProcess: ProcessRunner = (request) =>
  new Promise<ProcessResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    if (request.signal?.aborted) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: true,
        stdoutOverflow: false,
        spawnError: null,
      });
      return;
    }

    const child = spawn(request.file, [...request.args], {
      cwd: request.cwd,
      env: { ...request.env },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const kill = (sig: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined && process.platform !== "win32")
            process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          // Already gone.
        }
      };
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (
      result: Omit<ProcessResult, "stdout" | "stderr" | "timedOut" | "aborted" | "stdoutOverflow">,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve({
        ...result,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        aborted,
        stdoutOverflow,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutOverflow) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > request.maxStdoutBytes) {
        stdoutOverflow = true;
        terminate();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= request.maxStderrBytes) return;
      const room = request.maxStderrBytes - stderrBytes;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      stderrBytes += kept.length;
      stderr.push(kept);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ exitCode: null, signal: null, spawnError: error.code ?? "spawn_failed" });
    });
    child.on("close", (exitCode, signal) => {
      finish({ exitCode, signal, spawnError: null });
    });
    // A CLI that exits before reading stdin raises EPIPE; the exit status still decides.
    child.stdin.on("error", () => {});
    child.stdin.end(request.stdin ?? "");
  });

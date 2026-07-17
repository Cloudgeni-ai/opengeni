import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function runCommand(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  const [command, ...commandArgs] = args;
  if (!command) throw new Error("runCommand requires a command");
  const proc = spawn(command, commandArgs, {
    env: compactEnv({ ...process.env, ...options.env }),
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  proc.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timeout = options.timeoutMs
    ? setTimeout(() => proc.kill("SIGKILL"), options.timeoutMs)
    : null;
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      proc.once("error", reject);
      // Node's `close` event fires only after the child is reaped and both
      // output pipes close. That is the lifecycle finite commands need; Bun's
      // subprocess promise can otherwise remain pending on a defunct CLI.
      proc.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    return { stdout, stderr, exitCode };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export type StartedProcess = {
  proc: ReturnType<typeof Bun.spawn>;
  logs: () => string;
  stop: () => Promise<void>;
};

export type StartedE2eWorkerTopology = {
  control: StartedProcess;
  turns: StartedProcess;
  logs: () => string;
  ready: () => boolean;
  stop: () => Promise<void>;
};

/** Start the same isolated control/turn worker topology used in production. */
export async function startE2eWorkerTopology(options: {
  cwd: string;
  env: Record<string, string | undefined>;
}): Promise<StartedE2eWorkerTopology> {
  const [control, turns] = await Promise.all([
    startProcess(["bun", "packages/testing/src/e2e-worker.ts"], {
      ...options,
      env: { ...options.env, OPENGENI_WORKER_ROLE: "control" },
    }),
    startProcess(["bun", "packages/testing/src/e2e-worker.ts"], {
      ...options,
      env: { ...options.env, OPENGENI_WORKER_ROLE: "turn" },
    }),
  ]);
  return {
    control,
    turns,
    logs: () => `[control]\n${control.logs()}\n[turns]\n${turns.logs()}`,
    ready: () =>
      control.logs().includes("OpenGeni control test worker listening") &&
      turns.logs().includes("OpenGeni turn test worker listening"),
    stop: async () => {
      await Promise.allSettled([control.stop(), turns.stop()]);
    },
  };
}

export async function startProcess(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    ready?: () => Promise<boolean>;
    timeoutMs?: number;
  } = {},
): Promise<StartedProcess> {
  let output = "";
  const proc = Bun.spawn(isolatedCommand(args), {
    env: compactEnv({ ...process.env, ...options.env }),
    stdout: "pipe",
    stderr: "pipe",
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  collect(proc.stdout, (chunk) => {
    output += chunk;
  });
  collect(proc.stderr, (chunk) => {
    output += chunk;
  });
  const started = {
    proc,
    logs: () => output,
    stop: async () => {
      if (proc.exitCode === null) {
        terminateOwnedProcess(proc, "SIGTERM");
        await Promise.race([proc.exited, Bun.sleep(3_000)]);
      }
      if (proc.exitCode === null) {
        terminateOwnedProcess(proc, "SIGKILL");
        await proc.exited.catch(() => undefined);
      }
    },
  };
  if (options.ready) {
    await waitFor(options.ready, {
      timeoutMs: options.timeoutMs ?? 30_000,
      intervalMs: 250,
      describe: () => output,
    });
  }
  return started;
}

/**
 * Long-lived test servers frequently launch a child tree (`bun run vite`). On
 * Linux, give every owned server its own session so cleanup can
 * terminate the complete tree and close inherited stdout/stderr handles. A
 * direct-process kill can otherwise leave the grandchild alive and make a
 * completed test hang until the suite-level hook timeout.
 */
function isolatedCommand(args: string[]): string[] {
  return process.platform === "linux" ? ["setsid", "--wait", ...args] : args;
}

function terminateOwnedProcess(
  proc: ReturnType<typeof Bun.spawn>,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (process.platform === "linux") {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      // The session leader may have exited between the status check and the
      // signal. Bun still needs its own subprocess handle settled below.
    }
  }
  try {
    // Keep Bun's subprocess state in sync even when the OS-level group signal
    // already removed the session leader. Without this nudge, `proc.exited`
    // can remain pending after every process is visibly gone from the OS.
    proc.kill(signal);
  } catch {
    // The process may already have been reaped after the group signal.
  }
}

export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    describe?: () => string;
  } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const intervalMs = options.intervalMs ?? 100;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const result = await Promise.race([
        Promise.resolve(predicate()),
        Bun.sleep(remainingMs).then(() => {
          throw new Error("condition attempt exceeded the wait deadline");
        }),
      ]);
      if (result) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(intervalMs);
  }
  const detail = options.describe?.();
  throw new Error(
    `Timed out waiting for condition${lastError ? `: ${String(lastError)}` : ""}${detail ? `\n${detail}` : ""}`,
  );
}

export async function makeTempDir(prefix = "opengeni-test-"): Promise<string> {
  const path = join(tmpdir(), `${prefix}${crypto.randomUUID()}`);
  await mkdir(path, { recursive: true });
  return path;
}

export async function removeTempDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

function compactEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function collect(stream: ReadableStream<Uint8Array>, onChunk: (chunk: string) => void): void {
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      onChunk(decoder.decode(next.value));
    }
  })();
}

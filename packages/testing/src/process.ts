import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const proc = Bun.spawn(args, {
    env: compactEnv({ ...process.env, ...options.env }),
    stdout: "pipe",
    stderr: "pipe",
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  const timeout = options.timeoutMs
    ? setTimeout(() => proc.kill("SIGKILL"), options.timeoutMs)
    : null;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  return { stdout, stderr, exitCode };
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
  const proc = Bun.spawn(args, {
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
        proc.kill("SIGTERM");
        await Promise.race([proc.exited, Bun.sleep(3_000)]);
      }
      if (proc.exitCode === null) {
        proc.kill("SIGKILL");
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
      if (await predicate()) {
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

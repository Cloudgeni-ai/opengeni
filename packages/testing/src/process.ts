import { mkdir, rm } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
};

type OwnedProcess = ChildProcess | ReturnType<typeof Bun.spawn>;

export async function runCommand(
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  const ownedArgs = process.platform === "linux" ? ["setsid", "--wait", ...args] : args;
  const proc = Bun.spawn(ownedArgs, {
    env: compactEnv({ ...process.env, ...options.env }),
    stdout: "pipe",
    stderr: "pipe",
    detached: !["linux", "win32"].includes(process.platform),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  const stdout = collectCommandOutput(proc.stdout);
  const stderr = collectCommandOutput(proc.stderr);
  const outcome = await waitForCommandOutcome(proc, options.timeoutMs);
  if (outcome.kind === "exited") {
    const streams = await waitForCommandOutput([stdout, stderr], 1_000);
    if (streams === null) {
      await cancelCommandOutput([stdout, stderr], 1_000);
      throw new Error(
        `command exited but its output streams remained open (a detached descendant may still own them): ${args.join(" ")}\nstdout:\n${stdout.output()}\nstderr:\n${stderr.output()}`,
      );
    }
    const failedStream = streams.find((stream) => stream.status === "rejected");
    if (failedStream?.status === "rejected") {
      throw new Error("failed to collect command output", { cause: failedStream.reason });
    }
    return {
      stdout: stdout.output(),
      stderr: stderr.output(),
      exitCode: outcome.exitCode,
      timedOut: false,
    };
  }

  const descendants = ownedDescendantPids(proc.pid);
  signalOwnedProcessGroup(proc, "SIGTERM");
  signalProcesses(descendants, "SIGTERM");
  await waitForOwnedProcessesExit(proc, descendants, 2_000);
  if (ownedProcessGroupIsAlive(proc) || descendants.some(processIsAlive)) {
    signalOwnedProcessGroup(proc, "SIGKILL");
    signalProcesses(descendants, "SIGKILL");
    await waitForOwnedProcessesExit(proc, descendants, 2_000);
  }

  const exitCode = await waitForSubprocessExit(proc, 1_000);
  await cancelCommandOutput([stdout, stderr], 1_000);
  if (exitCode === null) {
    proc.unref();
  }
  return {
    stdout: stdout.output(),
    stderr: stderr.output(),
    exitCode: exitCode ?? 124,
    timedOut: true,
  };
}

type CommandOutput = ReturnType<typeof collectCommandOutput>;

async function waitForCommandOutput(
  outputs: CommandOutput[],
  timeoutMs: number,
): Promise<PromiseSettledResult<void>[] | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), timeoutMs);
  });
  const result = await Promise.race([
    Promise.allSettled(outputs.map((output) => output.done)),
    timedOut,
  ]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  return result;
}

async function cancelCommandOutput(outputs: CommandOutput[], timeoutMs: number): Promise<void> {
  await Promise.race([
    Promise.allSettled(outputs.map((output) => output.cancel())),
    Bun.sleep(timeoutMs),
  ]);
}

async function waitForCommandOutcome(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number | undefined,
): Promise<{ kind: "exited"; exitCode: number } | { kind: "timed-out" }> {
  if (timeoutMs === undefined) {
    return { kind: "exited", exitCode: await proc.exited };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ kind: "timed-out" }>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
  });
  const exited = async (): Promise<{ kind: "exited"; exitCode: number }> => {
    try {
      return { kind: "exited", exitCode: await proc.exited };
    } catch {
      return { kind: "exited", exitCode: 1 };
    }
  };
  const outcome = await Promise.race([exited(), timedOut]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  return outcome;
}

function collectCommandOutput(stream: ReadableStream<Uint8Array>): {
  output: () => string;
  done: Promise<void>;
  cancel: () => Promise<void>;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const done = (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          output += decoder.decode();
          return;
        }
        output += decoder.decode(next.value, { stream: true });
      }
    } catch (error) {
      if (!(error instanceof TypeError && String(error).includes("cancel"))) {
        throw error;
      }
    }
  })();
  return {
    output: () => output,
    done,
    cancel: async () => {
      await reader.cancel().catch(() => undefined);
      await done.catch(() => undefined);
    },
  };
}

export type StartedProcess = {
  proc: ChildProcess;
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
  const started = await Promise.allSettled([
    startProcess(["bun", "packages/testing/src/e2e-worker.ts"], {
      ...options,
      env: { ...options.env, OPENGENI_WORKER_ROLE: "control" },
    }),
    startProcess(["bun", "packages/testing/src/e2e-worker.ts"], {
      ...options,
      env: { ...options.env, OPENGENI_WORKER_ROLE: "turn" },
    }),
  ]);
  const failed = started.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") {
    await Promise.allSettled(
      started.map((result) =>
        result.status === "fulfilled" ? result.value.stop() : Promise.resolve(),
      ),
    );
    throw failed.reason;
  }
  const [controlResult, turnsResult] = started;
  if (controlResult?.status !== "fulfilled" || turnsResult?.status !== "fulfilled") {
    throw new Error("worker topology startup returned an incomplete result");
  }
  const control = controlResult.value;
  const turns = turnsResult.value;
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
  const [command, ...commandArgs] = args;
  if (!command) {
    throw new Error("startProcess requires a command");
  }
  let output = "";
  // Node's detached POSIX child becomes the leader of a new session/process
  // group. Bun's detached subprocess does not establish that boundary when
  // called from `bun test` on Linux, and wrapping it in `setsid --wait` leaves
  // a racy Bun subprocess lifecycle under a saturated suite.
  const proc = spawn(command, commandArgs, {
    env: compactEnv({ ...process.env, ...options.env }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  proc.stdout?.setEncoding("utf8");
  proc.stderr?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    output += chunk;
  });
  proc.stderr?.on("data", (chunk: string) => {
    output += chunk;
  });
  let spawnError: Error | undefined;
  proc.once("error", (error) => {
    spawnError = error;
    output += `\n${String(error)}`;
  });
  const closed = new Promise<void>((resolve) => {
    // `close` settles only after the child is reaped and both output streams
    // close. That is the ownership boundary a reusable test service needs.
    proc.once("close", () => resolve());
  });
  let stopPromise: Promise<void> | undefined;
  const stopOwnedProcess = async (): Promise<void> => {
    signalOwnedProcessGroup(proc, "SIGTERM");
    await waitForOwnedProcessGroupExit(proc, 3_000);
    if (ownedProcessGroupIsAlive(proc)) {
      signalOwnedProcessGroup(proc, "SIGKILL");
      await waitForOwnedProcessGroupExit(proc, 3_000);
    }
    if (ownedProcessGroupIsAlive(proc)) {
      throw new Error(`failed to stop owned process group ${proc.pid}: ${args.join(" ")}`);
    }
    if (!(await waitForProcessClose(closed, 3_000))) {
      throw new Error(`owned process streams did not close for ${proc.pid}: ${args.join(" ")}`);
    }
    if (spawnError && proc.pid === undefined) {
      throw new Error(`failed to start owned process: ${args.join(" ")}`, { cause: spawnError });
    }
  };
  const started = {
    proc,
    logs: () => output,
    stop: () => (stopPromise ??= stopOwnedProcess()),
  };
  if (options.ready) {
    try {
      await waitFor(options.ready, {
        timeoutMs: options.timeoutMs ?? 30_000,
        intervalMs: 250,
        describe: () => output,
      });
    } catch (error) {
      await started.stop().catch(() => undefined);
      throw error;
    }
  }
  return started;
}

function signalOwnedProcessGroup(proc: OwnedProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32" || proc.pid === undefined) {
      proc.kill(signal);
    } else {
      process.kill(-proc.pid, signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function ownedDescendantPids(rootPid: number): number[] {
  if (process.platform !== "linux") {
    return [];
  }
  const processes = new Map<number, { parentPid: number; state: string }>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      processes.set(Number(entry), { state: fields[0] ?? "", parentPid: Number(fields[1]) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  const descendants: number[] = [];
  const parents = new Set([rootPid]);
  let foundChild = true;
  while (foundChild) {
    foundChild = false;
    for (const [pid, candidate] of processes) {
      if (
        !parents.has(pid) &&
        parents.has(candidate.parentPid) &&
        !["X", "Z"].includes(candidate.state)
      ) {
        parents.add(pid);
        descendants.push(pid);
        foundChild = true;
      }
    }
  }
  return descendants;
}

function signalProcesses(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      return !["X", "Z"].includes(state ?? "");
    }
    return true;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }
    throw error;
  }
}

async function waitForOwnedProcessesExit(
  proc: ReturnType<typeof Bun.spawn>,
  descendants: number[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (
    (ownedProcessGroupIsAlive(proc) || descendants.some(processIsAlive)) &&
    Date.now() < deadline
  ) {
    await Bun.sleep(50);
  }
}

async function waitForSubprocessExit(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<number | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), timeoutMs);
  });
  const exitCode = await Promise.race([proc.exited.catch(() => null), timedOut]);
  if (timeout !== undefined) {
    clearTimeout(timeout);
  }
  return exitCode;
}

function ownedProcessGroupIsAlive(proc: OwnedProcess): boolean {
  if (process.platform === "win32") {
    return proc.exitCode === null;
  }
  if (proc.pid === undefined) {
    return false;
  }
  if (process.platform === "linux") {
    // `kill(-pgid, 0)` also reports unreaped zombies. They cannot execute or
    // own listeners, so inspect group members and count only live processes.
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const state = fields[0];
        const processGroupId = Number(fields[2]);
        if (processGroupId === proc.pid && state !== "Z" && state !== "X") {
          return true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    return false;
  }
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForOwnedProcessGroupExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (ownedProcessGroupIsAlive(proc) && Date.now() < deadline) {
    await Bun.sleep(50);
  }
}

async function waitForProcessClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolveTrue(closed),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
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
        rejectAfter(remainingMs, "condition attempt exceeded the wait deadline"),
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

async function resolveTrue(promise: Promise<unknown>): Promise<true> {
  await promise;
  return true;
}

async function rejectAfter(delayMs: number, message: string): Promise<never> {
  await Bun.sleep(delayMs);
  throw new Error(message);
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

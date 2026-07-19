#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type CgroupSnapshot = {
  memoryBytes: number | null;
  cpuNanoseconds: number | null;
  readBytes: number | null;
  writeBytes: number | null;
};

export type GnuTimeMetrics = {
  userSeconds: number | null;
  systemSeconds: number | null;
  maxRssBytes: number | null;
  fileSystemInputs: number | null;
  fileSystemOutputs: number | null;
};

function numberFromFile(path: string): number | null {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function cgroupV2Io(): { readBytes: number; writeBytes: number } | null {
  try {
    let readBytes = 0;
    let writeBytes = 0;
    for (const line of readFileSync("/sys/fs/cgroup/io.stat", "utf8").trim().split("\n")) {
      for (const field of line.split(/\s+/).slice(1)) {
        const [name, raw] = field.split("=");
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        if (name === "rbytes") readBytes += value;
        if (name === "wbytes") writeBytes += value;
      }
    }
    return { readBytes, writeBytes };
  } catch {
    return null;
  }
}

function cgroupV1Io(): { readBytes: number; writeBytes: number } | null {
  for (const path of [
    "/sys/fs/cgroup/blkio/blkio.throttle.io_service_bytes",
    "/sys/fs/cgroup/blkio/blkio.io_service_bytes",
  ]) {
    try {
      let readBytes = 0;
      let writeBytes = 0;
      for (const line of readFileSync(path, "utf8").trim().split("\n")) {
        const fields = line.trim().split(/\s+/);
        const operation = fields.at(-2)?.toLowerCase();
        const value = Number(fields.at(-1));
        if (!Number.isFinite(value)) continue;
        if (operation === "read") readBytes += value;
        if (operation === "write") writeBytes += value;
      }
      return { readBytes, writeBytes };
    } catch {
      // Try the next cgroup-v1 accounting file.
    }
  }
  return null;
}

function cgroupV2Cpu(): number | null {
  try {
    const match = readFileSync("/sys/fs/cgroup/cpu.stat", "utf8").match(/^usage_usec\s+(\d+)$/m);
    return match ? Number(match[1]) * 1_000 : null;
  } catch {
    return null;
  }
}

function cgroupSnapshot(): CgroupSnapshot {
  const io = cgroupV2Io() ?? cgroupV1Io();
  return {
    memoryBytes:
      numberFromFile("/sys/fs/cgroup/memory.current") ??
      numberFromFile("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
    cpuNanoseconds: cgroupV2Cpu() ?? numberFromFile("/sys/fs/cgroup/cpuacct/cpuacct.usage"),
    readBytes: io?.readBytes ?? null,
    writeBytes: io?.writeBytes ?? null,
  };
}

function delta(after: number | null, before: number | null): number | null {
  return after === null || before === null ? null : Math.max(0, after - before);
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid) && Date.now() < deadline) await Bun.sleep(25);
  return !processGroupExists(pid);
}

export function parseGnuTime(output: string): GnuTimeMetrics {
  const fields = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const value = (name: string): number | null => {
    const parsed = Number(fields.get(name));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const maxRssKib = value("Maximum resident set size (kbytes)");
  return {
    userSeconds: value("User time (seconds)"),
    systemSeconds: value("System time (seconds)"),
    maxRssBytes: maxRssKib === null ? null : maxRssKib * 1024,
    fileSystemInputs: value("File system inputs"),
    fileSystemOutputs: value("File system outputs"),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const separator = args.indexOf("--");
  const nameIndex = args.indexOf("--name");
  const outputIndex = args.indexOf("--output");
  const timeoutIndex = args.indexOf("--timeout-seconds");
  const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const timeoutSeconds = Number(
    timeoutIndex >= 0
      ? args[timeoutIndex + 1]
      : (process.env.OPENGENI_PROFILE_TIMEOUT_SECONDS ?? "900"),
  );
  const command = separator >= 0 ? args.slice(separator + 1) : [];
  if (!name || !outputPath || command.length === 0) {
    throw new Error(
      "usage: profile-command.ts --name <phase> --output <json> [--timeout-seconds <seconds>] -- <command> [args...]",
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("profile name is unsafe");
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 7200) {
    throw new Error("profile timeout must be an integer from 1 to 7200 seconds");
  }
  const killGraceMs = Number(process.env.OPENGENI_PROFILE_KILL_GRACE_MS ?? "5000");
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 50 || killGraceMs > 30_000) {
    throw new Error("OPENGENI_PROFILE_KILL_GRACE_MS must be an integer from 50 to 30000");
  }
  const naturalSettleMs = Number(process.env.OPENGENI_PROFILE_NATURAL_SETTLE_MS ?? "1000");
  if (!Number.isSafeInteger(naturalSettleMs) || naturalSettleMs < 50 || naturalSettleMs > 30_000) {
    throw new Error("OPENGENI_PROFILE_NATURAL_SETTLE_MS must be an integer from 50 to 30000");
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryTimePath = join(dirname(outputPath), `.${name}-${process.pid}.time`);
  const before = cgroupSnapshot();
  let peakMemoryBytes = before.memoryBytes;
  const startedAt = new Date();
  const started = performance.now();
  const wrapped = existsSync("/usr/bin/time")
    ? ["/usr/bin/time", "-v", "-o", temporaryTimePath, "--", ...command]
    : command;
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(wrapped[0] as string, wrapped.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    detached: useProcessGroup,
  });
  const sampler = setInterval(() => {
    const current = cgroupSnapshot().memoryBytes;
    if (current !== null && (peakMemoryBytes === null || current > peakMemoryBytes)) {
      peakMemoryBytes = current;
    }
  }, 25);
  sampler.unref();
  let forwardedSignal: string | null = null;
  let timedOut = false;
  let escalation: ReturnType<typeof setTimeout> | null = null;
  const signalChild = (signal: NodeJS.Signals): void => {
    if (useProcessGroup && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  };
  const forward = (signal: NodeJS.Signals): void => {
    forwardedSignal ??= signal;
    try {
      signalChild(signal);
    } catch {
      // The group may have settled between signal delivery and forwarding. Try
      // the direct child as a final best effort (Windows always takes this path).
      try {
        child.kill(signal);
      } catch {
        // The child has already settled.
      }
    }
    if (!escalation) {
      escalation = setTimeout(() => {
        try {
          signalChild("SIGKILL");
        } catch {
          // The group settled during the grace period.
        }
      }, killGraceMs);
      escalation.unref();
    }
  };
  const onSigint = (): void => forward("SIGINT");
  const onSigterm = (): void => forward("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const deadline = setTimeout(() => {
    timedOut = true;
    forward("SIGTERM");
  }, timeoutSeconds * 1000);
  deadline.unref();
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    spawnErrorCode: string | null;
  }>((resolveResult) => {
    let settled = false;
    const settle = (value: {
      code: number | null;
      signal: NodeJS.Signals | null;
      spawnErrorCode: string | null;
    }): void => {
      if (settled) return;
      settled = true;
      resolveResult(value);
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      settle({ code: 127, signal: null, spawnErrorCode: error.code ?? "spawn_error" });
    });
    child.once("close", (code, signal) => {
      settle({ code, signal, spawnErrorCode: null });
    });
  });
  const signalNumber = result.signal ? (constants.signals[result.signal] ?? 1) : 0;
  const observedExitCode = result.code ?? 128 + signalNumber;
  let processGroupObservedAfterLeaderExit = false;
  let processGroupSettledNaturally: boolean | null = null;
  let processGroupLeakDetected = false;
  let processGroupSettled = true;
  if (useProcessGroup && child.pid) {
    processGroupObservedAfterLeaderExit = processGroupExists(child.pid);
    if (!forwardedSignal && processGroupObservedAfterLeaderExit) {
      // `close` proves the direct leader and its stdio have closed, not that
      // every descendant has finished normal teardown. In particular, a
      // just-exited grandchild may remain visible as a zombie until the runner
      // init reaps it. Give the complete group one bounded chance to settle on
      // its own before classifying and terminating a persistent orphan.
      processGroupSettledNaturally = await waitForProcessGroupExit(child.pid, naturalSettleMs);
      if (!processGroupSettledNaturally) {
        processGroupLeakDetected = true;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
    processGroupSettled = await waitForProcessGroupExit(child.pid, killGraceMs);
    if (!processGroupSettled) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      processGroupSettled = await waitForProcessGroupExit(child.pid, killGraceMs);
    }
  }
  const forwardedSignalNumber = forwardedSignal
    ? (constants.signals[forwardedSignal as NodeJS.Signals] ?? 1)
    : 0;
  const exitCode = timedOut
    ? 124
    : forwardedSignal
      ? 128 + forwardedSignalNumber
      : processGroupLeakDetected
        ? 70
        : observedExitCode;
  clearInterval(sampler);
  clearTimeout(deadline);
  if (escalation) clearTimeout(escalation);
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  const after = cgroupSnapshot();
  if (
    after.memoryBytes !== null &&
    (peakMemoryBytes === null || after.memoryBytes > peakMemoryBytes)
  ) {
    peakMemoryBytes = after.memoryBytes;
  }
  const gnuTime = existsSync(temporaryTimePath)
    ? parseGnuTime(readFileSync(temporaryTimePath, "utf8"))
    : parseGnuTime("");
  rmSync(temporaryTimePath, { force: true });

  const profile = {
    schemaVersion: 1,
    name,
    executable: command[0],
    exitCode,
    forwardedSignal,
    timedOut,
    timeoutSeconds,
    spawnErrorCode: result.spawnErrorCode,
    observedExitCode,
    processGroupObservedAfterLeaderExit,
    processGroupNaturalSettleMs: naturalSettleMs,
    processGroupSettledNaturally,
    processGroupLeakDetected,
    processGroupSettled,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    wallSeconds: (performance.now() - started) / 1000,
    process: gnuTime,
    cgroup: {
      memoryBeforeBytes: before.memoryBytes,
      memoryAfterBytes: after.memoryBytes,
      memoryPeakSampledBytes: peakMemoryBytes,
      memoryPeakDeltaFromStartBytes:
        peakMemoryBytes === null || before.memoryBytes === null
          ? null
          : Math.max(0, peakMemoryBytes - before.memoryBytes),
      cpuUsageDeltaNanoseconds: delta(after.cpuNanoseconds, before.cpuNanoseconds),
      readBytesDelta: delta(after.readBytes, before.readBytes),
      writeBytesDelta: delta(after.writeBytes, before.writeBytes),
    },
    runner: {
      os: process.platform,
      arch: process.arch,
      bunVersion: Bun.version,
      githubRunnerOs: process.env.RUNNER_OS ?? null,
      githubRunnerArch: process.env.RUNNER_ARCH ?? null,
    },
  };
  writeFileSync(outputPath, `${JSON.stringify(profile, null, 2)}\n`);
  process.stdout.write(`[profile] ${name} -> ${outputPath}\n`);
  process.exit(exitCode);
}

if (import.meta.main) await main();

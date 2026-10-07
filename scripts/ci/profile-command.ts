#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";

const RESOURCE_PREFIX = "[profile-resource] ";
const RESOURCE_INTERVAL_MS = 1000;
const RESOURCE_RECORD_BYTES = 1024;
const RESOURCE_RECORDS = 1024;
const RESOURCE_LIFECYCLE_RESERVE = 64;
const RESOURCE_OUTPUT_BYTES = 1024 * 1024;
// cgroup-v2 order. Hierarchical and local counters must never be conflated.
const RESOURCE_COUNTERS = ["high", "max", "oom", "oom_kill", "oom_group_kill"] as const;
type ResourceCounters = [number | null, number | null, number | null, number | null, number | null];
type ResourceEvent =
  | "start"
  | "sample"
  | "signal"
  | "timeout"
  | "child-close"
  | "group-settled"
  | "limit"
  | "disabled";
type ResourceSignal =
  | "SIGINT"
  | "SIGTERM"
  | "SIGKILL"
  | "SIGHUP"
  | "SIGQUIT"
  | "SIGABRT"
  | "SIGSEGV"
  | "SIGBUS"
  | "SIGILL"
  | "SIGPIPE"
  | "SIGFPE"
  | "SIGALRM";
const RESOURCE_SIGNALS: readonly string[] = [
  "SIGINT",
  "SIGTERM",
  "SIGKILL",
  "SIGHUP",
  "SIGQUIT",
  "SIGABRT",
  "SIGSEGV",
  "SIGBUS",
  "SIGILL",
  "SIGPIPE",
  "SIGFPE",
  "SIGALRM",
];
export type LiveResourceSnapshot = {
  scope: "cgroup2" | "unavailable";
  currentBytes: number | null;
  kernelPeakBytes: number | null;
  limitBytes: number | null;
  limitUnlimited: boolean | null;
  hostTotalBytes: number | null;
  hostAvailableBytes: number | null;
  hierarchical: ResourceCounters;
  local: ResourceCounters;
};
type ResourceTermination = {
  forwardedSignal?: string | null;
  sentSignal?: string | null;
  timedOut?: boolean;
  observedExitCode?: number | null;
  childCloseSignal?: string | null;
  processGroupSettled?: boolean | null;
};

function resourceInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseResourceInteger(text: string | null): number | null {
  if (text === null || !/^(0|[1-9][0-9]*)$/u.test(text.trim())) return null;
  return resourceInteger(Number(text.trim()));
}

function emptyCounters(): ResourceCounters {
  return [null, null, null, null, null];
}

export function parseResourceCounters(text: string | null): ResourceCounters {
  const result = emptyCounters();
  if (text === null || Buffer.byteLength(text) > 4096) return result;
  const seen = new Set<string>();
  for (const line of text.trim().split("\n")) {
    const fields = line.trim().split(/\s+/u);
    const index = RESOURCE_COUNTERS.findIndex((key) => key === fields[0]);
    if (index < 0) continue;
    if (seen.has(fields[0]!) || fields.length !== 2) return emptyCounters();
    seen.add(fields[0]!);
    const value = parseResourceInteger(fields[1]!);
    if (value === null) return emptyCounters();
    result[index] = value;
  }
  return result;
}

function canonicalResourcePath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    posix.normalize(value) === value
  );
}

/** Resolve the observer's actual v2 membership, never a guessed cgroup root.
 * Unsupported v1, namespace traversal and ambiguous mounts stay unavailable. */
export function resolveResourceScope(membership: string, mountinfo: string): string | null {
  if (Buffer.byteLength(membership) > 16384 || Buffer.byteLength(mountinfo) > 65536) return null;
  const entries = membership
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("0::"));
  if (entries.length !== 1) return null;
  const member = entries[0]!.slice(3);
  if (!canonicalResourcePath(member)) return null;
  const matches: { root: string; path: string }[] = [];
  for (const line of mountinfo.trim().split("\n")) {
    const halves = line.split(" - ");
    if (halves.length !== 2 || halves[1]!.split(" ")[0] !== "cgroup2") continue;
    const fields = halves[0]!.split(" ");
    const decode = (value: string): string =>
      value.replace(/\\(040|011|012|134)/gu, (_, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
      );
    const root = decode(fields[3] ?? "");
    const mount = decode(fields[4] ?? "");
    if (!canonicalResourcePath(root) || !canonicalResourcePath(mount)) continue;
    if (member !== root && root !== "/" && !member.startsWith(`${root}/`)) continue;
    const suffix = root === "/" ? member.slice(1) : member.slice(root.length).replace(/^\//u, "");
    matches.push({ root, path: posix.join(mount, suffix) });
  }
  const longest = Math.max(...matches.map((entry) => entry.root.length));
  const selected = matches.filter((entry) => entry.root.length === longest);
  return selected.length === 1 ? selected[0]!.path : null;
}

export function readResourceFile(path: string, limit = 4096): string | null {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65536) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    for (let reads = 0; reads < 32; reads += 1) {
      const size = readSync(fd, bytes, count, bytes.length - count, null);
      count += size;
      if (count > limit) return null;
      if (size === 0) return bytes.subarray(0, count).toString("utf8");
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* Diagnostic only. */
      }
    }
  }
}

function currentResourceScope(): string | null {
  const membership = readResourceFile("/proc/self/cgroup", 16384);
  const mounts = readResourceFile("/proc/self/mountinfo", 65536);
  return membership === null || mounts === null ? null : resolveResourceScope(membership, mounts);
}

function hostResourceBytes(text: string | null, key: string): number | null {
  if (text === null) return null;
  const rows = text.split("\n").filter((line) => line.startsWith(`${key}:`));
  if (rows.length !== 1) return null;
  const match = rows[0]!.match(/^[A-Za-z]+:\s+([0-9]+) kB$/u);
  const kib = match ? parseResourceInteger(match[1]!) : null;
  return kib === null ? null : resourceInteger(kib * 1024);
}

function resourceReader(): () => LiveResourceSnapshot {
  const root = currentResourceScope();
  let identity: { dev: number; ino: number } | null = null;
  try {
    if (root && realpathSync(root) === root) identity = statSync(root);
  } catch {
    /* Unavailable. */
  }
  return () => {
    let bound = false;
    try {
      if (root && identity && currentResourceScope() === root && realpathSync(root) === root) {
        const current = statSync(root);
        bound = current.dev === identity.dev && current.ino === identity.ino;
      }
    } catch {
      /* Remount or namespace changes invalidate the original scope. */
    }
    const read = (name: string): string | null =>
      bound && root ? readResourceFile(join(root, name)) : null;
    const max = read("memory.max")?.trim() ?? null;
    const host = readResourceFile("/proc/meminfo");
    return {
      scope: bound ? "cgroup2" : "unavailable",
      currentBytes: parseResourceInteger(read("memory.current")),
      // Kernel lifetime peak can predate this command; never reset it.
      kernelPeakBytes: parseResourceInteger(read("memory.peak")),
      limitBytes: parseResourceInteger(max),
      limitUnlimited: max === "max" ? true : parseResourceInteger(max) === null ? null : false,
      hostTotalBytes: hostResourceBytes(host, "MemTotal"),
      hostAvailableBytes: hostResourceBytes(host, "MemAvailable"),
      hierarchical: parseResourceCounters(read("memory.events")),
      local: parseResourceCounters(read("memory.events.local")),
    };
  };
}

/** Diagnostic prefix only: never feeds admission, scheduling or exit status.
 * A false sink result disables telemetry immediately without queuing more. */
export class LiveResourceLog {
  private sequence = 0;
  private bytes = 0;
  private periodic = 0;
  private disabled = false;
  private limited = false;
  private nextSample = 0;
  private elapsed = 0;
  private peak: number | null = null;
  private baseline: { hierarchical: ResourceCounters; local: ResourceCounters } | null = null;
  private previous: {
    hierarchical: ResourceCounters;
    local: ResourceCounters;
    scope: LiveResourceSnapshot["scope"];
  } | null = null;
  private hierarchicalReset = false;
  private localReset = false;
  private scopeChanged = false;
  private termination: ResourceTermination = {};
  private readonly started: number;
  constructor(
    private readonly read: () => LiveResourceSnapshot,
    private readonly sink: (line: string) => boolean,
    private readonly clock: () => number = () => performance.now(),
  ) {
    this.started = clock();
  }

  disable(): void {
    this.disabled = true;
  }
  sample(): void {
    if (this.disabled || this.limited || this.clock() < this.nextSample) return;
    this.nextSample = this.clock() + RESOURCE_INTERVAL_MS;
    if (this.periodic >= RESOURCE_RECORDS - RESOURCE_LIFECYCLE_RESERVE) {
      this.limited = true;
      this.emit("limit");
      return;
    }
    this.periodic += 1;
    this.emit("sample");
  }
  emit(event: ResourceEvent, termination: ResourceTermination = {}): void {
    if (this.disabled || this.sequence >= RESOURCE_RECORDS) return;
    let snapshot: LiveResourceSnapshot;
    try {
      snapshot = this.read();
    } catch {
      snapshot = {
        scope: "unavailable",
        currentBytes: null,
        kernelPeakBytes: null,
        limitBytes: null,
        limitUnlimited: null,
        hostTotalBytes: null,
        hostAvailableBytes: null,
        hierarchical: emptyCounters(),
        local: emptyCounters(),
      };
      event = "disabled";
      this.disabled = true;
    }
    const counters = (values: ResourceCounters): ResourceCounters =>
      RESOURCE_COUNTERS.map((_, index) => resourceInteger(values[index])) as ResourceCounters;
    const hierarchical = counters(snapshot.hierarchical);
    const local = counters(snapshot.local);
    this.baseline ??= { hierarchical, local };
    const deltaCounters = (
      values: ResourceCounters,
      baseline: ResourceCounters,
    ): ResourceCounters =>
      values.map((value, index) =>
        value === null || baseline[index] === null || value < baseline[index]!
          ? null
          : value - baseline[index]!,
      ) as ResourceCounters;
    const reset = (values: ResourceCounters, baseline: ResourceCounters): boolean =>
      values.some(
        (value, index) => value !== null && baseline[index] !== null && value < baseline[index]!,
      );
    if (this.previous) {
      this.hierarchicalReset ||= reset(hierarchical, this.previous.hierarchical);
      this.localReset ||= reset(local, this.previous.local);
      this.scopeChanged ||= snapshot.scope !== this.previous.scope;
    }
    this.previous = { hierarchical, local, scope: snapshot.scope };
    this.termination = { ...this.termination, ...termination };
    const current = resourceInteger(snapshot.currentBytes);
    if (current !== null) this.peak = Math.max(this.peak ?? 0, current);
    const tick = resourceInteger(Math.floor(this.clock() - this.started));
    this.elapsed = Math.max(this.elapsed, tick ?? this.elapsed);
    const signal = (value: string | null | undefined): ResourceSignal | null =>
      value && RESOURCE_SIGNALS.includes(value) ? (value as ResourceSignal) : null;
    const record = {
      v: 1,
      seq: this.sequence,
      elapsedMs: this.elapsed,
      event,
      scope: snapshot.scope === "cgroup2" ? "cgroup2" : "unavailable",
      memory: {
        currentBytes: current,
        observedPeakBytes: this.peak,
        kernelPeakBytes: resourceInteger(snapshot.kernelPeakBytes),
        limitBytes: resourceInteger(snapshot.limitBytes),
        limitUnlimited:
          typeof snapshot.limitUnlimited === "boolean" ? snapshot.limitUnlimited : null,
        hostTotalBytes: resourceInteger(snapshot.hostTotalBytes),
        hostAvailableBytes: resourceInteger(snapshot.hostAvailableBytes),
      },
      events: {
        hierarchical,
        local,
        deltaHierarchical:
          this.hierarchicalReset || this.scopeChanged
            ? emptyCounters()
            : deltaCounters(hierarchical, this.baseline.hierarchical),
        deltaLocal:
          this.localReset || this.scopeChanged
            ? emptyCounters()
            : deltaCounters(local, this.baseline.local),
        hierarchicalReset: this.hierarchicalReset,
        localReset: this.localReset,
        scopeChanged: this.scopeChanged,
      },
      termination: {
        forwardedSignal: signal(this.termination.forwardedSignal),
        sentSignal: event === "signal" ? signal(termination.sentSignal) : null,
        timedOut: this.termination.timedOut === true,
        observedExitCode: resourceInteger(this.termination.observedExitCode),
        childCloseSignal: signal(this.termination.childCloseSignal),
        processGroupSettled:
          typeof this.termination.processGroupSettled === "boolean"
            ? this.termination.processGroupSettled
            : null,
      },
    };
    const line = `${RESOURCE_PREFIX}${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > RESOURCE_RECORD_BYTES || this.bytes + bytes > RESOURCE_OUTPUT_BYTES) {
      this.disable();
      return;
    }
    this.sequence += 1;
    this.bytes += bytes;
    if (event === "start") this.nextSample = this.clock() + RESOURCE_INTERVAL_MS;
    try {
      if (!this.sink(line)) this.disable();
    } catch {
      this.disable();
    }
  }
}

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

function resolveGnuTime(): string | null {
  // `/usr/bin/time` is BSD time on macOS and rejects GNU-only `-v -o --` with
  // exit 1. Probe the binary rather than treating path existence as a wire
  // contract; Homebrew exposes GNU time as `gtime`.
  for (const candidate of ["/usr/bin/time", "gtime"]) {
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (probe.status === 0 && /gnu time/i.test(`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`)) {
      return candidate;
    }
  }
  return null;
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
  const liveResources = separator >= 0 && args.slice(0, separator).includes("--live-resources");
  if (!name || !outputPath || command.length === 0) {
    throw new Error(
      "usage: profile-command.ts --name <phase> --output <json> [--timeout-seconds <seconds>] [--live-resources] -- <command> [args...]",
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
  const live = liveResources
    ? new LiveResourceLog(resourceReader(), (line) => process.stdout.write(line))
    : null;
  const onTelemetryError = (): void => live?.disable();
  if (live) process.stdout.on("error", onTelemetryError);
  live?.emit("start");
  const gnuTimeExecutable = resolveGnuTime();
  const wrapped = gnuTimeExecutable
    ? [gnuTimeExecutable, "-v", "-o", temporaryTimePath, "--", ...command]
    : command;
  const useProcessGroup = process.platform !== "win32";
  let child: ReturnType<typeof spawn> | null = null;
  let forwardedSignal: string | null = null;
  let timedOut = false;
  let escalation: ReturnType<typeof setTimeout> | null = null;
  const signalChild = (signal: NodeJS.Signals): void => {
    if (!child) return;
    if (useProcessGroup && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  };
  const forward = (signal: NodeJS.Signals): void => {
    forwardedSignal ??= signal;
    live?.emit("signal", { forwardedSignal, sentSignal: signal, timedOut });
    try {
      signalChild(signal);
    } catch {
      // The group may have settled between signal delivery and forwarding. Try
      // the direct child as a final best effort (Windows always takes this path).
      try {
        child?.kill(signal);
      } catch {
        // The child has already settled.
      }
    }
    if (!escalation) {
      escalation = setTimeout(() => {
        try {
          live?.emit("signal", { forwardedSignal, sentSignal: "SIGKILL", timedOut });
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
  // Own cancellation before launch. A very fast child can otherwise signal
  // readiness before these handlers exist, letting cancellation terminate this
  // wrapper before it persists the terminal profile.
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  child = spawn(wrapped[0] as string, wrapped.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    detached: useProcessGroup,
  });
  const runningChild = child;
  if (forwardedSignal) signalChild(forwardedSignal as NodeJS.Signals);
  const sampler = setInterval(() => {
    live?.sample();
    const current = cgroupSnapshot().memoryBytes;
    if (current !== null && (peakMemoryBytes === null || current > peakMemoryBytes)) {
      peakMemoryBytes = current;
    }
  }, 25);
  sampler.unref();
  const deadline = setTimeout(() => {
    timedOut = true;
    live?.emit("timeout", { forwardedSignal, timedOut });
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
    runningChild.once("error", (error: NodeJS.ErrnoException) => {
      settle({ code: 127, signal: null, spawnErrorCode: error.code ?? "spawn_error" });
    });
    runningChild.once("close", (code, signal) => {
      settle({ code, signal, spawnErrorCode: null });
    });
  });
  const signalNumber = result.signal ? (constants.signals[result.signal] ?? 1) : 0;
  const observedExitCode = result.code ?? 128 + signalNumber;
  live?.emit("child-close", {
    forwardedSignal,
    timedOut,
    observedExitCode,
    childCloseSignal: result.signal,
  });
  let processGroupObservedAfterLeaderExit = false;
  let processGroupSettledNaturally: boolean | null = null;
  let processGroupLeakDetected = false;
  let processGroupSettled = true;
  if (useProcessGroup && runningChild.pid) {
    processGroupObservedAfterLeaderExit = processGroupExists(runningChild.pid);
    if (!forwardedSignal && processGroupObservedAfterLeaderExit) {
      // `close` proves the direct leader and its stdio have closed, not that
      // every descendant has finished normal teardown. In particular, a
      // just-exited grandchild may remain visible as a zombie until the runner
      // init reaps it. Give the complete group one bounded chance to settle on
      // its own before classifying and terminating a persistent orphan.
      processGroupSettledNaturally = await waitForProcessGroupExit(
        runningChild.pid,
        naturalSettleMs,
      );
      if (!processGroupSettledNaturally) {
        processGroupLeakDetected = true;
        try {
          live?.emit("signal", {
            forwardedSignal,
            sentSignal: "SIGTERM",
            timedOut,
            observedExitCode,
            childCloseSignal: result.signal,
          });
          process.kill(-runningChild.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
    processGroupSettled = await waitForProcessGroupExit(runningChild.pid, killGraceMs);
    if (!processGroupSettled) {
      try {
        live?.emit("signal", {
          forwardedSignal,
          sentSignal: "SIGKILL",
          timedOut,
          observedExitCode,
          childCloseSignal: result.signal,
        });
        process.kill(-runningChild.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      processGroupSettled = await waitForProcessGroupExit(runningChild.pid, killGraceMs);
    }
  }
  live?.emit("group-settled", {
    forwardedSignal,
    timedOut,
    observedExitCode,
    childCloseSignal: result.signal,
    processGroupSettled,
  });
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

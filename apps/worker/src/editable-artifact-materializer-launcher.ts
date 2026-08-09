import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative } from "node:path";

import type { VerifiedEditableArtifactProcessLauncher } from "./editable-artifact-materializer-subprocess";

const MAX_PROBE_BYTES = 16 * 1024;
const PROBE_TIMEOUT_MS = 5_000;

export type LinuxEditableArtifactLauncherOptions = Readonly<{
  materializerExecutable: string;
  bubblewrapExecutable: string;
  prlimitExecutable: string;
  runtimeRoot: string;
  memoryLimitBytes: number;
  cpuTimeLimitMs: number;
  fileDescriptorLimit: number;
  processLimit: number;
  fileSizeLimitBytes: number;
  probeExecutable?: string;
}>;

export type DevelopmentEditableArtifactLauncherOptions = Readonly<{
  materializerExecutable: string;
  explicitlyEnabled: boolean;
  nodeEnvironment: string | undefined;
}>;

/**
 * Current-host local development only. This deliberately reports that no OS
 * sandbox, network namespace, or process resource limit is enforced. The
 * caller must surface that degraded capability and can never select this path
 * in production.
 */
export async function createDevelopmentEditableArtifactProcessLauncher(
  options: DevelopmentEditableArtifactLauncherOptions,
): Promise<VerifiedEditableArtifactProcessLauncher> {
  if (!options.explicitlyEnabled || options.nodeEnvironment === "production") {
    throw new Error("Unsandboxed artifact materialization is forbidden outside development");
  }
  const configuredMaterializerExecutable = options.materializerExecutable;
  const materializerExecutable = await developmentExecutable(options.materializerExecutable);
  return Object.freeze({
    identity: Object.freeze({
      platform: `${process.platform}-${process.arch}-development-unsandboxed-v1`,
      isolation: "subprocess",
      network: "host",
      officeAutomation: false,
      sandboxEnforced: false,
      memoryLimitBytes: 0,
      cpuTimeLimitMs: 0,
      fileDescriptorLimit: 0,
      processLimit: 0,
      fileSizeLimitBytes: 0,
    }),
    spawn(input) {
      if (
        input.executable !== configuredMaterializerExecutable &&
        input.executable !== materializerExecutable
      ) {
        throw new Error("Development materializer differs from its verified executable");
      }
      return spawn(materializerExecutable, [...input.args], {
        cwd: "/",
        env: { ...input.environment },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    },
  });
}

/**
 * Concrete production launcher for Linux. Isolation facts are established by
 * a parent-run behavioral probe of the actual bwrap+prlimit command, never by
 * the untrusted codec child. macOS/Windows require their own native launcher
 * implementation and therefore fail closed in production today.
 */
export async function createLinuxEditableArtifactProcessLauncher(
  options: LinuxEditableArtifactLauncherOptions,
): Promise<VerifiedEditableArtifactProcessLauncher> {
  if (process.platform !== "linux") {
    throw new Error("Linux artifact materializer sandbox is unavailable on this platform");
  }
  if (
    !Number.isSafeInteger(options.memoryLimitBytes) ||
    options.memoryLimitBytes <= 0 ||
    !Number.isSafeInteger(options.cpuTimeLimitMs) ||
    options.cpuTimeLimitMs <= 0 ||
    options.cpuTimeLimitMs % 1_000 !== 0 ||
    !Number.isSafeInteger(options.fileDescriptorLimit) ||
    options.fileDescriptorLimit <= 0 ||
    !Number.isSafeInteger(options.processLimit) ||
    options.processLimit <= 0 ||
    !Number.isSafeInteger(options.fileSizeLimitBytes) ||
    options.fileSizeLimitBytes <= 0
  ) {
    throw new Error("Artifact materializer launcher limits are invalid");
  }
  const bubblewrap = await trustedExecutable(options.bubblewrapExecutable, "bwrap");
  const prlimit = await trustedExecutable(options.prlimitExecutable, "prlimit");
  const configuredMaterializerExecutable = options.materializerExecutable;
  const materializerExecutable = await trustedExecutable(
    options.materializerExecutable,
    basename(options.materializerExecutable),
  );
  const runtimeRoot = await trustedRuntimeRoot(options.runtimeRoot);
  const cpuSeconds = options.cpuTimeLimitMs / 1_000;

  const spawnIsolated = (input: {
    executable: string;
    args: readonly string[];
    environment: Readonly<Record<string, string>>;
  }): ChildProcessWithoutNullStreams => {
    if (!isAbsolute(input.executable)) throw new Error("Sandbox target must be absolute");
    const sandboxArguments = linuxEditableArtifactSandboxArguments({
      executable: input.executable,
      args: input.args,
      runtimeRoot,
      scratchLimitBytes: options.fileSizeLimitBytes,
    });
    return spawn(
      prlimit,
      [
        ...linuxEditableArtifactPrlimitArguments({
          memoryLimitBytes: options.memoryLimitBytes,
          cpuSeconds,
          fileDescriptorLimit: options.fileDescriptorLimit,
          processLimit: options.processLimit,
          fileSizeLimitBytes: options.fileSizeLimitBytes,
        }),
        "--",
        bubblewrap,
        ...sandboxArguments,
      ],
      {
        cwd: "/",
        env: { ...input.environment },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  };

  const spawnMaterializer = (input: {
    executable: string;
    args: readonly string[];
    environment: Readonly<Record<string, string>>;
  }): ChildProcessWithoutNullStreams => {
    if (
      input.executable !== configuredMaterializerExecutable &&
      input.executable !== materializerExecutable
    ) {
      throw new Error("Sandbox target differs from the verified materializer executable");
    }
    assertRuntimeEnvironmentConfined(input.environment, runtimeRoot);
    return spawnIsolated({ ...input, executable: materializerExecutable });
  };

  const probeExecutable = await trustedExecutable(
    options.probeExecutable ?? process.execPath,
    basename(process.execPath),
  );
  const parentNetworkNamespace = await readlink("/proc/self/ns/net");
  const probe = spawnIsolated({
    executable: probeExecutable,
    args: [
      "-e",
      [
        'const fs=require("node:fs")',
        'const net=fs.readlinkSync("/proc/self/ns/net")',
        'const limits=fs.readFileSync("/proc/self/limits","utf8")',
        'const rootEntries=fs.readdirSync("/").sort()',
        'let rootWritable=false;try{fs.writeFileSync("/opengeni-root-write-probe","x");rootWritable=true;fs.unlinkSync("/opengeni-root-write-probe")}catch{}',
        'let scratchWritable=false;try{fs.writeFileSync("/tmp/opengeni-scratch-write-probe","x");scratchWritable=true;fs.unlinkSync("/tmp/opengeni-scratch-write-probe")}catch{}',
        "process.stdout.write(JSON.stringify({net,limits,rootEntries,rootWritable,scratchWritable}))",
      ].join(";"),
    ],
    environment: Object.freeze({ LANG: "C", LC_ALL: "C", TZ: "UTC" }),
  });
  probe.stdin.end();
  const timeout = setTimeout(() => terminateChild(probe), PROBE_TIMEOUT_MS);
  timeout.unref?.();
  let stdout: Uint8Array;
  let stderr: Uint8Array;
  let status: { code: number | null; signal: NodeJS.Signals | null };
  try {
    [stdout, stderr, status] = await Promise.all([
      boundedStream(probe.stdout),
      boundedStream(probe.stderr),
      waitForExit(probe),
    ]);
  } finally {
    clearTimeout(timeout);
    terminateChild(probe);
  }
  if (status.code !== 0 || status.signal !== null || stderr.byteLength !== 0) {
    throw new Error("Artifact materializer sandbox behavioral probe failed");
  }
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Artifact materializer sandbox probe returned invalid evidence");
  }
  const evidence = parsed as Record<string, unknown>;
  const expectedRootEntries = linuxEditableArtifactSandboxRootEntries({
    executable: probeExecutable,
    runtimeRoot,
  });
  if (
    typeof evidence.net !== "string" ||
    evidence.net === parentNetworkNamespace ||
    typeof evidence.limits !== "string" ||
    !hasResourceLimit(evidence.limits, "Max cpu time", String(cpuSeconds)) ||
    !hasResourceLimit(evidence.limits, "Max address space", String(options.memoryLimitBytes)) ||
    !hasResourceLimit(evidence.limits, "Max open files", String(options.fileDescriptorLimit)) ||
    !hasResourceLimit(evidence.limits, "Max processes", String(options.processLimit)) ||
    !hasResourceLimit(evidence.limits, "Max file size", String(options.fileSizeLimitBytes)) ||
    !sameStringList(evidence.rootEntries, expectedRootEntries) ||
    evidence.rootWritable !== false ||
    evidence.scratchWritable !== true
  ) {
    throw new Error("Artifact materializer sandbox enforcement could not be proved");
  }

  return Object.freeze({
    identity: Object.freeze({
      platform: `linux-${process.arch}-bwrap-prlimit-v1`,
      isolation: "subprocess",
      network: "denied",
      officeAutomation: false,
      sandboxEnforced: true,
      memoryLimitBytes: options.memoryLimitBytes,
      cpuTimeLimitMs: options.cpuTimeLimitMs,
      fileDescriptorLimit: options.fileDescriptorLimit,
      processLimit: options.processLimit,
      fileSizeLimitBytes: options.fileSizeLimitBytes,
    }),
    spawn: spawnMaterializer,
  });
}

export function linuxEditableArtifactSandboxArguments(
  input: Readonly<{
    executable: string;
    args: readonly string[];
    runtimeRoot: string;
    scratchLimitBytes: number;
  }>,
): readonly string[] {
  if (
    !isAbsolute(input.executable) ||
    !isAbsolute(input.runtimeRoot) ||
    !Number.isSafeInteger(input.scratchLimitBytes) ||
    input.scratchLimitBytes <= 0
  ) {
    throw new Error("Artifact materializer sandbox paths must be absolute");
  }
  const parentDirectories = sandboxParentDirectories([input.executable, input.runtimeRoot]);
  return Object.freeze([
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    ...parentDirectories.flatMap((path) => ["--dir", path]),
    "--ro-bind",
    "/usr/lib",
    "/usr/lib",
    "--ro-bind-try",
    "/usr/lib64",
    "/usr/lib64",
    "--ro-bind-try",
    "/usr/share",
    "/usr/share",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--dir",
    "/etc",
    "--ro-bind-try",
    "/etc/ld.so.cache",
    "/etc/ld.so.cache",
    "--ro-bind-try",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf",
    "--ro-bind-try",
    "/etc/ld.so.conf.d",
    "/etc/ld.so.conf.d",
    "--ro-bind",
    input.runtimeRoot,
    input.runtimeRoot,
    "--ro-bind",
    input.executable,
    input.executable,
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--size",
    String(input.scratchLimitBytes),
    "--tmpfs",
    "/tmp",
    "--remount-ro",
    "/",
    "--chdir",
    "/",
    "--",
    input.executable,
    ...input.args,
  ]);
}

export function linuxEditableArtifactPrlimitArguments(
  input: Readonly<{
    memoryLimitBytes: number;
    cpuSeconds: number;
    fileDescriptorLimit: number;
    processLimit: number;
    fileSizeLimitBytes: number;
  }>,
): readonly string[] {
  return Object.freeze([
    `--as=${input.memoryLimitBytes}`,
    `--cpu=${input.cpuSeconds}`,
    `--nofile=${input.fileDescriptorLimit}`,
    `--nproc=${input.processLimit}`,
    `--fsize=${input.fileSizeLimitBytes}`,
  ]);
}

export function linuxEditableArtifactSandboxRootEntries(
  input: Readonly<{
    executable: string;
    runtimeRoot: string;
  }>,
): readonly string[] {
  const entries = new Set(["dev", "etc", "lib", "lib64", "proc", "tmp", "usr"]);
  for (const path of [input.executable, input.runtimeRoot]) {
    const topLevel = path.split("/").find((part) => part.length > 0);
    if (topLevel) entries.add(topLevel);
  }
  return Object.freeze([...entries].sort());
}

async function trustedExecutable(input: string, expectedBasename: string): Promise<string> {
  if (!isAbsolute(input) || basename(input) !== expectedBasename) {
    throw new Error(`Artifact materializer ${expectedBasename} path is invalid`);
  }
  const canonical = await realpath(input);
  const metadata = await stat(canonical);
  await access(canonical, 1);
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
    throw new Error(`Artifact materializer ${expectedBasename} is not a trusted executable`);
  }
  return canonical;
}

async function trustedRuntimeRoot(input: string): Promise<string> {
  if (!isAbsolute(input) || broadRuntimeRoot(input)) {
    throw new Error("Artifact materializer runtime root is invalid");
  }
  const canonical = await realpath(input);
  const metadata = await stat(canonical);
  if (
    canonical !== input ||
    !metadata.isDirectory() ||
    metadata.uid !== 0 ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error("Artifact materializer runtime root is not a trusted directory");
  }
  return canonical;
}

function broadRuntimeRoot(input: string): boolean {
  if (input.split("/").filter(Boolean).length < 2) return true;
  return new Set([
    "/",
    "/app",
    "/bin",
    "/dev",
    "/etc",
    "/home",
    "/lib",
    "/lib64",
    "/media",
    "/mnt",
    "/opt",
    "/proc",
    "/root",
    "/run",
    "/sbin",
    "/srv",
    "/sys",
    "/tmp",
    "/usr",
    "/usr/local",
    "/var",
    "/workspace",
  ]).has(input);
}

function assertRuntimeEnvironmentConfined(
  environment: Readonly<Record<string, string>>,
  runtimeRoot: string,
): void {
  for (const name of [
    "OPENGENI_ARTIFACT_RUNTIME_MANIFEST",
    "OPENGENI_ARTIFACT_TOOL_ENTRY",
  ] as const) {
    const path = environment[name];
    if (!path || !isPathInside(runtimeRoot, path)) {
      throw new Error("Artifact materializer runtime environment escapes its verified root");
    }
  }
}

function isPathInside(root: string, path: string): boolean {
  if (!isAbsolute(path)) return false;
  const fromRoot = relative(root, path);
  return (
    fromRoot.length > 0 &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(fromRoot)
  );
}

function sandboxParentDirectories(paths: readonly string[]): readonly string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    let parent = dirname(path);
    while (parent !== "/" && parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  return [...directories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth === 0 ? left.localeCompare(right) : depth;
  });
}

function sameStringList(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

async function developmentExecutable(input: string): Promise<string> {
  if (!isAbsolute(input) || !/^opengeni-artifact-materializer(?:\.exe)?$/u.test(basename(input))) {
    throw new Error("Development artifact materializer path is invalid");
  }
  const canonical = await realpath(input);
  const metadata = await stat(canonical);
  await access(canonical, 1);
  if (!metadata.isFile()) throw new Error("Development artifact materializer is not executable");
  return canonical;
}

function hasResourceLimit(limits: string, name: string, expected: string): boolean {
  const line = limits.split("\n").find((candidate) => candidate.startsWith(name));
  if (!line) return false;
  const fields = line.trim().split(/\s{2,}/u);
  return fields[1] === expected && fields[2] === expected;
}

async function boundedStream(
  stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const value of stream) {
    const chunk = typeof value === "string" ? Buffer.from(value) : value;
    total += chunk.byteLength;
    if (total > MAX_PROBE_BYTES) throw new Error("Artifact materializer sandbox probe overflowed");
    chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice());
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      child.removeListener("exit", onExit);
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      child.removeListener("error", onError);
      resolve({ code, signal });
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.destroy();
  child.kill("SIGKILL");
}

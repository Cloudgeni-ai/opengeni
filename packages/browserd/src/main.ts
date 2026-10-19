import { constants, readFileSync } from "node:fs";
import { access, lstat, open } from "node:fs/promises";
import { totalmem } from "node:os";
import { resolve } from "node:path";
import { BROWSER_CONTROL_PORT } from "@opengeni/contracts";
import { BROWSER_CONTROL_PROTOCOL_VERSION } from "./protocol";
import { resolvePinnedAgentBrowserBinary } from "./binary";
import { resolvePinnedHeadlessShell } from "./headless-shell";
import { resolvePinnedLightpandaBinary } from "./lightpanda-binary";
import {
  ExistingComputerEnvironmentAllocator,
  LinuxVirtualComputerEnvironmentAllocator,
} from "./computer-environment";
import { ComputerSupervisor } from "./computer-supervisor";
import { createCuaComputerDriver } from "./cua/factory";
import { BrowserControlServer } from "./server";
import { BrowserSupervisor } from "./supervisor";
import { retainControllerDiagnostic } from "./controller-diagnostics";

/** Exact release identity baked into compiled sidecars. Development builds share
 * one explicit marker with the Rust agent. Missing/mismatched identities fail
 * closed instead of silently running an old helper with a new controller. */
export const INTERACTION_RUNTIME_BUILD_ID = process.env.OPENGENI_RUNTIME_BUILD_ID ?? "development";

export async function runBrowserd(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = await browserdConfig(environment);
  if (
    config.computerBackend === "cua" &&
    (process.platform === "linux"
      ? config.computerEnvironmentMode !== "isolated_linux"
      : !["darwin", "win32"].includes(process.platform) ||
        config.computerEnvironmentMode !== "existing")
  ) {
    throw new Error("CUA requires an isolated Linux seat or an existing macOS/Windows desktop");
  }
  const agentBrowserBinary = config.agentBrowserBinaryPath
    ? await resolvePinnedAgentBrowserBinary({ binaryPath: config.agentBrowserBinaryPath })
    : undefined;
  const lightpandaBinary = config.lightpandaBinaryPath
    ? await resolvePinnedLightpandaBinary({ binaryPath: config.lightpandaBinaryPath })
    : undefined;
  const headlessShell = config.headlessShellDirectory
    ? await resolvePinnedHeadlessShell(config.headlessShellDirectory)
    : undefined;
  const computerNativeBinaryPath =
    config.computerBackend === "native" && config.computerNativeBinaryPath
      ? await resolveExecutable(config.computerNativeBinaryPath, "computer native helper")
      : undefined;
  const supervisor = await BrowserSupervisor.open({
    rootDirectory: config.rootDirectory,
    ...(config.socketRootDirectory ? { socketRootDirectory: config.socketRootDirectory } : {}),
    maxSessions: config.maxSessions,
    ephemeralContextPoolEnabled: environment.OPENGENI_BROWSERD_EPHEMERAL_CONTEXT_POOL === "1",
    networkIsolation: environment.OPENGENI_BROWSERD_NETWORK_ISOLATION !== "off",
    ...(headlessShell ? { headlessShell } : {}),
    ...(agentBrowserBinary ? { agentBrowserBinary } : {}),
    ...(lightpandaBinary ? { lightpandaBinary } : {}),
  });
  let computerSupervisor: ComputerSupervisor | undefined;
  try {
    if (computerNativeBinaryPath || config.computerBackend === "cua") {
      computerSupervisor = await ComputerSupervisor.open({
        rootDirectory: config.rootDirectory,
        ...(computerNativeBinaryPath ? { nativeBinaryPath: computerNativeBinaryPath } : {}),
        ...(config.computerBackend === "cua" ? { createDriver: createCuaComputerDriver } : {}),
        maxSessions: config.maxComputerSessions,
        displaceExistingSessions: config.computerEnvironmentMode === "existing",
        environmentAllocator:
          config.computerEnvironmentMode === "isolated_linux"
            ? new LinuxVirtualComputerEnvironmentAllocator({
                compositing: config.computerBackend === "cua",
              })
            : new ExistingComputerEnvironmentAllocator({
                allowWindows: config.computerBackend === "cua",
              }),
      });
    }
  } catch (error) {
    await supervisor.close();
    throw error;
  }
  let server: BrowserControlServer;
  try {
    server = BrowserControlServer.start({
      supervisor,
      ...(computerSupervisor ? { computerSupervisor } : {}),
      adminToken: config.adminToken,
      hostname: config.hostname,
      port: config.port,
      allowedOrigins: config.allowedOrigins,
      ...(config.browserExecutablePath
        ? { browserExecutablePath: config.browserExecutablePath }
        : {}),
      onUnexpectedError: (error, context) =>
        reportUnexpectedControllerError(error, context, config.rootDirectory, config.adminToken),
    });
  } catch (error) {
    await Promise.allSettled([
      supervisor.close(),
      ...(computerSupervisor ? [computerSupervisor.close()] : []),
    ]);
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({
      service: "opengeni-browserd",
      status: "ready",
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
      runtimeBuildId: INTERACTION_RUNTIME_BUILD_ID,
      computer: computerSupervisor !== undefined,
      hostname: server.hostname,
      port: server.port,
    })}\n`,
  );
  await waitForShutdownSignal(environment.OPENGENI_BROWSERD_PARENT_LIFELINE === "stdin");
  await server.stop();
}

function reportUnexpectedControllerError(
  error: unknown,
  context: { method: string; pathname: string },
  rootDirectory: string,
  adminToken: string,
): void {
  const value =
    error instanceof Error
      ? {
          name: boundedDiagnostic(error.name, 256),
          message: boundedDiagnostic(error.message, 4_096),
          stack: boundedDiagnostic(error.stack ?? "", 16_384),
        }
      : {
          name: "UnknownError",
          message: boundedDiagnostic(nonErrorDiagnostic(error), 4_096),
          stack: "",
        };
  const line = `${JSON.stringify({
    service: "opengeni-browserd",
    event: "unexpected_request_error",
    method: context.method,
    pathname: context.pathname,
    error: value,
  })}\n`.replaceAll(adminToken, "[redacted]");
  process.stderr.write(line);
  try {
    retainControllerDiagnostic(rootDirectory, line);
  } catch {
    process.stderr.write("opengeni-browserd: could not retain controller diagnostic\n");
  }
}

function nonErrorDiagnostic(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function boundedDiagnostic(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  return bytes.byteLength <= maxBytes ? value : bytes.subarray(0, maxBytes).toString("utf8");
}

type BrowserdConfig = {
  rootDirectory: string;
  socketRootDirectory?: string;
  adminToken: string;
  hostname: string;
  port: number;
  maxSessions: number;
  allowedOrigins: string[];
  browserExecutablePath?: string;
  agentBrowserBinaryPath?: string;
  lightpandaBinaryPath?: string;
  headlessShellDirectory?: string;
  computerNativeBinaryPath?: string;
  computerBackend: "native" | "cua";
  maxComputerSessions: number;
  computerEnvironmentMode: "existing" | "isolated_linux";
};

async function browserdConfig(environment: NodeJS.ProcessEnv): Promise<BrowserdConfig> {
  const rootDirectory = resolve(requiredEnvironment(environment, "OPENGENI_BROWSERD_ROOT"));
  const tokenFile = resolve(requiredEnvironment(environment, "OPENGENI_BROWSERD_ADMIN_TOKEN_FILE"));
  return {
    rootDirectory,
    ...computerRuntimeConfig(environment),
    ...(environment.OPENGENI_BROWSERD_SOCKET_ROOT
      ? { socketRootDirectory: resolve(environment.OPENGENI_BROWSERD_SOCKET_ROOT) }
      : {}),
    adminToken: await readOwnerOnlyToken(tokenFile),
    hostname: environment.OPENGENI_BROWSERD_HOSTNAME ?? "0.0.0.0",
    port: environmentInteger(
      environment.OPENGENI_BROWSERD_PORT,
      BROWSER_CONTROL_PORT,
      0,
      65_535,
      "OPENGENI_BROWSERD_PORT",
    ),
    maxSessions: environmentInteger(
      environment.OPENGENI_BROWSERD_MAX_SESSIONS,
      defaultMaxBrowserSessions(machineMemoryBytes()),
      1,
      10_000,
      "OPENGENI_BROWSERD_MAX_SESSIONS",
    ),
    maxComputerSessions: environmentInteger(
      environment.OPENGENI_BROWSERD_MAX_COMPUTER_SESSIONS,
      64,
      1,
      10_000,
      "OPENGENI_BROWSERD_MAX_COMPUTER_SESSIONS",
    ),
    allowedOrigins: commaSeparated(environment.OPENGENI_BROWSERD_ALLOWED_ORIGINS),
    ...(environment.OPENGENI_BROWSERD_BROWSER_EXECUTABLE
      ? { browserExecutablePath: resolve(environment.OPENGENI_BROWSERD_BROWSER_EXECUTABLE) }
      : {}),
    ...(environment.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
      ? { agentBrowserBinaryPath: resolve(environment.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY) }
      : {}),
    ...(environment.OPENGENI_BROWSERD_HEADLESS_SHELL_DIRECTORY
      ? { headlessShellDirectory: resolve(environment.OPENGENI_BROWSERD_HEADLESS_SHELL_DIRECTORY) }
      : {}),
    ...(environment.OPENGENI_BROWSERD_LIGHTPANDA_BINARY
      ? { lightpandaBinaryPath: resolve(environment.OPENGENI_BROWSERD_LIGHTPANDA_BINARY) }
      : {}),
    ...(environment.OPENGENI_BROWSERD_COMPUTER_NATIVE_BINARY
      ? {
          computerNativeBinaryPath: resolve(environment.OPENGENI_BROWSERD_COMPUTER_NATIVE_BINARY),
        }
      : {}),
  };
}

export function computerRuntimeConfig(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Pick<BrowserdConfig, "computerBackend" | "computerEnvironmentMode"> {
  const environmentMode = environment.OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE;
  const backend = computerBackend(
    environment.OPENGENI_BROWSERD_COMPUTER_BACKEND,
    platform,
    environmentMode,
  );
  return {
    computerBackend: backend,
    computerEnvironmentMode: computerEnvironmentMode(environmentMode),
  };
}

function computerBackend(
  value: string | undefined,
  platform: NodeJS.Platform,
  environmentMode: string | undefined,
): "native" | "cua" {
  if (value === undefined) {
    // Linux CUA owns an isolated seat. Require that explicit environment choice
    // so an upgrade cannot redirect an existing host desktop to a new seat.
    // Windows has no working native helper, so CUA is its desktop backend.
    return platform === "darwin" ||
      platform === "win32" ||
      (platform === "linux" && environmentMode === "isolated_linux")
      ? "cua"
      : "native";
  }
  if (value === "native") return "native";
  if (value === "cua") return "cua";
  throw new Error("OPENGENI_BROWSERD_COMPUTER_BACKEND is invalid");
}

function computerEnvironmentMode(value: string | undefined): "existing" | "isolated_linux" {
  if (value === undefined || value === "existing") return "existing";
  if (value === "isolated_linux") return value;
  throw new Error("OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE is invalid");
}

async function resolveExecutable(path: string, label: string): Promise<string> {
  const resolved = resolve(path);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be an exact regular file`);
  }
  await access(resolved, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  return resolved;
}

async function readOwnerOnlyToken(path: string): Promise<string> {
  const handle = await open(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 4_096) {
      throw new Error("browserd admin token file is invalid");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error("browserd admin token file must be owner-only");
    }
    const token = (await handle.readFile("utf8")).trim();
    if (token.length < 32) throw new Error("browserd admin token is invalid");
    return token;
  } finally {
    await handle.close();
  }
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Memory one browser is planned at: about the p90 resident (PSS) size of
 * live agent browsers, including their renderer and GPU processes. */
const PLANNED_BROWSER_MEMORY_BYTES = 300 * 1024 * 1024;
/** Share of machine memory browsers may plan to use; the rest stays with the
 * operating system, the agent and whatever else the machine runs. */
const BROWSER_MEMORY_SHARE = 0.5;
const MIN_DEFAULT_BROWSER_SESSIONS = 8;

/**
 * Default browser limit for one controller, sized to the machine: half its
 * memory at {@link PLANNED_BROWSER_MEMORY_BYTES} each, so a 48 GiB machine
 * runs 81 browsers and an 86 GiB one 147. OPENGENI_BROWSERD_MAX_SESSIONS
 * overrides it.
 */
export function defaultMaxBrowserSessions(memoryBytes: number): number {
  if (!Number.isFinite(memoryBytes) || memoryBytes <= 0) return 64;
  return Math.min(
    10_000,
    Math.max(
      MIN_DEFAULT_BROWSER_SESSIONS,
      Math.floor((memoryBytes * BROWSER_MEMORY_SHARE) / PLANNED_BROWSER_MEMORY_BYTES),
    ),
  );
}

/**
 * Physical memory, or the tightest memory limit of this process's cgroup and
 * its ancestors when that is lower. A browser controller started inside a
 * service or container cgroup is bound by every limit above it, not just the
 * one at the cgroup mount root.
 */
export function machineMemoryBytes(
  physicalBytes: number = totalmem(),
  readLimit: (path: string) => string = (path) => readFileSync(path, "utf8"),
): number {
  let lowest = physicalBytes;
  const consider = (path: string) => {
    try {
      const value = readLimit(path).trim();
      // "max" (cgroup v2) means unlimited.
      if (!/^[0-9]+$/u.test(value)) return;
      const limit = Number(value);
      // cgroup v1 reports "unlimited" as a huge sentinel, past the safe range.
      if (Number.isSafeInteger(limit) && limit > 0 && limit < lowest) lowest = limit;
    } catch {
      // No limit file at this level.
    }
  };
  let membership = "";
  try {
    membership = readLimit("/proc/self/cgroup");
  } catch {
    // Not Linux, or /proc is unavailable: only the mount roots apply.
  }
  for (const line of membership.split("\n")) {
    const match = /^[0-9]+:([^:]*):(.*)$/u.exec(line.trim());
    if (!match) continue;
    const [, controllers, path] = match as unknown as [string, string, string];
    if (controllers === "") {
      for (const directory of cgroupAncestors("/sys/fs/cgroup", path)) {
        consider(`${directory}/memory.max`);
      }
    } else if (controllers.split(",").includes("memory")) {
      for (const directory of cgroupAncestors("/sys/fs/cgroup/memory", path)) {
        consider(`${directory}/memory.limit_in_bytes`);
      }
    }
  }
  consider("/sys/fs/cgroup/memory.max");
  consider("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  return lowest;
}

/** A cgroup's directory and each parent's, innermost first, under its mount. */
function cgroupAncestors(mount: string, path: string): string[] {
  const segments = path
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..");
  const directories: string[] = [];
  for (let depth = segments.length; depth > 0; depth -= 1) {
    directories.push(`${mount}/${segments.slice(0, depth).join("/")}`);
  }
  return directories;
}

function environmentInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${name} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is outside its supported range`);
  }
  return parsed;
}

function commaSeparated(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length > 100 || new Set(entries).size !== entries.length) {
    throw new Error("OPENGENI_BROWSERD_ALLOWED_ORIGINS is invalid");
  }
  return entries;
}

/**
 * Resolves on SIGINT/SIGTERM and, with `stdinLifeline`, when stdin reaches EOF.
 * A supervising parent that keeps the write end of stdin open (and never
 * writes) gives browserd a lifeline the kernel closes however the parent ends,
 * including SIGKILL or a crash. Without it a controller in its own process
 * group outlives its parent indefinitely, holding its port and state root
 * while the parent's successor starts another controller beside it. Shutdown is
 * the same graceful drain either way, which leaves retained browsers running.
 */
async function waitForShutdownSignal(stdinLifeline: boolean): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      if (stdinLifeline) {
        process.stdin.off("end", shutdown);
        process.stdin.off("close", shutdown);
        process.stdin.off("error", shutdown);
        process.stdin.off("data", discard);
        process.stdin.destroy();
      }
      resolveShutdown();
    };
    const discard = () => {};
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    if (stdinLifeline) {
      process.stdin.once("end", shutdown);
      process.stdin.once("close", shutdown);
      process.stdin.once("error", shutdown);
      process.stdin.on("data", discard);
    }
  });
}

if (import.meta.main) {
  void runBrowserd().catch((error: unknown) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
    process.stderr.write(`opengeni-browserd failed: ${boundedDiagnostic(message, 4_096)}\n`);
    process.exitCode = 1;
  });
}

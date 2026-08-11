import { constants } from "node:fs";
import { access, lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { BROWSER_CONTROL_PORT } from "@opengeni/contracts";
import { BROWSER_CONTROL_PROTOCOL_VERSION } from "./protocol";
import { resolvePinnedAgentBrowserBinary } from "./binary";
import { resolvePinnedLightpandaBinary } from "./lightpanda-binary";
import {
  ExistingComputerEnvironmentAllocator,
  LinuxVirtualComputerEnvironmentAllocator,
} from "./computer-environment";
import { ComputerSupervisor } from "./computer-supervisor";
import { BrowserControlServer } from "./server";
import { BrowserSupervisor } from "./supervisor";

export async function runBrowserd(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = await browserdConfig(environment);
  const agentBrowserBinary = config.agentBrowserBinaryPath
    ? await resolvePinnedAgentBrowserBinary({ binaryPath: config.agentBrowserBinaryPath })
    : undefined;
  const lightpandaBinary = config.lightpandaBinaryPath
    ? await resolvePinnedLightpandaBinary({ binaryPath: config.lightpandaBinaryPath })
    : undefined;
  const computerNativeBinaryPath = config.computerNativeBinaryPath
    ? await resolveExecutable(config.computerNativeBinaryPath, "computer native helper")
    : undefined;
  const supervisor = await BrowserSupervisor.open({
    rootDirectory: config.rootDirectory,
    ...(config.socketRootDirectory ? { socketRootDirectory: config.socketRootDirectory } : {}),
    maxSessions: config.maxSessions,
    ...(agentBrowserBinary ? { agentBrowserBinary } : {}),
    ...(lightpandaBinary ? { lightpandaBinary } : {}),
  });
  let computerSupervisor: ComputerSupervisor | undefined;
  try {
    if (computerNativeBinaryPath) {
      computerSupervisor = await ComputerSupervisor.open({
        rootDirectory: config.rootDirectory,
        nativeBinaryPath: computerNativeBinaryPath,
        maxSessions: config.maxComputerSessions,
        environmentAllocator:
          config.computerEnvironmentMode === "isolated_linux"
            ? new LinuxVirtualComputerEnvironmentAllocator()
            : new ExistingComputerEnvironmentAllocator(),
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
      onUnexpectedError: reportUnexpectedControllerError,
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
      computer: computerSupervisor !== undefined,
      hostname: server.hostname,
      port: server.port,
    })}\n`,
  );
  await waitForShutdownSignal();
  await server.stop();
}

function reportUnexpectedControllerError(
  error: unknown,
  context: { method: string; pathname: string },
): void {
  const value =
    error instanceof Error
      ? {
          name: boundedDiagnostic(error.name, 256),
          message: boundedDiagnostic(error.message, 4_096),
          stack: boundedDiagnostic(error.stack ?? "", 16_384),
        }
      : { name: "UnknownError", message: "non-Error controller failure", stack: "" };
  process.stderr.write(
    `${JSON.stringify({
      service: "opengeni-browserd",
      event: "unexpected_request_error",
      method: context.method,
      pathname: context.pathname,
      error: value,
    })}\n`,
  );
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
  computerNativeBinaryPath?: string;
  maxComputerSessions: number;
  computerEnvironmentMode: "existing" | "isolated_linux";
};

async function browserdConfig(environment: NodeJS.ProcessEnv): Promise<BrowserdConfig> {
  const rootDirectory = resolve(requiredEnvironment(environment, "OPENGENI_BROWSERD_ROOT"));
  const tokenFile = resolve(requiredEnvironment(environment, "OPENGENI_BROWSERD_ADMIN_TOKEN_FILE"));
  return {
    rootDirectory,
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
      64,
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
    computerEnvironmentMode: computerEnvironmentMode(
      environment.OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE,
    ),
    allowedOrigins: commaSeparated(environment.OPENGENI_BROWSERD_ALLOWED_ORIGINS),
    ...(environment.OPENGENI_BROWSERD_BROWSER_EXECUTABLE
      ? { browserExecutablePath: resolve(environment.OPENGENI_BROWSERD_BROWSER_EXECUTABLE) }
      : {}),
    ...(environment.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
      ? { agentBrowserBinaryPath: resolve(environment.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY) }
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

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    const shutdown = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      resolveShutdown();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

if (import.meta.main) {
  void runBrowserd().catch(() => {
    process.stderr.write("opengeni-browserd failed\n");
    process.exitCode = 1;
  });
}

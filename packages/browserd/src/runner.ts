import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { resolvePinnedAgentBrowserBinary, type ResolvedAgentBrowserBinary } from "./binary";

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 10 * 60_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 4 * 1024 * 1024;
const DAEMON_STOP_TIMEOUT_MS = 3_000;
const PROCESS_QUERY_TIMEOUT_MS = 2_000;
const MAX_PROCESS_QUERY_BYTES = 8 * 1024;

export type AgentBrowserEnvelope<T = unknown> = {
  success: boolean;
  data: T | null;
  error: string | null;
};

export class AgentBrowserCommandError extends Error {
  constructor(
    readonly code:
      | "invalid_response"
      | "driver_rejected"
      | "process_failed"
      | "timeout"
      | "aborted",
    message: string,
    readonly driverMessage: string | null = null,
  ) {
    super(message);
    this.name = "AgentBrowserCommandError";
  }
}

export type AgentBrowserRunOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type AgentBrowserJsonCommand = <T = unknown>(
  args: readonly string[],
  options?: AgentBrowserRunOptions,
) => Promise<T>;

export type AgentBrowserRunnerOptions = {
  namespace: string;
  sessionName: string;
  socketDirectory: string;
  profileDirectory: string;
  downloadDirectory: string;
  screenshotDirectory: string;
  headed: boolean;
  browserExecutablePath?: string;
  workingDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  binary?: ResolvedAgentBrowserBinary;
};

export type BrowserProfileCryptoPolicy =
  | "chromium_basic"
  | "chromium_mock_keychain"
  | "platform_bound";

export function browserProfileCryptoPolicy(platform: NodeJS.Platform): BrowserProfileCryptoPolicy {
  if (platform === "linux") return "chromium_basic";
  if (platform === "darwin") return "chromium_mock_keychain";
  return "platform_bound";
}

export class AgentBrowserJsonRunner {
  readonly binary: ResolvedAgentBrowserBinary;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly workingDirectory: string;
  private readonly daemonPidFile: string;

  private constructor(binary: ResolvedAgentBrowserBinary, options: AgentBrowserRunnerOptions) {
    this.binary = binary;
    this.workingDirectory = resolve(options.workingDirectory ?? process.cwd());
    this.environment = isolatedEnvironment(options);
    this.daemonPidFile = join(
      resolve(options.socketDirectory),
      "namespaces",
      options.namespace,
      "run",
      `${options.sessionName}.pid`,
    );
  }

  static async create(options: AgentBrowserRunnerOptions): Promise<AgentBrowserJsonRunner> {
    validateSegment(options.namespace, "namespace");
    validateSegment(options.sessionName, "session name");
    validateSocketPath(options);
    for (const directory of [
      options.socketDirectory,
      options.profileDirectory,
      options.downloadDirectory,
      options.screenshotDirectory,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    const binary = options.binary ?? (await resolvePinnedAgentBrowserBinary());
    return new AgentBrowserJsonRunner(binary, options);
  }

  async run<T = unknown>(
    args: readonly string[],
    options: AgentBrowserRunOptions = {},
  ): Promise<T> {
    validateArguments(args);
    const timeoutMs = boundedTimeout(options.timeoutMs);
    if (options.signal?.aborted) {
      throw new AgentBrowserCommandError("aborted", "agent-browser command was aborted");
    }
    const child = spawn(this.binary.path, ["--json", ...args], {
      cwd: this.workingDirectory,
      env: this.environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow: "stdout" | "stderr" | null = null;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_STDOUT_BYTES) stdout.push(chunk);
      else {
        overflow = "stdout";
        interrupt?.(
          new AgentBrowserCommandError(
            "process_failed",
            "agent-browser stdout exceeded its bounded transport envelope",
          ),
        );
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
      else {
        overflow = "stderr";
        interrupt?.(
          new AgentBrowserCommandError(
            "process_failed",
            "agent-browser stderr exceeded its bounded transport envelope",
          ),
        );
      }
    });

    let interrupt: ((error: AgentBrowserCommandError) => void) | null = null;
    const interrupted = new Promise<never>((_resolve, reject) => {
      interrupt = (error) => {
        if (interrupt === null) return;
        interrupt = null;
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        reject(error);
      };
    });
    const timer = setTimeout(
      () => interrupt?.(new AgentBrowserCommandError("timeout", "agent-browser command timed out")),
      timeoutMs,
    );
    timer.unref?.();
    const abort = () => {
      interrupt?.(new AgentBrowserCommandError("aborted", "agent-browser command was aborted"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const exit = await Promise.race([
      new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolveExit, reject) => {
        child.once("error", (error) => {
          reject(
            new AgentBrowserCommandError(
              "process_failed",
              "agent-browser process could not start",
              (error as NodeJS.ErrnoException).code ?? null,
            ),
          );
        });
        child.once("close", (code, signal) => resolveExit({ code, signal }));
      }),
      interrupted,
    ]).finally(() => {
      interrupt = null;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    });
    if (overflow) {
      throw new AgentBrowserCommandError(
        "process_failed",
        `agent-browser ${overflow} exceeded its bounded transport envelope`,
      );
    }
    const output = Buffer.concat(stdout).toString("utf8").trim();
    let envelope: AgentBrowserEnvelope<T>;
    try {
      envelope = parseEnvelope<T>(output);
    } catch (error) {
      if (exit.code !== 0 || exit.signal !== null) {
        throw new AgentBrowserCommandError("process_failed", "agent-browser process failed");
      }
      throw error;
    }
    if (!envelope.success) {
      throw new AgentBrowserCommandError(
        "driver_rejected",
        "agent-browser rejected the command",
        boundedDriverMessage(envelope.error),
      );
    }
    if (exit.code !== 0 || exit.signal !== null) {
      throw new AgentBrowserCommandError("process_failed", "agent-browser process failed");
    }
    return envelope.data as T;
  }

  /** Stop only the daemon whose private PID sidecar resolves to this exact
   * pinned executable. Used when upstream `close` cannot reconcile a failed
   * browser launch; never scans or kills by name. */
  async terminate(): Promise<void> {
    const pid = await readDaemonPid(this.daemonPidFile);
    if (pid === null || !(await processRunning(pid))) {
      await rm(this.daemonPidFile, { force: true });
      return;
    }
    if (!(await sameExecutable(pid, this.binary.path))) {
      throw new AgentBrowserCommandError(
        "process_failed",
        "agent-browser daemon PID does not identify the pinned executable",
      );
    }
    signalProcess(pid, "SIGTERM");
    if (!(await waitForProcessStop(pid, DAEMON_STOP_TIMEOUT_MS))) {
      if (!(await sameExecutable(pid, this.binary.path))) {
        throw new AgentBrowserCommandError(
          "process_failed",
          "agent-browser daemon identity changed before forced termination",
        );
      }
      signalProcess(pid, "SIGKILL");
      if (!(await waitForProcessStop(pid, DAEMON_STOP_TIMEOUT_MS))) {
        throw new AgentBrowserCommandError(
          "process_failed",
          "agent-browser daemon did not terminate",
        );
      }
    }
    await rm(this.daemonPidFile, { force: true });
  }
}

async function readDaemonPid(path: string): Promise<number | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 16) {
    throw new AgentBrowserCommandError(
      "process_failed",
      "agent-browser daemon PID file is invalid",
    );
  }
  const raw = (await readFile(path, "utf8")).trim();
  if (!/^[1-9][0-9]{0,9}$/u.test(raw)) {
    throw new AgentBrowserCommandError("process_failed", "agent-browser daemon PID is invalid");
  }
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid < 2 || pid > 2_147_483_647) {
    throw new AgentBrowserCommandError("process_failed", "agent-browser daemon PID is invalid");
  }
  return pid;
}

async function sameExecutable(pid: number, expectedPath: string): Promise<boolean> {
  const expected = await realpath(expectedPath);
  if (process.platform === "linux") {
    try {
      return (await realpath(await readlink(`/proc/${pid}/exe`))) === expected;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  if (process.platform === "darwin") {
    const command = (
      await boundedProcessOutput("/bin/ps", ["-p", String(pid), "-o", "comm="])
    ).trim();
    if (!command) return false;
    try {
      return (await realpath(command)) === expected;
    } catch {
      return false;
    }
  }
  if (process.platform === "win32") {
    const output = await boundedProcessOutput("tasklist.exe", [
      "/FI",
      `PID eq ${pid}`,
      "/FO",
      "CSV",
      "/NH",
    ]);
    return output
      .toLocaleLowerCase("en-US")
      .includes(`"${basename(expected).toLocaleLowerCase("en-US")}"`);
  }
  return false;
}

async function processRunning(pid: number): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      return commandEnd >= 0 && stat.slice(commandEnd + 2, commandEnd + 3) !== "Z";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessStop(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await processRunning(pid))) return true;
    await new Promise((done) => setTimeout(done, 25));
  } while (Date.now() < deadline);
  return !(await processRunning(pid));
}

async function boundedProcessOutput(command: string, args: readonly string[]): Promise<string> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes <= MAX_PROCESS_QUERY_BYTES) chunks.push(chunk);
    else {
      overflow = true;
      child.kill("SIGKILL");
    }
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), PROCESS_QUERY_TIMEOUT_MS);
  timer.unref?.();
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  }).finally(() => clearTimeout(timer));
  if (overflow || code !== 0) return "";
  return Buffer.concat(chunks).toString("utf8");
}

function isolatedEnvironment(options: AgentBrowserRunnerOptions): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  Object.assign(environment, options.environment);
  for (const key of Object.keys(environment)) {
    if (key.startsWith("AGENT_BROWSER_")) delete environment[key];
  }
  Object.assign(environment, {
    AGENT_BROWSER_NAMESPACE: options.namespace,
    AGENT_BROWSER_SESSION: options.sessionName,
    AGENT_BROWSER_SOCKET_DIR: resolve(options.socketDirectory),
    AGENT_BROWSER_PROFILE: resolve(options.profileDirectory),
    AGENT_BROWSER_DOWNLOAD_PATH: resolve(options.downloadDirectory),
    AGENT_BROWSER_SCREENSHOT_DIR: resolve(options.screenshotDirectory),
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
    AGENT_BROWSER_HEADED: options.headed ? "1" : "0",
    AGENT_BROWSER_ARGS: browserLaunchArguments(process.platform),
    NO_COLOR: "1",
  });
  if (options.browserExecutablePath) {
    environment.AGENT_BROWSER_EXECUTABLE_PATH = resolve(options.browserExecutablePath);
  }
  return environment;
}

export function browserLaunchArguments(platform: NodeJS.Platform): string {
  const policy = browserProfileCryptoPolicy(platform);
  const profileCryptoArgument =
    policy === "chromium_basic"
      ? "--password-store=basic"
      : policy === "chromium_mock_keychain"
        ? "--use-mock-keychain"
        : null;
  return ["--restore-last-session", profileCryptoArgument]
    .filter((value): value is string => value !== null)
    .join(",");
}

const PASSTHROUGH_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SYSTEMROOT",
  "COMSPEC",
] as const;

function validateSocketPath(options: AgentBrowserRunnerOptions): void {
  if (process.platform === "win32") return;
  const projected = join(
    resolve(options.socketDirectory),
    "namespaces",
    options.namespace,
    "run",
    `agent-browser-${options.sessionName}.sock`,
  );
  if (Buffer.byteLength(projected) > 100) {
    throw new Error("agent-browser socket directory and identifiers exceed the Unix socket limit");
  }
}

function parseEnvelope<T>(output: string): AgentBrowserEnvelope<T> {
  const line = output
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .at(-1);
  if (!line)
    throw new AgentBrowserCommandError("invalid_response", "agent-browser returned no JSON");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new AgentBrowserCommandError("invalid_response", "agent-browser returned invalid JSON");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { success?: unknown }).success !== "boolean"
  ) {
    throw new AgentBrowserCommandError(
      "invalid_response",
      "agent-browser returned an invalid response envelope",
    );
  }
  const candidate = value as {
    success: boolean;
    data?: unknown;
    error?: unknown;
  };
  return {
    success: candidate.success,
    data: (candidate.data ?? null) as T | null,
    error: typeof candidate.error === "string" ? candidate.error : null,
  };
}

function validateSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw new Error(`agent-browser ${label} must be a bounded safe identifier`);
  }
}

function validateArguments(args: readonly string[]): void {
  if (args.length === 0 || args.length > MAX_ARGUMENTS) {
    throw new Error("agent-browser command has an invalid argument count");
  }
  const bytes = args.reduce((total, argument) => total + Buffer.byteLength(argument), 0);
  if (bytes > MAX_ARGUMENT_BYTES || args.some((argument) => argument.includes("\0"))) {
    throw new Error("agent-browser command exceeds its bounded argument envelope");
  }
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_COMMAND_TIMEOUT_MS) {
    throw new Error("agent-browser timeout must be a positive bounded integer");
  }
  return timeout;
}

function boundedDriverMessage(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/[\r\n\t]+/gu, " ").trim();
  return normalized.slice(0, 2_048) || null;
}

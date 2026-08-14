import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readlink, realpath, rm } from "node:fs/promises";
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
  /** macOS lifecycle-preserving background launcher. Defaults to the packaged
   * native helper discovered by browserd's parent agent. */
  browserLaunchHelperPath?: string;
  workingDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  provider?: {
    id: "browserbase" | "kernel";
    apiKey: string;
    endpoint?: string;
    timeoutSeconds?: number;
    stealth?: boolean;
  };
  /** Private launch authority. It is injected into the daemon environment,
   * never into argv, logs, or durable browser metadata. */
  proxyUrl?: string;
  launchArguments?: readonly string[];
  timezone?: string;
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
  private readonly globalArguments: readonly string[];
  private readonly workingDirectory: string;
  private readonly daemonPidFile: string;

  private constructor(binary: ResolvedAgentBrowserBinary, options: AgentBrowserRunnerOptions) {
    this.binary = binary;
    this.workingDirectory = resolve(options.workingDirectory ?? process.cwd());
    const proxy = options.proxyUrl ? privateProxyAuthority(options.proxyUrl) : null;
    this.environment = isolatedEnvironment(options, proxy);
    this.globalArguments = [
      ...(proxy ? ["--proxy", proxy.server] : []),
      ...(options.provider ? ["--provider", options.provider.id] : []),
    ];
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
    assertAgentBrowserSocketPath(options);
    for (const directory of [
      options.socketDirectory,
      options.profileDirectory,
      options.downloadDirectory,
      options.screenshotDirectory,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    const browserLaunch = await managedBrowserLaunch(options);
    const binary = options.binary ?? (await resolvePinnedAgentBrowserBinary());
    return new AgentBrowserJsonRunner(binary, {
      ...options,
      ...(browserLaunch
        ? {
            browserExecutablePath: browserLaunch.executablePath,
            environment: {
              ...options.environment,
              ...(browserLaunch.backgroundBrowserExecutable
                ? {
                    OPENGENI_BACKGROUND_BROWSER_EXECUTABLE:
                      browserLaunch.backgroundBrowserExecutable,
                  }
                : {}),
            },
          }
        : {}),
    });
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
    const child = spawn(this.binary.path, ["--json", ...this.globalArguments, ...args], {
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
  async daemonPid(): Promise<number | null> {
    const pid = await readDaemonPid(this.daemonPidFile);
    if (pid === null || !(await processRunning(pid))) return null;
    if (!(await sameExecutable(pid, this.binary.path))) {
      throw new AgentBrowserCommandError(
        "process_failed",
        "agent-browser daemon PID does not identify the pinned executable",
      );
    }
    return pid;
  }

  async terminate(expectedPid?: number | null): Promise<void> {
    const recordedPid = await readDaemonPid(this.daemonPidFile);
    if (recordedPid !== null && expectedPid != null && recordedPid !== expectedPid) {
      throw new AgentBrowserCommandError(
        "process_failed",
        "agent-browser daemon identity changed during shutdown",
      );
    }
    const pid = recordedPid ?? expectedPid ?? null;
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

const MACOS_BROWSER_EXECUTABLES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] as const;

async function managedBrowserLaunch(
  options: AgentBrowserRunnerOptions,
): Promise<{ executablePath: string; backgroundBrowserExecutable?: string } | undefined> {
  const configured = options.browserExecutablePath
    ? resolve(options.browserExecutablePath)
    : undefined;
  if (process.platform !== "darwin" || !options.headed || options.provider) {
    return configured ? { executablePath: configured } : undefined;
  }

  const executable = configured ?? (await firstExecutable(MACOS_BROWSER_EXECUTABLES));
  if (!executable) return undefined;
  const helper = options.browserLaunchHelperPath
    ? resolve(options.browserLaunchHelperPath)
    : process.env.OPENGENI_BROWSERD_COMPUTER_NATIVE_BINARY
      ? resolve(process.env.OPENGENI_BROWSERD_COMPUTER_NATIVE_BINARY)
      : undefined;
  if (!helper) return { executablePath: executable };
  await access(helper, constants.X_OK);
  // The packaged helper stays alive for Chrome's full lifetime while using a
  // non-activating LaunchServices launch. This preserves agent-browser's
  // DevToolsActivePort/child-process handshake and keeps the window capturable.
  return {
    executablePath: helper,
    backgroundBrowserExecutable: executable,
  };
}

async function firstExecutable(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return resolve(candidate);
    } catch {
      // Continue to the next known Chrome/Chromium application.
    }
  }
  return undefined;
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
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
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

function isolatedEnvironment(
  options: AgentBrowserRunnerOptions,
  proxy: PrivateProxyAuthority | null,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  Object.assign(environment, options.environment);
  for (const key of Object.keys(environment)) {
    if (key.startsWith("AGENT_BROWSER_")) delete environment[key];
  }
  for (const key of [
    "BROWSERBASE_API_KEY",
    "KERNEL_API_KEY",
    "KERNEL_ENDPOINT",
    "KERNEL_HEADLESS",
    "KERNEL_STEALTH",
    "KERNEL_TIMEOUT_SECONDS",
    "KERNEL_PROFILE_NAME",
  ]) {
    delete environment[key];
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
    AGENT_BROWSER_ARGS: browserLaunchArguments(process.platform, options.launchArguments),
    NO_COLOR: "1",
  });
  if (proxy) {
    environment.AGENT_BROWSER_PROXY = proxy.server;
    if (proxy.username !== null && proxy.password !== null) {
      environment.AGENT_BROWSER_PROXY_USERNAME = proxy.username;
      environment.AGENT_BROWSER_PROXY_PASSWORD = proxy.password;
    }
  }
  if (options.timezone) environment.TZ = supportedTimezone(options.timezone);
  if (options.provider?.id === "browserbase") {
    environment.BROWSERBASE_API_KEY = providerCredential(options.provider.apiKey);
  } else if (options.provider?.id === "kernel") {
    environment.KERNEL_API_KEY = providerCredential(options.provider.apiKey);
    environment.KERNEL_HEADLESS = options.headed ? "false" : "true";
    environment.KERNEL_STEALTH = options.provider.stealth === true ? "true" : "false";
    if (options.provider.timeoutSeconds !== undefined) {
      if (
        !Number.isSafeInteger(options.provider.timeoutSeconds) ||
        options.provider.timeoutSeconds < 1 ||
        options.provider.timeoutSeconds > 86_400
      ) {
        throw new Error("Kernel browser timeout is invalid");
      }
      environment.KERNEL_TIMEOUT_SECONDS = String(options.provider.timeoutSeconds);
    }
    if (options.provider.endpoint) {
      environment.KERNEL_ENDPOINT = providerEndpoint(options.provider.endpoint);
    }
  }
  if (options.browserExecutablePath) {
    environment.AGENT_BROWSER_EXECUTABLE_PATH = resolve(options.browserExecutablePath);
  }
  return environment;
}

function providerCredential(value: string): string {
  if (
    Buffer.byteLength(value) < 1 ||
    Buffer.byteLength(value) > 8_192 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("external browser provider credential is invalid");
  }
  return value;
}

function providerEndpoint(value: string): string {
  if (Buffer.byteLength(value) > 16_384) {
    throw new Error("external browser provider endpoint is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("external browser provider endpoint is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error("external browser provider endpoint is invalid");
  }
  return parsed.toString().replace(/\/$/u, "");
}

type PrivateProxyAuthority = {
  server: string;
  username: string | null;
  password: string | null;
};

function privateProxyAuthority(value: string): PrivateProxyAuthority {
  if (Buffer.byteLength(value) > 16_384) throw new Error("proxy authority exceeds its envelope");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("proxy authority URL is invalid");
  }
  if (
    !["http:", "https:", "socks5:"].includes(url.protocol) ||
    !url.hostname ||
    (!url.port && url.protocol !== "http:" && url.protocol !== "https:") ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error("proxy authority URL is invalid");
  }
  const hasUsername = url.username.length > 0;
  const hasPassword = url.password.length > 0;
  if (hasUsername !== hasPassword) {
    throw new Error("proxy authority credentials are incomplete");
  }
  const username = hasUsername ? decodeUrlCredential(url.username) : null;
  const password = hasPassword ? decodeUrlCredential(url.password) : null;
  if (username?.includes("\0") || password?.includes("\0")) {
    throw new Error("proxy authority credentials are invalid");
  }
  const server = `${url.protocol}//${url.host}`;
  return { server, username, password };
}

function decodeUrlCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("proxy authority credentials are invalid");
  }
}

function supportedTimezone(value: string): string {
  if (Buffer.byteLength(value) > 128 || /[,\r\n\0]/u.test(value)) {
    throw new Error("browser timezone is invalid");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new Error("browser timezone is unsupported");
  }
  return value;
}

export function browserLaunchArguments(
  platform: NodeJS.Platform,
  additional: readonly string[] = [],
): string {
  const policy = browserProfileCryptoPolicy(platform);
  const profileCryptoArgument =
    policy === "chromium_basic"
      ? "--password-store=basic"
      : policy === "chromium_mock_keychain"
        ? "--use-mock-keychain"
        : null;
  const validatedAdditional = additional.map((argument) => {
    if (!argument.startsWith("--") || argument.length > 512 || /[,\r\n\0]/u.test(argument)) {
      throw new Error("browser launch argument is invalid");
    }
    return argument;
  });
  if (validatedAdditional.length > 32) {
    throw new Error("too many browser launch arguments");
  }
  return [
    "--restore-last-session",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    profileCryptoArgument,
    ...validatedAdditional,
  ]
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

export function assertAgentBrowserSocketPath(
  options: Pick<AgentBrowserRunnerOptions, "namespace" | "sessionName" | "socketDirectory">,
): void {
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

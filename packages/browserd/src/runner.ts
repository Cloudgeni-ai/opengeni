import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { resolvePinnedAgentBrowserBinary, type ResolvedAgentBrowserBinary } from "./binary";
import {
  readLinuxManagedBrowserIdentity,
  type LinuxManagedBrowserIdentity,
} from "./linux-process-identity";

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 10 * 60_000;
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_ARGUMENTS = 256;
const MAX_ARGUMENT_BYTES = 4 * 1024 * 1024;
const DAEMON_STOP_TIMEOUT_MS = 3_000;
const PROCESS_QUERY_TIMEOUT_MS = 2_000;
const MAX_PROCESS_QUERY_BYTES = 8 * 1024;
const CHROME_STDERR_DIAGNOSTIC_BYTES = 64 * 1024;

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
  /** Private completed launch receipt, checked again before attaching/launching. */
  recoverOwnedProcess?: OwnedManagedBrowserProcess;
  allowOwnedProcessLaunch?: boolean;
};

export type OwnedManagedBrowserProcess = {
  pid: number;
  birth: string;
  executablePath: string;
  profileDirectory: string;
  cdpEndpoint: string;
};

type OwnedAgentBrowserDaemon = {
  pid: number;
  birth: string;
  executablePath: string;
  pidFile: string;
  pidFileIdentity: { device: number; inode: number };
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
  private readonly browserPidFile: string;
  private readonly profileDirectory: string;
  private readonly managedBrowserExecutable: string | null;
  private readonly chromeStderrDrainPaths: readonly string[];
  private readonly recoveredProcess: OwnedManagedBrowserProcess | null;
  private readonly headlessManaged: boolean;
  private readonly daemonRunDirectory: string;
  private predecessorDaemon: OwnedAgentBrowserDaemon | null = null;
  private recoveredBrowserClosed = false;

  private constructor(
    binary: ResolvedAgentBrowserBinary,
    options: AgentBrowserRunnerOptions,
    browserLaunch?: ManagedBrowserLaunch,
  ) {
    this.binary = binary;
    this.workingDirectory = resolve(options.workingDirectory ?? process.cwd());
    this.profileDirectory = resolve(options.profileDirectory);
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
    this.browserPidFile = join(this.profileDirectory, "..", "browser.pid");
    this.managedBrowserExecutable =
      options.environment?.OPENGENI_BACKGROUND_BROWSER_EXECUTABLE ??
      (browserLaunch && "actualExecutablePath" in browserLaunch
        ? (browserLaunch.actualExecutablePath ?? null)
        : (options.browserExecutablePath ?? null));
    this.chromeStderrDrainPaths = browserLaunch?.cleanupPaths ?? [];
    this.recoveredProcess = options.recoverOwnedProcess ?? null;
    this.headlessManaged = !options.headed && !options.provider;
    this.daemonRunDirectory = dirname(this.daemonPidFile);
  }

  static async create(options: AgentBrowserRunnerOptions): Promise<AgentBrowserJsonRunner> {
    validateSegment(options.namespace, "namespace");
    validateSegment(options.sessionName, "session name");
    assertAgentBrowserSocketPath(options);
    if (options.recoverOwnedProcess) {
      const state = await inspectOwnedManagedBrowserProcess(options.recoverOwnedProcess);
      if (state === "live") {
        const binary = options.binary ?? (await resolvePinnedAgentBrowserBinary());
        const runner = new AgentBrowserJsonRunner(binary, options);
        if (!runner.headlessManaged) throw daemonLineageUnavailable();
        runner.predecessorDaemon = await runner.headlessDaemonIdentity(options.recoverOwnedProcess);
        return runner;
      }
      // A positively exited process permits a new launch only in this exact
      // directory. No missing-memory/PID-file inference or pre-launch kill.
      if (state !== "exited" || options.allowOwnedProcessLaunch !== true)
        throw new AgentBrowserCommandError("process_failed", "owned browser outcome is unknown");
      await assertNoLiveDaemonRecords(options.socketDirectory, options.namespace);
    }
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
    const browserLaunch = await managedBrowserLaunch(options);
    const browserPidFile = join(resolve(options.profileDirectory), "..", "browser.pid");
    if (browserLaunch?.backgroundBrowserExecutable && !options.recoverOwnedProcess) {
      await terminateManagedBrowser({
        pidFile: browserPidFile,
        profileDirectory: resolve(options.profileDirectory),
        executablePath: browserLaunch.backgroundBrowserExecutable,
      });
    }
    const { recoverOwnedProcess: _recoverOwnedProcess, ...launchOptions } = options;
    return new AgentBrowserJsonRunner(
      binary,
      {
        ...launchOptions,
        ...(browserLaunch
          ? {
              browserExecutablePath: browserLaunch.executablePath,
              environment: {
                ...options.environment,
                ...(browserLaunch.backgroundBrowserExecutable
                  ? {
                      OPENGENI_BACKGROUND_BROWSER_EXECUTABLE:
                        browserLaunch.backgroundBrowserExecutable,
                      OPENGENI_BACKGROUND_BROWSER_PID_FILE: browserPidFile,
                    }
                  : {}),
              },
            }
          : {}),
      },
      browserLaunch,
    );
  }

  async run<T = unknown>(
    args: readonly string[],
    options: AgentBrowserRunOptions = {},
  ): Promise<T> {
    if (this.recoveredProcess) {
      if (args.length === 2 && args[0] === "get" && args[1] === "cdp-url") {
        if ((await inspectOwnedManagedBrowserProcess(this.recoveredProcess)) !== "live") {
          throw new AgentBrowserCommandError("process_failed", "owned browser is unavailable");
        }
        return { cdpUrl: this.recoveredProcess.cdpEndpoint } as T;
      }
      if (args.length === 1 && args[0] === "close") return {} as T;
      throw new AgentBrowserCommandError(
        "driver_rejected",
        "reattached browser accepts only its CDP transport",
      );
    }
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
    if (this.recoveredProcess) {
      const daemon = this.predecessorDaemon;
      if (!daemon) throw daemonLineageUnavailable();
      return (await assertDaemonIdentity(daemon)) ? daemon.pid : null;
    }
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
    if (this.recoveredProcess) {
      const daemon = this.predecessorDaemon;
      if (!daemon || (expectedPid != null && expectedPid !== daemon.pid))
        throw daemonLineageUnavailable();
      const daemonLive = await assertDaemonIdentity(daemon);
      if (!this.recoveredBrowserClosed) {
        if (daemonLive && (await processParentPid(this.recoveredProcess.pid)) !== daemon.pid)
          throw daemonLineageUnavailable();
        await terminateOwnedManagedBrowserProcess(this.recoveredProcess);
        // Preserve a proved stop for the same cleanup retry; a missing macOS
        // PID still cannot authorize a fresh exact-directory launch.
        this.recoveredBrowserClosed = true;
      }
      await terminateOwnedAgentBrowserDaemon(daemon);
      await this.cleanupChromeStderrDrain();
      return;
    }
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
      await this.terminateManagedBrowser();
      await this.cleanupChromeStderrDrain();
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
    await this.terminateManagedBrowser();
    await this.cleanupChromeStderrDrain();
  }

  private async terminateManagedBrowser(): Promise<void> {
    if (this.recoveredProcess) {
      await terminateOwnedManagedBrowserProcess(this.recoveredProcess);
      return;
    }
    await terminateManagedBrowser({
      pidFile: this.browserPidFile,
      profileDirectory: this.profileDirectory,
      executablePath: this.managedBrowserExecutable,
      discoverByProfile: this.chromeStderrDrainPaths.length > 0,
    });
  }

  async ownedProcessIdentity(
    cdpEndpoint: string,
    cdpBrowserPid?: number,
  ): Promise<OwnedManagedBrowserProcess | null> {
    if (this.recoveredProcess) {
      return (await inspectOwnedManagedBrowserProcess(this.recoveredProcess)) === "live"
        ? this.recoveredProcess
        : null;
    }
    if (process.platform !== "linux" && process.platform !== "darwin") return null;
    const recordedPid = await readManagedBrowserPid(this.browserPidFile);
    const discovered =
      recordedPid === null && process.platform === "linux"
        ? await findLinuxManagedBrowserProcess(this.profileDirectory, this.managedBrowserExecutable)
        : null;
    let pid = recordedPid ?? discovered?.pid;
    const needsHeadlessWitness = this.headlessManaged && cdpBrowserPid !== undefined;
    if (!pid && needsHeadlessWitness && process.platform === "darwin")
      pid = await readProfileBrowserPid(this.profileDirectory);
    if (!pid || !(await processRunning(pid))) return null;
    if (cdpBrowserPid !== undefined && cdpBrowserPid !== pid) throw daemonLineageUnavailable();
    const executablePath =
      this.managedBrowserExecutable ??
      discovered?.executablePath ??
      (needsHeadlessWitness ? await processExecutablePath(pid) : null);
    if (!executablePath) return null;
    await assertManagedBrowserIdentity(pid, this.profileDirectory, executablePath);
    const receipt = {
      pid,
      birth: await processBirth(pid),
      executablePath: await realpath(executablePath),
      profileDirectory: this.profileDirectory,
      cdpEndpoint,
    };
    if ((await inspectOwnedManagedBrowserProcess(receipt)) !== "live") return null;
    if (needsHeadlessWitness) await this.headlessDaemonIdentity(receipt, this.daemonPidFile);
    return receipt;
  }

  private async headlessDaemonIdentity(
    browser: OwnedManagedBrowserProcess,
    initialPidFile?: string,
  ): Promise<OwnedAgentBrowserDaemon> {
    if (
      !this.headlessManaged ||
      (await readProfileBrowserPid(this.profileDirectory)) !== browser.pid
    )
      throw daemonLineageUnavailable();
    const parentPid = await processParentPid(browser.pid);
    const files = await daemonPidRecords(this.daemonRunDirectory);
    const live: { pid: number; path: string }[] = [];
    for (const path of files) {
      const pid = await readDaemonPid(path);
      if (pid !== null && (await processRunning(pid))) live.push({ pid, path });
    }
    if (
      live.length !== 1 ||
      live[0]!.pid !== parentPid ||
      (initialPidFile !== undefined && live[0]!.path !== initialPidFile) ||
      !(await sameExecutable(parentPid, this.binary.path))
    )
      throw daemonLineageUnavailable();
    const pidFile = live[0]!.path;
    const metadata = await lstat(pidFile);
    const daemon = {
      pid: parentPid,
      birth: await processBirth(parentPid),
      executablePath: await realpath(this.binary.path),
      pidFile,
      pidFileIdentity: { device: metadata.dev, inode: metadata.ino },
    };
    await assertDaemonIdentity(daemon);
    if (
      (await processBirth(browser.pid)) !== browser.birth ||
      (await processParentPid(browser.pid)) !== daemon.pid ||
      (await readProfileBrowserPid(this.profileDirectory)) !== browser.pid
    )
      throw daemonLineageUnavailable();
    return daemon;
  }

  get reattachedOwnedProcess(): OwnedManagedBrowserProcess | null {
    return this.recoveredProcess;
  }

  private async cleanupChromeStderrDrain(): Promise<void> {
    await Promise.all(
      this.chromeStderrDrainPaths.map(async (path) => await rm(path, { force: true })),
    );
  }
}

/** Reap only browser processes bound to an exact private OpenGeni profile.
 * A controller restart never adopts an unfenced native process; active durable
 * sessions are rebuilt on their next causal request. */
export async function reapManagedBrowserProcesses(
  rootDirectory: string,
  preserveSession?: (sessionDirectory: string) => Promise<boolean>,
): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const sessionsDirectory = join(resolve(rootDirectory), "sessions");
  let entries;
  try {
    entries = await readdir(sessionsDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/iu.test(entry.name)) continue;
    const sessionDirectory = join(sessionsDirectory, entry.name);
    if (await preserveSession?.(sessionDirectory)) continue;
    await terminateManagedBrowser({
      pidFile: join(sessionDirectory, "browser.pid"),
      profileDirectory: join(sessionDirectory, "profile"),
      executablePath: null,
      discoverByProfile: true,
    });
    await cleanupStaleChromeLaunchers(join(sessionDirectory, "chrome-launch"));
  }
}

async function cleanupStaleChromeLaunchers(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (/^[0-9a-f-]{36}\.(?:sh|stderr\.fifo)$/iu.test(name)) {
      await rm(join(directory, name), { force: true });
    }
  }
}

const MACOS_BROWSER_EXECUTABLES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] as const;

type ManagedBrowserLaunch = {
  executablePath: string;
  actualExecutablePath?: string | null;
  backgroundBrowserExecutable?: string;
  cleanupPaths?: readonly string[];
};

async function managedBrowserLaunch(
  options: AgentBrowserRunnerOptions,
): Promise<ManagedBrowserLaunch | undefined> {
  const configured = options.browserExecutablePath
    ? resolve(options.browserExecutablePath)
    : undefined;
  if (process.platform === "linux" && !options.provider) {
    const executable = configured ?? (await linuxChromeExecutable());
    if (executable) {
      return await linuxChromeStderrDrainWrapper(options.profileDirectory, executable);
    }
  }
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

/** The pinned agent-browser daemon keeps Chrome's stderr pipe open after
 * DevToolsActivePort appears but does not consume it. A noisy managed Chrome
 * fills that pipe and then stops answering even browser-level CDP requests.
 * Keep Chrome's PID/process group unchanged with shell exec, while a private
 * reader consumes stderr and retains only the last bounded diagnostic bytes. */
async function linuxChromeStderrDrainWrapper(
  profileDirectory: string,
  executable: string,
): Promise<ManagedBrowserLaunch> {
  await access(executable, constants.X_OK);
  const actualExecutablePath = (await isScriptExecutable(executable)) ? null : executable;
  const mkfifo =
    (await firstExecutableInPath(["mkfifo"])) ??
    (await firstExecutable(["/usr/bin/mkfifo", "/bin/mkfifo"]));
  const tail =
    (await firstExecutableInPath(["tail"])) ??
    (await firstExecutable(["/usr/bin/tail", "/bin/tail"]));
  if (!mkfifo || !tail) throw new Error("managed Linux Chrome requires mkfifo and tail");
  const directory = join(dirname(resolve(profileDirectory)), "chrome-launch");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const id = randomUUID();
  const fifo = join(directory, `${id}.stderr.fifo`);
  const log = join(directory, "chrome-stderr.log");
  const wrapper = join(directory, `${id}.sh`);
  try {
    await runProcess(mkfifo, ["-m", "600", fifo]);
    await writeFile(
      wrapper,
      `#!/bin/sh\numask 077\n${shellQuote(tail)} -c ${CHROME_STDERR_DIAGNOSTIC_BYTES} ${shellQuote(fifo)} > ${shellQuote(log)} 2>/dev/null &\nexec ${shellQuote(executable)} "$@" 2>${shellQuote(fifo)}\n`,
      { mode: 0o700, flag: "wx" },
    );
    await chmod(wrapper, 0o700);
    return {
      executablePath: wrapper,
      actualExecutablePath,
      cleanupPaths: [wrapper, fifo],
    };
  } catch (error) {
    await Promise.allSettled([rm(wrapper, { force: true }), rm(fifo, { force: true })]);
    throw error;
  }
}

async function isScriptExecutable(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const prefix = Buffer.alloc(2);
    const { bytesRead } = await file.read(prefix, 0, 2, 0);
    return bytesRead === 2 && prefix[0] === 35 && prefix[1] === 33;
  } finally {
    await file.close();
  }
}

async function linuxChromeExecutable(): Promise<string | undefined> {
  return await firstExecutableInPath([
    "google-chrome",
    "google-chrome-stable",
    "chromium-browser",
    "chromium",
  ]);
}

async function firstExecutableInPath(names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    for (const directory of (process.env.PATH ?? "").split(":")) {
      if (!directory) continue;
      const candidate = join(directory, name);
      try {
        await access(candidate, constants.X_OK);
        return resolve(candidate);
      } catch {
        // Continue to the next installed candidate.
      }
    }
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function runProcess(command: string, args: readonly string[]): Promise<void> {
  const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  if (code !== 0) throw new Error("managed Linux Chrome stderr drain could not start");
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
      if (commandEnd < 0 || !/^[A-Z]$/u.test(stat.slice(commandEnd + 2, commandEnd + 3))) {
        throw new AgentBrowserCommandError("process_failed", "process liveness is unproven");
      }
      return stat.slice(commandEnd + 2, commandEnd + 3) !== "Z";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return false;
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

async function terminateManagedBrowser(input: {
  pidFile: string;
  profileDirectory: string;
  executablePath: string | null;
  discoverByProfile?: boolean;
}): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const recordedPid = await readManagedBrowserPid(input.pidFile);
  const discovered =
    recordedPid === null &&
    process.platform === "linux" &&
    (input.executablePath !== null || input.discoverByProfile === true)
      ? await findLinuxManagedBrowserProcess(input.profileDirectory, input.executablePath)
      : null;
  const pid = recordedPid ?? discovered?.pid ?? null;
  if (pid === null) return;
  if (!(await processRunning(pid))) {
    await rm(input.pidFile, { force: true });
    return;
  }
  const executablePath = input.executablePath ?? discovered?.executablePath ?? null;
  const startTime = await assertManagedBrowserIdentity(
    pid,
    input.profileDirectory,
    executablePath,
    discovered?.startTime,
  );
  signalProcess(pid, "SIGTERM");
  if (!(await waitForProcessStop(pid, DAEMON_STOP_TIMEOUT_MS))) {
    await assertManagedBrowserIdentity(pid, input.profileDirectory, executablePath, startTime);
    signalProcess(pid, "SIGKILL");
    if (!(await waitForProcessStop(pid, DAEMON_STOP_TIMEOUT_MS))) {
      throw new AgentBrowserCommandError("process_failed", "managed browser did not terminate");
    }
  }
  await rm(input.pidFile, { force: true });
}

async function assertManagedBrowserIdentity(
  pid: number,
  profileDirectory: string,
  executablePath: string | null,
  expectedStartTime?: string,
): Promise<string | undefined> {
  if (process.platform === "linux") {
    const identity =
      executablePath === null
        ? null
        : await readLinuxManagedBrowserIdentity({
            pid,
            profileDirectory,
            executablePath,
            ...(expectedStartTime !== undefined ? { expectedStartTime } : {}),
          });
    if (!identity) {
      throw new AgentBrowserCommandError(
        "process_failed",
        "managed browser PID does not identify the exact live private profile and executable",
      );
    }
    return identity.startTime;
  }
  const profileArgument = `--user-data-dir=${resolve(profileDirectory)}`;
  const command = await boundedProcessOutput("/bin/ps", [
    "-ww",
    "-p",
    String(pid),
    "-o",
    "command=",
  ]);
  if (!command.includes(profileArgument)) {
    throw new AgentBrowserCommandError(
      "process_failed",
      "managed browser PID does not identify the exact private profile",
    );
  }
  if (executablePath && !(await sameExecutable(pid, executablePath))) {
    throw new AgentBrowserCommandError(
      "process_failed",
      "managed browser PID does not identify the configured executable",
    );
  }
  if (!executablePath && !isRecognizedMacBrowserCommand(command)) {
    throw new AgentBrowserCommandError(
      "process_failed",
      "managed browser PID does not identify a recognized macOS browser",
    );
  }
}

async function findLinuxManagedBrowserProcess(
  profileDirectory: string,
  executablePath: string | null,
  requireCompleteInventory = false,
): Promise<LinuxManagedBrowserIdentity | null> {
  const procEntries = await readdir("/proc", { withFileTypes: true });
  const matches: LinuxManagedBrowserIdentity[] = [];
  const profileArgument = Buffer.from(`--user-data-dir=${resolve(profileDirectory)}`);
  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (requireCompleteInventory) {
      try {
        const commandLine = await readFile(`/proc/${pid}/cmdline`);
        await realpath(await readlink(`/proc/${pid}/exe`));
        // This is refusal evidence only. Even an unverified or rewritten
        // profile mention prevents a new exact-directory launch.
        if (commandLine.includes(profileArgument)) {
          throw new AgentBrowserCommandError(
            "process_failed",
            "exact directory launch absence is unproven",
          );
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (["EACCES", "EPERM"].includes(code)) {
          throw new AgentBrowserCommandError(
            "process_failed",
            "exact profile process inventory is incomplete",
          );
        }
        if (["ENOENT", "ESRCH"].includes(code)) continue;
        throw error;
      }
      continue;
    }
    const identity = await readLinuxManagedBrowserIdentity({
      pid,
      profileDirectory,
      executablePath,
    });
    if (identity) matches.push(identity);
  }
  if (matches.length > 1) {
    throw new AgentBrowserCommandError(
      "process_failed",
      "multiple managed browsers identify the exact private profile",
    );
  }
  return matches[0] ?? null;
}

async function readManagedBrowserPid(path: string): Promise<number | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 16) {
    throw new AgentBrowserCommandError("process_failed", "managed browser PID file is invalid");
  }
  const raw = (await readFile(path, "utf8")).trim();
  if (!/^[1-9][0-9]{0,9}$/u.test(raw)) {
    throw new AgentBrowserCommandError("process_failed", "managed browser PID is invalid");
  }
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid < 2 || pid > 2_147_483_647) {
    throw new AgentBrowserCommandError("process_failed", "managed browser PID is invalid");
  }
  return pid;
}

function isRecognizedMacBrowserCommand(command: string): boolean {
  return ["Google Chrome.app", "Google Chrome Canary.app", "Chromium.app"].some((bundle) =>
    command.includes(`/${bundle}/Contents/MacOS/`),
  );
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
    AGENT_BROWSER_ARGS: browserLaunchArguments(
      process.platform,
      options.launchArguments,
      options.headed,
    ),
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
  headed = false,
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
    // Compiled Chromium testing experiments can alter offscreen rendering.
    // Keep managed automation on the browser's deterministic default behavior.
    "--disable-field-trial-config",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    // Component-update suppression does not stop Chromium's on-demand local
    // model downloads. Managed profiles must not each fetch gigabytes of AI
    // weights; OpenGeni's model provider is independent of Chrome's local AI.
    "--disable-features=OptimizationGuideOnDeviceModel",
    // Chromium's free-disk-derived default can retain gigabytes per actor.
    // Bound disposable HTTP caching without limiting cookies or site storage.
    "--disk-cache-size=67108864",
    // Chromium's presentation-fenced screenshot path can wait indefinitely for
    // hidden headed tabs. Copy a freshly repainted surface without raising the
    // browser or changing the shared desktop's active tab.
    platform === "linux" && headed ? "--enable-features=CDPScreenshotNewSurface" : null,
    platform === "linux" ? "--test-type" : null,
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

/** Read-only proof shared by initial attestation, recovery and bounded cleanup.
 * Any inaccessible/ambiguous/PID-reused outcome rejects; only positive exit
 * permits a new exact-directory launch. */
export async function inspectOwnedManagedBrowserProcess(
  receipt: OwnedManagedBrowserProcess,
): Promise<"live" | "exited"> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new AgentBrowserCommandError("process_failed", "owned browser identity is unsupported");
  }
  const profile = await lstat(receipt.profileDirectory);
  if (!profile.isDirectory() || profile.isSymbolicLink()) {
    throw new AgentBrowserCommandError("process_failed", "owned browser profile is invalid");
  }
  validateOwnedCdpEndpoint(receipt.cdpEndpoint);
  if (!(await processRunning(receipt.pid))) {
    if (process.platform !== "linux") {
      // macOS has no existing exhaustive profile-process inventory. Never
      // infer absence of a successor from a missing pid alone.
      throw new AgentBrowserCommandError(
        "process_failed",
        "exact directory launch absence is unproven",
      );
    }
    if (await findLinuxManagedBrowserProcess(receipt.profileDirectory, null, true)) {
      throw new AgentBrowserCommandError(
        "process_failed",
        "another process owns the exact profile",
      );
    }
    return "exited";
  }
  if ((await processBirth(receipt.pid)) !== receipt.birth) {
    throw new AgentBrowserCommandError("process_failed", "owned browser PID birth changed");
  }
  await assertManagedBrowserIdentity(receipt.pid, receipt.profileDirectory, receipt.executablePath);
  const activePort = join(receipt.profileDirectory, "DevToolsActivePort");
  const metadata = await lstat(activePort);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 3 ||
    metadata.size > 1024
  ) {
    throw new AgentBrowserCommandError(
      "process_failed",
      "owned browser CDP identity is unavailable",
    );
  }
  const [port, browserPath] = (await readFile(activePort, "utf8")).trim().split("\n");
  const endpoint = new URL(receipt.cdpEndpoint);
  if (port !== endpoint.port || browserPath !== endpoint.pathname) {
    throw new AgentBrowserCommandError("process_failed", "owned browser CDP identity changed");
  }
  if ((await processBirth(receipt.pid)) !== receipt.birth) {
    throw new AgentBrowserCommandError(
      "process_failed",
      "owned browser identity changed during proof",
    );
  }
  return "live";
}

export function validateOwnedCdpEndpoint(value: string): void {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !/^\/devtools\/browser\/[A-Za-z0-9-]{16,128}$/u.test(endpoint.pathname)
  ) {
    throw new AgentBrowserCommandError("process_failed", "owned browser CDP endpoint is invalid");
  }
}

async function processBirth(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    const startTime = fields[19];
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (!startTime || !/^[0-9]+$/u.test(startTime) || !/^[0-9a-f-]{36}$/iu.test(bootId)) {
      throw new AgentBrowserCommandError("process_failed", "owned browser birth is unavailable");
    }
    return `${bootId}:${startTime}`;
  }
  const birth = (
    await boundedProcessOutput("/bin/ps", ["-p", String(pid), "-o", "lstart="])
  ).trim();
  if (!birth || birth.length > 128)
    throw new AgentBrowserCommandError("process_failed", "owned browser birth is unavailable");
  return birth;
}

function daemonLineageUnavailable(): AgentBrowserCommandError {
  return new AgentBrowserCommandError("process_failed", "owned browser daemon lineage is unproven");
}

async function readProfileBrowserPid(profileDirectory: string): Promise<number> {
  const path = join(profileDirectory, "SingletonLock");
  const before = await lstat(path);
  if (!before.isSymbolicLink()) throw daemonLineageUnavailable();
  const value = await readlink(path);
  const match = /^[^/\u0000]{1,200}-([1-9][0-9]{0,9})$/u.exec(value);
  const pid = Number(match?.[1]);
  const after = await lstat(path);
  if (
    !Number.isSafeInteger(pid) ||
    pid < 2 ||
    pid > 2_147_483_647 ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  )
    throw daemonLineageUnavailable();
  return pid;
}

async function processParentPid(pid: number): Promise<number> {
  const raw =
    process.platform === "linux"
      ? (await readFile(`/proc/${pid}/stat`, "utf8")).split(/\) /u).at(-1)!.trim().split(/\s+/u)[1]
      : (await boundedProcessOutput("/bin/ps", ["-p", String(pid), "-o", "ppid="])).trim();
  const parent = Number(raw);
  if (
    !raw ||
    !/^[1-9][0-9]{0,9}$/u.test(raw) ||
    !Number.isSafeInteger(parent) ||
    parent < 2 ||
    parent > 2_147_483_647
  )
    throw daemonLineageUnavailable();
  return parent;
}

async function processExecutablePath(pid: number): Promise<string> {
  const path =
    process.platform === "linux"
      ? await readlink(`/proc/${pid}/exe`)
      : (await boundedProcessOutput("/bin/ps", ["-p", String(pid), "-o", "comm="])).trim();
  if (!path || !path.startsWith("/")) throw daemonLineageUnavailable();
  return await realpath(path);
}

async function daemonPidRecords(directory: string): Promise<string[]> {
  const namespace = dirname(directory);
  const namespaces = dirname(namespace);
  for (const path of [dirname(namespaces), namespaces, namespace, directory]) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw daemonLineageUnavailable();
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 64) throw daemonLineageUnavailable();
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".pid")) continue;
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.pid$/u.test(entry.name) ||
      !entry.isFile() ||
      entry.isSymbolicLink()
    )
      throw daemonLineageUnavailable();
    paths.push(join(directory, entry.name));
  }
  return paths;
}

async function assertNoLiveDaemonRecords(
  socketDirectory: string,
  namespace: string,
): Promise<void> {
  const directory = join(resolve(socketDirectory), "namespaces", namespace, "run");
  for (const path of await daemonPidRecords(directory)) {
    const pid = await readDaemonPid(path);
    if (pid !== null && (await processRunning(pid))) throw daemonLineageUnavailable();
  }
}

async function assertDaemonIdentity(daemon: OwnedAgentBrowserDaemon): Promise<boolean> {
  for (const path of await daemonPidRecords(dirname(daemon.pidFile))) {
    const pid = await readDaemonPid(path);
    if (
      pid !== null &&
      (await processRunning(pid)) &&
      (path !== daemon.pidFile || pid !== daemon.pid)
    )
      throw daemonLineageUnavailable();
  }
  const live = await processRunning(daemon.pid);
  if (live) {
    if ((await processBirth(daemon.pid)) !== daemon.birth)
      throw new AgentBrowserCommandError(
        "process_failed",
        "owned agent-browser daemon birth changed",
      );
    if (!(await sameExecutable(daemon.pid, daemon.executablePath)))
      throw daemonLineageUnavailable();
  }
  const pid = await readDaemonPid(daemon.pidFile);
  if (pid === null && !live) return false;
  const metadata = pid === null ? null : await lstat(daemon.pidFile);
  if (
    pid !== daemon.pid ||
    metadata?.dev !== daemon.pidFileIdentity.device ||
    metadata?.ino !== daemon.pidFileIdentity.inode
  )
    throw new AgentBrowserCommandError(
      "process_failed",
      "owned agent-browser daemon identity changed",
    );
  if (live && (await processBirth(daemon.pid)) !== daemon.birth) throw daemonLineageUnavailable();
  return live;
}

async function terminateOwnedAgentBrowserDaemon(daemon: OwnedAgentBrowserDaemon): Promise<void> {
  if (await assertDaemonIdentity(daemon)) {
    signalProcess(daemon.pid, "SIGTERM");
    if (!(await waitForProcessStop(daemon.pid, DAEMON_STOP_TIMEOUT_MS))) {
      if (await assertDaemonIdentity(daemon)) {
        signalProcess(daemon.pid, "SIGKILL");
        if (!(await waitForProcessStop(daemon.pid, DAEMON_STOP_TIMEOUT_MS)))
          throw new AgentBrowserCommandError(
            "process_failed",
            "owned agent-browser daemon did not stop",
          );
      }
    }
  }
  await assertDaemonIdentity(daemon);
  await rm(daemon.pidFile, { force: true });
}

async function terminateOwnedManagedBrowserProcess(
  receipt: OwnedManagedBrowserProcess,
): Promise<void> {
  if ((await inspectOwnedManagedBrowserProcess(receipt)) === "exited") return;
  signalProcess(receipt.pid, "SIGTERM");
  if (!(await waitForProcessStop(receipt.pid, DAEMON_STOP_TIMEOUT_MS))) {
    if ((await inspectOwnedManagedBrowserProcess(receipt)) !== "live") return;
    signalProcess(receipt.pid, "SIGKILL");
    if (!(await waitForProcessStop(receipt.pid, DAEMON_STOP_TIMEOUT_MS))) {
      throw new AgentBrowserCommandError("process_failed", "owned browser did not terminate");
    }
  }
}

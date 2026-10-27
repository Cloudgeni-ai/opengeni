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
  stat as fileStatus,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  BROWSER_SHARED_NETWORK_NOTICE,
  browserNetworkIsolationScript,
  freeLoopbackPort,
  hostNamespaceResolvConf,
  isolatedChromeLaunch,
  linuxBrowserNetworkIsolation,
  type BrowserNetworkIsolationTools,
} from "./browser-network-isolation";
import {
  readLinuxManagedBrowserIdentity,
  type LinuxManagedBrowserIdentity,
} from "./linux-process-identity";

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 10 * 60_000;
/** How often a launch checks for Chrome's DevToolsActivePort. */
const DEVTOOLS_PORT_POLL_MS = 20;
/** The Chrome stderr tail quoted when a launch fails. */
const LAUNCH_FAILURE_STDERR_BYTES = 2 * 1024;
/** How long a failed launch waits for the stderr drain to finish writing its
 * log. The drain writes only once Chrome's stderr closes, which a loaded
 * machine can schedule after this controller has already seen Chrome exit. */
const LAUNCH_FAILURE_STDERR_DRAIN_MS = 2_000;
/** Chrome refuses to start on a smaller /dev/shm unless told to use disk. */
const MIN_DEV_SHM_AVAILABLE_BYTES = 256 * 1024 * 1024;
const DAEMON_STOP_TIMEOUT_MS = 3_000;
const PROCESS_QUERY_TIMEOUT_MS = 2_000;
const MAX_PROCESS_QUERY_BYTES = 8 * 1024;
/** A whole-host process listing (every process with its command line) is far
 * larger than a single-process query and may take longer on a busy host. */
const PROCESS_INVENTORY_LIMITS = { maxBytes: 32 * 1024 * 1024, timeoutMs: 10_000 } as const;
/** One process's command line plus its environment. */
const PROCESS_ENVIRONMENT_LIMITS = { maxBytes: 1024 * 1024, timeoutMs: 2_000 } as const;
/** A launcher daemon from an earlier release without a browser child that is
 * younger than this may still be starting its browser, so startup
 * reconciliation leaves it. */
const ORPHANED_DAEMON_MIN_AGE_MS = 120_000;
const CHROME_STDERR_DIAGNOSTIC_BYTES = 64 * 1024;

/** Chromium features every managed browser turns off. Chromium honors only
 * the last `--disable-features` switch, so the launch wrapper appends this one
 * complete switch after every other argument. */
const MANAGED_CHROME_DISABLED_FEATURES = [
  // The translate bar would cover pages and offer to rewrite them.
  "Translate",
  // Component-update suppression does not stop Chromium's on-demand local
  // model downloads. Managed profiles must not each fetch gigabytes of AI
  // weights; Opengeni's model provider is independent of Chrome's local AI.
  "OptimizationGuideOnDeviceModel",
  // The address-bar suggestion popups are WebUI pages that Chrome preloads
  // into two dedicated renderers (about 200 MB) for the browser's lifetime.
  // Nothing types into a managed browser's address bar, and Chrome falls back
  // to its native popup. Pages cannot observe the difference.
  "WebUIOmniboxPopup",
  "WebUIOmniboxAimPopup",
  // History search embeddings: every new profile downloads a 37 MB text
  // embedding model and embeds visited pages in the background. Nothing in a
  // managed browser searches its history, and pages cannot observe it (the
  // built-in AI web APIs use other models and stay available).
  "PassageEmbedder",
] as const;

export const MANAGED_CHROME_DISABLED_FEATURES_ARGUMENT = `--disable-features=${MANAGED_CHROME_DISABLED_FEATURES.join(",")}`;

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

export type ManagedBrowserRunnerOptions = {
  profileDirectory: string;
  headed: boolean;
  /** Run a headed managed browser without any native window. On a person's
   * own desktop a windowed managed browser shows up in front of them, takes
   * focus and joins the Dock; an offscreen browser is the same real browser
   * and profile in Chrome's new headless mode, presenting the host display's
   * geometry and an ordinary User-Agent. Supported on macOS, and on Linux
   * hosts without a graphical display, where no window can open. */
  offscreen?: boolean;
  browserExecutablePath?: string;
  /** macOS lifecycle-preserving background launcher. Defaults to the packaged
   * native helper discovered by browserd's parent agent. */
  browserLaunchHelperPath?: string;
  workingDirectory?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  /** Private launch authority. Only the proxy server reaches Chrome's argv;
   * its credentials stay in this process and answer the proxy's challenges
   * over CDP, never in argv, logs, or durable browser metadata. */
  proxyUrl?: string;
  launchArguments?: readonly string[];
  timezone?: string;
  /** Private completed launch receipt, checked again before attaching/launching. */
  recoverOwnedProcess?: OwnedManagedBrowserProcess;
  allowOwnedProcessLaunch?: boolean;
  /** Launch a managed Linux browser in its own transient systemd user scope
   * when a user service manager is reachable. Defaults to on; tests disable it
   * to exercise the plain launch. */
  systemdScope?: boolean;
  /** Launch a managed Linux browser in its own network namespace when the
   * machine supports it. Defaults to on; tests disable it to exercise the
   * plain launch. */
  networkIsolation?: boolean;
};

export type OwnedManagedBrowserProcess = {
  pid: number;
  birth: string;
  executablePath: string;
  profileDirectory: string;
  cdpEndpoint: string;
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

/** Credentials a managed browser's proxy route asks for. Chrome cannot take
 * them on its command line; the controller answers the proxy's challenges over
 * CDP instead. */
export type ManagedBrowserProxyCredentials = { username: string; password: string };

type BrowserExit = { code: number | null; signal: NodeJS.Signals | null; error: string | null };

type LaunchedBrowser = {
  /** The spawned process: Chrome itself, except for the macOS background
   * launcher, which stays alive for Chrome's whole lifetime. */
  pid: number;
  cdpUrl: string;
  exit: Promise<BrowserExit>;
  exited: BrowserExit | null;
};

/**
 * Launches and owns one managed Chrome. Chrome runs detached, so it outlives a
 * controller restart and the next controller can adopt it from its receipt.
 *
 * The controller is the browser's only CDP client. Pages can tell when any
 * client enables the Runtime domain on them (anti-bot scripts log a crafted
 * object and watch for the inspector reading it), so no launcher or helper may
 * keep sessions attached to its pages.
 */
export class ManagedBrowserRunner {
  /** Set when this managed browser shares the machine's network because
   * isolating it is unavailable here; shown once to the agent at launch. */
  readonly networkNotice: string | null;
  /** How a headed browser shows on the machine: in a native window, or
   * offscreen with none. Null for a headless browser. It follows the same
   * decision as the launch arguments, so it never claims a window Chrome was
   * not given. */
  readonly display: ManagedBrowserDisplay | null;
  readonly proxyCredentials: ManagedBrowserProxyCredentials | null;
  private readonly profileDirectory: string;
  private readonly workingDirectory: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly launchExecutable: string | null;
  private readonly launchArguments: readonly string[];
  private readonly browserPidFile: string;
  /** The macOS background launcher records Chrome's PID itself. */
  private readonly launcherRecordsBrowserPid: boolean;
  /** The browser binary the managed PID runs; refined to the exec'd binary
   * once a Linux launch through a wrapper script has started. */
  private managedBrowserExecutable: string | null;
  private readonly chromeStderrDrainPaths: readonly string[];
  private readonly chromeStderrLog: string | null;
  /** Created by the stderr drain once it has written chromeStderrLog. */
  private readonly chromeStderrDone: string | null;
  private readonly browserScope: LinuxBrowserScope | null;
  private readonly recoveredProcess: OwnedManagedBrowserProcess | null;
  /** The launcher daemon of a browser an earlier release started, if it
   * still runs; it does not exit with its browser and is stopped with it. */
  private legacyLauncher: LaunchingAgentBrowserDaemon | null = null;
  private recoveredBrowserClosed = false;
  private launched: LaunchedBrowser | null = null;
  private launching: Promise<LaunchedBrowser> | null = null;

  private constructor(
    options: ManagedBrowserRunnerOptions,
    proxy: PrivateProxyAuthority | null,
    launch: {
      executable: string | null;
      browserLaunch: ManagedBrowserLaunch | undefined;
      sandboxUnavailable: boolean;
      smallSharedMemory: boolean;
    } | null,
  ) {
    this.profileDirectory = resolve(options.profileDirectory);
    this.workingDirectory = resolve(options.workingDirectory ?? process.cwd());
    this.browserPidFile = join(this.profileDirectory, "..", "browser.pid");
    // Only a live browser is reattached; an exited one is launched afresh.
    this.recoveredProcess = launch === null ? (options.recoverOwnedProcess ?? null) : null;
    this.proxyCredentials =
      proxy?.username != null && proxy.password != null
        ? { username: proxy.username, password: proxy.password }
        : null;
    const browserLaunch = launch?.browserLaunch;
    this.launchExecutable = launch?.executable ?? null;
    this.launcherRecordsBrowserPid = browserLaunch?.backgroundBrowserExecutable !== undefined;
    this.environment = launchEnvironment(options, browserLaunch, this.browserPidFile);
    this.launchArguments = managedChromeArguments({
      platform: process.platform,
      windowed: windowedBrowser(options),
      profileDirectory: this.profileDirectory,
      proxyServer: proxy?.server ?? null,
      additional: options.launchArguments ?? [],
      sandboxUnavailable: launch?.sandboxUnavailable ?? false,
      smallSharedMemory: launch?.smallSharedMemory ?? false,
    });
    this.managedBrowserExecutable =
      browserLaunch?.backgroundBrowserExecutable ??
      (browserLaunch && "actualExecutablePath" in browserLaunch
        ? (browserLaunch.actualExecutablePath ?? null)
        : (launch?.executable ?? options.browserExecutablePath ?? null));
    this.chromeStderrDrainPaths = browserLaunch?.cleanupPaths ?? [];
    this.chromeStderrLog = browserLaunch?.stderrLog ?? null;
    this.chromeStderrDone = browserLaunch?.stderrDone ?? null;
    this.browserScope = browserLaunch?.scope ?? null;
    this.networkNotice = browserLaunch?.networkNotice ?? null;
    this.display = managedBrowserDisplay(options);
  }

  static async create(options: ManagedBrowserRunnerOptions): Promise<ManagedBrowserRunner> {
    const proxy = options.proxyUrl ? privateProxyAuthority(options.proxyUrl) : null;
    if (options.timezone) supportedTimezone(options.timezone);
    if (options.recoverOwnedProcess) {
      const state = await inspectOwnedManagedBrowserProcess(options.recoverOwnedProcess);
      if (state === "live") {
        const runner = new ManagedBrowserRunner(options, proxy, null);
        runner.legacyLauncher = await launchingAgentBrowserDaemon(options.recoverOwnedProcess.pid);
        return runner;
      }
      // A positively exited process permits a new launch only in this exact
      // directory. No missing-memory/PID-file inference or pre-launch kill.
      if (state !== "exited" || options.allowOwnedProcessLaunch !== true)
        throw new AgentBrowserCommandError("process_failed", "owned browser outcome is unknown");
      // A browser an earlier release launched leaves its launcher daemon
      // running after the browser is gone; stop the one for this profile.
      await stopOrphanedAgentBrowserDaemons(options.profileDirectory);
    }
    await mkdir(options.profileDirectory, { recursive: true, mode: 0o700 });
    await chmod(options.profileDirectory, 0o700);
    const [browserLaunch, sandboxUnavailable, smallSharedMemory] = await Promise.all([
      managedBrowserLaunch(options),
      chromeSandboxUnavailable(),
      sharedMemoryTooSmall(),
    ]);
    const executable =
      browserLaunch?.executablePath ??
      (options.browserExecutablePath
        ? resolve(options.browserExecutablePath)
        : ((await defaultChromeExecutable()) ?? null));
    if (browserLaunch?.backgroundBrowserExecutable && !options.recoverOwnedProcess) {
      await terminateManagedBrowser({
        pidFile: join(resolve(options.profileDirectory), "..", "browser.pid"),
        profileDirectory: resolve(options.profileDirectory),
        executablePath: browserLaunch.backgroundBrowserExecutable,
      });
    }
    return new ManagedBrowserRunner(options, proxy, {
      executable,
      browserLaunch,
      sandboxUnavailable,
      smallSharedMemory,
    });
  }

  /** `get cdp-url` launches the browser when it is not running and returns its
   * private CDP endpoint; `close` waits for a browser asked to close over CDP
   * to exit. */
  async run<T = unknown>(
    args: readonly string[],
    options: AgentBrowserRunOptions = {},
  ): Promise<T> {
    if (args.length === 2 && args[0] === "get" && args[1] === "cdp-url") {
      if (this.recoveredProcess) {
        if ((await inspectOwnedManagedBrowserProcess(this.recoveredProcess)) !== "live") {
          throw new AgentBrowserCommandError("process_failed", "owned browser is unavailable");
        }
        return { cdpUrl: this.recoveredProcess.cdpEndpoint } as T;
      }
      return { cdpUrl: (await this.ensureLaunched(options)).cdpUrl } as T;
    }
    if (args.length === 1 && args[0] === "close") {
      if (!this.recoveredProcess) await this.awaitBrowserExit(options);
      return {} as T;
    }
    throw new AgentBrowserCommandError(
      "driver_rejected",
      "managed browser accepts only its CDP transport",
    );
  }

  async terminate(): Promise<void> {
    if (this.recoveredProcess) {
      if (!this.recoveredBrowserClosed) {
        await terminateOwnedManagedBrowserProcess(this.recoveredProcess);
        // Preserve a proved stop for the same cleanup retry; a missing macOS
        // PID still cannot authorize a fresh exact-directory launch.
        this.recoveredBrowserClosed = true;
      }
      await stopLaunchingAgentBrowserDaemon(this.legacyLauncher);
      await this.cleanupChromeStderrDrain();
      return;
    }
    if (this.launched && !this.launcherRecordsBrowserPid) {
      // The browser is this runner's own unreaped child, so its PID cannot
      // name another process; stop it directly rather than re-proving its
      // profile lock, which Chrome already removes while it exits.
      await stopLaunchedBrowser(this.launched);
      await rm(this.browserPidFile, { force: true });
    } else if (process.platform === "linux" || process.platform === "darwin") {
      await terminateManagedBrowser({
        pidFile: this.browserPidFile,
        profileDirectory: this.profileDirectory,
        executablePath: this.managedBrowserExecutable,
        discoverByProfile: this.chromeStderrDrainPaths.length > 0,
      });
    }
    await this.cleanupChromeStderrDrain();
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
    const pid = recordedPid ?? discovered?.pid;
    if (!pid || !(await processRunning(pid))) return null;
    if (cdpBrowserPid !== undefined && cdpBrowserPid !== pid) throw browserLineageUnavailable();
    // A browser this runner spawned is identified by its own PID; Chrome's
    // profile lock must name the same process.
    const launchedHere =
      this.launched !== null && this.launched.exited === null && this.launched.pid === pid;
    const executablePath =
      this.managedBrowserExecutable ??
      discovered?.executablePath ??
      (launchedHere ? await processExecutablePath(pid) : null);
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
    if (launchedHere && (await readProfileBrowserPid(this.profileDirectory)) !== pid)
      throw browserLineageUnavailable();
    if (this.browserScope) await collectBrowserIntoScope(this.browserScope, pid);
    return receipt;
  }

  get reattachedOwnedProcess(): OwnedManagedBrowserProcess | null {
    return this.recoveredProcess;
  }

  private async ensureLaunched(options: AgentBrowserRunOptions): Promise<LaunchedBrowser> {
    if (this.launched && this.launched.exited === null) return this.launched;
    this.launching ??= this.launch(options).finally(() => {
      this.launching = null;
    });
    return await this.launching;
  }

  private async launch(options: AgentBrowserRunOptions): Promise<LaunchedBrowser> {
    const timeoutMs = boundedTimeout(options.timeoutMs);
    if (options.signal?.aborted) {
      throw new AgentBrowserCommandError("aborted", "browser launch was aborted");
    }
    if (!this.launchExecutable) {
      throw new AgentBrowserCommandError(
        "driver_rejected",
        "no browser executable is installed",
        "Chrome not found. Install Google Chrome or Chromium on this machine.",
      );
    }
    const activePort = join(this.profileDirectory, "DevToolsActivePort");
    // A port file left by an earlier run names a browser that is gone.
    await rm(activePort, { force: true });
    // So is an earlier launch's finished stderr drain.
    if (this.chromeStderrDone) await rm(this.chromeStderrDone, { force: true });
    const child = spawn(this.launchExecutable, this.launchArguments, {
      cwd: this.workingDirectory,
      env: this.environment,
      // Chrome leads its own process group and session, so stopping this
      // controller's group leaves it running for the next controller.
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    const exit = new Promise<BrowserExit>((resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal, error: null }));
      child.once("error", (error) =>
        resolveExit({
          code: null,
          signal: null,
          error: (error as NodeJS.ErrnoException).code ?? "spawn_failed",
        }),
      );
    });
    child.unref();
    const launched: LaunchedBrowser = { pid: child.pid ?? 0, cdpUrl: "", exit, exited: null };
    void exit.then((value) => {
      launched.exited = value;
    });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (launched.exited) throw await this.launchFailure(launched.exited);
      const endpoint = await readDevToolsEndpoint(activePort);
      if (endpoint) {
        launched.cdpUrl = endpoint;
        break;
      }
      if (options.signal?.aborted || Date.now() >= deadline) {
        stopLaunchedProcessGroup(child.pid);
        throw options.signal?.aborted
          ? new AgentBrowserCommandError("aborted", "browser launch was aborted")
          : new AgentBrowserCommandError(
              "timeout",
              "browser launch timed out",
              "Chrome did not start its DevTools endpoint in time.",
            );
      }
      await Promise.race([new Promise((done) => setTimeout(done, DEVTOOLS_PORT_POLL_MS)), exit]);
    }
    if (!this.launcherRecordsBrowserPid && launched.pid > 0) {
      // A configured wrapper script (for example a distribution launcher)
      // execs the real browser in place; identify the PID by that binary.
      if (process.platform === "linux") {
        this.managedBrowserExecutable = await processExecutablePath(launched.pid);
      }
      await writeFile(this.browserPidFile, `${launched.pid}\n`, { mode: 0o600 });
    }
    this.launched = launched;
    return launched;
  }

  private async awaitBrowserExit(options: AgentBrowserRunOptions): Promise<void> {
    const launched = this.launched;
    if (!launched || launched.exited) return;
    const timeoutMs = boundedTimeout(options.timeoutMs);
    const exited = await Promise.race([
      launched.exit.then(() => true),
      new Promise<false>((done) => setTimeout(() => done(false), timeoutMs).unref?.()),
    ]);
    if (!exited) {
      throw new AgentBrowserCommandError("timeout", "managed browser did not close in time");
    }
  }

  private async launchFailure(exit: BrowserExit): Promise<AgentBrowserCommandError> {
    if (exit.error === "ENOENT") {
      return new AgentBrowserCommandError(
        "driver_rejected",
        "browser executable is missing",
        `Chrome not found at ${this.launchExecutable}.`,
      );
    }
    const status = exit.error ?? exit.signal ?? String(exit.code);
    if (this.chromeStderrDone)
      await waitForFile(this.chromeStderrDone, LAUNCH_FAILURE_STDERR_DRAIN_MS);
    const stderr = this.chromeStderrLog ? await fileTail(this.chromeStderrLog) : "";
    return new AgentBrowserCommandError(
      "driver_rejected",
      "browser exited during launch",
      boundedDriverMessage(
        `Chrome exited early (${status}) without writing DevToolsActivePort${stderr ? `. Chrome stderr: ${stderr}` : ""}`,
      ),
    );
  }

  private async cleanupChromeStderrDrain(): Promise<void> {
    await Promise.all(
      this.chromeStderrDrainPaths.map(
        async (path) => await rm(path, { force: true, recursive: true }),
      ),
    );
  }
}

/** Chrome's own switches for a managed browser, before the wrapper's fixed
 * arguments and its trailing disabled-feature list. Popup blocking and native
 * scrollbars stay as in an ordinary Chrome: switching either off is a
 * well-known automation signal, and an agent's clicks are user gestures that
 * may open popups anyway. */
export function managedChromeArguments(input: {
  platform: NodeJS.Platform;
  windowed: boolean;
  profileDirectory: string;
  proxyServer: string | null;
  additional?: readonly string[];
  sandboxUnavailable?: boolean;
  smallSharedMemory?: boolean;
}): string[] {
  return [
    "--remote-debugging-port=0",
    `--user-data-dir=${resolve(input.profileDirectory)}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Background services of a person's browser that an agent's must not run:
    // updates, sync, preinstalled apps and metrics upload. Pages see none.
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--metrics-recording-only",
    // An occluded or busy managed window keeps rendering and answering CDP,
    // and a reposted form never stops on a native prompt.
    "--disable-backgrounding-occluded-windows",
    "--disable-hang-monitor",
    "--disable-prompt-on-repost",
    ...(input.windowed ? [] : ["--headless=new", "--window-size=1280,720"]),
    // Headless Chrome elsewhere keeps WebGL through SwiftShader, as on Linux.
    ...(!input.windowed && input.platform !== "linux" ? ["--enable-unsafe-swiftshader"] : []),
    ...(input.proxyServer ? [`--proxy-server=${input.proxyServer}`] : []),
    ...browserLaunchArguments(input.platform, input.additional),
    // Chrome's sandbox cannot start as root or inside most containers.
    ...(input.sandboxUnavailable ? ["--no-sandbox"] : []),
    ...(input.smallSharedMemory ? ["--disable-dev-shm-usage"] : []),
  ];
}

async function chromeSandboxUnavailable(): Promise<boolean> {
  if (process.platform === "win32") return false;
  if (process.getuid?.() === 0) return true;
  if (process.platform !== "linux") return false;
  for (const marker of ["/.dockerenv", "/run/.containerenv"]) {
    try {
      await access(marker, constants.F_OK);
      return true;
    } catch {
      // Not this container runtime.
    }
  }
  try {
    return /docker|kubepods|lxc/u.test(await readFile("/proc/1/cgroup", "utf8"));
  } catch {
    return false;
  }
}

async function sharedMemoryTooSmall(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    const stats = await statfs("/dev/shm");
    return stats.bavail * stats.bsize < MIN_DEV_SHM_AVAILABLE_BYTES;
  } catch {
    return false;
  }
}

function windowsChromeExecutables(): string[] {
  return [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
    .filter((base): base is string => Boolean(base))
    .flatMap((base) => [
      join(base, "Google", "Chrome", "Application", "chrome.exe"),
      join(base, "Chromium", "Application", "chrome.exe"),
    ]);
}

/** The machine's own Chrome when no launch wrapper or configured executable
 * names one. */
async function defaultChromeExecutable(): Promise<string | undefined> {
  if (process.platform === "linux") return await linuxChromeExecutable();
  if (process.platform === "darwin") return await firstExecutable(MACOS_BROWSER_EXECUTABLES);
  if (process.platform === "win32") return await firstExecutable(windowsChromeExecutables());
  return undefined;
}

/** The CDP endpoint Chrome records in its profile once DevTools listens, or
 * null while the file is absent or still being written. */
async function readDevToolsEndpoint(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const [port, browserPath] = raw.trim().split("\n");
  if (
    !port ||
    !/^[1-9][0-9]{0,4}$/u.test(port) ||
    !/^\/devtools\/browser\/[0-9a-f-]{36}$/u.test(browserPath ?? "")
  )
    return null;
  const endpoint = `ws://127.0.0.1:${port}${browserPath}`;
  validateOwnedCdpEndpoint(endpoint);
  return endpoint;
}

async function stopLaunchedBrowser(launched: LaunchedBrowser): Promise<void> {
  const stopped = async (): Promise<boolean> => {
    if (launched.exited !== null) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        launched.exit.then(() => true),
        new Promise<false>((done) => {
          timer = setTimeout(done, DAEMON_STOP_TIMEOUT_MS, false);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  if (launched.exited !== null || launched.pid <= 0) return;
  signalProcess(launched.pid, "SIGTERM");
  if (await stopped()) return;
  stopLaunchedProcessGroup(launched.pid);
  if (!(await stopped())) {
    throw new AgentBrowserCommandError("process_failed", "managed browser did not terminate");
  }
}

function stopLaunchedProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Wait until a file exists, for at most timeoutMs. */
async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(path);
      return;
    } catch {}
    if (Date.now() >= deadline) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function fileTail(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const { size } = await file.stat();
    const length = Math.min(size, LAUNCH_FAILURE_STDERR_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return buffer.toString("utf8").trim();
  } finally {
    await file.close();
  }
}

/** Reap only browser processes bound to an exact private Opengeni profile.
 * A controller restart never adopts an unfenced native process; active durable
 * sessions are rebuilt on their next causal request. */
export async function reapManagedBrowserProcesses(
  rootDirectory: string,
  preserveSession?: (sessionDirectory: string) => Promise<boolean>,
  options: { readProcessCommandLines?: () => Promise<LinuxProcessCommandLines> } = {},
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
  // One procfs inventory serves the whole pass. Scanning every process once
  // per stale session directory made startup cost sessions x processes.
  let inventory: Promise<LinuxProcessCommandLines> | undefined;
  const processCommandLines = () =>
    (inventory ??= (options.readProcessCommandLines ?? readLinuxProcessCommandLines)());
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/iu.test(entry.name)) continue;
    const sessionDirectory = join(sessionsDirectory, entry.name);
    if (await preserveSession?.(sessionDirectory)) continue;
    await terminateManagedBrowser({
      pidFile: join(sessionDirectory, "browser.pid"),
      profileDirectory: join(sessionDirectory, "profile"),
      executablePath: null,
      discoverByProfile: true,
      processCommandLines,
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
    if (/^[0-9a-f-]{36}\.(?:sh|stderr\.fifo|stderr\.done|d|resolv\.conf)$/iu.test(name)) {
      await rm(join(directory, name), { force: true, recursive: true });
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
  /** Where the launch wrapper keeps Chrome's last stderr bytes. */
  stderrLog?: string;
  /** Created once the wrapper has finished writing stderrLog for a launch. */
  stderrDone?: string;
  scope?: LinuxBrowserScope | null;
  networkNotice?: string | null;
};

/** One transient systemd user scope per managed Linux browser launch. All
 * scopes share one slice that sets no resource limits; it only keeps browsers
 * out of the agent service, so stopping or replacing the agent never takes
 * running browsers with it, and makes their usage visible per browser. */
type LinuxBrowserScope = { unit: string; busctl: string };

const BROWSER_SCOPE_SLICE = "opengeni-browsers.slice";
const BROWSER_SCOPE_MARKER = "OPENGENI_BROWSER_SCOPE";
const SYSTEMD_PROBE_TIMEOUT_MS = 2_000;
const SCOPE_BUS_VARIABLES = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] as const;

/** Shell prologue that re-executes the wrapper inside the browser's transient
 * scope. `systemd-run` talks to the user manager over the probed bus; the
 * launch's own bus variables (a linked computer session's private desktop bus,
 * for example) are carried across the re-exec and restored for Chrome. */
export function browserScopeEntry(
  launcher: LinuxUserScopeLauncher,
  unit: string,
  wrapper: string,
): string {
  const saved = SCOPE_BUS_VARIABLES.map(
    (name) =>
      `${BROWSER_SCOPE_MARKER}_${name}="\${${name}-}" ${BROWSER_SCOPE_MARKER}_${name}_SET="\${${name}+1}"`,
  ).join(" ");
  const manager = SCOPE_BUS_VARIABLES.flatMap((name) => {
    const value = launcher.managerEnvironment[name];
    return value === undefined ? [] : [`${name}=${shellQuote(value)}`];
  }).join(" ");
  const restore = SCOPE_BUS_VARIABLES.map(
    (name) =>
      `if [ -n "\${${BROWSER_SCOPE_MARKER}_${name}_SET:-}" ]; then ${name}="\${${BROWSER_SCOPE_MARKER}_${name}}"; export ${name}; else unset ${name}; fi\nunset ${BROWSER_SCOPE_MARKER}_${name} ${BROWSER_SCOPE_MARKER}_${name}_SET\n`,
  ).join("");
  return `if [ "\${${BROWSER_SCOPE_MARKER}:-}" != ${shellQuote(unit)} ]; then\n  ${saved} ${BROWSER_SCOPE_MARKER}=${shellQuote(unit)} ${manager} exec ${shellQuote(launcher.systemdRun)} --user --scope --quiet --collect --property=Delegate=yes --slice=${BROWSER_SCOPE_SLICE} --unit=${shellQuote(unit)} -- ${shellQuote(wrapper)} "$@"\nfi\nunset ${BROWSER_SCOPE_MARKER}\n${restore}`;
}

async function managedBrowserLaunch(
  options: ManagedBrowserRunnerOptions,
): Promise<ManagedBrowserLaunch | undefined> {
  const configured = options.browserExecutablePath
    ? resolve(options.browserExecutablePath)
    : undefined;
  if (process.platform === "linux") {
    const executable = configured ?? (await linuxChromeExecutable());
    if (executable) {
      const [scopeLauncher, isolation, fixedArguments] = await Promise.all([
        options.systemdScope === false ? null : linuxUserScopeLauncher(),
        options.networkIsolation === false ? null : linuxBrowserNetworkIsolation(),
        windowedBrowser(options) ? [] : linuxHeadlessChromeArguments(executable),
      ]);
      const launch = await chromeStderrDrainWrapper(
        options.profileDirectory,
        executable,
        scopeLauncher,
        fixedArguments,
        isolation?.kind === "isolated" ? isolation.tools : null,
      );
      return isolation?.kind === "unavailable"
        ? { ...launch, networkNotice: BROWSER_SHARED_NETWORK_NOTICE }
        : launch;
    }
  }
  // Offscreen and headless are the same new-headless Chrome on macOS; both
  // present the host display and an ordinary User-Agent.
  if (process.platform === "darwin" && !windowedBrowser(options)) {
    const executable = configured ?? (await firstExecutable(MACOS_BROWSER_EXECUTABLES));
    if (!executable) return undefined;
    return await chromeStderrDrainWrapper(
      options.profileDirectory,
      executable,
      null,
      await macosOffscreenChromeArguments(executable),
    );
  }
  if (process.platform !== "darwin" || !options.headed) {
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
  // non-activating LaunchServices launch, records Chrome's PID, and keeps the
  // window capturable. Chrome still writes DevToolsActivePort to its profile.
  return {
    executablePath: helper,
    backgroundBrowserExecutable: executable,
  };
}

/** A launch wrapper that keeps Chrome's PID/process group unchanged with shell
 * exec, while a private reader consumes Chrome's stderr and retains only the
 * last bounded diagnostic bytes (quoted when a launch fails).
 *
 * Fixed Chrome arguments are added here too, and so is the managed browser's
 * complete disabled-feature list, last.
 *
 * With a reachable systemd user manager the wrapper first re-executes itself
 * through `systemd-run --scope`, which execs in place: the PID the controller
 * spawned stays Chrome's PID, and the stderr reader plus every Chrome child
 * start inside the browser's own scope.
 *
 * Where the machine supports it, the wrapper then moves Chrome into its own
 * network namespace (see browser-network-isolation.ts), again in place. */
async function chromeStderrDrainWrapper(
  profileDirectory: string,
  executable: string,
  scopeLauncher: LinuxUserScopeLauncher | null,
  fixedArguments: readonly string[] = [],
  isolation: BrowserNetworkIsolationTools | null = null,
): Promise<ManagedBrowserLaunch> {
  await access(executable, constants.X_OK);
  const actualExecutablePath = (await isScriptExecutable(executable)) ? null : executable;
  const mkfifo =
    (await firstExecutableInPath(["mkfifo"])) ??
    (await firstExecutable(["/usr/bin/mkfifo", "/bin/mkfifo"]));
  // Some distributions provide GNU tail separately from a generic implementation
  // whose byte cap is incorrect for pipes/FIFOs (for example uutils 0.8.0).
  const tail =
    (await firstExecutableInPath(["gnutail", "tail"])) ??
    (await firstExecutable(["/usr/bin/tail", "/bin/tail"]));
  if (!mkfifo || !tail) throw new Error("managed Chrome requires mkfifo and tail");
  const directory = join(dirname(resolve(profileDirectory)), "chrome-launch");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const id = randomUUID();
  const fifo = join(directory, `${id}.stderr.fifo`);
  const log = join(directory, "chrome-stderr.log");
  const done = join(directory, `${id}.stderr.done`);
  const wrapper = join(directory, `${id}.sh`);
  const scope = scopeLauncher
    ? { unit: `opengeni-browser-${id}.scope`, busctl: scopeLauncher.busctl }
    : null;
  const scopeEntry =
    scope && scopeLauncher ? browserScopeEntry(scopeLauncher, scope.unit, wrapper) : "";
  const fixed = fixedArguments.map((argument) => ` ${shellQuote(argument)}`).join("");
  const trailing = ` ${shellQuote(MANAGED_CHROME_DISABLED_FEATURES_ARGUMENT)}`;
  const state = join(directory, `${id}.d`);
  const resolvOverride = join(directory, `${id}.resolv.conf`);
  const cleanupPaths = isolation
    ? [wrapper, fifo, done, state, resolvOverride]
    : [wrapper, fifo, done];
  try {
    await runProcess(mkfifo, ["-m", "600", fifo]);
    // tail writes the log only once Chrome's stderr closes; the done marker
    // tells a failed launch when the log is complete.
    let script = `#!/bin/sh\numask 077\n${scopeEntry}{ ${shellQuote(tail)} -c ${CHROME_STDERR_DIAGNOSTIC_BYTES} ${shellQuote(fifo)} > ${shellQuote(log)} 2>/dev/null; : > ${shellQuote(done)}; } &\nexec ${shellQuote(executable)}${fixed} "$@"${trailing} 2>${shellQuote(fifo)}\n`;
    if (isolation) {
      await mkdir(state, { mode: 0o700 });
      const resolv = await hostNamespaceResolvConf();
      if (resolv !== null) await writeFile(resolvOverride, resolv, { mode: 0o600, flag: "wx" });
      const cdpPort = await freeLoopbackPort();
      script = browserNetworkIsolationScript({
        tools: isolation,
        wrapper,
        stateDirectory: state,
        cdpPort,
        resolvOverride: resolv === null ? null : resolvOverride,
        prologue: scopeEntry,
        launch: isolatedChromeLaunch({
          tools: isolation,
          cdpPort,
          executable,
          fixedArguments,
          trailingArguments: [MANAGED_CHROME_DISABLED_FEATURES_ARGUMENT],
          stderrFifo: fifo,
          stderrLog: log,
          stderrDone: done,
          tail,
          stderrBytes: CHROME_STDERR_DIAGNOSTIC_BYTES,
        }),
      });
    }
    await writeFile(wrapper, script, { mode: 0o700, flag: "wx" });
    await chmod(wrapper, 0o700);
    return {
      executablePath: wrapper,
      actualExecutablePath,
      cleanupPaths,
      stderrLog: log,
      stderrDone: done,
      scope,
    };
  } catch (error) {
    await Promise.allSettled(
      cleanupPaths.map(async (path) => await rm(path, { force: true, recursive: true })),
    );
    throw error;
  }
}

/** Arguments that make an offscreen (new headless) real Chrome on macOS
 * present like the person's ordinary windowed Chrome. Headless Chrome names
 * itself HeadlessChrome in every User-Agent, including workers', and reports
 * an 800x600 screen with no work area; sites treat both as bot signals. The
 * User-Agent switch reaches every scope, workers and the HTTP header included,
 * and keeps Chrome's own brand list. It also empties the high-entropy Client
 * Hints; the driver presents this machine's real values in their place. As on
 * Linux, a browser whose version cannot be read still launches with its own
 * User-Agent rather than one naming a guessed version. */
export async function macosOffscreenChromeArguments(
  executable: string,
  probes: {
    chromeMajorVersion?: (executable: string) => Promise<number>;
    mainDisplay?: () => Promise<MacosDisplayGeometry>;
  } = {},
): Promise<string[]> {
  const [major, display] = await Promise.all([
    (probes.chromeMajorVersion ?? chromeMajorVersion)(executable).catch(() => null),
    (probes.mainDisplay ?? macosMainDisplay)(),
  ]);
  // --screen-info sizes are device pixels; Chrome divides them by
  // devicePixelRatio. The display is measured in points, so a Retina screen
  // passed as-is would present half its real size (smaller than the window).
  const pixels = (points: number) => Math.round(points * display.scale);
  const screen = `--screen-info={${pixels(display.width)}x${pixels(display.height)} devicePixelRatio=${display.scale} workAreaLeft=${pixels(display.insets.left)} workAreaRight=${pixels(display.insets.right)} workAreaTop=${pixels(display.insets.top)} workAreaBottom=${pixels(display.insets.bottom)}}`;
  if (major === null) return [screen];
  return [
    `--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    screen,
  ];
}

/** A common Linux desktop: a 1080p monitor under a GNOME-style top bar. A
 * headless browser has no display to measure, and Chrome's own 800x600
 * screen with no work area is a well-known headless signal. */
const LINUX_HEADLESS_SCREEN = "{1920x1080 devicePixelRatio=1 workAreaTop=32}";

/** Arguments that make a headless managed Chrome on Linux present like an
 * ordinary desktop Chrome: the reduced User-Agent every desktop Linux Chrome
 * sends (always "X11; Linux x86_64"), instead of one naming HeadlessChrome,
 * and a desktop screen. Same reasoning as the macOS offscreen arguments. A
 * browser whose version cannot be read still launches, keeping its own
 * User-Agent rather than one naming a guessed version. */
export async function linuxHeadlessChromeArguments(
  executable: string,
  probes: { chromeMajorVersion?: (executable: string) => Promise<number> } = {},
): Promise<string[]> {
  const major = await (probes.chromeMajorVersion ?? chromeMajorVersion)(executable).catch(
    () => null,
  );
  const screen = `--screen-info=${LINUX_HEADLESS_SCREEN}`;
  if (major === null) return [screen];
  return [
    `--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    screen,
  ];
}

export type MacosDisplayGeometry = {
  width: number;
  height: number;
  scale: number;
  insets: { left: number; right: number; top: number; bottom: number };
};

/** A common built-in MacBook display, used only when the window server
 * cannot be queried (for example, no logged-in GUI session). */
const FALLBACK_MACOS_DISPLAY: MacosDisplayGeometry = {
  width: 1512,
  height: 982,
  scale: 2,
  insets: { left: 0, right: 0, top: 38, bottom: 0 },
};

const MACOS_DISPLAY_SCRIPT =
  "ObjC.import('AppKit');var s=$.NSScreen.screens.objectAtIndex(0);var f=s.frame;var v=s.visibleFrame;" +
  "JSON.stringify({w:f.size.width,h:f.size.height,x:v.origin.x-f.origin.x,y:v.origin.y-f.origin.y," +
  "vw:v.size.width,vh:v.size.height,scale:s.backingScaleFactor})";

/** The primary display (the one with the menu bar) in points, with its Dock
 * and menu-bar insets. Cocoa's visible frame is measured from the bottom. */
async function macosMainDisplay(): Promise<MacosDisplayGeometry> {
  const output = await boundedProcessOutput("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    MACOS_DISPLAY_SCRIPT,
  ]);
  return parseMacosDisplayGeometry(output) ?? FALLBACK_MACOS_DISPLAY;
}

export function parseMacosDisplayGeometry(output: string): MacosDisplayGeometry | null {
  let value: unknown;
  try {
    value = JSON.parse(output.trim());
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const number = (key: string) => {
    const entry = record[key];
    return typeof entry === "number" && Number.isFinite(entry) ? Math.round(entry) : null;
  };
  const width = number("w");
  const height = number("h");
  const x = number("x");
  const y = number("y");
  const visibleWidth = number("vw");
  const visibleHeight = number("vh");
  const scale = record.scale;
  if (
    width === null ||
    height === null ||
    x === null ||
    y === null ||
    visibleWidth === null ||
    visibleHeight === null ||
    typeof scale !== "number" ||
    !(scale >= 1 && scale <= 4) ||
    width < 320 ||
    height < 240 ||
    width > 16_384 ||
    height > 16_384
  )
    return null;
  const insets = {
    left: x,
    right: width - x - visibleWidth,
    top: height - y - visibleHeight,
    bottom: y,
  };
  if (Object.values(insets).some((inset) => inset < 0 || inset > Math.min(width, height) / 2))
    return null;
  return { width, height, scale, insets };
}

/** Major versions keyed by executable path and modification time, so each
 * launch does not start the browser again just to read its version, and an
 * upgraded browser is read afresh. */
const chromeMajorVersions = new Map<string, number>();

async function chromeMajorVersion(executable: string): Promise<number> {
  const key = `${executable}\0${(await fileStatus(executable)).mtimeMs}`;
  const cached = chromeMajorVersions.get(key);
  if (cached !== undefined) return cached;
  const major = await readChromeMajorVersion(executable);
  chromeMajorVersions.set(key, major);
  return major;
}

async function readChromeMajorVersion(executable: string): Promise<number> {
  // An application bundle records its version without starting the browser.
  const bundleInfo = join(dirname(dirname(executable)), "Info.plist");
  try {
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)\./u.exec(
      await readFile(bundleInfo, "utf8"),
    );
    if (match) return Number(match[1]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const match = /(?:^|\s)(\d+)\.\d+\.\d+\.\d+/u.exec(
    await boundedProcessOutput(executable, ["--version"]),
  );
  if (!match) throw new Error("managed browser version is unavailable");
  return Number(match[1]);
}

/** `managerEnvironment` is the bus environment the probe reached the user
 * manager with. A browser linked to a computer session launches with that
 * desktop's private D-Bus and runtime directory, where no systemd manager
 * answers, so the scope request always uses the probed manager instead. */
export type LinuxUserScopeLauncher = {
  systemdRun: string;
  busctl: string;
  managerEnvironment: { DBUS_SESSION_BUS_ADDRESS: string; XDG_RUNTIME_DIR?: string };
};

/** A transient scope is used only when this process can create one. The probe
 * performs exactly the launch's own operation (a throwaway `systemd-run
 * --scope`), because a reachable manager is not enough: from another PID
 * namespace, a container for example, the manager answers bus calls but
 * cannot place the caller's PID. Otherwise the browser launches as before. */
async function linuxUserScopeLauncher(): Promise<LinuxUserScopeLauncher | null> {
  if (!process.env.XDG_RUNTIME_DIR && !process.env.DBUS_SESSION_BUS_ADDRESS) return null;
  const systemdRun = await firstExecutableInPath(["systemd-run"]);
  const busctl = await firstExecutableInPath(["busctl"]);
  const shell = await firstExecutable(["/bin/sh"]);
  if (!systemdRun || !busctl || !shell) return null;
  const scopeCreated = await processSucceeds(
    systemdRun,
    [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--property=Delegate=yes",
      `--slice=${BROWSER_SCOPE_SLICE}`,
      `--unit=opengeni-browser-probe-${randomUUID()}.scope`,
      "--",
      shell,
      "-c",
      "exit 0",
    ],
    SYSTEMD_PROBE_TIMEOUT_MS,
  );
  if (!scopeCreated) return null;
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  return {
    systemdRun,
    busctl,
    managerEnvironment: {
      DBUS_SESSION_BUS_ADDRESS:
        process.env.DBUS_SESSION_BUS_ADDRESS ?? `unix:path=${runtimeDirectory}/bus`,
      ...(runtimeDirectory ? { XDG_RUNTIME_DIR: runtimeDirectory } : {}),
    },
  };
}

/** Chromium moves its own browser process into an `app-<id>-<pid>.scope` at
 * startup for desktop-portal identification, leaving only its children in the
 * launch scope. Once the launch is proven, bring the browser process back so
 * the browser's whole process tree is one unit. Best effort: the browser is
 * already outside the agent service either way. */
async function collectBrowserIntoScope(scope: LinuxBrowserScope, pid: number): Promise<void> {
  if (await processInScope(pid, scope.unit)) return;
  await processSucceeds(
    scope.busctl,
    [
      "--user",
      "call",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "AttachProcessesToUnit",
      "ssau",
      scope.unit,
      "/",
      "1",
      String(pid),
    ],
    SYSTEMD_PROBE_TIMEOUT_MS,
  );
}

async function processInScope(pid: number, unit: string): Promise<boolean> {
  try {
    const cgroup = await readFile(`/proc/${pid}/cgroup`, "utf8");
    return cgroup
      .split("\n")
      .some((line) => line.startsWith("0::") && line.split("/").includes(unit));
  } catch {
    return false;
  }
}

async function processSucceeds(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<boolean> {
  const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  timer.unref?.();
  try {
    const code = await new Promise<number | null>((resolveExit) => {
      child.once("error", () => resolveExit(null));
      child.once("close", resolveExit);
    });
    return code === 0;
  } finally {
    clearTimeout(timer);
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
  processCommandLines?: () => Promise<LinuxProcessCommandLines>;
}): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  const recordedPid = await readManagedBrowserPid(input.pidFile);
  const discovered =
    recordedPid === null &&
    process.platform === "linux" &&
    (input.executablePath !== null || input.discoverByProfile === true)
      ? await findLinuxManagedBrowserProcess(
          input.profileDirectory,
          input.executablePath,
          false,
          await input.processCommandLines?.(),
        )
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
  const daemon = await launchingAgentBrowserDaemon(pid);
  signalProcess(pid, "SIGTERM");
  if (!(await waitForProcessStop(pid, DAEMON_STOP_TIMEOUT_MS))) {
    await assertManagedBrowserIdentity(pid, input.profileDirectory, executablePath, startTime);
    signalProcess(pid, "SIGKILL");
    if (!(await waitForProcessStop(pid, DAEMON_STOP_TIMEOUT_MS))) {
      throw new AgentBrowserCommandError("process_failed", "managed browser did not terminate");
    }
  }
  await stopLaunchingAgentBrowserDaemon(daemon);
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

export type LinuxProcessCommandLines = ReadonlyArray<{ pid: number; commandLine: Uint8Array }>;

/** A point-in-time procfs command-line inventory used only to preselect
 * candidates; every candidate is still fully identity-checked. */
async function readLinuxProcessCommandLines(): Promise<LinuxProcessCommandLines> {
  const inventory: { pid: number; commandLine: Uint8Array }[] = [];
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      inventory.push({ pid, commandLine: await readFile(`/proc/${pid}/cmdline`) });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (["EACCES", "EINVAL", "ENOENT", "EPERM", "ESRCH"].includes(code)) continue;
      throw error;
    }
  }
  return inventory;
}

async function findLinuxManagedBrowserProcess(
  profileDirectory: string,
  executablePath: string | null,
  requireCompleteInventory = false,
  inventory?: LinuxProcessCommandLines,
): Promise<LinuxManagedBrowserIdentity | null> {
  const matches: LinuxManagedBrowserIdentity[] = [];
  const profileArgument = Buffer.from(`--user-data-dir=${resolve(profileDirectory)}`);
  // Both the argv and the rewritten-title representations contain the exact
  // profile switch bytes, so the inventory can only exclude non-matches.
  const pids =
    inventory !== undefined && !requireCompleteInventory
      ? inventory
          .filter((entry) => Buffer.from(entry.commandLine).includes(profileArgument))
          .map((entry) => entry.pid)
      : (await readdir("/proc", { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && /^[1-9][0-9]*$/u.test(entry.name))
          .map((entry) => Number(entry.name));
  for (const pid of pids) {
    if (requireCompleteInventory) {
      try {
        // Only the command line is evidence here. The executable link of
        // another user's (or root's) process is unreadable to an unprivileged
        // agent, and it says nothing about which profile the process uses, so
        // requiring it made absence unprovable on any real Linux host.
        const commandLine = await readFile(`/proc/${pid}/cmdline`);
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

async function boundedProcessOutput(
  command: string,
  args: readonly string[],
  limits: { maxBytes: number; timeoutMs: number } = {
    maxBytes: MAX_PROCESS_QUERY_BYTES,
    timeoutMs: PROCESS_QUERY_TIMEOUT_MS,
  },
): Promise<string> {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes <= limits.maxBytes) chunks.push(chunk);
    else {
      overflow = true;
      child.kill("SIGKILL");
    }
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), limits.timeoutMs);
  timer.unref?.();
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  }).finally(() => clearTimeout(timer));
  if (overflow || code !== 0) return "";
  return Buffer.concat(chunks).toString("utf8");
}

/** Whether this managed browser opens a native window. */
function windowedBrowser(
  options: Pick<ManagedBrowserRunnerOptions, "headed" | "offscreen">,
): boolean {
  return options.headed && options.offscreen !== true;
}

/** Where a headed managed browser is shown. */
export type ManagedBrowserDisplay = "window" | "offscreen";

/** The display a launch with these options gets: the same choice that adds
 * or leaves out --headless=new in managedChromeArguments. */
export function managedBrowserDisplay(
  options: Pick<ManagedBrowserRunnerOptions, "headed" | "offscreen">,
): ManagedBrowserDisplay | null {
  if (!options.headed) return null;
  return windowedBrowser(options) ? "window" : "offscreen";
}

/** Chrome's environment: only the machine basics a browser needs, the
 * caller's explicit additions, and the route's timezone. */
function launchEnvironment(
  options: ManagedBrowserRunnerOptions,
  browserLaunch: ManagedBrowserLaunch | undefined,
  browserPidFile: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  Object.assign(environment, options.environment);
  if (options.timezone) environment.TZ = supportedTimezone(options.timezone);
  if (browserLaunch?.backgroundBrowserExecutable) {
    environment.OPENGENI_BACKGROUND_BROWSER_EXECUTABLE = browserLaunch.backgroundBrowserExecutable;
    environment.OPENGENI_BACKGROUND_BROWSER_PID_FILE = browserPidFile;
  }
  return environment;
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
): string[] {
  const policy = browserProfileCryptoPolicy(platform);
  const profileCryptoArgument =
    policy === "chromium_basic"
      ? "--password-store=basic"
      : policy === "chromium_mock_keychain"
        ? "--use-mock-keychain"
        : null;
  const validatedAdditional = additional.map((argument) => {
    if (!argument.startsWith("--") || argument.length > 512 || /[\r\n\0]/u.test(argument)) {
      throw new Error("browser launch argument is invalid");
    }
    return argument;
  });
  if (validatedAdditional.length > 32) {
    throw new Error("too many browser launch arguments");
  }
  // Chromium honors only the last `--enable-features` switch, so an additional
  // one is folded into the managed switch instead of replacing it.
  const enabledFeatures = ["CDPScreenshotNewSurface"];
  const remainingAdditional = validatedAdditional.filter((argument) => {
    if (!argument.startsWith("--enable-features=")) return true;
    for (const feature of argument.slice("--enable-features=".length).split(",")) {
      if (feature && !enabledFeatures.includes(feature)) enabledFeatures.push(feature);
    }
    return false;
  });
  return [
    "--restore-last-session",
    // Compiled Chromium testing experiments can alter offscreen rendering.
    // Keep managed automation on the browser's deterministic default behavior.
    "--disable-field-trial-config",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    // Chromium's on-demand local AI model downloads (see
    // MANAGED_CHROME_DISABLED_FEATURES). Launches through the stderr wrapper
    // replace this switch with the complete list; the rest keep this one.
    "--disable-features=OptimizationGuideOnDeviceModel",
    // Chromium's free-disk-derived default can retain gigabytes per actor.
    // Bound disposable HTTP caching without limiting cookies or site storage.
    "--disk-cache-size=67108864",
    // Chromium reports navigator.webdriver=true whenever it is remotely
    // debugged. Managed browsers act for a signed-in person, and sites treat
    // that flag as a bot signal (rate-limited or refused logins).
    "--disable-blink-features=AutomationControlled",
    // Chromium's presentation-fenced screenshot path waits for the redraw to
    // be shown, which never happens for a tab another tab covers in its window
    // (headed or headless), so captures of background agent tabs stalled.
    // Copy a freshly repainted surface instead, without raising the browser or
    // changing the window's active tab.
    `--enable-features=${enabledFeatures.join(",")}`,
    platform === "linux" ? "--test-type" : null,
    // Linux machines that run managed browsers rarely have a GPU, and Chromium
    // turns WebGL off entirely on software rendering. Sites that need WebGL
    // (maps, editors, many bot challenges) then break, and a browser with no
    // WebGL context is itself a strong bot signal. Allow the host's software
    // OpenGL (Mesa llvmpipe) when the display provides GLX, and otherwise fall
    // back to Chromium's bundled SwiftShader. A real GPU is still preferred.
    platform === "linux" ? "--ignore-gpu-blocklist" : null,
    platform === "linux" ? "--enable-unsafe-swiftshader" : null,
    profileCryptoArgument,
    ...remainingAdditional,
  ].filter((value): value is string => value !== null);
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

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_COMMAND_TIMEOUT_MS) {
    throw new Error("browser command timeout must be a positive bounded integer");
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
    // Never infer absence of a successor from a missing pid alone: a complete
    // process inventory must show that nothing else runs the exact profile.
    await assertManagedBrowserProfileUnused(receipt.profileDirectory);
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

function browserLineageUnavailable(): AgentBrowserCommandError {
  return new AgentBrowserCommandError("process_failed", "owned browser lineage is unproven");
}

async function readProfileBrowserPid(profileDirectory: string): Promise<number> {
  const path = join(profileDirectory, "SingletonLock");
  const before = await lstat(path);
  if (!before.isSymbolicLink()) throw browserLineageUnavailable();
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
    throw browserLineageUnavailable();
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
    throw browserLineageUnavailable();
  return parent;
}

async function processExecutablePath(pid: number): Promise<string> {
  const path =
    process.platform === "linux"
      ? await readlink(`/proc/${pid}/exe`)
      : (await boundedProcessOutput("/bin/ps", ["-p", String(pid), "-o", "comm="])).trim();
  if (!path || !path.startsWith("/")) throw browserLineageUnavailable();
  return await realpath(path);
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

/** Stop whatever browser an explicitly ended session left running after its
 * controller lost track of it, so the session's private profile can be
 * removed. The recorded process is signalled only while its PID birth and
 * exact profile still identify it, so a reused PID is never touched. On Linux
 * any other browser still running that exact private profile is found the
 * same way and stopped too. */
export async function stopEndedManagedBrowserProcess(
  profileDirectory: string,
  recorded: OwnedManagedBrowserProcess | null,
): Promise<void> {
  if (recorded && (await processRunning(recorded.pid))) {
    let birth: string | null = null;
    try {
      birth = await processBirth(recorded.pid);
    } catch {
      birth = null;
    }
    if (birth === recorded.birth) {
      await assertManagedBrowserIdentity(
        recorded.pid,
        recorded.profileDirectory,
        recorded.executablePath,
      );
      const daemon = await launchingAgentBrowserDaemon(recorded.pid);
      await stopIdentifiedProcess(recorded.pid);
      await stopLaunchingAgentBrowserDaemon(daemon);
    }
  }
  if (process.platform === "linux") {
    let stopped = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const survivor = await findLinuxManagedBrowserProcess(profileDirectory, null);
      if (!survivor) {
        stopped = true;
        break;
      }
      const daemon = await launchingAgentBrowserDaemon(survivor.pid);
      await stopIdentifiedProcess(survivor.pid);
      await stopLaunchingAgentBrowserDaemon(daemon);
    }
    if (!stopped)
      throw new AgentBrowserCommandError(
        "process_failed",
        "a browser kept running the ended session's private profile",
      );
  }
  // A browser that had already exited leaves its launching daemon behind
  // with no parent to find it through; find it by the profile it serves.
  // The end itself never depends on this: the browser is already stopped.
  await stopOrphanedAgentBrowserDaemons(profileDirectory).catch(() => undefined);
}

/* Releases before the controller launched Chrome itself started every managed
 * browser through an agent-browser daemon. Such a browser can still be running
 * (a connected machine keeps its browsers across an agent update), and its
 * daemon does not exit with it. The helpers below find and stop those legacy
 * daemons; nothing launches one any more.
 *
 * The agent-browser executable as installed (agent-browser) or as shipped per
 * platform (agent-browser-darwin-arm64 and so on). */
const AGENT_BROWSER_EXECUTABLE_NAME = /^agent-browser(?:-[a-z0-9-]+)?(?:\.exe)?$/u;

type LaunchingAgentBrowserDaemon = { pid: number; birth: string };

/** The agent-browser daemon that launched an identified managed browser: the
 * browser's parent, while that parent runs an agent-browser executable. A
 * daemon has no idle timeout and does not exit when its browser does, so a
 * controller that lost track of a session (for example after an agent update
 * replaced the runtime) must stop it with the browser, or it runs forever. */
async function launchingAgentBrowserDaemon(
  browserPid: number,
): Promise<LaunchingAgentBrowserDaemon | null> {
  try {
    const pid = await processParentPid(browserPid);
    if (pid === process.pid) return null;
    const birth = await processBirth(pid);
    if (!AGENT_BROWSER_EXECUTABLE_NAME.test(await processExecutableName(pid))) return null;
    if ((await processParentPid(browserPid)) !== pid) return null;
    return { pid, birth };
  } catch {
    return null;
  }
}

/** Stop a launching daemon found before its browser was stopped, only while
 * its PID birth still identifies it, so a reused PID is never signalled. */
async function stopLaunchingAgentBrowserDaemon(
  daemon: LaunchingAgentBrowserDaemon | null,
): Promise<void> {
  if (!daemon || !(await processRunning(daemon.pid))) return;
  try {
    if ((await processBirth(daemon.pid)) !== daemon.birth) return;
  } catch {
    return;
  }
  await stopIdentifiedProcess(daemon.pid);
}

/** The file name of a process's executable, including one an upgrade has
 * since removed (Linux reports it with a " (deleted)" suffix). */
async function processExecutableName(pid: number): Promise<string> {
  const path =
    process.platform === "linux"
      ? (await readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/u, "")
      : (await boundedProcessOutput("/bin/ps", ["-p", String(pid), "-o", "comm="])).trim();
  return basename(path);
}

/** Read-only proof that no process is running a browser on this exact private
 * profile, with the same standard as an exact-directory relaunch: a complete
 * process inventory on Linux and macOS; elsewhere absence is unproven and
 * refused. */
export async function assertManagedBrowserProfileUnused(profileDirectory: string): Promise<void> {
  if (process.platform === "linux") {
    if (await findLinuxManagedBrowserProcess(profileDirectory, null, true)) {
      throw new AgentBrowserCommandError(
        "process_failed",
        "another process owns the exact profile",
      );
    }
    return;
  }
  if (process.platform === "darwin") {
    await assertNoDarwinProcessNamesProfile(profileDirectory);
    return;
  }
  throw new AgentBrowserCommandError("process_failed", "exact profile absence is unproven");
}

/** The macOS counterpart of the Linux procfs inventory: one listing of every
 * process with its full command line. Any mention of the exact profile switch
 * refuses, as on Linux. A process whose arguments the system withholds is
 * shown as "(name)"; that happens only for another user's process, which
 * cannot open a profile that is private to this user, so it is accepted only
 * while the profile is owned by this user and closed to everyone else. */
async function assertNoDarwinProcessNamesProfile(profileDirectory: string): Promise<void> {
  const profile = resolve(profileDirectory);
  const listing = await boundedProcessOutput(
    "/bin/ps",
    ["-axww", "-o", "pid=,uid=,command="],
    PROCESS_INVENTORY_LIMITS,
  );
  if (!listing.trim()) {
    throw new AgentBrowserCommandError(
      "process_failed",
      "exact profile process inventory is incomplete",
    );
  }
  const profileArgument = `--user-data-dir=${profile}`;
  const uid = process.getuid?.();
  let withheld = false;
  for (const line of listing.split("\n")) {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s(.*)$/u.exec(line);
    if (!match) continue;
    const command = match[3]!.trim();
    if (command.includes(profileArgument)) {
      throw new AgentBrowserCommandError(
        "process_failed",
        "exact directory launch absence is unproven",
      );
    }
    if (/^\(.*\)$/u.test(command) && Number(match[2]) !== uid) withheld = true;
  }
  if (!withheld) return;
  const metadata = await lstat(profile);
  if (metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
    throw new AgentBrowserCommandError(
      "process_failed",
      "exact profile process inventory is incomplete",
    );
  }
}

type AgentBrowserDaemonProcess = {
  pid: number;
  birth: string;
  profileDirectory: string | null;
  socketDirectory: string | null;
  ageMs: number | null;
  hasLiveChildren: boolean;
};

/** Every agent-browser daemon this user runs, identified from the live
 * process itself: an agent-browser executable started with the daemon
 * environment agent-browser gives it, including the exact profile and socket
 * directory it serves. A PID record can outlive its daemon or name a reused
 * PID; a process's own environment cannot. */
async function agentBrowserDaemonProcesses(): Promise<AgentBrowserDaemonProcess[]> {
  if (process.platform === "linux") return await linuxAgentBrowserDaemonProcesses();
  if (process.platform === "darwin") return await darwinAgentBrowserDaemonProcesses();
  return [];
}

async function linuxAgentBrowserDaemonProcesses(): Promise<AgentBrowserDaemonProcess[]> {
  const liveChildren = new Set<number>();
  const candidates: { pid: number; startTicks: number }[] = [];
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    let fields: string[];
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/u);
    } catch {
      continue;
    }
    if (fields[0] !== "Z") liveChildren.add(Number(fields[1]));
    let executable: string;
    try {
      // Another user's executable link is unreadable; such a process is
      // never one of this user's daemons.
      executable = await readlink(`/proc/${pid}/exe`);
    } catch {
      continue;
    }
    if (!AGENT_BROWSER_EXECUTABLE_NAME.test(basename(executable.replace(/ \(deleted\)$/u, ""))))
      continue;
    candidates.push({ pid, startTicks: Number(fields[19]) });
  }
  if (candidates.length === 0) return [];
  const uptimeSeconds = Number((await readFile("/proc/uptime", "utf8")).split(/\s+/u)[0]);
  const daemons: AgentBrowserDaemonProcess[] = [];
  for (const candidate of candidates) {
    let environment: Map<string, string>;
    let birth: string;
    try {
      environment = new Map(
        (await readFile(`/proc/${candidate.pid}/environ`, "utf8")).split("\0").map((entry) => {
          const separator = entry.indexOf("=");
          return [entry.slice(0, separator), entry.slice(separator + 1)] as [string, string];
        }),
      );
      birth = await processBirth(candidate.pid);
    } catch {
      continue;
    }
    if (environment.get("AGENT_BROWSER_DAEMON") !== "1") continue;
    // Linux reports process start in clock ticks of USER_HZ, which is 100 on
    // every supported architecture.
    const ageMs =
      Number.isFinite(uptimeSeconds) && Number.isFinite(candidate.startTicks)
        ? Math.round((uptimeSeconds - candidate.startTicks / 100) * 1000)
        : null;
    daemons.push({
      pid: candidate.pid,
      birth,
      profileDirectory: environment.get("AGENT_BROWSER_PROFILE") ?? null,
      socketDirectory: environment.get("AGENT_BROWSER_SOCKET_DIR") ?? null,
      ageMs,
      hasLiveChildren: liveChildren.has(candidate.pid),
    });
  }
  return daemons;
}

async function darwinAgentBrowserDaemonProcesses(): Promise<AgentBrowserDaemonProcess[]> {
  const listing = await boundedProcessOutput(
    "/bin/ps",
    ["-axww", "-o", "pid=,ppid=,uid=,stat=,etime=,comm="],
    PROCESS_INVENTORY_LIMITS,
  );
  if (!listing.trim()) {
    throw new AgentBrowserCommandError("process_failed", "process inventory is unavailable");
  }
  const uid = process.getuid?.();
  const liveChildren = new Set<number>();
  const candidates: { pid: number; ageMs: number | null }[] = [];
  for (const line of listing.split("\n")) {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+(\S+)\s+(\S+)\s(.*)$/u.exec(line);
    if (!match) continue;
    if (!match[4]!.startsWith("Z")) liveChildren.add(Number(match[2]));
    if (Number(match[3]) !== uid) continue;
    if (!AGENT_BROWSER_EXECUTABLE_NAME.test(basename(match[6]!.trim()))) continue;
    candidates.push({ pid: Number(match[1]), ageMs: darwinElapsedMs(match[5]!) });
  }
  const daemons: AgentBrowserDaemonProcess[] = [];
  for (const candidate of candidates) {
    // `ps -E` appends the process environment to its command line. A daemon
    // is started without arguments, so every later word is NAME=value.
    const described = (
      await boundedProcessOutput(
        "/bin/ps",
        ["-E", "-ww", "-o", "command=", "-p", String(candidate.pid)],
        PROCESS_ENVIRONMENT_LIMITS,
      )
    ).trim();
    if (!/(?:^| )AGENT_BROWSER_DAEMON=1(?: |$)/u.test(described)) continue;
    let birth: string;
    try {
      birth = await processBirth(candidate.pid);
    } catch {
      continue;
    }
    daemons.push({
      pid: candidate.pid,
      birth,
      profileDirectory: darwinEnvironmentValue(described, "AGENT_BROWSER_PROFILE"),
      socketDirectory: darwinEnvironmentValue(described, "AGENT_BROWSER_SOCKET_DIR"),
      ageMs: candidate.ageMs,
      hasLiveChildren: liveChildren.has(candidate.pid),
    });
  }
  return daemons;
}

function darwinEnvironmentValue(described: string, name: string): string | null {
  const match = new RegExp(`(?:^| )${name}=(.*?)(?= [A-Za-z_][A-Za-z0-9_]*=|$)`, "u").exec(
    described,
  );
  return match?.[1] || null;
}

/** `ps` elapsed time, formatted [[dd-]hh:]mm:ss. */
function darwinElapsedMs(value: string): number | null {
  const match = /^(?:(?:([0-9]+)-)?([0-9]+):)?([0-9]+):([0-9]+)$/u.exec(value);
  if (!match) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  return (((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!) * 1000;
}

/** Stop an identified daemon only while its PID birth still identifies it, so
 * a reused PID is never signalled. */
async function stopAgentBrowserDaemon(daemon: AgentBrowserDaemonProcess): Promise<void> {
  if (!(await processRunning(daemon.pid))) return;
  try {
    if ((await processBirth(daemon.pid)) !== daemon.birth) return;
  } catch {
    return;
  }
  await stopIdentifiedProcess(daemon.pid);
}

/** Stop every agent-browser daemon started for this exact private profile (or
 * socket directory). Called only once no process runs the profile, so each
 * one's browser is gone and it has nothing left to serve. A daemon that still
 * has a running child is refused rather than stopped. */
async function stopOrphanedAgentBrowserDaemons(
  profileDirectory: string,
  socketDirectory?: string,
): Promise<void> {
  const profile = resolve(profileDirectory);
  const socket = socketDirectory === undefined ? null : resolve(socketDirectory);
  for (const daemon of await agentBrowserDaemonProcesses()) {
    if (
      daemon.profileDirectory !== profile &&
      (socket === null || daemon.socketDirectory !== socket)
    )
      continue;
    if (daemon.hasLiveChildren)
      throw new AgentBrowserCommandError(
        "process_failed",
        "an agent-browser daemon for this profile still runs a child process",
      );
    await stopAgentBrowserDaemon(daemon);
  }
}

/** Startup reconciliation for agent-browser daemons whose browser is gone.
 * A daemon does not exit with its browser, so one whose controller died or
 * lost track of it (a crash, or an agent update that replaced the runtime)
 * would otherwise run forever. Only daemons started for a profile under this
 * controller's own sessions directory, with no child process and old enough
 * to have finished starting a browser, are stopped. A daemon whose browser
 * still runs is left for recovery or an explicit end. Returns how many were
 * stopped. */
export async function reapOrphanedAgentBrowserDaemons(
  rootDirectory: string,
  options: { minAgeMs?: number } = {},
): Promise<number> {
  const minAgeMs = options.minAgeMs ?? ORPHANED_DAEMON_MIN_AGE_MS;
  const sessions = `${join(resolve(rootDirectory), "sessions")}/`;
  let stopped = 0;
  for (const daemon of await agentBrowserDaemonProcesses()) {
    if (
      !daemon.profileDirectory?.startsWith(sessions) ||
      daemon.hasLiveChildren ||
      daemon.ageMs === null ||
      daemon.ageMs < minAgeMs
    )
      continue;
    try {
      await stopAgentBrowserDaemon(daemon);
      stopped += 1;
    } catch {
      // One daemon that cannot be stopped must not keep the others running.
    }
  }
  return stopped;
}

async function stopIdentifiedProcess(pid: number): Promise<void> {
  signalProcess(pid, "SIGTERM");
  if (await waitForProcessStop(pid, DAEMON_STOP_TIMEOUT_MS)) return;
  signalProcess(pid, "SIGKILL");
  if (!(await waitForProcessStop(pid, DAEMON_STOP_TIMEOUT_MS))) {
    throw new AgentBrowserCommandError("process_failed", "owned browser did not terminate");
  }
}

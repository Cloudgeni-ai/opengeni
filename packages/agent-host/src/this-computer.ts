import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { dirname, join } from "node:path";

import type {
  ThisComputerConnectOptions,
  ThisComputerErrorCode,
  ThisComputerPermission,
  ThisComputerPermissionId,
  ThisComputerStatus,
} from "@opengeni/sdk/this-computer";
import {
  MAC_FOLDERS_ALLOWED_ENV,
  macSystemNames,
  type MacSystemNameCatalog,
} from "@opengeni/sdk/this-computer";
import { normalizeServerUrl } from "@opengeni/sdk/app-links";
import {
  connectionFor,
  hostedAgentPath,
  lastErrorLine,
  parseAgentVersion,
  parseConnections,
  parsePermissions,
  standaloneMacAgentApp,
  type AgentConnection,
  type AgentPermissionId,
  type AgentPlatform,
} from "./agent-cli";
import { agentAssetName, signedHash, verifyAgentSignature } from "./agent-download";
import { computerName } from "./computer-name";
import { HostedAgent, type AgentChild } from "./hosted-agent";
import { parseAgentServiceStatus, type AgentServiceStatus } from "./agent-service";

interface RunResult {
  code: number;
  output: string;
  /** Killed for running past its time limit. */
  timedOut: boolean;
}

/** Marks the agent as the app's helper: the app asks for permissions and restarts it. */
const HOST_ENV = { OPENGENI_AGENT_HOST: "desktop-app" };

/** A failure the screens can explain in their own words; `message` stays plain English. */
export class ThisComputerError extends Error {
  constructor(
    readonly code: ThisComputerErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ThisComputerError";
  }
}

function run(
  file: string,
  args: readonly string[],
  options: { env?: Record<string, string>; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        env: { ...process.env, ...HOST_ENV, ...options.env },
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        const timedOut = Boolean(error?.killed);
        resolve({ code, output: `${stdout}\n${stderr}`, timedOut });
      },
    );
  });
}

export interface ThisComputerDeps {
  platform: AgentPlatform;
  /** The processor, as Node names it (`arm64`, `x64`). */
  arch: string;
  home: string;
  env: Record<string, string | undefined>;
  /** The agent releases' minisign public key (the `RW…` line); downloads must carry its signature. */
  agentSigningKey: string;
  /** Fetches with the app's network stack (proxies, certificates), following redirects. */
  fetch(url: string): Promise<Response>;
  /** The app's own data folder, for its small state file. */
  dataDir: string;
  /**
   * The system's preferred languages, most preferred first (Electron's
   * `app.getPreferredSystemLanguages()`), so screens can quote what the
   * system calls things in its own language. English names when absent.
   */
  systemLanguages?(): readonly string[];
  /**
   * What macOS calls things in the languages the app translates for (see
   * `macSystemNames`). English is built in.
   */
  systemNames?: MacSystemNameCatalog;
  /** Where the agent's log goes. */
  logDir: string;
  /**
   * Where the app keeps the agent it runs. By default the place the
   * command-line installer uses, so there is one agent per person. An app
   * that keeps its own agent apart from any other passes its own path.
   */
  agentPath?: string;
  /**
   * `agentPath` ships inside the app (e.g. a store package, where the app
   * can't run code it downloads): it is never downloaded and updates with the
   * app instead.
   */
  bundledAgent?: boolean;
  /**
   * The agent's own config folder (its machine identity and connections).
   * By default the agent's usual one; an app with its own agent passes its own.
   */
  agentConfigDir?: string;
  /**
   * Reuse a separately installed agent through its existing service. Default
   * true; an isolated app with its own agent leaves other agents alone.
   */
  adoptStandaloneAgent?: boolean;
  /**
   * On macOS, once the app has adopted an agent that runs as a background
   * service (e.g. set up from the web app's install command), run that same
   * agent as the app's own helper instead: the system then attributes its
   * screen and input permissions to the app, so one set of grants covers the
   * app and computer use. Same agent, same connections and registration; the
   * service is turned off, not removed, and is turned back on if the app's
   * helper doesn't start. Only for an app that keeps running in the
   * background and opens at login while this computer is in use. Default false.
   */
  hostServiceAgent?: boolean;
  /** How long a newly hosted agent must stay up to count as started. */
  hostedSettleMs?: number;
  /**
   * Read the enrolled machine as the server lists it, never a child-process
   * TCC probe. Resolve null only when the server answered and doesn't list
   * this enrollment (it was removed there); reject when it couldn't be read
   * (offline, signed out, a server error), so the screens can tell those apart.
   */
  readMachine?(
    accountId: string,
    baseUrl: string,
    workspaceId: string,
    enrollmentId: string,
  ): Promise<{
    online: boolean;
    screenControl: boolean;
    permissions: Partial<Record<AgentPermissionId, boolean>> | null;
  } | null>;
  enableScreenControl?(accountId: string, workspaceId: string, enrollmentId: string): Promise<void>;
  /**
   * Let the Opengeni Browser Chrome extension reach this agent, so agents can
   * work in the person's own Chrome. Default true. An app whose people don't
   * use that extension turns it off: its agent then leaves the extension to
   * any other agent on the computer.
   */
  browserExtension?: boolean;
  /**
   * IDs of the app's own Chrome extensions (its branded build of the Opengeni
   * Browser extension) that may reach this agent besides Opengeni Browser.
   * Each is Chrome's 32-letter extension ID. Ignored when `browserExtension`
   * is false.
   */
  browserExtensionIds?: readonly string[];
  /**
   * What the person lets the app's agent do on this computer, read every time
   * the agent starts. `screenControl: false` starts it without the screen (no
   * capture, no input, no question to the system); `browserExtension: false`
   * removes its Chrome extension bridge. Absent: both on. Call
   * `agentSwitchesChanged` after a change. A separately installed agent
   * service isn't started by the app, so these don't reach it.
   */
  agentSwitches?(): { screenControl: boolean; browserExtension: boolean };
  /** A single-use personal enroll token for the account's workspace. */
  mintEnrollToken(accountId: string, workspaceId: string, screenControl: boolean): Promise<string>;
  /**
   * Lets the account's agents use this computer (its enrollment) in their
   * chats in the workspace, without asking again in every chat.
   */
  allowAgents(accountId: string, workspaceId: string, enrollmentId: string): Promise<void>;
  /**
   * Takes back what `allowAgents` gave in one workspace, while other
   * workspaces keep using this computer. Without it, turning the computer off
   * in one workspace disconnects it everywhere.
   */
  disallowAgents?(accountId: string, workspaceId: string, enrollmentId: string): Promise<void>;
  /**
   * After this computer is disconnected from a workspace, remove it there too,
   * so it stops showing as an offline machine. Optional.
   */
  forgetComputer?(accountId: string, workspaceId: string, enrollmentId: string): Promise<void>;
  /** Opens a page of the system settings, e.g. one Privacy & Security list. */
  openSystemSettings(url: string): void;
  /**
   * The person was sent to System Settings to allow one permission: the app
   * can show its guide beside it. Called with null once it is allowed
   * (`granted`) or no longer being waited for.
   */
  onGuidePermission?(id: ThisComputerPermissionId | null, granted?: boolean): void;
  /** @deprecated Installations are never removed by desktop setup. */
  trash?(path: string): Promise<void>;
  /**
   * @deprecated Existing signing identities and grants are preserved; never called.
   */
  onScreenControlHandedOver?(): void;
  onChange(): void;
}

/** What the app remembers about this computer between launches. */
interface ComputerState {
  /** The person explicitly enabled this computer in the desktop app. */
  adopted: boolean;
  management: "app" | "service";
  /** Persisted before download so a failed enrollment can be retried after relaunch. */
  appInstalled: boolean;
  /** The person paused this computer; the agent stays stopped until they resume. */
  paused: boolean;
  /** Screen control was asked for, so its permissions are part of setting up. */
  screenControl: boolean;
  /** Permissions whose system prompt has been shown; asking again opens System Settings. */
  requested: ThisComputerPermissionId[];
  /**
   * The app set itself to open at login because this computer is connected.
   * Remembered so it happens once per connection: someone who then turns it
   * off in the system's settings keeps it off.
   */
  openAtLogin: boolean;
  /** Setting up began and some permission is still to be allowed. */
  setupPending: boolean;
  /**
   * Workspaces that use a connection made from another workspace, by server
   * and workspace: the person's own computer serves every workspace they
   * belong to on that server, so connecting there only allows their agents.
   * The value is the connection's enrollment.
   */
  alsoIn: Record<string, string>;
  /**
   * Workspaces the computer was connected from and then turned off in while
   * other workspaces still use it, by server and workspace.
   */
  turnedOff: string[];
  /**
   * The binary of an agent that ran as a background service and that the app
   * now runs as its own helper instead (see `hostServiceAgent`); its service
   * stays turned off. Null otherwise.
   */
  hostedService: string | null;
  /** When permissions were last asked for (ms), so only a recent ask continues after a relaunch. */
  askedAt: number;
  /**
   * The account each enrollment belongs to, as far as known: the one that
   * made it, or the first whose Machines view listed it. Another account's
   * view may not list it (enrollments are the person's own), so only its
   * owner's view can say it was removed.
   */
  owners: Record<string, string>;
}

/** What the agent reports and asks for itself: screen control. */
const SCREEN_PERMISSIONS: readonly AgentPermissionId[] = [
  "screenRecording",
  "accessibility",
  "inputMonitoring",
];
/** Every step, in order: screen control, then the folders macOS guards. */
const PERMISSION_ORDER: readonly ThisComputerPermissionId[] = [...SCREEN_PERMISSIONS, "files"];

const SETTINGS_PANES: Record<ThisComputerPermissionId, string> = {
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  inputMonitoring: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
  files: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
};

const REQUEST_ARGUMENT: Record<AgentPermissionId, string> = {
  screenRecording: "screen-recording",
  accessibility: "accessibility",
  inputMonitoring: "input-monitoring",
};

/**
 * The folders macOS asks about before any app opens them. The agent runs as
 * the app's helper, so one answer for the app covers both.
 */
const GUARDED_FOLDERS = ["Desktop", "Documents", "Downloads"] as const;
/** A folder that doesn't answer this fast is still waiting on its question. */
const FOLDER_CHECK_MS = 1_500;

const CONNECTIONS_TTL_MS = 3_000;
/** Short, so a permission granted in System Settings shows up while the person watches. */
const PERMISSIONS_TTL_MS = 900;
/** After asking for a permission, how often and how long to look for the grant. */
const GRANT_WATCH_INTERVAL_MS = 1_500;
const GRANT_WATCH_LIMIT_MS = 10 * 60_000;
const STOP_GRACE_MS = 15_000;
/** A hosted agent that exits sooner than this (another agent holds the lock, it crashed) didn't start. */
const HOSTED_SETTLE_MS = 6_000;
const SETTLE_SAMPLE_MS = 200;
/** Asking for permissions continues after a relaunch only within this long of the last ask. */
const ASKING_RESUME_MS = 10 * 60_000;
const LOG_LIMIT_BYTES = 10 * 1024 * 1024;

type Permissions = ReturnType<typeof parsePermissions>;

/** What `readMachine` resolves with when the server lists the machine. */
type ListedMachine = NonNullable<Awaited<ReturnType<NonNullable<ThisComputerDeps["readMachine"]>>>>;

/**
 * The server's view of this computer's enrollment: listed, no longer listed
 * (removed there, so the local connection is stale), or unknown because it
 * couldn't be read.
 */
type MachineReading =
  | { kind: "listed"; machine: ListedMachine }
  | { kind: "missing" }
  | { kind: "unread"; failure: ThisComputerError }
  /** Another account's view didn't list it: that decides nothing. */
  | { kind: "unknown" };

/**
 * Right after connecting, the server may not list the new enrollment yet;
 * until then a missing machine isn't taken as removed.
 */
const NEW_ENROLLMENT_GRACE_MS = 60_000;
/** A machine read that takes longer says nothing, so status reads stay quick. */
const MACHINE_READ_TIMEOUT_MS = 10_000;

const REMOVED_MESSAGE =
  "This computer was removed from this workspace. Reconnect it to let agents use it again.";

/**
 * This computer as a place agents can work. The app ships the
 * connected-machine agent, keeps a copy where the command line expects it (so
 * the agent's own signed updates land there), connects it to a workspace with
 * a single-use token, and runs it as its own helper while the app is open.
 * Running it as a helper makes the system attribute the agent's screen and
 * input use to the app, so people grant permissions to the app they know.
 */
export class ThisComputer {
  private readonly agent: HostedAgent;
  private readonly installedPath: string;
  private serviceBinary: string | null = null;
  private serviceCache: { at: number; value: AgentServiceStatus } | null = null;
  private machineCache: {
    at: number;
    key: string;
    value: MachineReading;
  } | null = null;
  /** Enrollments this app made, by when, so a not-yet-listed one isn't called removed. */
  private readonly enrolledAt = new Map<string, number>();
  /** Enrollments the server answered it no longer lists: their local connection is stale. */
  private readonly removed = new Set<string>();
  private readonly statePath: string;
  private state: ComputerState;
  private connectionsCache: { at: number; value: AgentConnection[] } | null = null;
  private permissionsCache: { at: number; value: Permissions } | null = null;
  private reading: Promise<AgentConnection[]> | null = null;
  /** The last connections read, kept when the cache is cleared, to notice a change. */
  private lastConnections: AgentConnection[] | null = null;
  private checking: Promise<Permissions> | null = null;
  /** The guarded-folder check in flight, shared by status reads meanwhile. */
  private checkingFolders: Promise<boolean> | null = null;
  /** The folder questions being asked in setup, shared by a second ask meanwhile. */
  private requestingFolders: Promise<void> | null = null;
  /** Helper processes opening guarded folders, stopped when the app ends. */
  private readonly folderChecks = new Set<ChildProcess>();
  private installing: Promise<string> | null = null;
  /** How much of the agent has downloaded, from 0 to 1, while it downloads. */
  private progress: number | null = null;
  private busy = false;
  private error: string | null = null;
  private errorCode: ThisComputerErrorCode | null = null;
  private childPid: number | null = null;
  private grantWatch: { timer: NodeJS.Timeout; until: number } | null = null;
  /** Moving a service agent into the app is in progress (see `hostService`). */
  private hosting: Promise<void> | null = null;
  /** Tried once per launch: a move not made leaves the service as it was. */
  private hostingTried = false;
  /** A move that didn't stay up isn't tried again this launch, even when asking. */
  private hostingFailed = false;
  /** The permission the person was sent to System Settings for, while it is missing. */
  private guiding: ThisComputerPermissionId | null = null;
  /** Environment every agent command gets: the host marker and, when set, its own config. */
  private readonly agentEnv: Record<string, string>;
  /**
   * On a Mac, a directory with one empty file per guarded folder the app last
   * found it could open. The agent's commands get its path
   * (`MAC_FOLDERS_ALLOWED_ENV`) and leave every other guarded folder out of
   * whole-folder walks: reading one not yet asked about would put macOS's
   * question up unasked, and a refused one fails the walk.
   */
  private readonly allowedFoldersDir: string | null;

  constructor(private readonly deps: ThisComputerDeps) {
    this.installedPath = deps.agentPath ?? hostedAgentPath(deps.platform, deps.home, deps.env);
    const extensionIds = browserExtensionIdsEnv(deps.browserExtensionIds);
    this.allowedFoldersDir =
      deps.platform === "darwin" ? join(deps.dataDir, "mac-folders-allowed") : null;
    this.agentEnv = {
      ...(deps.agentConfigDir ? { OPENGENI_CONFIG_DIR: deps.agentConfigDir } : {}),
      ...(this.allowedFoldersDir ? { [MAC_FOLDERS_ALLOWED_ENV]: this.allowedFoldersDir } : {}),
      ...(deps.browserExtension === false
        ? { OPENGENI_AGENT_BROWSER_EXTENSION: "off" }
        : extensionIds
          ? { OPENGENI_AGENT_BROWSER_EXTENSION_IDS: extensionIds }
          : {}),
    };
    this.statePath = join(deps.dataDir, "this-computer.json");
    this.state = this.loadState();
    this.agent = new HostedAgent({
      spawn: (apiUrl) => this.spawnAgent(apiUrl),
      terminate: (child) => this.terminate(child),
      now: () => Date.now(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
      onChange: () => deps.onChange(),
    });
  }

  get supported(): boolean {
    return ["darwin", "linux", "win32"].includes(this.deps.platform);
  }

  /** Whether an agent installed separately is taken over (see the deps). */
  private get adopts(): boolean {
    return this.deps.adoptStandaloneAgent ?? (!this.deps.agentPath && !this.deps.agentConfigDir);
  }

  private get macBundleBinary(): string | null {
    if (!this.adopts || this.deps.platform !== "darwin") return null;
    const path = join(standaloneMacAgentApp(this.deps.home), "Contents", "MacOS", "opengeni-agent");
    return existsSync(path) ? path : null;
  }

  private get hostedPath(): string {
    const hosted = this.state.hostedService;
    if (hosted && existsSync(hosted)) return hosted;
    return this.serviceBinary ?? this.macBundleBinary ?? this.installedPath;
  }

  private get serviceBacked(): boolean {
    return (
      this.adopts &&
      this.state.hostedService === null &&
      (this.state.management === "service" ||
        this.macBundleBinary !== null ||
        (!this.state.adopted && !this.state.appInstalled && existsSync(this.installedPath)))
    );
  }

  private async serviceStatus(): Promise<AgentServiceStatus> {
    if (this.serviceCache && Date.now() - this.serviceCache.at < 5_000)
      return this.serviceCache.value;
    const result = await this.run(this.hostedPath, ["service", "status", "--json"], {
      timeoutMs: 15_000,
    });
    const status = result.code === 0 ? parseAgentServiceStatus(result.output) : null;
    if (!status) {
      const legacy =
        result.code !== 0 && /(?:unexpected|unrecognized|unknown).*--json/iu.test(result.output);
      throw new ThisComputerError(
        "unknown",
        legacy
          ? "Update the existing Opengeni agent from Machines before managing it here. Its installation and permissions have not been changed."
          : failureMessage("Couldn't read the existing agent service status", result),
      );
    }
    if (status?.installed && status.binaryPath) this.serviceBinary = status.binaryPath;
    this.serviceCache = { at: Date.now(), value: status };
    return status;
  }

  private async reportedMachine(
    accountId: string,
    baseUrl: string,
    workspaceId: string,
    connection: AgentConnection,
  ): Promise<MachineReading | null> {
    const read = this.deps.readMachine;
    if (!read) return null;
    const key = JSON.stringify([accountId, baseUrl, workspaceId, connection.agentId]);
    if (this.machineCache?.key === key && Date.now() - this.machineCache.at < 5_000)
      return this.machineCache.value;
    const readIn = async (workspace: string): Promise<MachineReading> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const machine = await Promise.race([
          read(accountId, baseUrl, workspace, connection.agentId),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new ThisComputerError(
                    "unknown",
                    "The server took too long to confirm this computer's connection. Try again.",
                  ),
                ),
              MACHINE_READ_TIMEOUT_MS,
            );
          }),
        ]);
        return machine ? { kind: "listed", machine } : { kind: "missing" };
      } catch (caught) {
        return { kind: "unread", failure: machineReadFailure(caught) };
      } finally {
        clearTimeout(timer);
      }
    };
    let value: MachineReading = await readIn(connection.workspaceId);
    if (value.kind !== "listed" && connection.workspaceId !== workspaceId) {
      const here = await readIn(workspaceId);
      // Removed only when every server answer says so; a failed read decides nothing.
      if (here.kind === "listed" || value.kind === "missing") value = here;
    }
    if (value.kind === "listed") {
      this.removed.delete(connection.agentId);
      if (!this.state.owners[connection.agentId]) this.own(connection.agentId, accountId);
    }
    if (value.kind === "missing" && !this.ownedBy(connection.agentId, accountId)) {
      // Another account's view: not listing it there says nothing.
      value = { kind: "unknown" };
    }
    this.machineCache = { at: Date.now(), key, value };
    return value;
  }

  private own(agentId: string, accountId: string): void {
    this.saveState({ owners: { ...this.state.owners, [agentId]: accountId } });
  }

  /** Whether this account's view decides about the enrollment (its owner, or nobody known). */
  private ownedBy(agentId: string, accountId: string): boolean {
    const owner = this.state.owners[agentId];
    return owner === undefined || owner === accountId;
  }

  /**
   * The server answered that it no longer lists this connection's enrollment:
   * it was removed there (e.g. from Machines), so the local connection is
   * stale and only a fresh enrollment brings it back. Not for one this app
   * just made, which the server may not list yet.
   */
  private removedOnServer(reading: MachineReading | null, connection: AgentConnection): boolean {
    if (reading?.kind !== "missing") return false;
    const enrolled = this.enrolledAt.get(connection.agentId);
    if (enrolled !== undefined && Date.now() - enrolled < NEW_ENROLLMENT_GRACE_MS) return false;
    this.removed.add(connection.agentId);
    return true;
  }

  private async requireService(): Promise<AgentServiceStatus> {
    const status = await this.serviceStatus();
    if (!status.installed)
      throw new ThisComputerError(
        "unknown",
        "The existing agent has no installed background service. Start it with opengeni-agent start, then try again. Its files have not been changed.",
      );
    return status;
  }

  private async serviceAction(action: "start" | "stop"): Promise<void> {
    await this.requireService();
    await this.expect(
      this.run(this.hostedPath, ["service", action], { timeoutMs: 60_000 }),
      action === "start" ? "Couldn't resume the agent service" : "Couldn't pause the agent service",
      "unknown",
    );
    this.serviceCache = null;
    this.machineCache = null;
  }

  private run(
    file: string,
    args: readonly string[],
    options: { env?: Record<string, string>; timeoutMs: number },
  ): Promise<RunResult> {
    return run(file, args, { ...options, env: { ...this.agentEnv, ...options.env } });
  }

  /** Whether the app opens at login, without a window, for this computer. */
  get opensAtLogin(): boolean {
    return this.state.openAtLogin;
  }

  /**
   * Whether the app should now start ("open") or stop ("stop") opening at
   * login, given whether this computer is connected; null when nothing changes.
   * A connected computer stays available after a restart, and one that was
   * disconnected no longer opens the app at login.
   */
  openAtLoginChange(connected: boolean): "open" | "stop" | null {
    connected = connected && !this.serviceBacked;
    if (connected === this.state.openAtLogin) return null;
    this.saveState({ openAtLogin: connected });
    return connected ? "open" : "stop";
  }

  /**
   * At launch: start the agent when this computer serves a workspace and isn't
   * paused. Existing standalone services are never changed or started here.
   */
  async boot(): Promise<void> {
    if (this.state.hostedService !== null) return await this.bootHostedService();
    if (!this.supported || this.state.paused || this.serviceBacked) return;
    if (!this.state.adopted && (this.adopts || !this.hasAnyAgent())) return;
    try {
      await this.ensureInstalled(null);
      const connections = await this.connections(true);
      const first = connections[0];
      if (first) this.agent.start(first.apiUrl);
    } catch (caught) {
      this.fail(caught);
      this.deps.onChange();
    }
  }

  /**
   * A service agent the app runs (see `hostServiceAgent`): started again, and
   * handed back to its service when its binary is gone or it doesn't stay up,
   * so the computer is never left without an agent.
   */
  private async bootHostedService(): Promise<void> {
    const binary = this.state.hostedService;
    const back = () =>
      this.handBack().catch((caught: unknown) => {
        this.fail(caught);
        this.deps.onChange();
      });
    if (!binary || !existsSync(binary)) return await back();
    // The app ended without asking and the service took the agent back
    // (see `shutdownNow`): it keeps it, so there's never a second one.
    if ((await this.serviceStatus().catch(() => null))?.enabled) {
      this.saveState({ hostedService: null, management: "service", paused: false });
      this.serviceCache = null;
      return;
    }
    if (this.state.paused) return;
    const first = (await this.connections(true).catch(() => []))[0];
    if (!first) return await back();
    this.agent.start(first.apiUrl);
    void this.runHosting(async () => {
      if (await this.hostedSettles()) return true;
      await this.handBack();
      return false;
    });
  }

  async status(
    baseUrl: string,
    workspaceId: string,
    accountId?: string,
  ): Promise<ThisComputerStatus> {
    const base = {
      busy: this.busy || this.installing !== null,
      error: this.error,
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
      machineName: await computerName(),
      management: this.serviceBacked ? ("service" as const) : ("app" as const),
      ...(this.serviceBacked && this.deps.platform === "darwin"
        ? { permissionAppName: "Opengeni Agent" }
        : {}),
      ...(this.progress !== null ? { setupProgress: this.progress } : {}),
    };
    if (!this.supported || !agentAssetName(this.deps.platform, this.deps.arch)) {
      return { ...base, state: "unavailable" };
    }
    if (!existsSync(this.hostedPath)) return { ...base, state: "not_installed" };
    if (this.serviceBacked && !this.state.adopted) {
      if (!accountId || !(await this.adoptExisting(accountId, baseUrl, workspaceId))) {
        return { ...base, state: "not_connected" };
      }
    }
    const connections = await this.connections();
    const connection = this.connectionIn(connections, baseUrl, workspaceId);
    if (!connection) {
      return { ...base, state: "not_connected" };
    }
    // A failed action's own error says more than the standing condition.
    const removed = (): ThisComputerStatus => ({
      ...base,
      state: "not_connected",
      ...(base.error ? {} : { error: REMOVED_MESSAGE, errorCode: "removed" as const }),
    });
    if (this.serviceBacked) {
      let service: AgentServiceStatus;
      try {
        service = await this.serviceStatus();
      } catch (caught) {
        return {
          ...base,
          state: "connected",
          reconnecting: true,
          error: errorText(caught),
          errorCode: "unknown",
        };
      }
      const reading = accountId
        ? await this.reportedMachine(accountId, baseUrl, workspaceId, connection)
        : null;
      if (this.removedOnServer(reading, connection)) return removed();
      const machine = reading?.kind === "listed" ? reading.machine : null;
      const unread = reading?.kind === "unread" ? reading.failure : null;
      const permissions =
        machine?.permissions && (machine.online || (service?.installed && !service.enabled))
          ? SCREEN_PERMISSIONS.flatMap((id) =>
              typeof machine.permissions?.[id] === "boolean"
                ? [{ id, granted: machine.permissions[id]! }]
                : [],
            )
          : undefined;
      if (service.running && !this.state.paused) this.hostService(machine);
      return {
        ...base,
        // While it moves into the app, its service is briefly off: still on.
        state: service?.installed && !service.enabled && !this.hosting ? "paused" : "connected",
        reconnecting:
          this.hosting !== null ||
          !service?.running ||
          !machine?.online ||
          (this.deps.platform === "darwin" && this.state.screenControl && !machine.permissions),
        ...(permissions ? { permissions } : {}),
        // Only a read that failed is an error; a listed machine that is offline
        // is still connecting, and its own reason is unknown here.
        ...(unread && service.enabled && !base.error
          ? { error: unread.message, errorCode: unread.code }
          : {}),
      };
    }
    const reading = accountId
      ? await this.reportedMachine(accountId, baseUrl, workspaceId, connection)
      : null;
    // The agent keeps running: a removed enrollment gives it no access, and
    // turning on again restarts it with the new one.
    if (this.removedOnServer(reading, connection)) return removed();
    const permissions = await this.permissionList();
    const missing = permissions?.some((permission) => !permission.granted) ?? false;
    // Without the screen-control list, the guarded folders still have their
    // answer: agents read files whether or not they see the screen.
    const folders =
      !permissions && this.deps.platform === "darwin" ? await this.foldersAllowed() : undefined;
    return {
      ...base,
      state: this.state.paused ? "paused" : "connected",
      enrollmentId: connection.agentId,
      ...(permissions
        ? {
            permissions,
            systemNames: macSystemNames(this.deps.systemLanguages?.() ?? [], this.deps.systemNames),
          }
        : {}),
      ...(folders !== undefined ? { folders } : {}),
      ...(missing && this.askingRecently ? { setupPending: true } : {}),
      ...(permissions ? { requestedPermissions: [...this.state.requested] } : {}),
      ...(!this.state.paused && this.agent.state !== "running" ? { reconnecting: true } : {}),
    };
  }

  /** For the menu bar item and quitting: whether agents can use this computer now. */
  async summary(): Promise<{
    installed: boolean;
    connected: boolean;
    running: boolean;
    /** On, but the agent is starting again, so agents can't use it for the moment. */
    reconnecting: boolean;
    needsPermissions: boolean;
    /** In the order to allow them. */
    missingPermissions: ThisComputerPermissionId[];
    management?: "service" | "app";
    /** A service agent the app runs: quitting hands it back to its service, so it stays available. */
    handsBackOnQuit?: boolean;
  }> {
    if (!this.supported) {
      return {
        installed: false,
        connected: false,
        running: false,
        reconnecting: false,
        needsPermissions: false,
        missingPermissions: [],
      };
    }
    if (this.serviceBacked) {
      const connections = this.state.adopted ? this.live(await this.connections()) : [];
      const service = this.state.adopted ? await this.serviceStatus().catch(() => null) : null;
      return {
        installed: true,
        connected: connections.length > 0,
        running: service?.running ?? false,
        reconnecting: Boolean(service?.enabled && !service.running),
        needsPermissions: false,
        missingPermissions: [],
        management: "service",
      };
    }
    const connections = this.live(await this.connections());
    const permissions = connections.length > 0 ? await this.permissionList() : null;
    const missingPermissions = (permissions ?? [])
      .filter((permission) => !permission.granted)
      .map((permission) => permission.id);
    return {
      installed: existsSync(this.hostedPath),
      connected: connections.length > 0,
      // Serving only removed connections, it gives agents nothing.
      running: !this.state.paused && this.agent.state !== "stopped" && connections.length > 0,
      reconnecting: !this.state.paused && connections.length > 0 && this.agent.state !== "running",
      needsPermissions: missingPermissions.length > 0,
      missingPermissions,
      ...(this.handsBackOnQuit ? { handsBackOnQuit: true } : {}),
    };
  }

  async connect(
    accountId: string,
    baseUrl: string,
    workspaceId: string,
    options: ThisComputerConnectOptions,
  ): Promise<ThisComputerStatus> {
    await this.act(async () => {
      // Whether the server still lists this computer decides how to reconnect.
      this.machineCache = null;
      // Read-only compatibility check before granting access; never replace an
      // older standalone agent to make this setup action succeed.
      if (this.serviceBacked) await this.requireService();
      if (await this.connectThroughAnother(accountId, baseUrl, workspaceId, options)) return;
      const token = await this.deps
        .mintEnrollToken(accountId, workspaceId, options.screenControl)
        .catch((caught: unknown) => {
          throw serverFailure(caught, "Couldn't start setting up this computer");
        });
      // Authenticate before downloading, enrolling, or starting any local runner.
      const binary = await this.ensureInstalled(baseUrl);
      await this.expect(
        // The name people know the computer by, not its network hostname.
        this.run(
          binary,
          [
            "--api-url",
            baseUrl,
            "connect",
            "--non-interactive",
            "--machine-name",
            await computerName(),
          ],
          {
            env: { OPENGENI_API_URL: baseUrl, OPENGENI_ENROLL_TOKEN: token },
            timeoutMs: 120_000,
          },
        ),
        "Couldn't connect this computer",
        "connect_failed",
      );
      this.saveState({
        adopted: true,
        management: this.serviceBacked ? "service" : "app",
        paused: false,
        screenControl: this.state.screenControl || options.screenControl,
        setupPending: options.screenControl && this.deps.platform === "darwin",
        askedAt: Date.now(),
        turnedOff: this.state.turnedOff.filter((key) => key !== useKey(baseUrl, workspaceId)),
      });
      // A running agent reads its connections when it starts.
      if (this.serviceBacked) await this.serviceAction("start");
      else if (this.agent.state === "stopped") this.agent.start(baseUrl);
      else await this.agent.restart();
      const connection = connectionFor(await this.connections(true), baseUrl, workspaceId);
      if (!connection) {
        throw new ThisComputerError("connect_failed", "Couldn't connect this computer. Try again.");
      }
      this.enrolledAt.set(connection.agentId, Date.now());
      this.removed.delete(connection.agentId);
      this.own(connection.agentId, accountId);
      await this.deps.allowAgents(accountId, workspaceId, connection.agentId).catch((caught) => {
        throw serverFailure(caught, "Couldn't let agents use this computer");
      });
    });
    return await this.status(baseUrl, workspaceId, accountId);
  }

  async pause(): Promise<void> {
    await this.act(async () => {
      if (this.serviceBacked) {
        if (!this.state.adopted) return;
        await this.serviceAction("stop");
        return;
      }
      this.saveState({ paused: true, setupPending: false });
      await this.agent.stop();
    });
  }

  async resume(): Promise<void> {
    await this.act(async () => {
      if (this.serviceBacked) {
        if (!this.state.adopted) return;
        await this.serviceAction("start");
        return;
      }
      this.saveState({ paused: false });
      await this.ensureInstalled(null);
      const first = (await this.connections(true))[0];
      if (!first) {
        throw new ThisComputerError(
          "connect_failed",
          "This computer isn't connected to a workspace yet.",
        );
      }
      this.agent.start(first.apiUrl);
    });
  }

  /**
   * Stops agents using this computer in the workspace: its connection there is
   * removed, and the agent stops when it serves nothing else. Connecting again
   * later sets it up as new.
   */
  async disconnect(accountId: string, baseUrl: string, workspaceId: string): Promise<void> {
    await this.act(async () => {
      const connections = await this.connections(true);
      const connection = this.connectionIn(connections, baseUrl, workspaceId);
      if (!connection) return;
      const key = useKey(baseUrl, workspaceId);
      const othersUsing = this.workspacesUsing(connection).filter((other) => other !== key);
      if (othersUsing.length > 0 && this.deps.disallowAgents) {
        // Other workspaces keep this computer: only this one stops using it.
        await this.deps
          .disallowAgents(accountId, workspaceId, connection.agentId)
          .catch((caught: unknown) => {
            throw serverFailure(caught, "Couldn't turn this computer off here");
          });
        const { [key]: _removed, ...alsoIn } = this.state.alsoIn;
        this.saveState({
          alsoIn,
          turnedOff:
            connection.workspaceId === workspaceId
              ? [...this.state.turnedOff.filter((entry) => entry !== key), key]
              : this.state.turnedOff,
        });
        return;
      }
      await this.expect(
        this.run(this.hostedPath, ["disconnect", connection.connectionId], { timeoutMs: 30_000 }),
        "Couldn't disconnect this computer",
        "unknown",
      );
      // Every workspace that used this connection stops with it.
      const used = new Set(this.workspacesUsing(connection));
      this.saveState({
        alsoIn: Object.fromEntries(
          Object.entries(this.state.alsoIn).filter(([entry]) => !used.has(entry)),
        ),
        turnedOff: this.state.turnedOff.filter(
          (entry) => entry !== useKey(connection.apiUrl, connection.workspaceId),
        ),
      });
      const rest = await this.connections(true);
      if (rest.length === 0) {
        this.saveState({ paused: false, setupPending: false });
        if (this.serviceBacked) await this.serviceAction("stop");
        else await this.agent.stop();
      } else {
        if (!this.serviceBacked) await this.agent.restart();
      }
      // The local link is gone either way; removing the machine there is a courtesy.
      await this.deps
        .forgetComputer?.(accountId, workspaceId, connection.agentId)
        .catch(() => undefined);
    });
  }

  /**
   * The connection agents in a workspace use: the one made there, unless it was
   * turned off there, else one made from another workspace on the same server
   * that this workspace was allowed to use.
   */
  private connectionIn(
    connections: readonly AgentConnection[],
    baseUrl: string,
    workspaceId: string,
  ): AgentConnection | null {
    const key = useKey(baseUrl, workspaceId);
    const own = connectionFor(connections, baseUrl, workspaceId);
    if (own && !this.state.turnedOff.includes(key)) return own;
    const shared = this.state.alsoIn[key];
    if (!shared) return null;
    const origin = normalizeServerUrl(baseUrl);
    return (
      connections.find(
        (connection) => connection.agentId === shared && connection.apiUrl === origin,
      ) ?? null
    );
  }

  /** Connections whose enrollment the server still lists (as far as it's known). */
  private live(connections: readonly AgentConnection[]): AgentConnection[] {
    return connections.filter((connection) => !this.removed.has(connection.agentId));
  }

  /**
   * An agent set up before this app, e.g. from the web app's install command,
   * that is already registered to this workspace: the app takes it over as
   * is, so computer use shows on with nothing to do, and the app's switch then
   * pauses and resumes that same agent. Only once the server lists the
   * registration; its installation, service and permissions stay untouched.
   */
  private async adoptExisting(
    accountId: string,
    baseUrl: string,
    workspaceId: string,
  ): Promise<boolean> {
    if (this.state.turnedOff.includes(useKey(baseUrl, workspaceId))) return false;
    let own: AgentConnection | null;
    try {
      own = connectionFor(await this.connections(), baseUrl, workspaceId);
    } catch {
      return false;
    }
    if (!own) return false;
    const reading = await this.reportedMachine(accountId, baseUrl, workspaceId, own);
    if (reading?.kind !== "listed") return false;
    this.saveState({ adopted: true, management: "service" });
    // Agents may already be allowed; this only fills in what's missing.
    void this.deps.allowAgents(accountId, workspaceId, own.agentId).catch(() => undefined);
    return true;
  }

  /**
   * Moves an adopted service agent into the app (see `hostServiceAgent`), once
   * per launch, in the background. On its own it moves only when the app
   * already holds every screen permission the service has, so a setup that
   * works never loses a grant; asking for a permission moves it first anyway
   * (see `requestPermission`), so the grant goes to the app. Actions wait for
   * a move in progress.
   */
  private hostService(machine: ListedMachine | null): void {
    if (!this.canHostService() || this.hostingTried || this.hosting || this.busy) return;
    this.hostingTried = true;
    void this.runHosting(() => this.moveServiceIntoApp(machine, false));
  }

  private canHostService(): boolean {
    return (
      this.deps.hostServiceAgent === true &&
      this.deps.platform === "darwin" &&
      this.serviceBacked &&
      this.state.adopted
    );
  }

  /** Runs a move (or its check) as the one in progress; true when the app now runs the agent. */
  private runHosting(move: () => Promise<boolean>): Promise<boolean> {
    const moving = move()
      .catch((caught: unknown) => {
        // Even the way back failed: say so, as for any failed action.
        this.fail(caught);
        return false;
      })
      .finally(() => {
        this.hosting = null;
        this.serviceCache = null;
        this.machineCache = null;
        this.permissionsCache = null;
        this.deps.onChange();
      });
    this.hosting = moving.then(() => undefined);
    return moving;
  }

  /**
   * One agent at a time: the service is turned off before the app starts the
   * same agent as its helper, with the same connections and registration. If
   * the helper doesn't stay up, the service runs it again as before.
   */
  private async moveServiceIntoApp(
    machine: ListedMachine | null,
    force: boolean,
  ): Promise<boolean> {
    const service = await this.serviceStatus().catch(() => null);
    if (!service?.installed || !service.enabled || !service.running) return false;
    const binary = service.binaryPath ?? this.hostedPath;
    const first = (await this.connections(true))[0];
    if (!first || !(await this.versionOf(binary))) return false;
    if (!force && !(await this.appHoldsGrants(binary, machine))) return false;
    try {
      await this.serviceAction("stop");
    } catch {
      // It may have stopped anyway: make sure the service runs, as before.
      await this.serviceAction("start");
      return false;
    }
    this.saveState({
      hostedService: binary,
      management: "app",
      paused: false,
      screenControl: this.state.screenControl || machine?.screenControl === true || force,
    });
    this.agent.start(first.apiUrl);
    if (await this.hostedSettles()) return true;
    this.hostingFailed = true;
    await this.handBack();
    return false;
  }

  /**
   * Whether the app already has every screen permission the service has (a
   * check run by the app reads the app's own grants). When the service's are
   * unknown, only all of them will do.
   */
  private async appHoldsGrants(binary: string, machine: ListedMachine | null): Promise<boolean> {
    const result = await this.run(binary, ["permissions"], { timeoutMs: 10_000 });
    const own = result.code === 0 ? parsePermissions(result.output) : null;
    if (!own) return false;
    if (!own.required) return true;
    // The protected folders too: the app has to have asked for them itself.
    if (!(await this.foldersAllowed())) return false;
    const service = machine?.permissions ?? null;
    return SCREEN_PERMISSIONS.every(
      (id) => own.granted[id] || (service !== null && service[id] !== true),
    );
  }

  /** The app's helper keeps running, without restarting, for the whole settle time. */
  private async hostedSettles(): Promise<boolean> {
    const pid = this.childPid;
    const until = Date.now() + (this.deps.hostedSettleMs ?? HOSTED_SETTLE_MS);
    while (Date.now() < until) {
      if (pid === null || this.agent.state !== "running" || this.childPid !== pid) return false;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_SAMPLE_MS));
    }
    return pid !== null && this.agent.state === "running" && this.childPid === pid;
  }

  /**
   * The service runs the agent again, as before it moved into the app, and the
   * app's helper stops. Off stays off: the service then stays turned off.
   */
  private async handBack(): Promise<void> {
    const off = this.state.paused;
    await this.agent.stop();
    this.saveState({ hostedService: null, management: "service", paused: false });
    if (!off) await this.serviceAction("start");
  }

  /** Every workspace that uses a connection, by server and workspace. */
  private workspacesUsing(connection: AgentConnection): string[] {
    const origin = useKey(connection.apiUrl, connection.workspaceId);
    return [
      ...(this.state.turnedOff.includes(origin) ? [] : [origin]),
      ...Object.entries(this.state.alsoIn)
        .filter(([, agentId]) => agentId === connection.agentId)
        .map(([key]) => key),
    ];
  }

  /**
   * The person's own computer, once connected, serves every workspace they
   * belong to on that server: connecting it in another one only lets their
   * agents there use it. False when there is no such connection, or the server
   * doesn't let this workspace use it, so the computer is set up as new.
   */
  private async connectThroughAnother(
    accountId: string,
    baseUrl: string,
    workspaceId: string,
    options: ThisComputerConnectOptions,
  ): Promise<boolean> {
    // A connection made without screen control can't give it.
    if (options.screenControl && !this.state.screenControl && !this.serviceBacked) return false;
    const connections = await this.connections(true);
    const key = useKey(baseUrl, workspaceId);
    const origin = normalizeServerUrl(baseUrl);
    const own = connectionFor(connections, baseUrl, workspaceId);
    const candidates = [
      ...(own ? [own] : []),
      ...connections.filter(
        (connection) => connection.apiUrl === origin && connection.workspaceId !== workspaceId,
      ),
    ];
    for (const connection of candidates) {
      // An enrollment the server no longer lists can't be reused: it was removed
      // there, and connecting again enrolls this computer afresh below.
      const reading = await this.reportedMachine(accountId, baseUrl, workspaceId, connection);
      if (this.removedOnServer(reading, connection)) continue;
      try {
        if (this.serviceBacked && options.screenControl) {
          const machine = reading?.kind === "listed" ? reading.machine : null;
          if (!machine?.screenControl) {
            if (!this.deps.enableScreenControl)
              throw new Error("Couldn't verify screen-control access for the existing agent.");
            await this.deps.enableScreenControl(accountId, workspaceId, connection.agentId);
          }
        }
        await this.deps.allowAgents(accountId, workspaceId, connection.agentId);
      } catch (caught) {
        if (this.serviceBacked && connection === own)
          throw serverFailure(caught, "Couldn't use the existing agent");
        continue;
      }
      if (connection === own) {
        this.saveState({ turnedOff: this.state.turnedOff.filter((entry) => entry !== key) });
      } else {
        this.saveState({ alsoIn: { ...this.state.alsoIn, [key]: connection.agentId } });
      }
      // The authenticated server grant succeeded before local management begins.
      const serviceBacked = this.serviceBacked;
      if (serviceBacked) await this.serviceAction("start");
      this.saveState({
        paused: false,
        adopted: true,
        management: serviceBacked ? "service" : "app",
        screenControl: this.state.screenControl || options.screenControl,
      });
      if (!serviceBacked && this.agent.state === "stopped") this.agent.start(connection.apiUrl);
      return true;
    }
    return false;
  }

  /**
   * Asks for one screen-control permission. The first time the system shows
   * its own prompt, under the app's name; after that the person turns it on in
   * System Settings, which opens at the right list. The request is made every
   * time, before System Settings opens: it is what puts the app in that list,
   * and macOS forgets the app when its permissions are reset or it is
   * reinstalled. The system prompt only shows while macOS hasn't asked yet.
   */
  async requestPermission(id: ThisComputerPermissionId): Promise<void> {
    if (this.deps.platform !== "darwin" || !PERMISSION_ORDER.includes(id)) return;
    if (this.hosting) await this.hosting.catch(() => undefined);
    if (this.serviceBacked) {
      // The grant should go to the app: the agent moves into it first.
      if (
        this.canHostService() &&
        !this.hostingFailed &&
        (await this.runHosting(() => this.moveServiceIntoApp(null, true)))
      ) {
        // Turned off (or another action began) meanwhile: nothing to ask for now.
        if (this.state.paused || this.busy) return;
        return await this.requestPermission(id);
      }
      // A child of the desktop asks for the desktop's grants, not the service's.
      // The existing agent already owns the System Settings entries.
      if (this.state.adopted) this.deps.openSystemSettings(SETTINGS_PANES[id]);
      return;
    }
    // Asking began: after a relaunch macOS forces for a grant, it may go on.
    this.saveState({ setupPending: true, askedAt: Date.now() });
    if (id === "files") return await this.requestFolders();
    this.watchForGrants();
    this.guide(id);
    const askedBefore = this.state.requested.includes(id);
    let requested = false;
    if (existsSync(this.hostedPath)) {
      if (!askedBefore) this.saveState({ requested: [...this.state.requested, id] });
      requested = await this.run(
        this.hostedPath,
        ["permissions", "--request", REQUEST_ARGUMENT[id]],
        { timeoutMs: 30_000 },
      ).then(
        () => true,
        () => false,
      );
    }
    // Without a system prompt to answer, the switch in System Settings is the way.
    if (askedBefore || !requested) this.deps.openSystemSettings(SETTINGS_PANES[id]);
    this.permissionsCache = null;
    this.deps.onChange();
  }

  /**
   * Opening each guarded folder makes macOS ask about it, one question after
   * another, while the person is in setup expecting them. It is tried every
   * time: macOS forgets its answers when permissions are reset or the app is
   * reinstalled, and then only asking again brings the question back. A
   * folder refused earlier opens at once without a question; for those, the
   * switch in System Settings is the way. Asking twice at once shares the
   * first request.
   */
  private requestFolders(): Promise<void> {
    this.requestingFolders ??= (async () => {
      if (!this.state.requested.includes("files")) {
        this.saveState({ requested: [...this.state.requested, "files"] });
      }
      let allowed = true;
      for (const folder of GUARDED_FOLDERS) {
        const opened = await this.opensFolder(join(this.deps.home, folder), null);
        this.recordFolder(folder, opened);
        if (!opened) allowed = false;
      }
      if (!allowed) {
        this.watchForGrants();
        this.guide("files");
        this.deps.openSystemSettings(SETTINGS_PANES.files);
      }
      this.permissionsCache = null;
      this.deps.onChange();
    })().finally(() => {
      this.requestingFolders = null;
    });
    return this.requestingFolders;
  }

  /**
   * Whether every guarded folder opens. Only once they've been asked about:
   * before that, opening one would put macOS's question up unexpectedly.
   * One check at a time: a status read while one runs shares it.
   */
  private foldersAllowed(): Promise<boolean> {
    if (!this.state.requested.includes("files")) return Promise.resolve(false);
    this.checkingFolders ??= Promise.all(
      GUARDED_FOLDERS.map(async (folder) => {
        const opened = await this.opensFolder(join(this.deps.home, folder), FOLDER_CHECK_MS);
        // Keeps the agent's list current: a grant made later in System
        // Settings, and an answer macOS forgot, show up here.
        this.recordFolder(folder, opened);
        return opened;
      }),
    )
      .then((results) => results.every(Boolean))
      .finally(() => {
        this.checkingFolders = null;
      });
    return this.checkingFolders;
  }

  /**
   * Whether a guarded folder opens, tried in a short-lived helper process.
   * While macOS's question about the folder is up, opening it waits for the
   * answer; in the app's own process that wait would hold one of its few
   * file-system threads, and the app could not quit until the question was
   * answered. A helper is stopped after `timeoutMs` (null: wait for the answer)
   * and when the app ends. macOS asks about the helper under the app's name.
   * A folder that doesn't exist needs no permission.
   */
  private opensFolder(path: string, timeoutMs: number | null): Promise<boolean> {
    if (!existsSync(path)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const child = spawn("/bin/ls", [path], { stdio: "ignore" });
      this.folderChecks.add(child);
      const timer = timeoutMs === null ? null : setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      const done = (opened: boolean) => {
        if (timer) clearTimeout(timer);
        this.folderChecks.delete(child);
        resolve(opened);
      };
      child.once("error", () => done(false));
      child.once("exit", (code) => done(code === 0));
    });
  }

  /**
   * The grant happens in System Settings, where nothing tells the app. Look
   * for it for a while, so the agent restarts with it and the menu bar item
   * and window update, even when no window is asking.
   */
  private watchForGrants(): void {
    const until = Date.now() + GRANT_WATCH_LIMIT_MS;
    if (this.grantWatch) {
      this.grantWatch.until = until;
      return;
    }
    const tick = async (): Promise<void> => {
      const watch = this.grantWatch;
      if (!watch) return;
      const missing = (await this.permissionList())?.some((permission) => !permission.granted);
      if (!missing || Date.now() > watch.until) {
        this.stopWatchingForGrants();
        return;
      }
      watch.timer = setTimeout(() => void tick(), GRANT_WATCH_INTERVAL_MS);
    };
    this.grantWatch = { timer: setTimeout(() => void tick(), GRANT_WATCH_INTERVAL_MS), until };
  }

  private stopWatchingForGrants(): void {
    if (this.grantWatch) clearTimeout(this.grantWatch.timer);
    this.grantWatch = null;
    this.guide(null);
  }

  /** Tells the app which permission the person is allowing in System Settings now. */
  private guide(id: ThisComputerPermissionId | null, granted = false): void {
    if (this.guiding === id) return;
    this.guiding = id;
    this.deps.onGuidePermission?.(id, granted);
  }

  /**
   * A service agent the app runs goes back to its service when the app ends,
   * except while permissions are being asked for: macOS quits and reopens the
   * app to apply a grant, and the app takes the agent straight back then.
   */
  private get handsBackOnQuit(): boolean {
    return this.state.hostedService !== null && !this.askingRecently;
  }

  private get askingRecently(): boolean {
    return this.state.setupPending && Date.now() - this.state.askedAt < ASKING_RESUME_MS;
  }

  /** Stops the agent with the app. It starts again when the app next opens. */
  async shutdown(): Promise<void> {
    this.stopWatchingForGrants();
    for (const check of this.folderChecks) check.kill("SIGKILL");
    if (this.hosting) await this.hosting.catch(() => undefined);
    if (this.handsBackOnQuit) {
      // Quitting the app keeps this computer available: the service runs the
      // agent until the app is back (and Off stays off).
      await this.handBack().catch(() => this.agent.stop());
      return;
    }
    await this.agent.stop();
  }

  /**
   * The app is ending now: tell a still-running agent to stop, without waiting.
   * Otherwise it would outlive the app and hold this computer's single agent.
   */
  shutdownNow(): void {
    this.stopWatchingForGrants();
    for (const check of this.folderChecks) check.kill("SIGKILL");
    const pid = this.childPid;
    if (pid !== null) killTree(pid, this.deps.platform, false, true);
    const binary = this.state.hostedService;
    if (!this.handsBackOnQuit || binary === null || this.state.paused || !existsSync(binary)) {
      return;
    }
    // Ended without asking (logout, restart): the service runs the agent again,
    // as `shutdown` would, so this computer stays available. The saved state
    // still says the app runs it: the next launch finds the service holding the
    // agent and hands it back for good (see `bootHostedService`).
    try {
      spawn(binary, ["service", "start"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ...this.agentEnv },
      }).unref();
    } catch {
      // The next launch hands it back (see `boot`).
    }
  }

  /** Forget the cached readings, e.g. when the window comes back to the front. */
  invalidate(): void {
    this.connectionsCache = null;
    this.permissionsCache = null;
    this.serviceCache = null;
    this.machineCache = null;
  }

  /**
   * Whether the app runs this computer's agent itself, so `agentSwitches`
   * reach it. False for a separately installed agent service.
   */
  get runsOwnAgent(): boolean {
    return this.supported && !this.serviceBacked;
  }

  /**
   * Another agent on this computer holds it, so the app's agent waits and the
   * person's switches don't reach the one serving.
   */
  get anotherAgentServes(): boolean {
    return this.agent.state === "elsewhere";
  }

  /** This computer was connected (or since reconnected) with screen control. */
  get screenControlConnected(): boolean {
    return this.state.screenControl;
  }

  /**
   * Whether the agent the app runs honours its screen-control switch: true or
   * false from its `permissions` answer, null when there is no answer (no
   * agent installed, a separately installed service, or no reply).
   */
  async screenControlSwitchSupported(): Promise<boolean | null> {
    if (!this.runsOwnAgent || !existsSync(this.hostedPath)) return null;
    try {
      const permissions = await this.permissions();
      return permissions ? permissions.screenControlSwitch === true : null;
    } catch {
      return null;
    }
  }

  /** The person changed `agentSwitches`: a running agent starts again with them. */
  async agentSwitchesChanged(): Promise<void> {
    this.permissionsCache = null;
    if (this.runsOwnAgent && this.agent.state !== "stopped") await this.agent.restart();
    this.deps.onChange();
  }

  /** The agent's environment for the person's switches. */
  private switchEnv(): Record<string, string> {
    const switches = this.deps.agentSwitches?.();
    return {
      ...(switches?.screenControl === false ? { OPENGENI_AGENT_SCREEN_CONTROL: "off" } : {}),
      ...(switches?.browserExtension === false ? { OPENGENI_AGENT_BROWSER_EXTENSION: "off" } : {}),
    };
  }

  /** Screen control is turned off in the app, so its permissions aren't needed. */
  private get screenControlTurnedOff(): boolean {
    return this.deps.agentSwitches?.().screenControl === false;
  }

  // --- The agent's file -------------------------------------------------------------------------

  private hasAnyAgent(): boolean {
    return (
      existsSync(this.hostedPath) ||
      (this.adopts &&
        this.deps.platform === "darwin" &&
        existsSync(standaloneMacAgentApp(this.deps.home)))
    );
  }

  /**
   * The agent the app runs. One that works stays (it updates itself); a
   * missing or broken one is downloaded from `server`, else from the server a
   * separately installed agent was connected to.
   */
  private ensureInstalled(server: string | null): Promise<string> {
    this.installing ??= this.install(server).finally(() => {
      this.installing = null;
      this.progress = null;
    });
    return this.installing;
  }

  private async install(server: string | null): Promise<string> {
    if (this.serviceBacked) {
      await this.requireService();
      return this.hostedPath;
    }
    if (await this.versionOf(this.hostedPath)) return this.hostedPath;
    if (this.deps.bundledAgent) {
      throw new ThisComputerError(
        "unsupported",
        "This app's copy of the agent is missing or damaged. Reinstall the app.",
      );
    }
    const from = server;
    if (!from) {
      throw new ThisComputerError("connect_failed", "Set up this computer again from a workspace.");
    }
    if (!this.saveState({ appInstalled: true }))
      throw new ThisComputerError(
        "download_failed",
        "Couldn't save this computer's setup state. Check the app's data-folder access and try again.",
      );
    await this.download(from);
    return this.hostedPath;
  }

  private async versionOf(binary: string): Promise<string | null> {
    if (!existsSync(binary)) return null;
    const result = await this.run(binary, ["--version"], { timeoutMs: 15_000 });
    return result.code === 0 ? parseAgentVersion(result.output) : null;
  }

  /**
   * Downloads the server's current agent next to where it goes, checks its
   * signature, then moves it into place, so there is never a half-written or
   * unverified agent to run.
   */
  private async download(server: string): Promise<void> {
    const asset = agentAssetName(this.deps.platform, this.deps.arch);
    if (!asset) {
      throw new ThisComputerError("unsupported", "Agents can't use this kind of computer yet.");
    }
    const url = new URL(`/agent/latest/${asset}`, server).toString();
    const [file, signature] = await Promise.all([
      this.deps.fetch(url),
      this.deps.fetch(`${url}.minisig`),
    ]).catch((caught: unknown) => {
      throw new ThisComputerError(
        "offline",
        `Couldn't reach ${new URL(server).host}. Check your connection and try again.`,
        { cause: caught },
      );
    });
    if (!file.ok || !file.body || !signature.ok) {
      throw new ThisComputerError(
        "download_failed",
        `Couldn't download the agent from ${new URL(server).host} (${file.ok ? signature.status : file.status}).`,
      );
    }
    const signatureText = await signature.text();
    const total = Number(file.headers.get("content-length")) || 0;
    mkdirSync(dirname(this.hostedPath), { recursive: true });
    const staged = `${this.hostedPath}.download`;
    const hash = signedHash();
    const out = createWriteStream(staged, { mode: 0o755 });
    try {
      const reader = file.body.getReader();
      let received = 0;
      let shown = 0;
      this.setProgress(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.byteLength;
        if (!out.write(value)) await once(out, "drain");
        if (total > 0 && received / total - shown >= 0.02) {
          shown = received / total;
          this.setProgress(Math.min(shown, 1));
        }
      }
      await new Promise<void>((resolve, reject) =>
        out.end((error?: Error | null) => (error ? reject(error) : resolve())),
      );
      verifyAgentSignature(this.deps.agentSigningKey, signatureText, hash.digest(), asset);
    } catch (caught) {
      out.destroy();
      rmSync(staged, { force: true });
      throw new ThisComputerError(
        "download_failed",
        `Couldn't set up the agent: ${errorText(caught)}`,
        {
          cause: caught,
        },
      );
    }
    this.moveIntoPlace(staged);
  }

  private setProgress(progress: number): void {
    this.progress = progress;
    this.deps.onChange();
  }

  private moveIntoPlace(staged: string): void {
    const target = this.hostedPath;
    // The installer linked the command into the separate agent app; replace the link itself.
    if (isSymlink(target)) unlinkSync(target);
    if (this.deps.platform === "win32" && existsSync(target)) {
      // A running Windows program can be renamed but not overwritten.
      const old = `${target}.old`;
      rmSync(old, { force: true });
      renameSync(target, old);
    }
    renameSync(staged, target);
  }

  // --- Running it -------------------------------------------------------------------------------

  private spawnAgent(apiUrl: string): AgentChild {
    // Nothing else may check the folders for a while (screen control off, so
    // no status reads them): a grant taken back in System Settings since the
    // last check is taken back from the agent as it starts.
    if (this.allowedFoldersDir) void this.foldersAllowed().catch(() => undefined);
    const log = this.openLog();
    try {
      const child = spawn(this.hostedPath, ["--api-url", apiUrl, "run"], {
        // Plain text: the log is a file, not a terminal.
        // The app's own config folder, so it runs this app's connections and
        // never meets another agent's single-instance lock.
        env: { ...process.env, ...HOST_ENV, ...this.agentEnv, ...this.switchEnv(), NO_COLOR: "1" },
        stdio: ["ignore", log ?? "ignore", log ?? "ignore"],
        windowsHide: true,
      });
      this.childPid = child.pid ?? null;
      child.once("exit", () => {
        if (this.childPid === child.pid) this.childPid = null;
      });
      return {
        pid: child.pid,
        onExit: (listener) => {
          child.once("exit", (code) => listener(code));
          child.once("error", () => listener(null));
        },
      };
    } finally {
      if (log !== null) closeSync(log);
    }
  }

  private openLog(): number | null {
    try {
      mkdirSync(this.deps.logDir, { recursive: true });
      const path = join(this.deps.logDir, "agent.log");
      if (existsSync(path) && statSync(path).size > LOG_LIMIT_BYTES) {
        renameSync(path, `${path}.1`);
      }
      return openSync(path, "a");
    } catch {
      return null;
    }
  }

  private terminate(child: AgentChild): Promise<void> {
    return new Promise((resolve) => {
      const pid = child.pid;
      if (pid === undefined) return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(force);
        resolve();
      };
      child.onExit(finish);
      const force = setTimeout(() => {
        killTree(pid, this.deps.platform, true);
        setTimeout(finish, 1_000);
      }, STOP_GRACE_MS);
      killTree(pid, this.deps.platform, false);
    });
  }

  // --- Reading where it stands ------------------------------------------------------------------

  private async connections(fresh = false): Promise<AgentConnection[]> {
    const cached = this.connectionsCache;
    if (!fresh && cached && Date.now() - cached.at < CONNECTIONS_TTL_MS) return cached.value;
    this.reading ??= (async () => {
      if (!existsSync(this.hostedPath)) return [] as AgentConnection[];
      const result = await this.run(this.hostedPath, ["connections"], { timeoutMs: 15_000 });
      // A read that failed (busy, timed out) says nothing new: keep what was known.
      return result.code === 0 ? parseConnections(result.output) : null;
    })()
      .then((read) => {
        const before = this.lastConnections;
        const value = read ?? before ?? [];
        this.lastConnections = value;
        this.connectionsCache = { at: Date.now(), value };
        if (before && before.length > 0 !== value.length > 0) this.connectionsChanged(value);
        return value;
      })
      .finally(() => {
        this.reading = null;
      });
    return await this.reading;
  }

  /**
   * This computer was connected outside the app or, more often, disconnected
   * (`opengeni-agent disconnect`): the menu bar item, opening at login and the
   * windows follow, and an agent left with nothing to serve stops.
   */
  private connectionsChanged(connections: readonly AgentConnection[]): void {
    if (connections.length === 0 && this.agent.state !== "stopped") {
      void this.agent.stop().catch(() => undefined);
    }
    this.deps.onChange();
  }

  /** The screen-control permissions to set up, or null when there are none to ask for. */
  private async permissionList(): Promise<ThisComputerPermission[] | null> {
    if (this.serviceBacked) return null;
    if (!this.state.screenControl || this.deps.platform !== "darwin") return null;
    // Turned off: none of these is needed. The folders are reported on their own.
    if (this.screenControlTurnedOff) return null;
    const permissions = await this.permissions();
    if (!permissions?.required) return null;
    const list: ThisComputerPermission[] = [
      ...SCREEN_PERMISSIONS.map((id) => ({ id, granted: permissions.granted[id] })),
      { id: "files", granted: await this.foldersAllowed() },
    ];
    if (this.guiding === "files" && list.at(-1)?.granted) this.guide(null, true);
    if (this.state.setupPending && list.every((permission) => permission.granted)) {
      this.saveState({ setupPending: false });
    }
    return list;
  }

  private async permissions(): Promise<Permissions> {
    const cached = this.permissionsCache;
    if (cached && Date.now() - cached.at < PERMISSIONS_TTL_MS) return cached.value;
    this.checking ??= (async () => {
      if (!existsSync(this.hostedPath)) return null;
      // A fresh process each time: a running one can keep an old answer.
      const result = await this.run(this.hostedPath, ["permissions"], { timeoutMs: 10_000 });
      return result.code === 0 ? parsePermissions(result.output) : null;
    })()
      .then((value) => {
        const before = this.permissionsCache?.value;
        this.permissionsCache = { at: Date.now(), value };
        if (newlyGranted(before ?? null, value)) {
          // The running agent learns about a new grant only by starting again.
          void this.agent.restart();
          this.deps.onChange();
        }
        if (value?.required) {
          const guiding = this.guiding;
          if (guiding && guiding !== "files" && value.granted[guiding]) this.guide(null, true);
        }
        return value;
      })
      .finally(() => {
        this.checking = null;
      });
    return await this.checking;
  }

  // --- Bookkeeping ------------------------------------------------------------------------------

  private loadState(): ComputerState {
    const fallback: ComputerState = {
      adopted: false,
      management: "app",
      appInstalled: false,
      paused: false,
      screenControl: false,
      requested: [],
      openAtLogin: false,
      setupPending: false,
      alsoIn: {},
      turnedOff: [],
      hostedService: null,
      askedAt: 0,
      owners: {},
    };
    try {
      const saved = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<ComputerState>;
      return {
        adopted: saved.adopted === true,
        management: saved.management === "service" ? "service" : "app",
        appInstalled: saved.appInstalled === true,
        paused: saved.paused === true,
        screenControl: saved.screenControl === true,
        requested: Array.isArray(saved.requested)
          ? saved.requested.filter((id) => PERMISSION_ORDER.includes(id))
          : [],
        openAtLogin: saved.openAtLogin === true,
        setupPending: saved.setupPending === true,
        alsoIn:
          saved.alsoIn && typeof saved.alsoIn === "object" && !Array.isArray(saved.alsoIn)
            ? Object.fromEntries(
                Object.entries(saved.alsoIn).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              )
            : {},
        turnedOff: Array.isArray(saved.turnedOff)
          ? saved.turnedOff.filter((entry): entry is string => typeof entry === "string")
          : [],
        hostedService:
          typeof saved.hostedService === "string" && saved.hostedService
            ? saved.hostedService
            : null,
        askedAt: typeof saved.askedAt === "number" ? saved.askedAt : 0,
        owners:
          saved.owners && typeof saved.owners === "object" && !Array.isArray(saved.owners)
            ? Object.fromEntries(
                Object.entries(saved.owners).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              )
            : {},
      };
    } catch {
      return fallback;
    }
  }

  private saveState(change: Partial<ComputerState>): boolean {
    this.state = { ...this.state, ...change };
    try {
      mkdirSync(this.deps.dataDir, { recursive: true });
      writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      return true;
    } catch {
      // Kept in memory; the next launch asks again.
      return false;
    }
  }

  /** Records whether a guarded folder opens, for the agent (see `allowedFoldersDir`). */
  private recordFolder(folder: (typeof GUARDED_FOLDERS)[number], opened: boolean): void {
    if (!this.allowedFoldersDir) return;
    const marker = join(this.allowedFoldersDir, folder);
    try {
      if (opened) {
        if (existsSync(marker)) return;
        mkdirSync(this.allowedFoldersDir, { recursive: true, mode: 0o700 });
        writeFileSync(marker, "", { mode: 0o600 });
      } else {
        rmSync(marker, { force: true });
      }
    } catch {
      // The folder stays out of whole-folder walks; nothing else changes.
    }
  }

  private async expect(
    pending: Promise<RunResult>,
    failure: string,
    code: ThisComputerErrorCode,
  ): Promise<RunResult> {
    const result = await pending;
    if (result.code !== 0) {
      throw new ThisComputerError(
        result.timedOut ? "offline" : code,
        failureMessage(failure, result),
      );
    }
    return result;
  }

  private fail(caught: unknown): void {
    this.error = errorText(caught);
    this.errorCode = caught instanceof ThisComputerError ? caught.code : "unknown";
  }

  private async act(action: () => Promise<void>): Promise<void> {
    if (this.busy) throw new ThisComputerError("busy", "This computer is already being set up.");
    this.busy = true;
    // A move into the app in progress finishes (or rolls back) first, so the
    // person's action applies to the agent as it then is.
    if (this.hosting) await this.hosting.catch(() => undefined);
    this.error = null;
    this.errorCode = null;
    this.deps.onChange();
    try {
      await action();
    } catch (caught) {
      this.fail(caught);
      throw caught;
    } finally {
      this.busy = false;
      this.invalidate();
      this.deps.onChange();
    }
  }
}

/** Some permission went from missing to granted between two readings. */
const CHROME_EXTENSION_ID = /^[a-p]{32}$/u;

/**
 * The app's own extension IDs as the agent's comma-separated setting, or null
 * for none. A malformed ID is a packaging mistake, so it fails at startup
 * instead of leaving that extension silently unable to connect.
 */
export function browserExtensionIdsEnv(ids: readonly string[] | undefined): string | null {
  if (!ids?.length) return null;
  for (const id of ids) {
    if (!CHROME_EXTENSION_ID.test(id)) {
      throw new Error(`"${id}" is not a Chrome extension ID (32 letters from a to p).`);
    }
  }
  return [...new Set(ids)].join(",");
}

export function newlyGranted(before: Permissions, after: Permissions): boolean {
  if (!before?.required || !after?.required) return false;
  return SCREEN_PERMISSIONS.some((id) => !before.granted[id] && after.granted[id]);
}

function killTree(pid: number, platform: AgentPlatform, force: boolean, now = false): void {
  try {
    if (platform === "win32") {
      // A console-less Windows program gets no signal; end it with its helpers.
      const args = ["/PID", String(pid), "/T", "/F"];
      if (now) spawnSync("taskkill", args, { windowsHide: true, timeout: 5_000 });
      else execFile("taskkill", args, { windowsHide: true }, () => undefined);
    } else {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    // Already gone.
  }
}

/** A failed call to the server: unreachable, or refused. */
/** A workspace on a server, as the state keeps it. */
function useKey(baseUrl: string, workspaceId: string): string {
  return `${normalizeServerUrl(baseUrl)} ${workspaceId}`;
}

/** A request that never got an answer: fetch's TypeError, or the SDK's transport failure. */
function transportFailure(caught: unknown): boolean {
  if (caught instanceof TypeError) return true;
  if (typeof caught !== "object" || caught === null) return false;
  const { status, code } = caught as { status?: unknown; code?: unknown };
  return status === 0 || code === "network_error";
}

function serverFailure(caught: unknown, failure: string): ThisComputerError {
  if (caught instanceof ThisComputerError) return caught;
  if (transportFailure(caught)) {
    return new ThisComputerError("offline", `${failure}: the server couldn't be reached.`, {
      cause: caught,
    });
  }
  if (
    typeof caught === "object" &&
    caught !== null &&
    (caught as { status?: unknown }).status === 401
  ) {
    return new ThisComputerError("signed_out", `${failure}: sign in again, then try again.`, {
      cause: caught,
    });
  }
  return new ThisComputerError("connect_failed", `${failure}: ${errorText(caught)}`, {
    cause: caught,
  });
}

/** A network failure as fetch implementations report it, not a server's answer. */
const NETWORK_FAILURE =
  /fetch failed|failed to fetch|networkerror|net::err_|econnrefused|econnreset|enotfound|etimedout|eai_again/iu;

/**
 * Why the server's list of machines couldn't be read: no network, the
 * account needs to sign in again, or the server answered with an error. A
 * server that answered is never reported as unreachable.
 */
export function machineReadFailure(caught: unknown): ThisComputerError {
  if (caught instanceof ThisComputerError) return caught;
  if (transportFailure(caught)) {
    return new ThisComputerError(
      "offline",
      "Couldn't reach the server to check this computer's connection. Check your connection and try again.",
      { cause: caught },
    );
  }
  const status =
    typeof caught === "object" && caught !== null && "status" in caught
      ? (caught as { status: unknown }).status
      : undefined;
  if (typeof status === "number") {
    if (status === 401) {
      return new ThisComputerError(
        "signed_out",
        "Sign in again to check this computer's connection.",
        { cause: caught },
      );
    }
    return new ThisComputerError(
      "unknown",
      `Couldn't check this computer's connection: ${errorText(caught)}`,
      { cause: caught },
    );
  }
  if (caught instanceof TypeError || NETWORK_FAILURE.test(errorText(caught))) {
    return new ThisComputerError(
      "offline",
      "Couldn't reach the server to check this computer's connection. Check your connection and try again.",
      { cause: caught },
    );
  }
  return new ThisComputerError(
    "unknown",
    `Couldn't check this computer's connection: ${errorText(caught)}`,
    { cause: caught },
  );
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function errorText(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  const message =
    typeof caught === "object" && caught !== null
      ? (caught as { message?: unknown }).message
      : null;
  return typeof message === "string" ? message : String(caught);
}

/** A plain sentence for a failed agent command: what failed, then why. */
function failureMessage(failure: string, result: RunResult): string {
  if (result.timedOut) return `${failure}: it took too long. Check your connection and try again.`;
  const detail = lastErrorLine(result.output);
  return detail ? `${failure}: ${detail}` : `${failure}.`;
}

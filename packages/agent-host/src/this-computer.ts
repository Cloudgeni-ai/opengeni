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
import { macSystemNames, type MacSystemNameCatalog } from "@opengeni/sdk/this-computer";
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
   * Take over an agent installed separately on this computer (its background
   * service, and on a Mac the older standalone agent app). Default true; an
   * app with its own agent leaves other agents alone.
   */
  adoptStandaloneAgent?: boolean;
  /**
   * Let the Opengeni Browser Chrome extension reach this agent, so agents can
   * work in the person's own Chrome. Default true. An app whose people don't
   * use that extension turns it off: its agent then leaves the extension to
   * any other agent on the computer.
   */
  browserExtension?: boolean;
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
  /** Moves a file or folder to the Trash. */
  trash(path: string): Promise<void>;
  /**
   * The separate Mac agent app, which held the screen-control permissions,
   * was handed over: the person has to allow them again for this app.
   */
  onScreenControlHandedOver?(): void;
  onChange(): void;
}

/** What the app remembers about this computer between launches. */
interface ComputerState {
  /** A separately installed agent's background service was handed over to the app. */
  adopted: boolean;
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
const LOG_LIMIT_BYTES = 10 * 1024 * 1024;

type Permissions = ReturnType<typeof parsePermissions>;

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
  private readonly hostedPath: string;
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
  /** The permission the person was sent to System Settings for, while it is missing. */
  private guiding: ThisComputerPermissionId | null = null;
  /** Environment every agent command gets: the host marker and, when set, its own config. */
  private readonly agentEnv: Record<string, string>;

  constructor(private readonly deps: ThisComputerDeps) {
    this.hostedPath = deps.agentPath ?? hostedAgentPath(deps.platform, deps.home, deps.env);
    this.agentEnv = {
      ...(deps.agentConfigDir ? { OPENGENI_CONFIG_DIR: deps.agentConfigDir } : {}),
      ...(deps.browserExtension === false ? { OPENGENI_AGENT_BROWSER_EXTENSION: "off" } : {}),
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
    return this.deps.adoptStandaloneAgent !== false;
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
    if (connected === this.state.openAtLogin) return null;
    this.saveState({ openAtLogin: connected });
    return connected ? "open" : "stop";
  }

  /**
   * At launch: start the agent when this computer serves a workspace and isn't
   * paused. A separately installed agent is taken over first.
   */
  async boot(): Promise<void> {
    if (!this.supported || this.state.paused) return;
    if (!this.state.adopted && !this.hasAnyAgent()) return;
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

  async status(baseUrl: string, workspaceId: string): Promise<ThisComputerStatus> {
    const base = {
      busy: this.busy || this.installing !== null,
      error: this.error,
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
      machineName: await computerName(),
      ...(this.progress !== null ? { setupProgress: this.progress } : {}),
    };
    if (!this.supported || !agentAssetName(this.deps.platform, this.deps.arch)) {
      return { ...base, state: "unavailable" };
    }
    if (!existsSync(this.hostedPath)) return { ...base, state: "not_installed" };
    const connections = await this.connections();
    if (!this.connectionIn(connections, baseUrl, workspaceId)) {
      return { ...base, state: "not_connected" };
    }
    const permissions = await this.permissionList();
    const missing = permissions?.some((permission) => !permission.granted) ?? false;
    return {
      ...base,
      state: this.state.paused ? "paused" : "connected",
      ...(permissions
        ? {
            permissions,
            systemNames: macSystemNames(this.deps.systemLanguages?.() ?? [], this.deps.systemNames),
          }
        : {}),
      ...(missing && this.state.setupPending ? { setupPending: true } : {}),
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
    const connections = await this.connections();
    const permissions = connections.length > 0 ? await this.permissionList() : null;
    const missingPermissions = (permissions ?? [])
      .filter((permission) => !permission.granted)
      .map((permission) => permission.id);
    return {
      installed: existsSync(this.hostedPath),
      connected: connections.length > 0,
      running: !this.state.paused && this.agent.state !== "stopped",
      reconnecting: !this.state.paused && connections.length > 0 && this.agent.state !== "running",
      needsPermissions: missingPermissions.length > 0,
      missingPermissions,
    };
  }

  async connect(
    accountId: string,
    baseUrl: string,
    workspaceId: string,
    options: ThisComputerConnectOptions,
  ): Promise<ThisComputerStatus> {
    await this.act(async () => {
      const binary = await this.ensureInstalled(baseUrl);
      if (await this.connectThroughAnother(accountId, baseUrl, workspaceId, options)) return;
      const token = await this.deps
        .mintEnrollToken(accountId, workspaceId, options.screenControl)
        .catch((caught: unknown) => {
          throw serverFailure(caught, "Couldn't start setting up this computer");
        });
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
        paused: false,
        screenControl: this.state.screenControl || options.screenControl,
        setupPending: options.screenControl && this.deps.platform === "darwin",
        turnedOff: this.state.turnedOff.filter((key) => key !== useKey(baseUrl, workspaceId)),
      });
      // A running agent reads its connections when it starts.
      if (this.agent.state === "stopped") this.agent.start(baseUrl);
      else await this.agent.restart();
      const connection = connectionFor(await this.connections(true), baseUrl, workspaceId);
      if (!connection) {
        throw new ThisComputerError("connect_failed", "Couldn't connect this computer. Try again.");
      }
      await this.deps.allowAgents(accountId, workspaceId, connection.agentId).catch((caught) => {
        throw serverFailure(caught, "Couldn't let agents use this computer");
      });
    });
    return await this.status(baseUrl, workspaceId);
  }

  async pause(): Promise<void> {
    await this.act(async () => {
      this.saveState({ paused: true });
      await this.agent.stop();
    });
  }

  async resume(): Promise<void> {
    await this.act(async () => {
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
        await this.agent.stop();
      } else {
        await this.agent.restart();
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
    if (options.screenControl && !this.state.screenControl) return false;
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
      try {
        await this.deps.allowAgents(accountId, workspaceId, connection.agentId);
      } catch {
        continue;
      }
      if (connection === own) {
        this.saveState({ turnedOff: this.state.turnedOff.filter((entry) => entry !== key) });
      } else {
        this.saveState({ alsoIn: { ...this.state.alsoIn, [key]: connection.agentId } });
      }
      this.saveState({ paused: false });
      if (this.agent.state === "stopped") this.agent.start(connection.apiUrl);
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
        if (!(await this.opensFolder(join(this.deps.home, folder), null))) allowed = false;
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
      GUARDED_FOLDERS.map((folder) =>
        this.opensFolder(join(this.deps.home, folder), FOLDER_CHECK_MS),
      ),
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

  /** Stops the agent with the app. It starts again when the app next opens. */
  async shutdown(): Promise<void> {
    this.stopWatchingForGrants();
    for (const check of this.folderChecks) check.kill("SIGKILL");
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
  }

  /** Forget the cached readings, e.g. when the window comes back to the front. */
  invalidate(): void {
    this.connectionsCache = null;
    this.permissionsCache = null;
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
    const learned = this.state.adopted || !this.adopts ? null : await this.adoptStandalone();
    if (await this.versionOf(this.hostedPath)) return this.hostedPath;
    if (this.deps.bundledAgent) {
      throw new ThisComputerError(
        "unsupported",
        "This app's copy of the agent is missing or damaged. Reinstall the app.",
      );
    }
    const from = server ?? learned;
    if (!from) {
      throw new ThisComputerError("connect_failed", "Set up this computer again from a workspace.");
    }
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

  /**
   * Hands a separately installed agent over to the app, once: its background
   * service is removed (its connections stay), and on a Mac the separate agent
   * app goes to the Trash with its entries in Privacy & Security. That app was
   * how agents used the screen, so screen control carries over and its
   * permissions become part of setting up this app.
   */
  private async adoptStandalone(): Promise<string | null> {
    const macApp = this.deps.platform === "darwin" ? standaloneMacAgentApp(this.deps.home) : null;
    const macBinary = macApp ? join(macApp, "Contents", "MacOS", "opengeni-agent") : null;
    const existing = [this.hostedPath, macBinary].find(
      (candidate): candidate is string => candidate !== null && existsSync(candidate),
    );
    let server: string | null = null;
    if (existing) {
      const listed = await this.run(existing, ["connections"], { timeoutMs: 15_000 });
      server = listed.code === 0 ? (parseConnections(listed.output)[0]?.apiUrl ?? null) : null;
      const removed = await this.run(existing, ["service", "uninstall"], { timeoutMs: 60_000 });
      if (removed.code !== 0) {
        throw new ThisComputerError(
          "takeover_failed",
          failureMessage("Couldn't take over the agent already on this computer", removed),
        );
      }
    }
    const handsOverScreen = macApp !== null && existsSync(macApp);
    if (macApp && handsOverScreen) {
      if (isSymlink(this.hostedPath)) unlinkSync(this.hostedPath);
      await this.deps.trash(macApp);
      execFile("/usr/bin/tccutil", ["reset", "All", "ai.opengeni.agent"], () => undefined);
    }
    this.saveState({ adopted: true, ...(handsOverScreen ? { screenControl: true } : {}) });
    if (handsOverScreen) this.deps.onScreenControlHandedOver?.();
    return server;
  }

  // --- Running it -------------------------------------------------------------------------------

  private spawnAgent(apiUrl: string): AgentChild {
    const log = this.openLog();
    try {
      const child = spawn(this.hostedPath, ["--api-url", apiUrl, "run"], {
        // Plain text: the log is a file, not a terminal.
        // The app's own config folder, so it runs this app's connections and
        // never meets another agent's single-instance lock.
        env: { ...process.env, ...HOST_ENV, ...this.agentEnv, NO_COLOR: "1" },
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
    if (!this.state.screenControl || this.deps.platform !== "darwin") return null;
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
      paused: false,
      screenControl: false,
      requested: [],
      openAtLogin: false,
      setupPending: false,
      alsoIn: {},
      turnedOff: [],
    };
    try {
      const saved = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<ComputerState>;
      return {
        adopted: saved.adopted === true,
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
      };
    } catch {
      return fallback;
    }
  }

  private saveState(change: Partial<ComputerState>): void {
    this.state = { ...this.state, ...change };
    try {
      mkdirSync(this.deps.dataDir, { recursive: true });
      writeFileSync(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Kept in memory; the next launch asks again.
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

function serverFailure(caught: unknown, failure: string): ThisComputerError {
  if (caught instanceof ThisComputerError) return caught;
  if (caught instanceof TypeError) {
    return new ThisComputerError("offline", `${failure}: the server couldn't be reached.`, {
      cause: caught,
    });
  }
  return new ThisComputerError("connect_failed", `${failure}: ${errorText(caught)}`, {
    cause: caught,
  });
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** A plain sentence for a failed agent command: what failed, then why. */
function failureMessage(failure: string, result: RunResult): string {
  if (result.timedOut) return `${failure}: it took too long. Check your connection and try again.`;
  const detail = lastErrorLine(result.output);
  return detail ? `${failure}: ${detail}` : `${failure}.`;
}

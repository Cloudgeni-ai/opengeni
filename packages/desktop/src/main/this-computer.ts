import { execFile, spawn, spawnSync } from "node:child_process";
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
  ThisComputerPermission,
  ThisComputerPermissionId,
  ThisComputerStatus,
} from "../contract";
import {
  connectionFor,
  hostedAgentPath,
  lastErrorLine,
  parseAgentVersion,
  parseConnections,
  parsePermissions,
  standaloneMacAgentApp,
  type AgentConnection,
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
  /** Where the agent's log goes. */
  logDir: string;
  /** A single-use personal enroll token for the account's workspace. */
  mintEnrollToken(accountId: string, workspaceId: string, screenControl: boolean): Promise<string>;
  /** Opens a page of the system settings, e.g. one Privacy & Security list. */
  openSystemSettings(url: string): void;
  /** Moves a file or folder to the Trash. */
  trash(path: string): Promise<void>;
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
}

const PERMISSION_ORDER: readonly ThisComputerPermissionId[] = [
  "screenRecording",
  "accessibility",
  "inputMonitoring",
];

const SETTINGS_PANES: Record<ThisComputerPermissionId, string> = {
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  inputMonitoring: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
};

const REQUEST_ARGUMENT: Record<ThisComputerPermissionId, string> = {
  screenRecording: "screen-recording",
  accessibility: "accessibility",
  inputMonitoring: "input-monitoring",
};

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
  private checking: Promise<Permissions> | null = null;
  private installing: Promise<string> | null = null;
  /** How much of the agent has downloaded, from 0 to 1, while it downloads. */
  private progress: number | null = null;
  private busy = false;
  private error: string | null = null;
  private childPid: number | null = null;
  private grantWatch: { timer: NodeJS.Timeout; until: number } | null = null;

  constructor(private readonly deps: ThisComputerDeps) {
    this.hostedPath = hostedAgentPath(deps.platform, deps.home, deps.env);
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
      this.error = message(caught);
      this.deps.onChange();
    }
  }

  async status(baseUrl: string, workspaceId: string): Promise<ThisComputerStatus> {
    const base = {
      busy: this.busy || this.installing !== null,
      error: this.error,
      machineName: await computerName(),
      ...(this.progress !== null ? { setupProgress: this.progress } : {}),
    };
    if (!this.supported || !agentAssetName(this.deps.platform, this.deps.arch)) {
      return { ...base, state: "unavailable" };
    }
    if (!existsSync(this.hostedPath)) return { ...base, state: "not_installed" };
    const connections = await this.connections();
    if (!connectionFor(connections, baseUrl, workspaceId)) {
      return { ...base, state: "not_connected" };
    }
    const permissions = await this.permissionList();
    return {
      ...base,
      state: this.state.paused ? "paused" : "connected",
      ...(permissions ? { permissions } : {}),
    };
  }

  /** For the menu bar item and quitting: whether agents can use this computer now. */
  async summary(): Promise<{
    installed: boolean;
    connected: boolean;
    running: boolean;
    needsPermissions: boolean;
    /** In the order to allow them. */
    missingPermissions: ThisComputerPermissionId[];
  }> {
    if (!this.supported) {
      return {
        installed: false,
        connected: false,
        running: false,
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
      const token = await this.deps.mintEnrollToken(accountId, workspaceId, options.screenControl);
      await this.expect(
        run(binary, ["--api-url", baseUrl, "connect", "--non-interactive"], {
          env: { OPENGENI_API_URL: baseUrl, OPENGENI_ENROLL_TOKEN: token },
          timeoutMs: 120_000,
        }),
        "Couldn't connect this computer",
      );
      this.saveState({
        paused: false,
        screenControl: this.state.screenControl || options.screenControl,
      });
      // A running agent reads its connections when it starts.
      if (this.agent.state === "stopped") this.agent.start(baseUrl);
      else await this.agent.restart();
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
      if (!first) throw new Error("This computer isn't connected to a workspace yet.");
      this.agent.start(first.apiUrl);
    });
  }

  /**
   * Asks for one screen-control permission. The first time the system shows
   * its own prompt, under the app's name; after that the person turns it on in
   * System Settings, which opens at the right list.
   */
  async requestPermission(id: ThisComputerPermissionId): Promise<void> {
    if (this.deps.platform !== "darwin" || !PERMISSION_ORDER.includes(id)) return;
    this.watchForGrants();
    if (this.state.requested.includes(id) || !existsSync(this.hostedPath)) {
      this.deps.openSystemSettings(SETTINGS_PANES[id]);
      return;
    }
    this.saveState({ requested: [...this.state.requested, id] });
    await run(this.hostedPath, ["permissions", "--request", REQUEST_ARGUMENT[id]], {
      timeoutMs: 30_000,
    });
    this.permissionsCache = null;
    this.deps.onChange();
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
  }

  /** Stops the agent with the app. It starts again when the app next opens. */
  async shutdown(): Promise<void> {
    this.stopWatchingForGrants();
    await this.agent.stop();
  }

  /**
   * The app is ending now: tell a still-running agent to stop, without waiting.
   * Otherwise it would outlive the app and hold this computer's single agent.
   */
  shutdownNow(): void {
    this.stopWatchingForGrants();
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
      (this.deps.platform === "darwin" && existsSync(standaloneMacAgentApp(this.deps.home)))
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
    const learned = this.state.adopted ? null : await this.adoptStandalone();
    if (await this.versionOf(this.hostedPath)) return this.hostedPath;
    const from = server ?? learned;
    if (!from) throw new Error("Set up this computer again from a workspace.");
    await this.download(from);
    return this.hostedPath;
  }

  private async versionOf(binary: string): Promise<string | null> {
    if (!existsSync(binary)) return null;
    const result = await run(binary, ["--version"], { timeoutMs: 15_000 });
    return result.code === 0 ? parseAgentVersion(result.output) : null;
  }

  /**
   * Downloads the server's current agent next to where it goes, checks its
   * signature, then moves it into place, so there is never a half-written or
   * unverified agent to run.
   */
  private async download(server: string): Promise<void> {
    const asset = agentAssetName(this.deps.platform, this.deps.arch);
    if (!asset) throw new Error("Agents can't use this kind of computer yet.");
    const url = new URL(`/agent/latest/${asset}`, server).toString();
    const [file, signature] = await Promise.all([
      this.deps.fetch(url),
      this.deps.fetch(`${url}.minisig`),
    ]);
    if (!file.ok || !file.body || !signature.ok) {
      throw new Error(
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
      throw new Error(`Couldn't set up the agent: ${message(caught)}`, { cause: caught });
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
   * app goes to the Trash with its entries in Privacy & Security.
   */
  private async adoptStandalone(): Promise<string | null> {
    const macApp = this.deps.platform === "darwin" ? standaloneMacAgentApp(this.deps.home) : null;
    const macBinary = macApp ? join(macApp, "Contents", "MacOS", "opengeni-agent") : null;
    const existing = [this.hostedPath, macBinary].find(
      (candidate): candidate is string => candidate !== null && existsSync(candidate),
    );
    let server: string | null = null;
    if (existing) {
      const listed = await run(existing, ["connections"], { timeoutMs: 15_000 });
      server = listed.code === 0 ? (parseConnections(listed.output)[0]?.apiUrl ?? null) : null;
      const removed = await run(existing, ["service", "uninstall"], { timeoutMs: 60_000 });
      if (removed.code !== 0) {
        throw new Error(
          failureMessage("Couldn't take over the agent already on this computer", removed),
        );
      }
    }
    if (macApp && existsSync(macApp)) {
      if (isSymlink(this.hostedPath)) unlinkSync(this.hostedPath);
      await this.deps.trash(macApp);
      execFile("/usr/bin/tccutil", ["reset", "All", "ai.opengeni.agent"], () => undefined);
    }
    this.saveState({ adopted: true });
    return server;
  }

  // --- Running it -------------------------------------------------------------------------------

  private spawnAgent(apiUrl: string): AgentChild {
    const log = this.openLog();
    try {
      const child = spawn(this.hostedPath, ["--api-url", apiUrl, "run"], {
        // Plain text: the log is a file, not a terminal.
        env: { ...process.env, ...HOST_ENV, NO_COLOR: "1" },
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
      if (!existsSync(this.hostedPath)) return [];
      const result = await run(this.hostedPath, ["connections"], { timeoutMs: 15_000 });
      return result.code === 0 ? parseConnections(result.output) : [];
    })()
      .then((value) => {
        this.connectionsCache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.reading = null;
      });
    return await this.reading;
  }

  /** The screen-control permissions to set up, or null when there are none to ask for. */
  private async permissionList(): Promise<ThisComputerPermission[] | null> {
    if (!this.state.screenControl || this.deps.platform !== "darwin") return null;
    const permissions = await this.permissions();
    if (!permissions?.required) return null;
    return PERMISSION_ORDER.map((id) => ({ id, granted: permissions.granted[id] }));
  }

  private async permissions(): Promise<Permissions> {
    const cached = this.permissionsCache;
    if (cached && Date.now() - cached.at < PERMISSIONS_TTL_MS) return cached.value;
    this.checking ??= (async () => {
      if (!existsSync(this.hostedPath)) return null;
      // A fresh process each time: a running one can keep an old answer.
      const result = await run(this.hostedPath, ["permissions"], { timeoutMs: 10_000 });
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

  private async expect(pending: Promise<RunResult>, failure: string): Promise<RunResult> {
    const result = await pending;
    if (result.code !== 0) throw new Error(failureMessage(failure, result));
    return result;
  }

  private async act(action: () => Promise<void>): Promise<void> {
    if (this.busy) throw new Error("This computer is already being set up.");
    this.busy = true;
    this.error = null;
    this.deps.onChange();
    try {
      await action();
    } catch (caught) {
      this.error = message(caught);
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
  return PERMISSION_ORDER.some((id) => !before.granted[id] && after.granted[id]);
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

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** A plain sentence for a failed agent command: what failed, then why. */
function failureMessage(failure: string, result: RunResult): string {
  if (result.timedOut) return `${failure}: it took too long. Check your connection and try again.`;
  const detail = lastErrorLine(result.output);
  return detail ? `${failure}: ${detail}` : `${failure}.`;
}

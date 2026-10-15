import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ThisComputerConnectOptions, ThisComputerStatus } from "../contract";
import {
  agentBinaryCandidates,
  connectionFor,
  lastErrorLine,
  parseConnections,
  parseServiceRunning,
  repairServer,
  windowsInstallCommand,
  type AgentConnection,
  type AgentPlatform,
} from "./agent-cli";
import { computerName } from "./computer-name";

interface RunResult {
  code: number;
  output: string;
  /** Killed for running past its time limit. */
  timedOut: boolean;
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
        env: { ...process.env, ...options.env },
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
  home: string;
  /** A single-use personal enroll token for the account's workspace. */
  mintEnrollToken(accountId: string, workspaceId: string, screenControl: boolean): Promise<string>;
  /** The server's installer script, fetched with the app's network stack. */
  fetchInstaller(baseUrl: string, fileName: string): Promise<string>;
  onChange(): void;
}

interface Snapshot {
  at: number;
  installed: boolean;
  running: boolean;
  connections: AgentConnection[];
}

const SNAPSHOT_TTL_MS = 3_000;

/**
 * The connected-machine agent on this computer. The deployment's own installer
 * puts it in place (verified, signed, with its own updater and background
 * service); this class connects it to a workspace with a single-use token,
 * reads where it stands, and pauses or resumes the background service. The
 * agent keeps running when the app quits.
 */
export class ThisComputer {
  private snapshotCache: Snapshot | null = null;
  private inflight: Promise<Snapshot> | null = null;
  private busy = false;
  private error: string | null = null;

  constructor(private readonly deps: ThisComputerDeps) {}

  get supported(): boolean {
    return ["darwin", "linux", "win32"].includes(this.deps.platform);
  }

  binaryPath(): string | null {
    return (
      agentBinaryCandidates(this.deps.platform, this.deps.home, process.env).find((candidate) =>
        existsSync(candidate),
      ) ?? null
    );
  }

  async status(baseUrl: string, workspaceId: string): Promise<ThisComputerStatus> {
    const base = { busy: this.busy, error: this.error, machineName: await computerName() };
    if (!this.supported) return { ...base, state: "unavailable" };
    const snapshot = await this.snapshot();
    if (!snapshot.installed) return { ...base, state: "not_installed" };
    if (!connectionFor(snapshot.connections, baseUrl, workspaceId)) {
      return { ...base, state: "not_connected" };
    }
    return { ...base, state: snapshot.running ? "connected" : "paused" };
  }

  /** Whether the agent serves anything here, and whether it runs, for the menu bar item. */
  async summary(): Promise<{ installed: boolean; connected: boolean; running: boolean }> {
    if (!this.supported) return { installed: false, connected: false, running: false };
    const snapshot = await this.snapshot();
    return {
      installed: snapshot.installed,
      connected: snapshot.connections.length > 0,
      running: snapshot.running,
    };
  }

  async connect(
    accountId: string,
    baseUrl: string,
    workspaceId: string,
    options: ThisComputerConnectOptions,
  ): Promise<ThisComputerStatus> {
    await this.act(async () => {
      const token = await this.deps.mintEnrollToken(accountId, workspaceId, options.screenControl);
      const env = { OPENGENI_API_URL: baseUrl, OPENGENI_ENROLL_TOKEN: token };
      const binary = this.binaryPath();
      if (binary) {
        await this.expect(
          run(binary, ["--api-url", baseUrl, "connect", "--non-interactive"], {
            env,
            timeoutMs: 120_000,
          }),
          "Couldn't connect this computer",
        );
        await this.startOrRepair(binary, baseUrl, "Couldn't start the agent");
        return;
      }
      await this.install(baseUrl, env);
    });
    return await this.status(baseUrl, workspaceId);
  }

  async pause(): Promise<void> {
    await this.act(async () => {
      const binary = this.binaryPath();
      if (binary)
        await this.expect(run(binary, ["stop"], { timeoutMs: 60_000 }), "Couldn't pause the agent");
    });
  }

  /**
   * Starts the background agent again. `baseUrl` is the server asking (the
   * menu bar item has none); a broken agent is repaired from it, or from the
   * first server the agent is connected to.
   */
  async resume(baseUrl?: string): Promise<void> {
    await this.act(async () => {
      const binary = this.binaryPath();
      if (!binary) return;
      const { connections } = await this.snapshot();
      await this.startOrRepair(
        binary,
        repairServer(connections, baseUrl),
        "Couldn't resume the agent",
      );
    });
  }

  /** Forget the cached reading, e.g. when the window comes back to the front. */
  invalidate(): void {
    this.snapshotCache = null;
  }

  /**
   * Starts the background agent. An installed agent that cannot start (an older
   * release, a damaged file) is replaced by the server's current release, then
   * started again. The installer runs without an enrollment token, so it only
   * puts the binary in place; the saved connections are unchanged.
   */
  private async startOrRepair(
    binary: string,
    server: string | null,
    failure: string,
  ): Promise<void> {
    const started = await run(binary, ["start"], { timeoutMs: 60_000 });
    if (started.code === 0) return;
    if (!server) throw new Error(failureMessage(failure, started));
    await this.install(server, { OPENGENI_API_URL: server });
    await this.expect(run(binary, ["start", "--restart"], { timeoutMs: 60_000 }), failure);
  }

  private async install(baseUrl: string, env: Record<string, string>): Promise<void> {
    const windows = this.deps.platform === "win32";
    const script = await this.deps.fetchInstaller(baseUrl, windows ? "install.ps1" : "install.sh");
    const directory = mkdtempSync(join(tmpdir(), "opengeni-install-"));
    try {
      const path = join(directory, windows ? "install.ps1" : "install.sh");
      writeFileSync(path, script, { mode: 0o700 });
      const result = windows
        ? run(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              windowsInstallCommand(path),
            ],
            { env, timeoutMs: 600_000 },
          )
        : run("/bin/sh", [path], { env, timeoutMs: 600_000 });
      await this.expect(result, "Couldn't install the agent");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  private async expect(pending: Promise<RunResult>, failure: string): Promise<RunResult> {
    const result = await pending;
    if (result.code !== 0) {
      throw new Error(failureMessage(failure, result));
    }
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
      this.error = caught instanceof Error ? caught.message : String(caught);
      throw caught;
    } finally {
      this.busy = false;
      this.snapshotCache = null;
      this.deps.onChange();
    }
  }

  private async snapshot(): Promise<Snapshot> {
    if (this.snapshotCache && Date.now() - this.snapshotCache.at < SNAPSHOT_TTL_MS) {
      return this.snapshotCache;
    }
    this.inflight ??= this.read().finally(() => {
      this.inflight = null;
    });
    return await this.inflight;
  }

  private async read(): Promise<Snapshot> {
    const binary = this.binaryPath();
    if (!binary) {
      this.snapshotCache = { at: Date.now(), installed: false, running: false, connections: [] };
      return this.snapshotCache;
    }
    const [connections, status] = await Promise.all([
      run(binary, ["connections"], { timeoutMs: 15_000 }),
      run(binary, ["status"], { timeoutMs: 15_000 }),
    ]);
    this.snapshotCache = {
      at: Date.now(),
      installed: true,
      running: status.code === 0 && parseServiceRunning(status.output),
      connections: connections.code === 0 ? parseConnections(connections.output) : [],
    };
    return this.snapshotCache;
  }
}

/** A plain sentence for a failed agent command: what failed, then why. */
function failureMessage(failure: string, result: RunResult): string {
  if (result.timedOut) return `${failure}: it took too long. Check your connection and try again.`;
  const detail = lastErrorLine(result.output);
  return detail ? `${failure}: ${detail}` : `${failure}.`;
}

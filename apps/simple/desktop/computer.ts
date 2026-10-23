// "This computer" for Opengeni Simple: the person's agents can work on this
// Mac (commands, the screen, their own Chrome through the Opengeni Browser
// extension). The connected-machine agent runs as this app's helper while the
// app is open, so macOS shows the permissions under this app's name.
//
// Bundled by Bun into desktop/out/computer.cjs, which main.cjs requires.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  net,
  screen,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { OpenGeniClient } from "@opengeni/sdk";
import {
  macSystemNames,
  THIS_COMPUTER_PERMISSION_ORDER,
  type ThisComputerPermissionId,
} from "@opengeni/sdk/this-computer";
import {
  allowAgentsOnComputer,
  disallowAgentsOnComputer,
  OPENGENI_AGENT_SIGNING_KEY,
  ThisComputer,
} from "@opengeni/agent-host";
import {
  defaultPermissionGuideLabels,
  PermissionGuide,
} from "@opengeni/agent-host/permission-guide";
import { macLoginAgentName } from "@opengeni/desktop/mac-login-agent";

import { SIMPLE_IPC } from "./ipc";

/** The server the app is signed in to, with the person's token for it. */
export interface SimpleAccount {
  serverUrl: string;
  token: string;
}

export interface SimpleComputerOptions {
  appId: string;
  productName: string;
  /** The signed-in server, or null while signed out. */
  account(): SimpleAccount | null;
  /** The app window and the local server origin it shows, or null when there is none. */
  appWindow(): { contents: WebContents; origin: string } | null;
  /** Bring the app window forward, e.g. after the last permission is allowed. */
  reveal(): void;
  log(line: string): void;
}

export interface SimpleComputer {
  /** At launch: start the agent when this computer serves a workspace and isn't paused. */
  boot(): Promise<void>;
  /** The account changed (sign-in, server switch, sign-out): forget cached readings. */
  reset(): void;
  /** Whether quitting now should ask first, because agents would lose this computer. */
  quitNeedsQuestion(): Promise<boolean>;
  /**
   * Whether this quit is macOS's "Quit & Reopen" after a permission: one was
   * asked for lately and System Settings is in front. The app then quits at
   * once and opens again by itself.
   */
  quitIsForPermission(): boolean;
  /** Stops the agent with the app; it starts again when the app next opens. */
  shutdown(): Promise<void>;
  /** The app is ending now: stop the agent without waiting. */
  shutdownNow(): void;
}

/**
 * Opened by the system at login, to keep this computer available without a
 * window: with `--hidden` (the bundled login agent's argument), or by a
 * macOS 12 login item.
 */
export function openedAtLogin(): boolean {
  if (process.argv.includes("--hidden")) return true;
  return process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin === true;
}

/** The oldest agent release that works with this app. */
const MINIMUM_AGENT_VERSION = "0.1.124";
/** How long after asking for a permission a quit from outside the app is macOS's. */
const PERMISSION_QUIT_WINDOW_MS = 15 * 60_000;

/** Whether System Settings is the app in front, so a quit now came from it. */
function systemSettingsInFront(): boolean {
  if (process.platform !== "darwin") return false;
  const run = (args: string[]) =>
    spawnSync("/usr/bin/lsappinfo", args, { encoding: "utf8", timeout: 2000 }).stdout ?? "";
  const front = run(["front"]).trim();
  if (!front) return false;
  return /"CFBundleIdentifier"="com\.apple\.(systempreferences|settings)/u.test(
    run(["info", "-only", "bundleid", front]),
  );
}

export function createSimpleComputer(options: SimpleComputerOptions): SimpleComputer {
  const userData = app.getPath("userData");
  let cached: { key: string; client: OpenGeniClient } | null = null;

  /** The API client for the account ThisComputer names (the server URL), as the person. */
  const client = (accountId: string): OpenGeniClient | null => {
    const account = options.account();
    if (!account || account.serverUrl !== accountId) return null;
    const key = `${account.serverUrl}\n${account.token}`;
    if (cached?.key !== key) {
      cached = {
        key,
        client: new OpenGeniClient({
          baseUrl: account.serverUrl,
          // The `ogapp_` token from the native sign-in. The API admits bearer
          // callers from any SDK revision of this major; the SDK still names
          // its own `x-opengeni-api-contract` revision on every request.
          apiKey: account.token,
          fetch: ((input: string, init?: RequestInit) => net.fetch(input, init)) as never,
          onDeprecation: false,
          apiContract: "compatible",
        }),
      };
    }
    return cached.client;
  };
  const signedIn = (accountId: string): OpenGeniClient => {
    const found = client(accountId);
    if (!found) throw new Error("Sign in again to manage this computer.");
    return found;
  };

  const permissionGuide = new PermissionGuide({
    electron: { BrowserWindow, screen, nativeTheme },
    appName: options.productName,
    labels: defaultPermissionGuideLabels(
      options.productName,
      macSystemNames(app.getPreferredSystemLanguages()),
    ),
    // The bundle's icon; the executable inside it has a generic one.
    appIcon: async () =>
      (
        await app.getFileIcon(process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/u, ""), {
          size: "normal",
        })
      ).toDataURL(),
    onFinished: () => {
      app.focus({ steal: true });
      options.reveal();
    },
  });

  const computer: ThisComputer = new ThisComputer({
    platform: process.platform as "darwin" | "linux" | "win32",
    arch: process.arch,
    home: homedir(),
    env: process.env,
    agentSigningKey: OPENGENI_AGENT_SIGNING_KEY,
    // This app keeps its own agent, apart from the one Opengeni.app or the
    // command-line installer runs, so the two never compete for one agent's
    // single-instance lock or its connections.
    agentPath: join(userData, "agent", "opengeni-agent"),
    agentConfigDir: join(userData, "agent", "config"),
    adoptStandaloneAgent: false,
    // Servers can name an old stable agent; this app needs one that reports
    // and asks for permissions and links the Chrome extension.
    minimumAgentVersion: MINIMUM_AGENT_VERSION,
    fetch: (url) => net.fetch(url),
    dataDir: userData,
    systemLanguages: () => app.getPreferredSystemLanguages(),
    logDir: app.getPath("logs"),
    mintEnrollToken: async (accountId, workspaceId, screenControl) => {
      const minted = await signedIn(accountId).mintEnrollToken(workspaceId, {
        scope: "user",
        allowScreenControl: screenControl,
      });
      return minted.token;
    },
    allowAgents: async (accountId, workspaceId, enrollmentId) => {
      await allowAgentsOnComputer(signedIn(accountId), workspaceId, enrollmentId);
    },
    disallowAgents: async (accountId, workspaceId, enrollmentId) => {
      await disallowAgentsOnComputer(signedIn(accountId), workspaceId, enrollmentId);
    },
    readMachine: async (accountId, _baseUrl, workspaceId, enrollmentId) => {
      const found = client(accountId);
      if (!found) return null;
      const machines = await found.listMachines(workspaceId);
      const machine = machines.machines.find((entry) => entry.enrollmentId === enrollmentId);
      return machine
        ? {
            online: ["online", "consent_required", "display_unavailable"].includes(machine.state),
            screenControl: machine.allowScreenControl,
            permissions: machine.runtime?.macPermissions ?? null,
          }
        : null;
    },
    enableScreenControl: async (accountId, workspaceId, enrollmentId) => {
      await signedIn(accountId).enableMachineScreenControl(workspaceId, enrollmentId);
    },
    openSystemSettings: (url) => void shell.openExternal(url),
    onGuidePermission: (id, granted) => {
      if (id) permissionGuide.show(id);
      else if (granted) permissionGuide.granted();
      else permissionGuide.hide();
    },
    onChange: () => {
      const window = options.appWindow();
      if (window && !window.contents.isDestroyed()) {
        window.contents.send(SIMPLE_IPC.computerChanged);
      }
      followOpenAtLogin();
    },
  });

  // A connected computer opens the app (without a window) at login, once per
  // connection: someone who then turns it off in System Settings keeps it off.
  let following: Promise<void> | null = null;
  let followAgain = false;
  const followOpenAtLogin = (): void => {
    if (following) {
      followAgain = true;
      return;
    }
    following = (async () => {
      do {
        followAgain = false;
        const summary = await computer.summary();
        const change = computer.openAtLoginChange(summary.connected);
        if (change && app.isPackaged) setOpenAtLogin(options.appId, change === "open");
        if (change) options.log(`open at login: ${change}`);
      } while (followAgain);
    })()
      .catch((caught: unknown) => options.log(`open at login: ${String(caught)}`))
      .finally(() => {
        following = null;
      });
  };

  /** The account behind a message from the app window's own page, top frame only. */
  const sender = (event: IpcMainInvokeEvent): SimpleAccount => {
    const window = options.appWindow();
    const frame = event.senderFrame;
    if (!window || event.sender !== window.contents || !frame || frame !== event.sender.mainFrame)
      throw new Error("Not allowed");
    if (new URL(frame.url).origin !== window.origin) throw new Error("Not allowed");
    const account = options.account();
    if (!account) throw new Error("Sign in again to manage this computer.");
    return account;
  };
  const workspace = (value: unknown): string => {
    if (typeof value !== "string" || !value) throw new Error("A workspace is required.");
    return value;
  };
  const handle = (
    channel: string,
    listener: (account: SimpleAccount, ...args: unknown[]) => unknown,
  ) => ipcMain.handle(channel, (event, ...args) => listener(sender(event), ...args));

  handle(SIMPLE_IPC.computerStatus, (account, workspaceId) =>
    computer.status(account.serverUrl, workspace(workspaceId), account.serverUrl),
  );
  handle(SIMPLE_IPC.computerConnect, (account, workspaceId, connectOptions) =>
    computer.connect(account.serverUrl, account.serverUrl, workspace(workspaceId), {
      screenControl: Boolean(
        (connectOptions as { screenControl?: unknown } | undefined)?.screenControl,
      ),
    }),
  );
  handle(SIMPLE_IPC.computerPause, () => computer.pause());
  handle(SIMPLE_IPC.computerResume, () => computer.resume());
  let permissionAskedAt = 0;
  handle(SIMPLE_IPC.computerRequestPermission, (_account, id) => {
    if (!THIS_COMPUTER_PERMISSION_ORDER.includes(id as ThisComputerPermissionId)) return;
    // Only screen permissions make macOS offer to quit and reopen the app.
    if (id !== "files") permissionAskedAt = Date.now();
    return computer.requestPermission(id as ThisComputerPermissionId);
  });
  handle(SIMPLE_IPC.computerDisconnect, (account, workspaceId) =>
    computer.disconnect(account.serverUrl, account.serverUrl, workspace(workspaceId)),
  );

  return {
    async boot() {
      await computer.boot();
      followOpenAtLogin();
    },
    reset() {
      cached = null;
      computer.invalidate();
      const window = options.appWindow();
      if (window && !window.contents.isDestroyed()) {
        window.contents.send(SIMPLE_IPC.computerChanged);
      }
    },
    async quitNeedsQuestion() {
      // macOS quits the app itself to apply some permissions; never ask then.
      const summary = await computer.summary().catch(() => null);
      return Boolean(
        summary?.running && summary.management !== "service" && !summary.needsPermissions,
      );
    },
    quitIsForPermission: () =>
      Date.now() - permissionAskedAt < PERMISSION_QUIT_WINDOW_MS && systemSettingsInFront(),
    shutdown: () => computer.shutdown(),
    shutdownNow: () => computer.shutdownNow(),
  };
}

/** Open the app, without a window, at login, or stop doing so. */
function setOpenAtLogin(appId: string, open: boolean): void {
  if (process.platform !== "darwin") return;
  const agent = macLoginAgent(appId);
  if (agent) {
    app.setLoginItemSettings({ openAtLogin: open, ...agent });
    return;
  }
  // macOS 12 reports a login launch through `wasOpenedAtLogin`.
  app.setLoginItemSettings({ openAtLogin: open });
}

/**
 * The bundled launch agent that opens the app with `--hidden` at login (see
 * @opengeni/desktop/mac-login-agent), on macOS 13 and later.
 */
function macLoginAgent(appId: string): { type: "agentService"; serviceName: string } | null {
  const major = Number.parseInt(process.getSystemVersion().split(".")[0] ?? "", 10);
  if (!(major >= 13)) return null;
  const serviceName = macLoginAgentName(appId);
  // macOS reports an agent it hasn't registered yet as not found, so look in the bundle.
  const contents = dirname(dirname(app.getPath("exe")));
  if (!existsSync(join(contents, "Library", "LaunchAgents", serviceName))) return null;
  return { type: "agentService", serviceName };
}

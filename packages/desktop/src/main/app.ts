import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  type CookiesSetDetails,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import type { InboxItem, OpenGeniClient } from "@opengeni/sdk";
import {
  accountForAppLink,
  normalizeServerUrl,
  OPENGENI_WEB_PATHS,
  parseAppLink,
  parseComputerConnectLink,
  type AppWebPaths,
  type ComputerConnectLink,
  serverLabel,
} from "@opengeni/sdk/app-links";
import { macSystemNames } from "@opengeni/sdk/this-computer";
import {
  allowAgentsOnComputer,
  computerName,
  disallowAgentsOnComputer,
  ThisComputer,
  ThisComputerError,
} from "@opengeni/agent-host";
import {
  defaultPermissionGuideLabels,
  PermissionGuide,
} from "@opengeni/agent-host/permission-guide";

import {
  DESKTOP_IPC,
  type DesktopAccountsSnapshot,
  type DesktopAppShotPermissionId,
  type DesktopAppShotResult,
  type DesktopCommand,
  type DesktopMenuAction,
  type DesktopPlatform,
  type ThisComputerConnectOptions,
  type ThisComputerPermissionId,
  type WelcomeState,
} from "../contract";
import { AccountStore, readInstalledFrom, type StoredAccount } from "./accounts";
import { AppShots, AppShotSettingsStore, MacAppShots } from "./app-shots";
import type { DesktopAppConfig } from "./config";
import { InboxNotifier } from "./inbox-notifier";
import { inboxItemPath } from "./inbox-model";
import { reopenablePath } from "./page-paths";
import {
  installAppImageIntegration,
  installLinuxAutostart,
  removeLinuxAutostart,
} from "./linux-integration";
import { LOCAL_ORIGIN } from "./local-pages";
import { macLoginAgentName } from "./mac-login-agent";
import { registerLocalScheme, serveLocalPages } from "./local-protocol";
import { buildApplicationMenu, readMenuActions } from "./menu";
import { flushMarks, mark, measuring, privateMemoryMb } from "./perf";
import { retryDelayMs } from "./reachability";
import { nativeSignInUrl, parseSignInCallback, pkcePair, randomState } from "./pkce";
import { SystemAudioCaptures } from "./system-audio";
import { AppTray } from "./tray";
import { AppUpdates } from "./updates";
import { refuseAllPermissions } from "./web-permissions";
import { MainWindow, openExternalSafely } from "./window";
import { completeComputerLink, computerLinkAccount } from "./computer-link";

type SdkModule = typeof import("@opengeni/sdk");

interface PendingSignIn {
  state: string;
  verifier: string;
  baseUrl: string;
  computerLink?: ComputerConnectLink;
}

/** The account the window should show while its server is out of reach. */
interface Unreachable {
  accountId: string;
  /** Tries so far, for the backoff. */
  attempt: number;
  retrying: boolean;
  /** The next try, or the watchdog of the one in progress. */
  timer: NodeJS.Timeout | null;
}

/** A try that never reports back counts as failed after this long. */
const RETRY_WATCHDOG_MS = 30_000;

function desktopPlatform(): DesktopPlatform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

/** The AppImage file this process runs from, on Linux. */
function appImagePath(): string | null {
  return process.platform === "linux" && app.isPackaged ? process.env.APPIMAGE || null : null;
}

/**
 * The Wayland app id (and X11 WM_CLASS) Chromium gives the window: the desktop
 * entry name Electron publishes from package.json's desktopName.
 */
function linuxWindowClass(): string {
  return (process.env.CHROME_DESKTOP || `${app.getName()}.desktop`).replace(/\.desktop$/, "");
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

/** Records the app's memory once the first page has loaded, and again once it has settled. */
async function recordMemory(): Promise<void> {
  const loaded = await privateMemoryMb(app.getAppMetrics());
  const loadedMarks = loaded === null ? {} : { loadedMemoryMb: loaded };
  flushMarks(loadedMarks);
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  const idle = await privateMemoryMb(app.getAppMetrics());
  flushMarks(idle === null ? loadedMarks : { ...loadedMarks, idleMemoryMb: idle });
}

/**
 * Opened by the system at login, to keep this computer available without a
 * window: with `--hidden` (the login item's argument), or by a macOS 12 login item.
 */
function openedAtLogin(): boolean {
  if (process.argv.includes("--hidden")) return true;
  return process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin === true;
}

/**
 * The desktop app: accounts, the window, sign-in, links, notifications, this
 * computer, the menu bar item and updates. A product creates one with its own
 * configuration; the web app it shows talks to it through the preload bridge.
 */
export class DesktopShell {
  private readonly store: AccountStore;
  private window: MainWindow | null = null;
  private readonly clients = new Map<string, { token: string; client: Promise<OpenGeniClient> }>();
  private sdk: Promise<SdkModule> | null = null;
  private pending: PendingSignIn | null = null;
  private connectingFromLink = false;
  private welcomeError: string | null = null;
  /** Read once; "" when the app wasn't installed by a server's install script. */
  private installedFrom: string | null = null;
  private readonly computer: ThisComputer;
  /** Beside System Settings while a screen-control permission is being allowed there. */
  private readonly permissionGuide: PermissionGuide;
  private readonly inbox: InboxNotifier;
  /** The shortcut that sends the window in front into the composer. */
  private readonly appShots: AppShots;
  /** Other apps' audio for the web app's meeting recorder. */
  private readonly systemAudio: SystemAudioCaptures;
  /** Pages whose system audio captures end when they navigate or close. */
  private readonly systemAudioPages = new WeakSet<WebContents>();
  private tray: AppTray | null = null;
  private updates: AppUpdates | null = null;
  private quitting = false;
  /** Quitting was confirmed (or needs no confirmation); the agent is stopping. */
  private quitConfirmed = false;
  private confirmingQuit = false;
  private readonly lastPaths = new Map<string, string>();
  /** Each account page's menu bar actions, as it last reported them. */
  private readonly pageMenuActions = new Map<
    string,
    { actions: DesktopMenuAction[]; key: string }
  >();
  /** Accounts whose page didn't load, with the address to try again. */
  private readonly failedLoads = new Map<string, string>();
  private unreachable: Unreachable | null = null;
  /** The welcome page is adding an account, so an unreachable one doesn't take it over. */
  private addingAccount = false;
  private readonly redirectUri: string;
  private readonly paths: AppWebPaths;

  constructor(private readonly config: DesktopAppConfig) {
    this.redirectUri = `${config.scheme}://auth/callback`;
    this.paths = config.webPaths ?? OPENGENI_WEB_PATHS;
    // Opened on first use, so a first launch with nothing to unlock doesn't
    // ask for the keyring. Linux desktops without a keyring (minimal window
    // managers, remote desktops) still sign in: the credential is then
    // protected by the owner-only file permissions alone, as command-line
    // tools do.
    let keyringChecked = false;
    const keyring = () => {
      if (!keyringChecked) {
        keyringChecked = true;
        if (process.platform === "linux" && !safeStorage.isEncryptionAvailable()) {
          safeStorage.setUsePlainTextEncryption(true);
        }
      }
      return safeStorage;
    };
    this.store = new AccountStore(app.getPath("userData"), {
      available: () => keyring().isEncryptionAvailable(),
      encrypt: (plain) => keyring().encryptString(plain),
      decrypt: (sealed) => keyring().decryptString(sealed),
    });
    this.permissionGuide = new PermissionGuide({
      electron: { BrowserWindow, screen, nativeTheme },
      appName: config.productName,
      labels: defaultPermissionGuideLabels(
        config.productName,
        macSystemNames(app.getPreferredSystemLanguages()),
      ),
      // The bundle's icon; the executable inside it has a generic one.
      appIcon: async () =>
        (
          await app.getFileIcon(process.execPath.replace(/\/Contents\/MacOS\/[^/]+$/u, ""), {
            size: "normal",
          })
        ).toDataURL(),
      // Back to the app, where the next step or the finish waits.
      onFinished: () => {
        app.focus({ steal: true });
        this.reveal();
      },
    });
    this.computer = new ThisComputer({
      platform: process.platform as "darwin" | "linux" | "win32",
      arch: process.arch,
      home: homedir(),
      env: process.env,
      agentSigningKey: config.agentSigningKey,
      ...(config.browserExtensionIds ? { browserExtensionIds: config.browserExtensionIds } : {}),
      ...(config.agentPath ? { agentPath: config.agentPath } : {}),
      ...(config.agentConfigDir ? { agentConfigDir: config.agentConfigDir } : {}),
      ...(config.adoptStandaloneAgent !== undefined
        ? { adoptStandaloneAgent: config.adoptStandaloneAgent }
        : {}),
      // The app opens at login and keeps running in the menu bar while this
      // computer is in use, so an adopted service agent can run as its helper
      // and share the app's permissions.
      hostServiceAgent: process.platform === "darwin",
      fetch: (url) => net.fetch(url),
      dataDir: app.getPath("userData"),
      systemLanguages: () => app.getPreferredSystemLanguages(),
      logDir: app.getPath("logs"),
      mintEnrollToken: async (accountId, workspaceId, screenControl) => {
        const client = await this.client(accountId);
        if (!client)
          throw new ThisComputerError("signed_out", "Sign in again to connect this computer.");
        const minted = await client.mintEnrollToken(workspaceId, {
          scope: "user",
          allowScreenControl: screenControl,
        });
        return minted.token;
      },
      allowAgents: async (accountId, workspaceId, enrollmentId) => {
        const client = await this.client(accountId);
        if (!client)
          throw new ThisComputerError("signed_out", "Sign in again to connect this computer.");
        await allowAgentsOnComputer(client, workspaceId, enrollmentId);
      },
      disallowAgents: async (accountId, workspaceId, enrollmentId) => {
        const client = await this.client(accountId);
        if (!client)
          throw new ThisComputerError(
            "signed_out",
            "Sign in again to turn this computer off here.",
          );
        await disallowAgentsOnComputer(client, workspaceId, enrollmentId);
      },
      // Null only when the server answered without this enrollment (removed
      // there); a sign-in or network failure rejects instead.
      readMachine: async (accountId, _baseUrl, workspaceId, enrollmentId) => {
        const client = await this.client(accountId);
        if (!client) {
          throw new ThisComputerError(
            "signed_out",
            "Sign in again to check this computer's connection.",
          );
        }
        const machines = await client.listMachines(workspaceId);
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
        const client = await this.client(accountId);
        if (!client)
          throw new ThisComputerError("signed_out", "Sign in again to connect this computer.");
        await client.enableMachineScreenControl(workspaceId, enrollmentId);
      },
      openSystemSettings: (url) => void shell.openExternal(url),
      onGuidePermission: (id, granted) => {
        if (id) this.permissionGuide.show(id);
        else if (granted) this.permissionGuide.granted();
        else this.permissionGuide.hide();
      },
      onChange: () => {
        this.broadcast(DESKTOP_IPC.computerChanged);
        void this.refreshTray();
      },
    });
    const appShotStore = new AppShotSettingsStore(app.getPath("userData"), process.platform);
    this.systemAudio = new SystemAudioCaptures({
      helperPath: config.systemAudioHelperPath ?? null,
      excludePid: process.pid,
      excludeBundlePrefix: config.appId,
      channels: {
        samples: DESKTOP_IPC.systemAudioSamples,
        ended: DESKTOP_IPC.systemAudioEnded,
      },
    });
    this.appShots = new AppShots({
      platform:
        process.platform === "darwin"
          ? new MacAppShots({
              ownPid: process.pid,
              openSystemSettings: (url) => void shell.openExternal(url),
              guide: (id, granted) => {
                if (id && granted) this.permissionGuide.granted();
                else if (id) this.permissionGuide.show(id);
                else this.permissionGuide.hide();
              },
              requested: () => appShotStore.requested(),
              markRequested: (id) => appShotStore.markRequested(id),
              onPermissionsChange: () => this.broadcast(DESKTOP_IPC.appShotsChanged),
            })
          : null,
      store: appShotStore,
      globalShortcut,
      reveal: () => {
        app.focus({ steal: true });
        this.reveal();
      },
      deliver: (result) => this.deliverAppShot(result),
      onChange: () => this.broadcast(DESKTOP_IPC.appShotsChanged),
      log: (message, caught) => console.warn(message, caught),
    });
    this.inbox = new InboxNotifier({
      accounts: () => {
        const signedIn = this.store.snapshot().accounts.filter((account) => !account.signedOut);
        return signedIn.map((account) => ({
          id: account.id,
          label: signedIn.length > 1 ? `${account.email} · ${serverLabel(account.baseUrl)}` : null,
        }));
      },
      client: (accountId) => this.client(accountId),
      open: (accountId, item) => this.openInboxItem(accountId, item),
      unauthorized: (accountId) => this.markSignedOut(accountId),
      setBadge: (count) => app.setBadgeCount(count),
    });
  }

  /** Before `ready`: one instance, the URL scheme, and links that launch the app. */
  static launch(config: DesktopAppConfig): void {
    mark("main");
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return;
    }
    registerLocalScheme();
    // GNOME and KDE show thin scrollbars only while scrolling; Chromium's
    // default on Linux is a classic bar with arrow buttons.
    if (process.platform === "linux") {
      app.commandLine.appendSwitch("enable-features", "OverlayScrollbar");
    }
    // No feature uses Web Bluetooth. Without it no page can start Bluetooth,
    // which macOS would ask the person about (the app ships no Bluetooth
    // usage description; see web-permissions.ts).
    app.commandLine.appendSwitch("disable-blink-features", "WebBluetooth");
    // Without it Windows shows no notifications for the installed app.
    if (process.platform === "win32") app.setAppUserModelId(config.appId);
    if (process.defaultApp && process.argv[1]) {
      app.setAsDefaultProtocolClient(config.scheme, process.execPath, [process.argv[1]]);
    } else if (!appImagePath()) {
      // An AppImage registers through its own desktop entry instead (see start()).
      app.setAsDefaultProtocolClient(config.scheme);
    }
    const queued: string[] = [];
    let desktop: DesktopShell | null = null;
    const deliver = (url: string) => (desktop ? desktop.handleUrl(url) : queued.push(url));
    app.on("open-url", (event, url) => {
      event.preventDefault();
      deliver(url);
    });
    app.on("second-instance", (_event, argv) => {
      const url = argv.find((arg) => arg.startsWith(`${config.scheme}://`));
      if (url) deliver(url);
      else desktop?.reveal();
    });
    const launchUrl = process.argv.find((arg) => arg.startsWith(`${config.scheme}://`));
    if (launchUrl) queued.push(launchUrl);
    void app.whenReady().then(() => {
      mark("ready");
      // The app's own local pages run in the default session and need no permissions.
      refuseAllPermissions(session.defaultSession);
      serveLocalPages(dirname(config.welcomePagePath));
      desktop = new DesktopShell(config);
      desktop.start();
      for (const url of queued.splice(0)) desktop.handleUrl(url);
    });
  }

  start(): void {
    this.registerIpc();
    this.appShots.start();
    const hidden =
      (openedAtLogin() || this.reopenedWithoutWindow()) && this.store.active() !== null;
    if (!hidden) this.openWindow();
    if (process.platform === "darwin" && app.isPackaged && this.config.thisComputer) {
      setTimeout(() => migrateMacLoginItem(this.config.appId), 5_000);
    }
    app.on("activate", () => this.reveal());
    powerMonitor.on("resume", () => this.retryUnreachable());
    app.on("before-quit", (event) => {
      if (this.quitConfirmed) {
        this.quitting = true;
        return;
      }
      event.preventDefault();
      void this.confirmQuit();
    });
    // Nobody is there to answer when the system logs out, restarts or stops
    // the app: quit without asking, so the app never holds that up.
    const quitUnasked = (): void => {
      this.quitConfirmed = true;
      app.quit();
    };
    powerMonitor.on("shutdown", () => {
      this.rememberClosedAtLogout();
      quitUnasked();
    });
    process.once("SIGTERM", quitUnasked);
    process.once("SIGINT", quitUnasked);
    // However the app ends, its agent doesn't outlive it.
    app.on("will-quit", () => {
      this.appShots.stop();
      this.systemAudio.stopAll();
      this.computer.shutdownNow();
    });
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin" && !this.tray) app.quit();
    });
    // Everything below waits until the window is up.
    setTimeout(() => {
      if (this.config.updates && app.isPackaged) {
        this.updates = new AppUpdates(
          this.config.productName,
          this.config.updates,
          app.getVersion(),
          () => {
            Menu.setApplicationMenu(this.menu());
            if (this.updates) this.broadcast(DESKTOP_IPC.updatesChanged, this.updates.pageState);
          },
          () => {
            this.quitConfirmed = true;
            this.quitting = true;
          },
        );
        this.updates.start();
      }
      if (this.config.thisComputer) void this.computer.boot();
      Menu.setApplicationMenu(this.menu());
      this.inbox.start();
      void this.refreshTray();
      const appImage = appImagePath();
      if (appImage) {
        try {
          installAppImageIntegration({
            productName: this.config.productName,
            scheme: this.config.scheme,
            appImagePath: appImage,
            iconPath: this.config.appIconPath,
            windowClass: linuxWindowClass(),
          });
        } catch {
          // Links and the dock icon degrade; the app itself still works.
        }
      }
    }, 0);
  }

  /**
   * Quitting stops the agent, so agents lose this computer until the app opens
   * again. While this computer serves agents, ask first; closing the window
   * keeps it available. macOS quits the app itself to apply a new permission,
   * so there is no question while permissions are being set up.
   */
  private async confirmQuit(): Promise<void> {
    if (this.confirmingQuit) return;
    this.confirmingQuit = true;
    try {
      const summary = this.config.thisComputer ? await this.computer.summary() : null;
      if (summary?.running && summary.management !== "service" && !summary.needsPermissions) {
        const parent = this.window?.window;
        const options: Electron.MessageBoxOptions = {
          type: "question",
          buttons: ["Quit", "Cancel"],
          defaultId: 0,
          cancelId: 1,
          message: `Quit ${this.config.productName}?`,
          detail:
            "Agents can't use this computer until you open the app again. To keep it available, close the window instead.",
        };
        const { response } = parent
          ? await dialog.showMessageBox(parent, options)
          : await dialog.showMessageBox(options);
        if (response !== 0) return;
      }
      this.quitConfirmed = true;
      this.quitting = true;
      await this.computer.shutdown();
      app.quit();
    } finally {
      this.confirmingQuit = false;
    }
  }

  /**
   * macOS reopens the apps that were running when the person logged out, with
   * no arguments, before login items run. Whether the window was closed then
   * is remembered here, so a connected computer comes back without a window
   * as it would from its login item.
   */
  private rememberClosedAtLogout(): void {
    // Closing only hides the window, so what counts is whether it is visible.
    const windowShown = this.window?.window.isVisible() ?? false;
    if (process.platform !== "darwin" || windowShown || !this.computer.opensAtLogin) return;
    try {
      writeFileSync(this.closedAtLogoutPath(), "");
    } catch {
      // Then the window shows again after login.
    }
  }

  /** Reopened by macOS after a logout that left the window closed (see above). */
  private reopenedWithoutWindow(): boolean {
    if (process.platform !== "darwin") return false;
    const path = this.closedAtLogoutPath();
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return this.config.thisComputer && this.computer.opensAtLogin;
  }

  private closedAtLogoutPath(): string {
    return join(app.getPath("userData"), "closed-at-logout");
  }

  reveal(): void {
    if (!this.window) this.openWindow();
    this.window?.reveal();
  }

  /** Asks for the first screen-control permission still missing, as the menu bar item does. */
  private async allowNextPermission(): Promise<void> {
    const next = (await this.computer.summary()).missingPermissions[0];
    if (next) await this.computer.requestPermission(next).catch(() => undefined);
  }

  // --- Window -------------------------------------------------------------------------------------

  private openWindow(): void {
    const window = new MainWindow(this.config, app.getPath("userData"), {
      connectComputer: (url) => this.handleUrl(url),
      navigated: (accountId, url) => this.rememberPath(accountId, url),
      crashed: (accountId) => this.window?.reload(accountId),
      loadFailed: (accountId, url) => this.loadFailed(accountId, url),
      loaded: (accountId) => this.loaded(accountId),
      closed: () => {
        this.window = null;
        this.failedLoads.clear();
        this.clearUnreachable();
      },
      focused: () => {
        this.computer.invalidate();
        void this.inbox.poll();
        this.retryUnreachable();
      },
    });
    this.window = window;
    // Closing hides the window while the app keeps running (notifications,
    // the menu bar item); quitting closes it for real.
    window.window.on("close", (event) => {
      if (this.quitting) return;
      if (process.platform === "darwin" || this.tray) {
        event.preventDefault();
        window.window.hide();
      }
    });
    const active = this.store.active();
    const contents =
      active && !active.signedOut ? window.showAccount(this.target(active)) : window.showWelcome();
    contents.once("did-finish-load", () => {
      mark("content-loaded");
      flushMarks();
      if (measuring()) void recordMemory();
    });
    window.reveal();
    mark("window-shown");
  }

  private target(account: StoredAccount) {
    const fallback = account.workspaceId ? this.paths.home(account.workspaceId) : "/";
    return {
      id: account.id,
      baseUrl: account.baseUrl,
      initialPath: this.lastPaths.get(account.id) ?? account.lastPath ?? fallback,
    };
  }

  private rememberPath(accountId: string, url: string): void {
    const reopen = reopenablePath(url, this.paths);
    if (!reopen) return;
    this.lastPaths.set(accountId, reopen.path);
    // A page whose address doesn't name its workspace keeps the one last known.
    this.store.update(accountId, {
      lastPath: reopen.path,
      ...(reopen.workspaceId ? { workspaceId: reopen.workspaceId } : {}),
    });
  }

  private showAccount(accountId: string, path?: string): void {
    const account = this.store.get(accountId);
    if (!account) return;
    if (!this.window) this.openWindow();
    this.store.setActive(accountId);
    this.addingAccount = false;
    if (account.signedOut) {
      this.clearUnreachable();
      this.welcomeError = `Sign in again to ${serverLabel(account.baseUrl)}.`;
      this.window?.showWelcome();
      this.pushWelcome();
    } else if (this.failedLoads.has(accountId)) {
      // Its page didn't load: keep the welcome page up and try again now.
      if (path) this.failedLoads.set(accountId, new URL(path, account.baseUrl).toString());
      this.showUnreachable(accountId);
      this.retryUnreachable();
    } else {
      this.clearUnreachable();
      this.window?.showAccount(this.target(account), path);
      this.window?.closeWelcome();
    }
    this.window?.reveal();
    this.accountsChanged();
  }

  // --- Reachability -------------------------------------------------------------------------------

  private loadFailed(accountId: string, url: string): void {
    this.failedLoads.set(accountId, url);
    if (this.store.snapshot().activeId === accountId) this.showUnreachable(accountId);
  }

  private loaded(accountId: string): void {
    this.failedLoads.delete(accountId);
    if (this.unreachable?.accountId !== accountId) return;
    this.clearUnreachable();
    const account = this.store.get(accountId);
    if (!account || account.signedOut || this.addingAccount) return;
    if (this.store.snapshot().activeId !== accountId) return;
    this.window?.showAccount(this.target(account));
    this.window?.closeWelcome();
  }

  /** Stand in for the account with the welcome page, which says so and keeps trying. */
  private showUnreachable(accountId: string): void {
    const account = this.store.get(accountId);
    if (!account || account.signedOut || this.addingAccount || this.pending) return;
    if (this.unreachable?.accountId === accountId) {
      this.unreachable.retrying = false;
    } else {
      this.clearUnreachable();
      this.unreachable = {
        accountId,
        attempt: 0,
        retrying: false,
        timer: null,
      };
    }
    this.welcomeError = null;
    this.window?.showWelcome();
    this.pushWelcome();
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    const state = this.unreachable;
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => this.retryUnreachable(), retryDelayMs(state.attempt));
  }

  /** Try the unreachable account again now, unless a try is already under way. */
  private retryUnreachable(): void {
    const state = this.unreachable;
    if (!state || state.retrying) return;
    const account = this.store.get(state.accountId);
    if (!account) {
      this.clearUnreachable();
      return;
    }
    if (state.timer) clearTimeout(state.timer);
    state.retrying = true;
    state.attempt += 1;
    state.timer = setTimeout(() => {
      if (this.unreachable !== state || !state.retrying) return;
      state.retrying = false;
      this.pushWelcome();
      this.scheduleRetry();
    }, RETRY_WATCHDOG_MS);
    this.pushWelcome();
    const url =
      this.failedLoads.get(state.accountId) ??
      new URL(this.target(account).initialPath, account.baseUrl).toString();
    this.window?.retry(state.accountId, url);
  }

  private clearUnreachable(): void {
    if (this.unreachable?.timer) clearTimeout(this.unreachable.timer);
    this.unreachable = null;
  }

  // --- Links --------------------------------------------------------------------------------------

  handleUrl(raw: string): void {
    const callback = parseSignInCallback(raw, this.redirectUri);
    if (callback) {
      void this.finishSignIn(callback);
      return;
    }
    const computerLink = parseComputerConnectLink(raw, this.config.scheme, this.paths);
    if (computerLink && this.config.thisComputer) {
      if (this.connectingFromLink || this.pending) return;
      const account = computerLinkAccount(computerLink, this.store.snapshot().accounts);
      if (account) void this.connectFromLink(account, computerLink);
      else void this.beginSignIn(computerLink.origin, computerLink);
      return;
    }
    const link = parseAppLink(raw, {
      scheme: this.config.scheme,
      paths: this.paths,
    });
    if (!link) {
      this.reveal();
      return;
    }
    const accounts = this.store.snapshot();
    const account = accountForAppLink(link, accounts.accounts, accounts.activeId);
    if (!account) {
      openExternalSafely(link.webUrl);
      return;
    }
    const url = new URL(link.webUrl);
    this.showAccount(account.id, `${url.pathname}${url.search}`);
  }

  private openInboxItem(accountId: string, item: InboxItem): void {
    this.showAccount(accountId, inboxItemPath(item, this.paths));
  }

  /**
   * Where a menu command goes when the page doesn't handle it itself (a page
   * from an older server): the account's workspace's page for it.
   */
  private commandPath(account: StoredAccount, command: DesktopCommand): string | null {
    if (!account.workspaceId) return null;
    if (command === "newSession") return this.paths.home(account.workspaceId);
    if (command === "openInbox") return this.paths.inbox(account.workspaceId);
    return null;
  }

  // --- Sign-in ------------------------------------------------------------------------------------

  private async beginSignIn(
    serverInput: string,
    computerLink?: ComputerConnectLink,
  ): Promise<void> {
    const baseUrl = normalizeServerUrl(serverInput);
    if (!baseUrl) {
      this.welcomeError = `Enter the address of your server, like ${serverLabel(this.defaultServerUrl())}.`;
      this.pushWelcome();
      return;
    }
    if (!this.allowsServer(baseUrl)) {
      this.welcomeError = `${this.config.productName} signs in to ${serverLabel(this.defaultServerUrl())} only.`;
      this.pushWelcome();
      return;
    }
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    this.pending = {
      state,
      verifier,
      baseUrl,
      ...(computerLink ? { computerLink } : {}),
    };
    this.welcomeError = null;
    this.pushWelcome();
    openExternalSafely(
      nativeSignInUrl({
        baseUrl,
        redirectUri: this.redirectUri,
        challenge,
        state,
        platform: desktopPlatform(),
        deviceName: await computerName(),
      }),
    );
  }

  private async finishSignIn(
    callback: NonNullable<ReturnType<typeof parseSignInCallback>>,
  ): Promise<void> {
    const pending = this.pending;
    this.reveal();
    if (!pending || callback.state !== pending.state) {
      this.welcomeError = pending ? "That sign-in didn't match this request. Try again." : null;
      this.pushWelcome();
      return;
    }
    if (callback.kind === "error") {
      this.pending = null;
      this.welcomeError =
        callback.error === "access_denied" ? null : "The sign-in didn't finish. Try again.";
      this.pushWelcome();
      return;
    }
    try {
      const { OpenGeniClient } = await this.loadSdk();
      const anonymous = new OpenGeniClient(this.clientOptions(pending.baseUrl));
      const token = await anonymous.exchangeNativeAppCode({
        code: callback.code,
        codeVerifier: pending.verifier,
        redirectUri: this.redirectUri,
      });
      const client = new OpenGeniClient(this.clientOptions(pending.baseUrl, token.accessToken));
      const [context, workspaces] = await Promise.all([
        client.getAccessContext(),
        client.listWorkspaces().catch(() => []),
      ]);
      if (pending.computerLink && context.subjectId !== pending.computerLink.subjectId) {
        await client.signOutNativeApp().catch(() => undefined);
        throw new Error(
          "You signed in with a different account. Return to the browser, switch to the account that offered to connect this computer, and try again.",
        );
      }
      const account = this.store.upsert(
        {
          baseUrl: pending.baseUrl,
          subjectId: context.subjectId,
          email: context.subjectLabel ?? context.subjectId,
          workspaceId: context.defaultWorkspaceId ?? workspaces[0]?.id ?? null,
        },
        token.accessToken,
      );
      this.clients.delete(account.id);
      await this.establishWebSession(account.id);
      this.pending = null;
      this.welcomeError = null;
      this.window?.removeAccount(account.id);
      this.showAccount(account.id);
      if (pending.computerLink) await this.connectFromLink(account, pending.computerLink);
      void this.inbox.poll();
    } catch (caught) {
      this.pending = null;
      this.welcomeError = errorMessage(caught, "The sign-in couldn't finish. Try again.");
      this.pushWelcome();
    }
  }

  /** An external link never grants host access: confirm with the person on this computer. */
  private async connectFromLink(account: StoredAccount, link: ComputerConnectLink): Promise<void> {
    if (this.connectingFromLink) return;
    this.connectingFromLink = true;
    try {
      const client = await this.client(account.id);
      if (!client) return;
      await completeComputerLink({
        link,
        account,
        workspace: (id) => client.getWorkspace(id),
        confirm: async (workspaceName) => {
          this.reveal();
          const { response } = await dialog.showMessageBox({
            type: "question",
            title: "Use this computer",
            message: `Connect this computer to ${workspaceName}?`,
            detail: `Signed in as ${account.email} on ${serverLabel(account.baseUrl)}. Your agents will be able to work with files and use the screen after you allow system permissions. Only you can use this connection. You can turn it off in the app.`,
            buttons: ["Connect", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          });
          return response === 0;
        },
        navigate: (path) => this.showAccount(account.id, path),
        connect: async (workspaceId) => {
          await this.computer.connect(account.id, account.baseUrl, workspaceId, {
            screenControl: true,
          });
        },
      });
    } catch (caught) {
      await dialog.showMessageBox({
        type: "error",
        message: "Couldn't connect this computer",
        detail: errorMessage(caught, "Return to the browser and try Open app and connect again."),
      });
    } finally {
      this.connectingFromLink = false;
    }
  }

  /**
   * Sign the account's browser session in from the app's credential: the
   * server sets its web sign-in cookie for the same device session, so the
   * window needs no second sign-in and signing out ends both.
   */
  private async establishWebSession(accountId: string): Promise<boolean> {
    const account = this.store.get(accountId);
    const token = this.store.token(accountId);
    if (!account || !token) return false;
    const partition = session.fromPartition(`persist:account-${accountId}`);
    const url = new URL("/v1/native-app/web-session", account.baseUrl).toString();
    const response = await partition.fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      credentials: "include",
    });
    if (response.status === 401) {
      this.markSignedOut(accountId);
      return false;
    }
    if (!response.ok)
      throw new Error(`The server couldn't open the window session (${response.status}).`);
    // Older Electron network stacks hand Set-Cookie back instead of storing it.
    const stored = await partition.cookies.get({ url: account.baseUrl });
    if (stored.length === 0) {
      for (const header of response.headers.getSetCookie()) {
        await partition.cookies.set(cookieFromHeader(account.baseUrl, header));
      }
    }
    return true;
  }

  private markSignedOut(accountId: string): void {
    const account = this.store.get(accountId);
    if (!account || account.signedOut) return;
    this.store.update(accountId, { signedOut: true });
    this.clients.delete(accountId);
    this.inbox.forget(accountId);
    const wasUnreachable = this.unreachable?.accountId === accountId;
    if (wasUnreachable) this.clearUnreachable();
    if (this.window?.accountId === accountId || wasUnreachable) {
      this.welcomeError = `Sign in again to ${serverLabel(account.baseUrl)}.`;
      this.window?.showWelcome();
      this.pushWelcome();
    }
    this.accountsChanged();
  }

  private async signOut(accountId: string): Promise<void> {
    const client = await this.client(accountId).catch(() => null);
    await client?.signOutNativeApp().catch(() => undefined);
    this.inbox.forget(accountId);
    this.clients.delete(accountId);
    this.failedLoads.delete(accountId);
    if (this.unreachable?.accountId === accountId) this.clearUnreachable();
    this.window?.removeAccount(accountId);
    await session
      .fromPartition(`persist:account-${accountId}`)
      .clearStorageData()
      .catch(() => undefined);
    this.store.remove(accountId);
    const next = this.store.active();
    if (next) this.showAccount(next.id);
    else {
      this.window?.showWelcome();
      this.pushWelcome();
    }
    this.accountsChanged();
    void this.refreshTray();
  }

  // --- API clients --------------------------------------------------------------------------------

  private loadSdk(): Promise<SdkModule> {
    this.sdk ??= import("@opengeni/sdk");
    return this.sdk;
  }

  private clientOptions(baseUrl: string, token?: string) {
    return {
      baseUrl,
      ...(token ? { apiKey: token } : {}),
      fetch: ((input: string, init?: RequestInit) => net.fetch(input, init)) as never,
      onDeprecation: false as const,
      apiContract: "compatible" as const,
    };
  }

  private async client(accountId: string): Promise<OpenGeniClient | null> {
    const account = this.store.get(accountId);
    const token = this.store.token(accountId);
    if (!account || account.signedOut || !token) return null;
    const cached = this.clients.get(accountId);
    if (cached?.token === token) return await cached.client;
    const client = this.loadSdk().then(
      ({ OpenGeniClient }) => new OpenGeniClient(this.clientOptions(account.baseUrl, token)),
    );
    this.clients.set(accountId, { token, client });
    return await client;
  }

  // --- Bridge -------------------------------------------------------------------------------------

  /** The account whose own web app (top frame, own origin) sent this message. */
  private senderAccount(event: IpcMainInvokeEvent | IpcMainEvent): StoredAccount {
    const accountId = this.window?.accountFor(event.sender);
    const account = accountId ? this.store.get(accountId) : null;
    const frame = event.senderFrame;
    if (!account || !frame || frame !== event.sender.mainFrame) throw new Error("Not allowed");
    if (new URL(frame.url).origin !== new URL(account.baseUrl).origin)
      throw new Error("Not allowed");
    return account;
  }

  private senderWelcome(event: IpcMainInvokeEvent): void {
    const frame = event.senderFrame;
    if (
      !this.window?.isWelcome(event.sender) ||
      !frame ||
      frame !== event.sender.mainFrame ||
      !frame.url.startsWith(`${LOCAL_ORIGIN}/`)
    ) {
      throw new Error("Not allowed");
    }
  }

  private accountsSnapshot(): DesktopAccountsSnapshot {
    const snapshot = this.store.snapshot();
    return {
      activeId: snapshot.activeId,
      accounts: snapshot.accounts.map((account) => ({
        id: account.id,
        baseUrl: account.baseUrl,
        serverLabel: serverLabel(account.baseUrl),
        email: account.email,
        workspaceId: account.workspaceId,
        signedOut: Boolean(account.signedOut),
      })),
    };
  }

  private welcomeState(): WelcomeState {
    return {
      productName: this.config.productName,
      defaultServerUrl: this.defaultServerUrl(),
      otherServers: this.config.allowOtherServers !== false,
      pendingServer: this.pending ? serverLabel(this.pending.baseUrl) : null,
      error: this.welcomeError,
      canCancel: this.store.snapshot().accounts.some((account) => !account.signedOut),
      unreachable: this.unreachableState(),
    };
  }

  /** The server whose install script installed the app, or the product's own. */
  private defaultServerUrl(): string {
    this.installedFrom ??= readInstalledFrom(app.getPath("userData"));
    return this.installedFrom || this.config.defaultServerUrl;
  }

  /** An app made for one server signs in to that server only. */
  private allowsServer(baseUrl: string): boolean {
    if (this.config.allowOtherServers !== false) return true;
    return [this.defaultServerUrl(), this.config.defaultServerUrl].some(
      (server) => normalizeServerUrl(server) === baseUrl,
    );
  }

  private unreachableState(): WelcomeState["unreachable"] {
    const state = this.unreachable;
    const account = state ? this.store.get(state.accountId) : null;
    if (!state || !account) return null;
    return { server: serverLabel(account.baseUrl), retrying: state.retrying };
  }

  private registerIpc(): void {
    const handle = <T>(
      channel: string,
      listener: (account: StoredAccount, ...args: unknown[]) => Promise<T> | T,
    ) => ipcMain.handle(channel, (event, ...args) => listener(this.senderAccount(event), ...args));

    handle(DESKTOP_IPC.accountsList, () => this.accountsSnapshot());
    handle(DESKTOP_IPC.accountsSwitch, (_account, id) => {
      if (typeof id === "string") this.showAccount(id);
    });
    handle(DESKTOP_IPC.accountsAdd, () => this.addAccount());
    handle(DESKTOP_IPC.accountsSignOut, async (_account, id) => {
      if (typeof id === "string" && this.store.get(id)) await this.signOut(id);
    });
    handle(DESKTOP_IPC.accountsRestoreWebSession, async (account) => {
      try {
        return await this.establishWebSession(account.id);
      } catch {
        return false;
      }
    });
    ipcMain.on(DESKTOP_IPC.accountsSetWorkspace, (event, workspaceId: unknown) => {
      try {
        const account = this.senderAccount(event);
        if (typeof workspaceId === "string" && /^[0-9a-f-]{36}$/iu.test(workspaceId)) {
          this.store.update(account.id, { workspaceId });
        }
      } catch {
        // Ignore messages from anything but an account's own page.
      }
    });
    ipcMain.on(DESKTOP_IPC.menuActionsSet, (event, value: unknown) => {
      let account: StoredAccount;
      try {
        account = this.senderAccount(event);
      } catch {
        return;
      }
      const actions = readMenuActions(value);
      if (!actions) return;
      const key = JSON.stringify(actions);
      if ((this.pageMenuActions.get(account.id)?.key ?? "[]") === key) return;
      if (actions.length === 0) this.pageMenuActions.delete(account.id);
      else this.pageMenuActions.set(account.id, { actions, key });
      if (this.store.snapshot().activeId === account.id) Menu.setApplicationMenu(this.menu());
    });
    ipcMain.on(DESKTOP_IPC.appearanceSet, (event, appearance: unknown) => {
      try {
        this.senderAccount(event);
      } catch {
        return;
      }
      if (appearance === "light" || appearance === "dark" || appearance === "system") {
        nativeTheme.themeSource = appearance;
      }
    });
    handle(DESKTOP_IPC.computerStatus, (account, workspaceId) =>
      this.computer.status(account.baseUrl, String(workspaceId), account.id),
    );
    handle(DESKTOP_IPC.computerConnect, (account, workspaceId, options) =>
      this.computer.connect(account.id, account.baseUrl, String(workspaceId), {
        screenControl: Boolean((options as ThisComputerConnectOptions | undefined)?.screenControl),
      }),
    );
    handle(DESKTOP_IPC.computerPause, (account) => {
      if (account.signedOut || !this.store.token(account.id))
        throw new Error("Sign in again to manage this computer.");
      return this.computer.pause();
    });
    handle(DESKTOP_IPC.computerResume, (account) => {
      if (account.signedOut || !this.store.token(account.id))
        throw new Error("Sign in again to manage this computer.");
      return this.computer.resume();
    });
    handle(DESKTOP_IPC.computerRequestPermission, (_account, id) =>
      this.computer.requestPermission(id as ThisComputerPermissionId),
    );
    handle(DESKTOP_IPC.computerDisconnect, (account, workspaceId) =>
      this.computer.disconnect(account.id, account.baseUrl, String(workspaceId)),
    );
    handle(DESKTOP_IPC.openExternal, (_account, url) => {
      if (typeof url === "string") openExternalSafely(url);
    });
    handle(DESKTOP_IPC.appShotsStatus, () => this.appShots.status());
    handle(DESKTOP_IPC.updatesState, () => this.updates?.pageState ?? { kind: "none" });
    handle(DESKTOP_IPC.updatesInstall, () => {
      this.updates?.install();
    });
    handle(DESKTOP_IPC.appShotsUpdate, (_account, change) => this.appShots.update(change));
    handle(DESKTOP_IPC.appShotsRequestPermission, async (_account, id) => {
      if (id === "screenRecording" || id === "accessibility") {
        await this.appShots.requestPermission(id as DesktopAppShotPermissionId);
      }
    });
    ipcMain.handle(DESKTOP_IPC.systemAudioStart, async (event) => {
      this.senderAccount(event);
      const page = event.sender;
      if (!this.systemAudioPages.has(page)) {
        this.systemAudioPages.add(page);
        const end = () => this.systemAudio.stopFor(page);
        page.once("destroyed", end);
        page.on("did-start-navigation", (details) => {
          if (details.isMainFrame && !details.isSameDocument) end();
        });
      }
      try {
        return { ok: true as const, ...(await this.systemAudio.start(page)) };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    ipcMain.handle(DESKTOP_IPC.systemAudioStop, (event, captureId: unknown) => {
      this.senderAccount(event);
      if (typeof captureId === "string") this.systemAudio.stop(captureId, event.sender);
    });

    ipcMain.handle(DESKTOP_IPC.welcomeState, (event) => {
      this.senderWelcome(event);
      return this.welcomeState();
    });
    ipcMain.handle(DESKTOP_IPC.welcomeSignIn, (event, serverUrl: unknown) => {
      this.senderWelcome(event);
      return this.beginSignIn(String(serverUrl ?? ""));
    });
    ipcMain.handle(DESKTOP_IPC.welcomeRetry, (event) => {
      this.senderWelcome(event);
      this.retryUnreachable();
    });
    ipcMain.handle(DESKTOP_IPC.welcomeCancel, (event) => {
      this.senderWelcome(event);
      this.pending = null;
      this.welcomeError = null;
      const active = this.store.snapshot().accounts.find((account) => !account.signedOut);
      if (active) this.showAccount(active.id);
      else this.pushWelcome();
    });
  }

  private addAccount(): void {
    this.pending = null;
    this.welcomeError = null;
    this.addingAccount = true;
    this.clearUnreachable();
    this.window?.showWelcome();
    this.pushWelcome();
  }

  private broadcast(channel: string, payload?: unknown): void {
    const targets: WebContents[] = this.window?.allAccountContents() ?? [];
    for (const contents of targets) {
      if (!contents.isDestroyed()) contents.send(channel, payload);
    }
  }

  /** A capture goes to the account the window shows, once its page has loaded. */
  private deliverAppShot(result: DesktopAppShotResult): void {
    const accountId = this.window?.accountId;
    const contents = accountId ? this.window?.contentsFor(accountId) : null;
    if (!contents || contents.isDestroyed()) return;
    const send = () => {
      if (!contents.isDestroyed()) contents.send(DESKTOP_IPC.appShotsCaptured, result);
    };
    if (contents.isLoading()) contents.once("did-finish-load", send);
    else send();
  }

  private accountsChanged(): void {
    this.broadcast(DESKTOP_IPC.accountsChanged, this.accountsSnapshot());
    Menu.setApplicationMenu(this.menu());
    void this.refreshTray();
  }

  private pushWelcome(): void {
    const contents = this.window?.welcomeContents();
    if (contents && !contents.isDestroyed())
      contents.send(DESKTOP_IPC.welcomeChanged, this.welcomeState());
  }

  // --- Menus --------------------------------------------------------------------------------------

  private menu(): Menu {
    const snapshot = this.store.snapshot();
    const active = this.store.active();
    const settings = this.paths.settings?.bind(this.paths);
    return buildApplicationMenu({
      productName: this.config.productName,
      accounts: snapshot.accounts.map((account) => ({
        id: account.id,
        label: `${account.email} — ${serverLabel(account.baseUrl)}${account.signedOut ? " (signed out)" : ""}`,
        active: account.id === snapshot.activeId,
      })),
      switchTo: (id) => this.showAccount(id),
      addAccount: () => {
        this.reveal();
        this.addAccount();
      },
      signOut: active ? () => void this.signOut(active.id) : null,
      openSettings:
        active?.workspaceId && !active.signedOut && settings
          ? () => this.showAccount(active.id, settings(active.workspaceId!))
          : null,
      command:
        active && !active.signedOut
          ? (command) => {
              this.reveal();
              const contents = this.window?.contentsFor(active.id);
              if (contents && !contents.isDestroyed())
                contents.send(DESKTOP_IPC.command, command, this.commandPath(active, command));
            }
          : null,
      pageActions:
        active && !active.signedOut ? (this.pageMenuActions.get(active.id)?.actions ?? null) : null,
      runPageAction: (id) => {
        if (!active || active.signedOut) return;
        this.reveal();
        const contents = this.window?.contentsFor(active.id);
        if (contents && !contents.isDestroyed()) contents.send(DESKTOP_IPC.menuAction, id);
      },
      updates: this.updates
        ? {
            state: this.updates.menuState,
            run: () => this.updates?.menuAction(),
          }
        : null,
      contents: () => {
        const id = this.window?.accountId;
        return id
          ? (this.window?.contentsFor(id) ?? null)
          : (this.window?.welcomeContents() ?? null);
      },
    });
  }

  private async refreshTray(): Promise<void> {
    const hasAccounts = this.store.snapshot().accounts.length > 0;
    const summary = this.config.thisComputer
      ? await this.computer.summary()
      : {
          installed: false,
          connected: false,
          running: false,
          reconnecting: false,
          needsPermissions: false,
          missingPermissions: [],
        };
    if (this.config.thisComputer && app.isPackaged) {
      const change = this.computer.openAtLoginChange(summary.connected);
      if (change) setOpenAtLogin(this.config, change === "open");
    }
    // macOS keeps running without a window anyway; the menu bar item is for the
    // computer. Elsewhere the tray is how a closed window comes back.
    const wanted = process.platform === "darwin" ? summary.connected : hasAccounts;
    if (!wanted) {
      this.tray?.destroy();
      this.tray = null;
      return;
    }
    this.tray ??= new AppTray(this.config, {
      open: () => this.reveal(),
      pause: () => void this.computer.pause().catch(() => undefined),
      resume: () => void this.computer.resume().catch(() => undefined),
      allow: (permission) =>
        void this.computer.requestPermission(permission).catch(() => undefined),
      quit: () => app.quit(),
    });
    this.tray.update(summary);
  }
}

/** Open the app, without a window, at login, or stop doing so. */
function setOpenAtLogin(config: DesktopAppConfig, open: boolean): void {
  if (process.platform === "linux") {
    if (open) installLinuxAutostart(config.productName);
    else removeLinuxAutostart(config.productName);
    return;
  }
  if (process.platform === "darwin") {
    const agent = macLoginAgent(config.appId);
    if (agent) {
      app.setLoginItemSettings({ openAtLogin: open, ...agent });
      // Earlier versions registered the app itself; macOS opens that with a window.
      if (app.getLoginItemSettings().openAtLogin) app.setLoginItemSettings({ openAtLogin: false });
      return;
    }
    // macOS 12 reports a login launch through `wasOpenedAtLogin`.
    app.setLoginItemSettings({ openAtLogin: open });
    return;
  }
  app.setLoginItemSettings({ openAtLogin: open, args: ["--hidden"] });
}

/**
 * The bundled launch agent that opens the app hidden at login (see
 * mac-login-agent.ts), on macOS 13 and later when the build includes it.
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

/**
 * Moves a login item from an earlier version, which registered the app itself,
 * to the launch agent. Login items the person turned off stay off.
 */
function migrateMacLoginItem(appId: string): void {
  const agent = macLoginAgent(appId);
  if (!agent || !app.getLoginItemSettings().openAtLogin) return;
  app.setLoginItemSettings({ openAtLogin: true, ...agent });
  app.setLoginItemSettings({ openAtLogin: false });
}

/** A Set-Cookie header as Electron cookie details. */
export function cookieFromHeader(url: string, header: string): CookiesSetDetails {
  const [pair = "", ...attributes] = header.split(";");
  const separator = pair.indexOf("=");
  const details: CookiesSetDetails = {
    url,
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
  };
  for (const attribute of attributes) {
    const [rawKey = "", ...rest] = attribute.split("=");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join("=").trim();
    if (key === "path") details.path = value;
    else if (key === "domain") details.domain = value;
    else if (key === "secure") details.secure = true;
    else if (key === "httponly") details.httpOnly = true;
    else if (key === "max-age") details.expirationDate = Date.now() / 1000 + Number(value);
    else if (key === "expires" && details.expirationDate === undefined) {
      const at = Date.parse(value);
      if (Number.isFinite(at)) details.expirationDate = at / 1000;
    } else if (key === "samesite") {
      const lower = value.toLowerCase();
      details.sameSite =
        lower === "strict" ? "strict" : lower === "none" ? "no_restriction" : "lax";
    }
  }
  return details;
}

export function showSimpleNotification(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  if (onClick) notification.on("click", onClick);
  notification.show();
}

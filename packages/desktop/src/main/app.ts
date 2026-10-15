import { homedir } from "node:os";
import { dirname } from "node:path";

import {
  app,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  Notification,
  powerMonitor,
  safeStorage,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import type { InboxItem, OpenGeniClient } from "@opengeni/sdk";
import {
  accountForAppLink,
  normalizeServerUrl,
  parseAppLink,
  serverLabel,
} from "@opengeni/sdk/app-links";

import {
  DESKTOP_IPC,
  type DesktopAccountsSnapshot,
  type DesktopPlatform,
  type ThisComputerConnectOptions,
  type ThisComputerPermissionId,
  type WelcomeState,
} from "../contract";
import { AccountStore, type StoredAccount } from "./accounts";
import type { DesktopAppConfig } from "./config";
import { InboxNotifier } from "./inbox-notifier";
import { inboxItemPath } from "./inbox-model";
import {
  installAppImageIntegration,
  installLinuxAutostart,
  removeLinuxAutostart,
} from "./linux-integration";
import { LOCAL_ORIGIN } from "./local-pages";
import { registerLocalScheme, serveLocalPages } from "./local-protocol";
import { buildApplicationMenu } from "./menu";
import { flushMarks, mark, measuring, privateMemoryMb } from "./perf";
import { retryDelayMs } from "./reachability";
import { computerName } from "./computer-name";
import { nativeSignInUrl, parseSignInCallback, pkcePair, randomState } from "./pkce";
import { ThisComputer } from "./this-computer";
import { AppTray } from "./tray";
import { AppUpdates } from "./updates";
import { MainWindow, openExternalSafely } from "./window";

type SdkModule = typeof import("@opengeni/sdk");

interface PendingSignIn {
  state: string;
  verifier: string;
  baseUrl: string;
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

/** Opened by the system at login, to keep this computer available without a window. */
function openedAtLogin(): boolean {
  if (process.argv.includes("--hidden")) return true;
  return process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin === true;
}

/** The path a person was on, when it is one the app reopens: a workspace or a session. */
function reopenablePath(url: string): { path: string; workspaceId: string | null } | null {
  const link = parseAppLink(url);
  if (!link?.workspaceId) return null;
  const parsed = new URL(link.webUrl);
  return { path: parsed.pathname, workspaceId: link.workspaceId };
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
  private welcomeError: string | null = null;
  private readonly computer: ThisComputer;
  private readonly inbox: InboxNotifier;
  private tray: AppTray | null = null;
  private updates: AppUpdates | null = null;
  private quitting = false;
  /** Quitting was confirmed (or needs no confirmation); the agent is stopping. */
  private quitConfirmed = false;
  private confirmingQuit = false;
  private readonly lastPaths = new Map<string, string>();
  /** Accounts whose page didn't load, with the address to try again. */
  private readonly failedLoads = new Map<string, string>();
  private unreachable: Unreachable | null = null;
  /** The welcome page is adding an account, so an unreachable one doesn't take it over. */
  private addingAccount = false;
  private readonly redirectUri: string;

  constructor(private readonly config: DesktopAppConfig) {
    this.redirectUri = `${config.scheme}://auth/callback`;
    // Linux desktops without a keyring (minimal window managers, remote
    // desktops) still sign in: the credential is then protected by the
    // owner-only file permissions alone, as command-line tools do.
    if (process.platform === "linux" && !safeStorage.isEncryptionAvailable()) {
      safeStorage.setUsePlainTextEncryption(true);
    }
    this.store = new AccountStore(app.getPath("userData"), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (sealed) => safeStorage.decryptString(sealed),
    });
    this.computer = new ThisComputer({
      platform: process.platform as "darwin" | "linux" | "win32",
      arch: process.arch,
      home: homedir(),
      env: process.env,
      agentSigningKey: config.agentSigningKey,
      fetch: (url) => net.fetch(url),
      dataDir: app.getPath("userData"),
      logDir: app.getPath("logs"),
      mintEnrollToken: async (accountId, workspaceId, screenControl) => {
        const client = await this.client(accountId);
        if (!client) throw new Error("Sign in again to connect this computer.");
        const minted = await client.mintEnrollToken(workspaceId, {
          scope: "user",
          allowScreenControl: screenControl,
        });
        return minted.token;
      },
      openSystemSettings: (url) => void shell.openExternal(url),
      trash: (path) => shell.trashItem(path),
      onChange: () => {
        this.broadcast(DESKTOP_IPC.computerChanged);
        void this.refreshTray();
      },
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
      serveLocalPages(dirname(config.welcomePagePath));
      desktop = new DesktopShell(config);
      desktop.start();
      for (const url of queued.splice(0)) desktop.handleUrl(url);
    });
  }

  start(): void {
    this.registerIpc();
    const hidden = openedAtLogin() && this.store.active() !== null;
    if (!hidden) this.openWindow();
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
    powerMonitor.on("shutdown", quitUnasked);
    process.once("SIGTERM", quitUnasked);
    process.once("SIGINT", quitUnasked);
    // However the app ends, its agent doesn't outlive it.
    app.on("will-quit", () => this.computer.shutdownNow());
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
          () => Menu.setApplicationMenu(this.menu()),
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
      if (summary?.running && !summary.needsPermissions) {
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

  reveal(): void {
    if (!this.window) this.openWindow();
    this.window?.reveal();
  }

  // --- Window -------------------------------------------------------------------------------------

  private openWindow(): void {
    const window = new MainWindow(this.config, app.getPath("userData"), {
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
    const fallback = account.workspaceId ? `/workspaces/${account.workspaceId}/sessions` : "/";
    return {
      id: account.id,
      baseUrl: account.baseUrl,
      initialPath: this.lastPaths.get(account.id) ?? account.lastPath ?? fallback,
    };
  }

  private rememberPath(accountId: string, url: string): void {
    const reopen = reopenablePath(url);
    if (!reopen) return;
    this.lastPaths.set(accountId, reopen.path);
    this.store.update(accountId, { lastPath: reopen.path, workspaceId: reopen.workspaceId });
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
      this.unreachable = { accountId, attempt: 0, retrying: false, timer: null };
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
    const link = parseAppLink(raw);
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
    this.showAccount(accountId, inboxItemPath(item));
  }

  // --- Sign-in ------------------------------------------------------------------------------------

  private async beginSignIn(serverInput: string): Promise<void> {
    const baseUrl = normalizeServerUrl(serverInput);
    if (!baseUrl) {
      this.welcomeError = "Enter the address of your server, like app.opengeni.ai.";
      this.pushWelcome();
      return;
    }
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    this.pending = { state, verifier, baseUrl };
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
      void this.inbox.poll();
    } catch (caught) {
      this.pending = null;
      this.welcomeError = errorMessage(caught, "The sign-in couldn't finish. Try again.");
      this.pushWelcome();
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
      defaultServerUrl: this.config.defaultServerUrl,
      pendingServer: this.pending ? serverLabel(this.pending.baseUrl) : null,
      error: this.welcomeError,
      canCancel: this.store.snapshot().accounts.some((account) => !account.signedOut),
      unreachable: this.unreachableState(),
    };
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
      this.computer.status(account.baseUrl, String(workspaceId)),
    );
    handle(DESKTOP_IPC.computerConnect, (account, workspaceId, options) =>
      this.computer.connect(account.id, account.baseUrl, String(workspaceId), {
        screenControl: Boolean((options as ThisComputerConnectOptions | undefined)?.screenControl),
      }),
    );
    handle(DESKTOP_IPC.computerPause, () => this.computer.pause());
    handle(DESKTOP_IPC.computerResume, () => this.computer.resume());
    handle(DESKTOP_IPC.computerRequestPermission, (_account, id) =>
      this.computer.requestPermission(id as ThisComputerPermissionId),
    );
    handle(DESKTOP_IPC.openExternal, (_account, url) => {
      if (typeof url === "string") openExternalSafely(url);
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
        active?.workspaceId && !active.signedOut
          ? () => this.showAccount(active.id, `/workspaces/${active.workspaceId}/settings`)
          : null,
      command:
        active && !active.signedOut
          ? (command) => {
              this.reveal();
              const contents = this.window?.contentsFor(active.id);
              if (contents && !contents.isDestroyed()) contents.send(DESKTOP_IPC.command, command);
            }
          : null,
      updates: this.updates
        ? { state: this.updates.menuState, run: () => this.updates?.menuAction() }
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
          needsPermissions: false,
          missingPermissions: [],
        };
    if (this.config.thisComputer && app.isPackaged) {
      const change = this.computer.openAtLoginChange(summary.connected);
      if (change) setOpenAtLogin(this.config.productName, change === "open");
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
function setOpenAtLogin(productName: string, open: boolean): void {
  if (process.platform === "linux") {
    if (open) installLinuxAutostart(productName);
    else removeLinuxAutostart(productName);
    return;
  }
  app.setLoginItemSettings({ openAtLogin: open, args: ["--hidden"] });
}

/** A Set-Cookie header as Electron cookie details. */
export function cookieFromHeader(url: string, header: string): Electron.CookiesSetDetails {
  const [pair = "", ...attributes] = header.split(";");
  const separator = pair.indexOf("=");
  const details: Electron.CookiesSetDetails = {
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

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  BaseWindow,
  clipboard,
  Menu,
  nativeTheme,
  screen,
  shell,
  WebContentsView,
  type ContextMenuParams,
  type WebContents,
} from "electron";

import type { DesktopAppConfig } from "./config";
import { LOCAL_ORIGIN, localPageUrl } from "./local-pages";
import { MainFrameLoad } from "./reachability";
import { MIN_SIZE, placeWindow, type Placement, type SavedWindow } from "./window-placement";

export interface AccountTarget {
  id: string;
  baseUrl: string;
  /** The page to open when the account's view is created. */
  initialPath: string;
}

export interface WindowEvents {
  /** An in-window navigation, for remembering where each account was. */
  navigated(accountId: string, url: string): void;
  /** The view's renderer went away; the shell decides whether to reload. */
  crashed(accountId: string): void;
  /** The account's server couldn't be reached, or answered with a server error. */
  loadFailed(accountId: string, url: string): void;
  /** The account's web app loaded. */
  loaded(accountId: string): void;
  /** The window was closed by the person. */
  closed(): void;
  focused(): void;
}

/**
 * The height of the web app's title row. On macOS the traffic lights are
 * centred on it; on Windows the caption buttons fill it.
 */
const TITLE_ROW_HEIGHT = 56;

/**
 * Windows' own minimize, maximize and close buttons, drawn over the page's
 * title row. The overlay is transparent so the page shows through, and the
 * glyphs follow the app's appearance.
 */
function captionButtons(dark: boolean) {
  return {
    color: "#00000000",
    symbolColor: dark ? "#ffffff" : "#000000",
    height: TITLE_ROW_HEIGHT,
  };
}

/** Opens only web pages in the browser; anything else is ignored. */
export function openExternalSafely(url: string): void {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol === "https:" ||
      parsed.protocol === "http:" ||
      parsed.protocol === "mailto:"
    ) {
      void shell.openExternal(parsed.toString());
    }
  } catch {
    // Not a URL.
  }
}

function sameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * The one main window. Each account's web app lives in its own view with its
 * own persistent browser session, so switching accounts is instant and
 * cookies never mix. The window paints the theme background immediately, so
 * there is never a white flash while the web app loads.
 */
export class MainWindow {
  readonly window: BaseWindow;
  private readonly views = new Map<string, { view: WebContentsView; baseUrl: string }>();
  private welcome: WebContentsView | null = null;
  private shown: WebContentsView | null = null;
  private shownAccountId: string | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private maximizeOnReveal = false;

  constructor(
    private readonly config: DesktopAppConfig,
    private readonly stateDirectory: string,
    private readonly events: WindowEvents,
  ) {
    const placement = this.placement();
    this.maximizeOnReveal = placement.maximize;
    const mac = process.platform === "darwin";
    const windows = process.platform === "win32";
    const dark = nativeTheme.shouldUseDarkColors;
    this.window = new BaseWindow({
      ...placement.bounds,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      title: config.productName,
      show: false,
      backgroundColor: mac ? "#00000000" : dark ? config.background.dark : config.background.light,
      // macOS: the page runs under an inset title bar with sidebar material.
      // Windows: the page runs under the caption buttons, as in other modern
      // Windows apps, so there is one title row instead of two.
      // Linux keeps the system title bar, so the window follows the desktop's
      // own theme and controls.
      ...(mac
        ? {
            titleBarStyle: "hiddenInset" as const,
            // Centred on the 56px title row: the rail's top row and every
            // page's header share that centre line.
            trafficLightPosition: { x: 18, y: 21 },
            vibrancy: "sidebar" as const,
            visualEffectState: "followWindow" as const,
          }
        : windows
          ? {
              titleBarStyle: "hidden" as const,
              titleBarOverlay: captionButtons(dark),
              autoHideMenuBar: true,
            }
          : { autoHideMenuBar: true, icon: config.appIconPath }),
    });
    if (windows) {
      nativeTheme.on("updated", () => {
        if (this.window.isDestroyed()) return;
        this.window.setTitleBarOverlay(captionButtons(nativeTheme.shouldUseDarkColors));
      });
    }
    this.window.on("resize", () => {
      this.scheduleSave();
    });
    // Follow the content area itself: on Wayland a maximize (including GNOME's
    // automatic one as a large window maps) settles after the window's state
    // events, with no resize event.
    this.window.contentView.on("bounds-changed", () => this.layout());
    for (const event of ["maximize", "unmaximize"] as const) {
      this.window.on(event as "maximize", () => this.scheduleSave());
    }
    this.window.on("move", () => this.scheduleSave());
    this.window.on("focus", () => this.events.focused());
    this.window.on("closed", () => this.events.closed());
  }

  /** Show the window right away; the theme background is already painted. */
  reveal(): void {
    if (this.window.isDestroyed()) return;
    if (this.window.isMinimized()) this.window.restore();
    if (!this.window.isVisible()) {
      // Maximize once the window is mapped: on X11 a maximize requested while
      // hidden, or in the same task as show(), is dropped.
      if (this.maximizeOnReveal) {
        this.window.once("show", () => setImmediate(() => this.window.maximize()));
      }
      this.window.show();
      this.maximizeOnReveal = false;
    }
    this.window.focus();
  }

  get accountId(): string | null {
    return this.shownAccountId;
  }

  /** The account a renderer belongs to, if it is one of this window's account views. */
  accountFor(contents: WebContents): string | null {
    for (const [id, entry] of this.views) {
      if (entry.view.webContents === contents) return id;
    }
    return null;
  }

  isWelcome(contents: WebContents): boolean {
    return this.welcome?.webContents === contents;
  }

  welcomeContents(): WebContents | null {
    return this.welcome?.webContents ?? null;
  }

  contentsFor(accountId: string): WebContents | null {
    return this.views.get(accountId)?.view.webContents ?? null;
  }

  allAccountContents(): WebContents[] {
    return [...this.views.values()].map((entry) => entry.view.webContents);
  }

  /** Show an account's web app, creating its view on first use. */
  showAccount(target: AccountTarget, path?: string): WebContents {
    let entry = this.views.get(target.id);
    if (!entry) {
      entry = { view: this.createAccountView(target), baseUrl: target.baseUrl };
      this.views.set(target.id, entry);
      this.load(entry.view.webContents, new URL(path ?? target.initialPath, target.baseUrl));
    } else if (path) {
      this.navigate(target.id, path);
    }
    this.present(entry.view);
    this.shownAccountId = target.id;
    return entry.view.webContents;
  }

  /** Go to a path inside an account's web app without reloading it. */
  navigate(accountId: string, path: string): void {
    const entry = this.views.get(accountId);
    if (!entry) return;
    const url = new URL(path, entry.baseUrl).toString();
    const contents = entry.view.webContents;
    // The web app routes client-side: ask it first, load as a fallback.
    void contents
      .executeJavaScript(
        `(() => { const f = window.__opengeniDesktopNavigate; if (typeof f !== "function") return false; f(${JSON.stringify(path)}); return true; })()`,
        true,
      )
      .then((handled: unknown) => {
        if (handled !== true) this.load(contents, url);
      })
      .catch(() => this.load(contents, url));
  }

  reload(accountId: string, path?: string): void {
    const entry = this.views.get(accountId);
    if (!entry) return;
    if (path) this.load(entry.view.webContents, new URL(path, entry.baseUrl));
    else entry.view.webContents.reload();
  }

  /** Load an account's page again after it failed, in the background. */
  retry(accountId: string, url: string): void {
    const entry = this.views.get(accountId);
    if (!entry) return;
    this.load(entry.view.webContents, sameOrigin(url, entry.baseUrl) ? url : entry.baseUrl);
  }

  /** Failures arrive as load events; the promise only repeats them. */
  private load(contents: WebContents, url: URL | string): void {
    contents.loadURL(url.toString()).catch(() => undefined);
  }

  removeAccount(accountId: string): void {
    const entry = this.views.get(accountId);
    if (!entry) return;
    this.views.delete(accountId);
    if (this.shown === entry.view) {
      this.window.contentView.removeChildView(entry.view);
      this.shown = null;
      this.shownAccountId = null;
    }
    entry.view.webContents.close();
  }

  /** Show the first-run page (sign in, or add another account). */
  showWelcome(): WebContents {
    if (!this.welcome) {
      this.welcome = new WebContentsView({
        webPreferences: {
          preload: this.config.welcomePreloadPath,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          spellcheck: false,
        },
      });
      this.welcome.setBackgroundColor("#00000000");
      this.guardNavigation(this.welcome.webContents, null);
      void this.welcome.webContents.loadURL(localPageUrl(basename(this.config.welcomePagePath)));
    }
    this.present(this.welcome);
    this.shownAccountId = null;
    return this.welcome.webContents;
  }

  closeWelcome(): void {
    if (!this.welcome) return;
    if (this.shown === this.welcome) {
      this.window.contentView.removeChildView(this.welcome);
      this.shown = null;
    }
    this.welcome.webContents.close();
    this.welcome = null;
  }

  private present(view: WebContentsView): void {
    if (this.shown === view) return;
    if (this.shown) this.window.contentView.removeChildView(this.shown);
    this.window.contentView.addChildView(view);
    this.shown = view;
    this.layout();
    view.webContents.focus();
  }

  private layout(): void {
    if (!this.shown || this.window.isDestroyed()) return;
    const { width, height } = this.window.contentView.getBounds();
    this.shown.setBounds({ x: 0, y: 0, width, height });
  }

  private createAccountView(target: AccountTarget): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        preload: this.config.preloadPath,
        partition: `persist:account-${target.id}`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: true,
        additionalArguments: [
          `--opengeni-origin=${new URL(target.baseUrl).origin}`,
          `--opengeni-product=${this.config.productName}`,
        ],
      },
    });
    // Transparent where the web app is, so macOS sidebar vibrancy shows through.
    if (process.platform === "darwin") view.setBackgroundColor("#00000000");
    const contents = view.webContents;
    this.guardNavigation(contents, target.baseUrl);
    const load = new MainFrameLoad();
    contents.on("did-navigate", (_event, url, httpResponseCode) => {
      load.navigated(url, httpResponseCode);
      this.events.navigated(target.id, url);
    });
    contents.on("did-fail-load", (_event, errorCode, _description, url, isMainFrame) => {
      const outcome = load.failedToLoad(errorCode, url, isMainFrame);
      if (outcome?.kind === "failed") this.events.loadFailed(target.id, outcome.url);
    });
    contents.on("did-finish-load", () => {
      const outcome = load.finished();
      if (outcome?.kind === "failed") this.events.loadFailed(target.id, outcome.url);
      else if (outcome?.kind === "loaded") this.events.loaded(target.id);
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) this.events.navigated(target.id, url);
    });
    contents.on("render-process-gone", (_event, details) => {
      if (details.reason !== "clean-exit") this.events.crashed(target.id);
    });
    contents.on("context-menu", (_event, params) => this.contextMenu(contents, params));
    contents.session.setPermissionRequestHandler((requester, permission, callback, details) => {
      const trusted = sameOrigin(details.requestingUrl, target.baseUrl) && requester === contents;
      callback(
        trusted &&
          [
            "media",
            "clipboard-sanitized-write",
            "clipboard-read",
            "fullscreen",
            "pointerLock",
          ].includes(permission),
      );
    });
    contents.session.setPermissionCheckHandler(
      (_requester, permission, origin) =>
        sameOrigin(origin, target.baseUrl) &&
        ["media", "clipboard-sanitized-write", "clipboard-read", "fullscreen"].includes(permission),
    );
    return view;
  }

  /** Only the account's own server loads in its view; everything else opens in the browser. */
  private guardNavigation(contents: WebContents, baseUrl: string | null): void {
    const stays = (url: string) =>
      baseUrl ? sameOrigin(url, baseUrl) : url.startsWith(`${LOCAL_ORIGIN}/`);
    contents.on("will-navigate", (event, url) => {
      if (stays(url)) return;
      event.preventDefault();
      openExternalSafely(url);
    });
    contents.on("will-redirect", (event, url) => {
      if (stays(url)) return;
      event.preventDefault();
      openExternalSafely(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      openExternalSafely(url);
      return { action: "deny" };
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
  }

  private contextMenu(contents: WebContents, params: ContextMenuParams): void {
    const template: Electron.MenuItemConstructorOptions[] = [];
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      template.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
    }
    if (params.misspelledWord) {
      template.push(
        {
          label: "Add to Dictionary",
          click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
        { type: "separator" },
      );
    }
    if (params.linkURL && /^https?:/u.test(params.linkURL)) {
      template.push(
        { label: "Open Link in Browser", click: () => openExternalSafely(params.linkURL) },
        { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
        { type: "separator" },
      );
    }
    if (params.isEditable) {
      template.push(
        { role: "undo", enabled: params.editFlags.canUndo },
        { role: "redo", enabled: params.editFlags.canRedo },
        { type: "separator" },
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "selectAll" },
      );
    } else if (params.selectionText.trim()) {
      template.push({ role: "copy" });
    } else if (params.mediaType === "image" && params.srcURL) {
      template.push({ label: "Copy Image", click: () => contents.copyImageAt(params.x, params.y) });
    }
    while (template.at(-1)?.type === "separator") template.pop();
    if (template.length > 0) Menu.buildFromTemplate(template).popup();
  }

  private boundsFile(): string {
    return join(this.stateDirectory, "window.json");
  }

  private placement(): Placement {
    let saved: SavedWindow | null = null;
    try {
      saved = JSON.parse(readFileSync(this.boundsFile(), "utf8")) as SavedWindow;
    } catch {
      // First launch, or the file is unreadable.
    }
    return placeWindow({
      saved,
      workAreas: screen.getAllDisplays().map((display) => display.workArea),
      primary: screen.getPrimaryDisplay().workArea,
      platform: process.platform,
    });
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (this.window.isDestroyed() || this.window.isMinimized() || this.window.isFullScreen())
        return;
      try {
        const saved: SavedWindow = {
          ...this.window.getNormalBounds(),
          maximized: this.window.isMaximized(),
        };
        writeFileSync(this.boundsFile(), JSON.stringify(saved));
      } catch {
        // Remembering the size is best effort.
      }
    }, 500);
  }
}

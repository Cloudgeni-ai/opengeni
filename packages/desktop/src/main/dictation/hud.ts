// The dictation window: a pill floating at the bottom of the screen the
// person is on, above full-screen apps, that never takes the keyboard from the
// app they are dictating into (the text is pasted there).

import { BrowserWindow, screen } from "electron";

import type { DictationHudView } from "./index";
import {
  DICTATION_HUD_ACTIONS,
  type DictationHudAction,
  type DictationHudState,
} from "./hud-state";
import { DICTATION_HUD_HTML } from "./hud-page";
import { ENGLISH_DICTATION_WORDS, type DictationWords } from "./words";
import {
  FLOATING_PAGE_ANSWER_MS,
  pageAnswer,
  showOrRebuild,
  warnFloatingWindow,
  watchFloatingPage,
  type FloatingWindowLog,
} from "../floating-window";

const HEIGHT = 64;
const MIN_WIDTH = 120;
const MAX_WIDTH = 560;
/** Above the Dock or taskbar, clear of the screen's bottom edge. */
const BOTTOM_GAP = 40;

/** The action a button reported through the page's address, if any. */
export function hudAction(url: string): DictationHudAction | null {
  const hash = url.split("#")[1] ?? "";
  const name = hash.split("/")[0] as DictationHudAction;
  return DICTATION_HUD_ACTIONS.includes(name) ? name : null;
}

export interface DictationHudOptions {
  /** Where the pill's failures go. The console by default. */
  log?: FloatingWindowLog;
  /** How long the pill's page has to load or answer before its window is built again. */
  answerMs?: number;
}

export class DictationHud implements DictationHudView {
  private window: BrowserWindow | null = null;
  private loaded: Promise<void> | null = null;
  private listener: ((action: DictationHudAction) => void) | null = null;
  private state: DictationHudState = { kind: "hidden" };
  private visible = false;
  /** The display the pill stays on while it is showing. */
  private displayId: number | null = null;

  private readonly log: FloatingWindowLog;
  private readonly answerMs: number;

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    /** The pill's words, in the app's language. */
    private readonly words: () => DictationWords = () => ENGLISH_DICTATION_WORDS,
    options: DictationHudOptions = {},
  ) {
    this.log = options.log ?? warnFloatingWindow;
    this.answerMs = options.answerMs ?? FLOATING_PAGE_ANSWER_MS;
  }

  onAction(listener: (action: DictationHudAction) => void): void {
    this.listener = listener;
  }

  show(state: DictationHudState): void {
    this.state = state;
    if (state.kind === "hidden") {
      const window = this.window;
      if (window && !window.isDestroyed()) {
        window.hide();
        void this.clear(window, state);
      }
      this.visible = false;
      this.displayId = null;
      return;
    }
    void this.render(state);
  }

  destroy(): void {
    this.state = { kind: "hidden" };
    this.visible = false;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.loaded = null;
  }

  /** Throw the window away, so the next state shows in a fresh one. */
  private discard(window: BrowserWindow): void {
    if (this.window === window) {
      this.window = null;
      this.loaded = null;
      this.visible = false;
    }
    if (!window.isDestroyed()) window.destroy();
  }

  /** The page died or hung: build the pill again, showing what it showed. */
  private lost(window: BrowserWindow, why: string): void {
    if (this.window !== window) return;
    const showing = this.visible;
    this.discard(window);
    this.log(`The dictation pill's window was thrown away: ${why}`);
    if (showing && this.state.kind !== "hidden") void this.render(this.state);
  }

  /** Empty the hidden page, so a recording's clock stops ticking out of sight. */
  private async clear(window: BrowserWindow, state: DictationHudState): Promise<void> {
    try {
      await pageAnswer(this.loaded ?? Promise.resolve(), this.answerMs);
      if (this.state !== state || window.isDestroyed()) return;
      await pageAnswer(
        window.webContents.executeJavaScript(`render(${JSON.stringify(state)})`),
        this.answerMs,
      );
    } catch (error) {
      // A page that can't be emptied can't tick either; the next state builds a fresh one.
      this.discard(window);
      this.log("The hidden dictation pill failed to clear; its window was thrown away", error);
    }
  }

  private ensure(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = new BrowserWindow({
      width: 320,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // The keyboard stays with the app the text goes to.
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      ...(this.platform === "darwin" ? { type: "panel" as const } : {}),
      title: this.words().title,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    window.setAlwaysOnTop(true, "screen-saver");
    // skipTransformProcessType keeps the app's Dock icon on macOS.
    window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("did-navigate-in-page", (_event, url) => {
      const action = hudAction(url);
      if (action) this.listener?.(action);
    });
    watchFloatingPage(window, (why) => this.lost(window, why));
    window.on("closed", () => {
      if (this.window === window) {
        this.window = null;
        this.loaded = null;
        this.visible = false;
      }
    });
    this.window = window;
    this.loaded = window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(DICTATION_HUD_HTML)}`,
    );
    // A failed load is seen, and logged, by the render that waits for it.
    this.loaded.catch(() => undefined);
    return window;
  }

  private async render(state: DictationHudState): Promise<void> {
    await showOrRebuild({
      what: "The dictation pill",
      ensure: () => this.ensure(),
      paint: (window) => this.paint(window, state),
      discard: (window) => this.discard(window),
      wanted: () => this.state === state,
      log: this.log,
    });
  }

  private async paint(window: BrowserWindow, state: DictationHudState): Promise<void> {
    await pageAnswer(this.loaded ?? Promise.resolve(), this.answerMs);
    if (this.state !== state) return;
    if (window.isDestroyed()) throw new Error("The window was destroyed while its page loaded");
    const words = this.words();
    const labels = {
      starting: words.starting,
      transcribing: words.transcribing,
      finish: words.finish,
      cancel: words.cancel,
      close: words.close,
      retry: words.retry,
      allow: words.allow,
      open: words.open,
    };
    const measured = (await pageAnswer(
      window.webContents.executeJavaScript(
        `render(${JSON.stringify(state)}, ${JSON.stringify(labels)})`,
      ),
      this.answerMs,
    )) as unknown;
    if (this.state !== state) return;
    if (window.isDestroyed()) throw new Error("The window was destroyed while its page rendered");
    const width = Math.min(
      MAX_WIDTH,
      Math.max(MIN_WIDTH, typeof measured === "number" ? measured : 320),
    );
    const display =
      (this.displayId !== null &&
        screen.getAllDisplays().find((candidate) => candidate.id === this.displayId)) ||
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    this.displayId = display.id;
    const area = display.workArea;
    const bounds = {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + area.height - HEIGHT - BOTTOM_GAP),
      width,
      height: HEIGHT,
    };
    const current = window.getBounds();
    if (
      current.x !== bounds.x ||
      current.y !== bounds.y ||
      current.width !== bounds.width ||
      current.height !== bounds.height
    ) {
      window.setBounds(bounds);
    }
    if (!this.visible) {
      window.showInactive();
      this.visible = true;
    }
  }
}

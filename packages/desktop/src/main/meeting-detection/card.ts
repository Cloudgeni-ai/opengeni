// The card that asks whether to record a call: a small window in the top
// right corner of the screen the person is on, above full-screen apps, that
// never takes the keyboard from the call. The app's own window, not a system
// notification, so Focus and Do Not Disturb don't hide it.

import { BrowserWindow, screen } from "electron";

import type { MeetingPrompt, MeetingPromptOutcome, MeetingPromptView, ShownPrompt } from "./index";
import { promptText } from "./index";
import { MEETING_CARD_HTML, MEETING_CARD_MARGIN } from "./card-page";
import { ENGLISH_MEETING_WORDS, type MeetingWords } from "./words";
import {
  FLOATING_PAGE_ANSWER_MS,
  pageAnswer,
  showOrRebuild,
  warnFloatingWindow,
  watchFloatingPage,
  type FloatingWindowLog,
} from "../floating-window";

/** The window's width, with room for the card's shadow. */
const WIDTH = 360 + MEETING_CARD_MARGIN * 2;
const MIN_HEIGHT = 96;
const MAX_HEIGHT = 320;
/**
 * How long a question to record, or the note that a call is being recorded,
 * stays up; hovering holds it. A question to stop stays.
 */
export const MEETING_CARD_TIMEOUT_MS = 45_000;

const ACTIONS = { act: "chosen", dismiss: "dismissed", expire: "expired" } as const;

/** What the card's page answered (`action/token`): the outcome, and for which question. */
export function cardAnswer(
  answer: unknown,
): { outcome: MeetingPromptOutcome; token: number } | null {
  if (typeof answer !== "string") return null;
  const [name = "", token = ""] = answer.split("/");
  const outcome = ACTIONS[name as keyof typeof ACTIONS];
  const value = Number(token);
  return outcome && Number.isInteger(value) && value > 0 ? { outcome, token: value } : null;
}

/** Where the window goes: the top right of the work area, the card's edges clear of the screen's. */
export function cardBounds(
  area: { x: number; y: number; width: number; height: number },
  height: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(area.x + area.width - WIDTH),
    y: Math.round(area.y),
    width: WIDTH,
    height,
  };
}

export interface MeetingPromptCardOptions {
  platform?: NodeJS.Platform;
  /** The card's words, in the app's language; read each time a card shows. English by default. */
  words?: () => MeetingWords;
  /** The app's icon on the card as a data: URL, or null for none. */
  icon?: () => string | null;
  /** How long a question to record stays up. */
  timeoutMs?: number;
  /** Where the card's failures go. The console by default. */
  log?: FloatingWindowLog;
  /** How long the card's page has to load or answer before its window is built again. */
  answerMs?: number;
}

export class MeetingPromptCard implements MeetingPromptView {
  private window: BrowserWindow | null = null;
  private loaded: Promise<void> | null = null;
  private current: {
    token: number;
    prompt: MeetingPrompt;
    done: (outcome: MeetingPromptOutcome) => void;
  } | null = null;
  /** Whether the window is on screen. */
  private showing = false;
  private tokens = 0;

  constructor(private readonly options: MeetingPromptCardOptions = {}) {}

  show(prompt: MeetingPrompt, done: (outcome: MeetingPromptOutcome) => void): ShownPrompt {
    const token = ++this.tokens;
    this.current = { token, prompt, done };
    void this.render(prompt, token);
    return {
      close: () => {
        if (this.current?.token !== token) return;
        this.current = null;
        this.hide();
      },
    };
  }

  destroy(): void {
    this.current = null;
    this.showing = false;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.loaded = null;
  }

  private finish(token: number, outcome: MeetingPromptOutcome): void {
    const current = this.current;
    if (!current || current.token !== token) return;
    this.current = null;
    this.hide();
    current.done(outcome);
  }

  private hide(): void {
    this.showing = false;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  private log(message: string, error?: unknown): void {
    (this.options.log ?? warnFloatingWindow)(message, error);
  }

  /** Throw the window away, so the next card shows in a fresh one. */
  private discard(window: BrowserWindow): void {
    if (this.window === window) {
      this.window = null;
      this.loaded = null;
      this.showing = false;
    }
    if (!window.isDestroyed()) window.destroy();
  }

  /** The page died or hung: build the card again, showing the question it showed. */
  private lost(window: BrowserWindow, why: string): void {
    if (this.window !== window) return;
    const showing = this.showing;
    this.discard(window);
    this.log(`The meeting card's window was thrown away: ${why}`);
    const current = this.current;
    if (showing && current) void this.render(current.prompt, current.token);
  }

  private ensure(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const platform = this.options.platform ?? process.platform;
    const window = new BrowserWindow({
      width: WIDTH,
      height: MIN_HEIGHT,
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
      // The keyboard stays with the call.
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      ...(platform === "darwin" ? { type: "panel" as const } : {}),
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
    watchFloatingPage(window, (why) => this.lost(window, why));
    window.on("closed", () => {
      if (this.window !== window) return;
      this.window = null;
      this.loaded = null;
      this.showing = false;
    });
    this.window = window;
    this.loaded = window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(MEETING_CARD_HTML)}`,
    );
    // A failed load is seen, and logged, by the render that waits for it.
    this.loaded.catch(() => undefined);
    return window;
  }

  private words(): MeetingWords {
    return this.options.words?.() ?? ENGLISH_MEETING_WORDS;
  }

  private async render(prompt: MeetingPrompt, token: number): Promise<void> {
    const shown: { window?: BrowserWindow } = {};
    await showOrRebuild({
      what: "The meeting card",
      ensure: () => this.ensure(),
      paint: async (window) => {
        if (await this.paint(window, prompt, token)) shown.window = window;
      },
      discard: (window) => this.discard(window),
      wanted: () => this.current?.token === token,
      log: (message, error) => this.log(message, error),
    });
    if (!shown.window) return;
    // Settles when a button is pressed or the time runs out, or with null when
    // a newer question replaces this one. A page that dies meanwhile shows the
    // question again in a fresh window, which answers instead.
    const answer = cardAnswer(
      await shown.window.webContents.executeJavaScript("answer()").catch(() => null),
    );
    if (answer) this.finish(answer.token, answer.outcome);
  }

  /** Put the question on the card and show it; false when it is no longer asked. */
  private async paint(
    window: BrowserWindow,
    prompt: MeetingPrompt,
    token: number,
  ): Promise<boolean> {
    const answerMs = this.options.answerMs ?? FLOATING_PAGE_ANSWER_MS;
    await pageAnswer(this.loaded ?? Promise.resolve(), answerMs);
    if (this.current?.token !== token) return false;
    if (window.isDestroyed()) throw new Error("The window was destroyed while its page loaded");
    const words = this.words();
    const text = promptText(prompt, words);
    const state = {
      token,
      title: words.title,
      ...text,
      icon: this.options.icon?.() ?? null,
      timeoutMs:
        prompt.kind === "stop"
          ? 0
          : // A reminder stays until a few minutes after its meeting started.
            prompt.kind === "join"
            ? prompt.reminder.timeoutMs
            : (this.options.timeoutMs ?? MEETING_CARD_TIMEOUT_MS),
    };
    const measured = (await pageAnswer(
      window.webContents.executeJavaScript(`render(${JSON.stringify(state)})`),
      answerMs,
    )) as unknown;
    if (this.current?.token !== token) return false;
    if (window.isDestroyed()) throw new Error("The window was destroyed while its page rendered");
    const height = Math.min(
      MAX_HEIGHT,
      Math.max(MIN_HEIGHT, typeof measured === "number" ? measured : MIN_HEIGHT),
    );
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    window.setBounds(cardBounds(display.workArea, height));
    window.showInactive();
    this.showing = true;
    return true;
  }
}

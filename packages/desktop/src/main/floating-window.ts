// The small windows that float above other apps (the dictation pill, the card
// asking whether to record a call) stay hidden between uses. Their page runs in
// a renderer process the system can kill, for example under memory pressure,
// or that can hang. A window whose page is gone never shows again, so these
// helpers notice that, and the window is thrown away and built afresh.

import type { BrowserWindow } from "electron";

/** How long a floating window's page has to load, or to answer a render. */
export const FLOATING_PAGE_ANSWER_MS = 5_000;

export type FloatingWindowLog = (message: string, error?: unknown) => void;

export const warnFloatingWindow: FloatingWindowLog = (message, error) =>
  console.warn(message, error ?? "");

/** Calls `lost` once, saying why, when the window's page dies or stops responding. */
export function watchFloatingPage(window: BrowserWindow, lost: (why: string) => void): void {
  let told = false;
  const tell = (why: string) => {
    if (told) return;
    told = true;
    lost(why);
  };
  window.webContents.on("render-process-gone", (_event, details) =>
    tell(`its page's process is gone (${details.reason})`),
  );
  window.webContents.on("unresponsive", () => tell("its page stopped responding"));
}

/** The page's answer, or a rejection when it doesn't come within `ms`. */
export async function pageAnswer<T>(answer: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`The page didn't answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shows something in the window `ensure` gives. When that fails, the window is
 * thrown away and, if `wanted` still holds, it is shown once more in a fresh one.
 */
export async function showOrRebuild(options: {
  what: string;
  ensure: () => BrowserWindow;
  paint: (window: BrowserWindow) => Promise<void>;
  discard: (window: BrowserWindow) => void;
  wanted: () => boolean;
  log: FloatingWindowLog;
}): Promise<void> {
  for (const again of [false, true]) {
    const window = options.ensure();
    try {
      await options.paint(window);
      return;
    } catch (error) {
      options.discard(window);
      options.log(
        again
          ? `${options.what} failed to show again`
          : `${options.what} failed to show; building its window again`,
        error,
      );
      if (!options.wanted()) return;
    }
  }
}

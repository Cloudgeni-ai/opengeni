/**
 * Idle window parking for windowed managed browsers.
 *
 * A Linux X11 display has no window occlusion tracking, so Chromium treats
 * every one of its windows as visible: each animated page keeps rendering
 * frames at the display's rate through software GL, whether or not anything
 * is looking at it or acting on it. On a shared virtual desktop that is a
 * CPU core or more per idle browser, indefinitely.
 *
 * Minimizing a window makes its pages hidden: Chromium stops producing frames
 * (requestAnimationFrame pauses, compositing stops) while JavaScript timers,
 * network activity and CDP screenshots keep working. Focus emulation, which
 * the controller holds on every tab so background tabs act at full speed,
 * keeps a page rendering even then, so parking suspends it first. This parks
 * a browser once nothing has used it for a while, and presents it again
 * before the next operation runs, so agents and live viewers always act on a
 * normally rendering page.
 */

export const BROWSER_WINDOW_PARK_IDLE_MS = 60_000;
const WINDOW_COMMAND_TIMEOUT_MS = 2_000;

type WindowState = "normal" | "minimized" | "maximized" | "fullscreen";

export type WindowParkingConnection = {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
};

export type BrowserWindowParkingOptions = {
  idleMs: number;
  /** The browser's current CDP connection; null while disconnected. */
  connection: () => WindowParkingConnection | null;
  /** Page targets whose windows belong to this browser session. */
  pageTargetIds: () => Promise<readonly string[]>;
  /** Stops controller overrides that keep pages rendering while hidden. */
  suspendRendering?: () => Promise<void>;
  /** Restores what suspendRendering stopped. */
  resumeRendering?: () => Promise<void>;
  onError?: (phase: "park" | "present", error: unknown) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export class BrowserWindowParking {
  private holders = 0;
  private timer: unknown = null;
  private closed = false;
  /** Unknown until first checked: a browser reattached after a controller
   * restart may still have windows its previous controller parked. */
  private mayHaveParkedWindows = true;
  private renderingSuspended = false;
  /** State to restore for each window this controller minimized. */
  private readonly parked = new Map<number, WindowState>();
  private tail: Promise<void> = Promise.resolve();
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: BrowserWindowParkingOptions) {
    this.setTimer =
      options.setTimer ??
      ((callback, ms) => {
        const handle = setTimeout(callback, ms);
        handle.unref?.();
        return handle;
      });
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Presents the browser's windows and keeps them presented until the
   * returned release is called. Presenting is best effort: an operation never
   * fails because a window could not be restored. */
  async acquire(): Promise<() => void> {
    if (this.closed) return () => undefined;
    this.holders += 1;
    this.cancelTimer();
    await this.serialize(async () => await this.present());
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders -= 1;
      this.schedule();
    };
  }

  /** Starts the idle countdown for a browser nothing is using yet. */
  arm(): void {
    this.schedule();
  }

  /** Presents any parked windows now, for example once a connection to a
   * reattached browser exists. Holders are unaffected. */
  async presentNow(): Promise<void> {
    if (this.closed) return;
    await this.serialize(async () => await this.present());
  }

  close(): void {
    this.closed = true;
    this.cancelTimer();
  }

  private schedule(): void {
    if (this.closed || this.holders > 0) return;
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.serialize(async () => await this.park());
    }, this.options.idleMs);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  private async serialize(step: () => Promise<void>): Promise<void> {
    const run = this.tail.then(step).catch(() => undefined);
    this.tail = run;
    await run;
  }

  private async park(): Promise<void> {
    if (this.closed || this.holders > 0) return;
    const connection = this.options.connection();
    if (!connection) return;
    try {
      if (this.options.suspendRendering) {
        this.renderingSuspended = true;
        await this.options.suspendRendering();
      }
      for (const { windowId, state } of (await this.windows(connection)).windows) {
        if (this.holders > 0 || this.closed) return;
        // Already minimized (for example by a previous controller of this
        // browser): the next operation presents it again.
        if (state === "minimized") {
          this.mayHaveParkedWindows = true;
          continue;
        }
        await connection.send(
          "Browser.setWindowBounds",
          { windowId, bounds: { windowState: "minimized" } },
          { timeoutMs: WINDOW_COMMAND_TIMEOUT_MS },
        );
        this.parked.set(windowId, state);
        this.mayHaveParkedWindows = true;
      }
    } catch (error) {
      this.options.onError?.("park", error);
    }
  }

  private async present(): Promise<void> {
    if (!this.mayHaveParkedWindows && !this.renderingSuspended) return;
    const connection = this.options.connection();
    if (!connection) return;
    if (this.mayHaveParkedWindows) await this.presentWindows(connection);
    if (this.renderingSuspended) {
      try {
        await this.options.resumeRendering?.();
        this.renderingSuspended = false;
      } catch (error) {
        this.options.onError?.("present", error);
      }
    }
  }

  private async presentWindows(connection: WindowParkingConnection): Promise<void> {
    try {
      const { windows, complete } = await this.windows(connection);
      for (const { windowId, state } of windows) {
        if (state !== "minimized") {
          this.parked.delete(windowId);
          continue;
        }
        await connection.send(
          "Browser.setWindowBounds",
          { windowId, bounds: { windowState: this.parked.get(windowId) ?? "normal" } },
          { timeoutMs: WINDOW_COMMAND_TIMEOUT_MS },
        );
        this.parked.delete(windowId);
      }
      // A window whose lookup failed may still be minimized: keep it eligible
      // for the next presentation instead of forgetting it.
      if (!complete) return;
      this.parked.clear();
      this.mayHaveParkedWindows = false;
    } catch (error) {
      this.options.onError?.("present", error);
    }
  }

  private async windows(connection: WindowParkingConnection): Promise<{
    windows: Array<{ windowId: number; state: WindowState }>;
    complete: boolean;
  }> {
    const windows = new Map<number, WindowState>();
    let complete = true;
    for (const targetId of await this.options.pageTargetIds()) {
      let response: { windowId?: unknown; bounds?: { windowState?: unknown } };
      try {
        response = await connection.send(
          "Browser.getWindowForTarget",
          { targetId },
          { timeoutMs: WINDOW_COMMAND_TIMEOUT_MS },
        );
      } catch {
        // The tab closed meanwhile, or the lookup failed transiently. Either
        // way this enumeration cannot prove every window was seen.
        complete = false;
        continue;
      }
      if (typeof response.windowId !== "number" || windows.has(response.windowId)) continue;
      windows.set(response.windowId, windowState(response.bounds?.windowState));
    }
    return { windows: [...windows].map(([windowId, state]) => ({ windowId, state })), complete };
  }
}

function windowState(value: unknown): WindowState {
  return value === "minimized" || value === "maximized" || value === "fullscreen"
    ? value
    : "normal";
}

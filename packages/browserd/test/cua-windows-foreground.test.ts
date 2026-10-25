import { describe, expect, test } from "bun:test";
import { bringToFront, giveBack, type Win32Foreground } from "../src/cua/windows-foreground";

type Window = {
  className: string;
  title: string;
  process: string;
  owner?: number;
  minimized?: boolean;
};

/** A desktop whose foreground follows rules a test sets: which windows take
 * the foreground when activated, and what Escape and a title-bar click do. */
class Desktop implements Win32Foreground {
  readonly log: string[] = [];
  current: number;
  /** Activation works only after the no-meaning key (an elevated window in front). */
  needsInputClaim = false;
  /** Nothing but a title-bar click moves the foreground. */
  onlyClick = false;
  claimed = false;
  caption: { x: number; y: number } | null = { x: 300, y: 8 };
  constructor(
    readonly windows: Map<number, Window>,
    foreground: number,
  ) {
    this.current = foreground;
  }
  private shell(): boolean {
    const window = this.windows.get(this.current);
    return window?.className === "Windows.UI.Core.CoreWindow";
  }
  foreground = () => this.current;
  isWindow = (window: number) => this.windows.has(window);
  owner = (window: number) => this.windows.get(window)?.owner ?? 0;
  className = (window: number) => this.windows.get(window)?.className ?? "";
  title = (window: number) => this.windows.get(window)?.title ?? "";
  processName = (window: number) => this.windows.get(window)?.process ?? null;
  isMinimized = (window: number) => this.windows.get(window)?.minimized === true;
  restore = (window: number) => {
    this.log.push(`restore ${window}`);
    this.windows.get(window)!.minimized = false;
  };
  activate = (window: number) => {
    this.log.push(`activate ${window}`);
    if (this.shell() || this.onlyClick || (this.needsInputClaim && !this.claimed)) return;
    this.current = window;
  };
  claimInput = () => {
    this.log.push("claim");
    this.claimed = true;
  };
  pressEscape = () => {
    this.log.push("escape");
    if (this.shell()) this.current = 1;
  };
  captionPoint = () => this.caption;
  click = (point: { x: number; y: number }) => {
    this.log.push(`click ${point.x},${point.y}`);
    this.pointer = point;
    if (this.onlyClick) this.current = 10;
  };
  pointer = { x: 640, y: 400 };
  cursor = () => this.pointer;
  moveCursor = (point: { x: number; y: number }) => {
    this.log.push(`cursor ${point.x},${point.y}`);
    this.pointer = point;
  };
}

const sleep = async () => {};

function desktop(foreground: number): Desktop {
  return new Desktop(
    new Map<number, Window>([
      [1, { className: "Progman", title: "Program Manager", process: "explorer.exe" }],
      [10, { className: "Notepad", title: "Untitled - Notepad", process: "notepad.exe" }],
      [11, { className: "#32770", title: "Save As", process: "notepad.exe", owner: 10 }],
      [
        20,
        {
          className: "Windows.UI.Core.CoreWindow",
          title: "Search",
          process: "searchhost.exe",
        },
      ],
      [30, { className: "Chrome_WidgetWin_1", title: "Inbox", process: "chrome.exe" }],
      [40, { className: "Shell_TrayWnd", title: "", process: "explorer.exe" }],
    ]),
    foreground,
  );
}

describe("bringing a Windows window to the front", () => {
  test("a window already in front, or its own dialog in front, is left as it is", async () => {
    for (const foreground of [10, 11]) {
      const win = desktop(foreground);
      expect(await bringToFront(win, 10, sleep)).toEqual({ front: true, previous: 0 });
      expect(win.log).toEqual([]);
      expect(win.current).toBe(foreground);
    }
  });

  test("Start or Search left open is dismissed with Escape, then the window is activated", async () => {
    const win = desktop(20);
    // A dismissed Search is not given the foreground back.
    expect(await bringToFront(win, 10, sleep)).toEqual({ front: true, previous: 0 });
    expect(win.log).toEqual(["escape", "activate 10"]);
    expect(win.current).toBe(10);
  });

  test("Escape is never sent to an ordinary app in front", async () => {
    const win = desktop(30);
    expect(await bringToFront(win, 10, sleep)).toEqual({ front: true, previous: 30 });
    expect(win.log).toEqual(["activate 10"]);
  });

  test("a minimized window is restored before it is activated", async () => {
    const win = desktop(1);
    win.windows.get(10)!.minimized = true;
    expect(await bringToFront(win, 10, sleep)).toEqual({ front: true, previous: 1 });
    expect(win.log).toEqual(["restore 10", "activate 10"]);
  });

  test("activation is retried after this process claims the last input", async () => {
    const win = desktop(30);
    win.needsInputClaim = true;
    expect(await bringToFront(win, 10, sleep)).toEqual({ front: true, previous: 30 });
    expect(win.log).toEqual(["activate 10", "claim", "activate 10"]);
  });

  test("the window's own title bar is clicked as the last resort, and the cursor put back", async () => {
    const win = desktop(30);
    win.onlyClick = true;
    expect(await bringToFront(win, 10, sleep)).toEqual({ front: true, previous: 30 });
    expect(win.log).toEqual([
      "activate 10",
      "claim",
      "activate 10",
      "click 300,8",
      "cursor 640,400",
    ]);
  });

  test("when nothing works, it names the window Windows kept in front", async () => {
    const win = desktop(30);
    win.onlyClick = true;
    win.caption = null;
    expect(await bringToFront(win, 10, sleep)).toEqual({
      front: false,
      inFront: '"Inbox" (chrome)',
    });
    // The taskbar has no title; it is named as a person knows it.
    const taskbar = desktop(40);
    taskbar.onlyClick = true;
    taskbar.caption = null;
    expect(await bringToFront(taskbar, 10, sleep)).toEqual({
      front: false,
      inFront: "the taskbar",
    });
  });

  test("a window that is gone is left for CUA to report", async () => {
    const win = desktop(30);
    expect(await bringToFront(win, 99, sleep)).toEqual({ front: true, previous: 0 });
    expect(win.log).toEqual([]);
  });
});

describe("giving the foreground back", () => {
  test("the window that was in front gets it back while the target is still in front", async () => {
    for (const foreground of [10, 11]) {
      const win = desktop(foreground);
      giveBack(win, 10, 30);
      expect(win.log).toEqual(["activate 30"]);
      expect(win.current).toBe(30);
    }
  });

  test("nothing is given back when there is nothing to give back or the input moved the foreground", () => {
    const none = desktop(10);
    giveBack(none, 10, 0);
    const gone = desktop(10);
    giveBack(gone, 10, 99);
    const moved = desktop(1);
    giveBack(moved, 10, 30);
    for (const win of [none, gone, moved]) expect(win.log).toEqual([]);
    expect(moved.current).toBe(1);
  });
});

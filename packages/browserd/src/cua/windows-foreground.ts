/**
 * Bringing a window to the front on Windows before CUA sends it pointer or
 * keyboard input. CUA delivers that input through SendInput, which goes to
 * the foreground window, so it fronts the target first and refuses to send
 * anything when Windows does not let it. Windows grants the foreground only
 * to some callers, and a few windows hold it against every technique: the
 * Start menu and Search (one SearchHost window) keep it until they are
 * dismissed, so a person who pressed the Windows key, or an agent that did,
 * left every later click and keystroke refused.
 *
 * The window is fronted here, in the order a person would: a Start, Search or
 * notification surface in front is dismissed with Escape; a minimized window
 * is restored; the window is activated through the foreground window's input
 * queue, then again after an input event that carries no meaning, which gives
 * this process the foreground right; and as a last resort its own title bar
 * is clicked. Only then is the input refused, and the refusal names the
 * window Windows kept in front.
 */

/** What fronting needs from Windows. Window handles are plain numbers. */
export type Win32Foreground = {
  foreground(): number;
  isWindow(window: number): boolean;
  /** The window that owns this one (a dialog's main window), or 0. */
  owner(window: number): number;
  className(window: number): string;
  title(window: number): string;
  /** The lowercase file name of the window's process, such as "notepad.exe". */
  processName(window: number): string | null;
  isMinimized(window: number): boolean;
  restore(window: number): void;
  /** SetForegroundWindow and BringWindowToTop while attached to the
   * foreground window's input queue. */
  activate(window: number): void;
  /** One key event pair no application uses, after which Windows counts this
   * process as the one that received the last input. */
  claimInput(): void;
  pressEscape(): void;
  /** A screen point on the window's own title bar that no other window covers. */
  captionPoint(window: number): { x: number; y: number } | null;
  /** A left click at the point. The cursor stays there: injected clicks land
   * where the cursor is when Windows processes them, after this returns. */
  click(point: { x: number; y: number }): void;
};

export type ForegroundResult =
  | { front: true }
  | {
      front: false;
      /** The window Windows kept in front, as a person would name it. */
      inFront: string;
    };

/** The processes whose Start, Search and notification surfaces take the
 * foreground while open and give it to no other window until dismissed. */
const SHELL_SURFACE_PROCESSES = new Set([
  "searchhost.exe",
  "searchapp.exe",
  "searchui.exe",
  "startmenuexperiencehost.exe",
  "shellexperiencehost.exe",
]);

const SHELL_SURFACE_CLASS = "Windows.UI.Core.CoreWindow";

/** The taskbar has no title; a person calls it the taskbar. */
const TASKBAR_CLASSES = new Set(["Shell_TrayWnd", "Shell_SecondaryTrayWnd"]);

/** How long each step waits for Windows to show its result. */
const DISMISS_WAIT_MS = 500;
const ACTIVATE_WAIT_MS = 250;
const CLICK_WAIT_MS = 500;

function isShellSurface(win: Win32Foreground, window: number): boolean {
  if (!window) return false;
  const process = win.processName(window);
  return (
    process !== null &&
    SHELL_SURFACE_PROCESSES.has(process) &&
    win.className(window) === SHELL_SURFACE_CLASS
  );
}

/** The window, or one of its own dialogs, is in front: input reaches it. */
function inFront(win: Win32Foreground, window: number): boolean {
  let current = win.foreground();
  for (let depth = 0; current && depth < 8; depth++) {
    if (current === window) return true;
    current = win.owner(current);
  }
  return false;
}

async function waitFor(
  check: () => boolean,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(15);
  }
}

/** A person's name for the window in front: its title and its program. */
function described(win: Win32Foreground, window: number): string {
  if (!window) return "no window";
  if (TASKBAR_CLASSES.has(win.className(window))) return "the taskbar";
  const title = win.title(window).trim();
  const process = win.processName(window);
  const program = process?.replace(/\.exe$/iu, "");
  if (title && program) return `"${title}" (${program})`;
  if (title) return `"${title}"`;
  return program ? `a window of ${program}` : "another window";
}

export async function bringToFront(
  win: Win32Foreground,
  window: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): Promise<ForegroundResult> {
  // A window that is gone is CUA's to report, with its own target checks.
  if (!win.isWindow(window) || inFront(win, window)) return { front: true };
  const front = () => inFront(win, window);
  // Escape dismisses Start or Search the way it does for a person; nothing
  // else takes the foreground from them.
  for (let attempt = 0; attempt < 2 && isShellSurface(win, win.foreground()); attempt++) {
    const surface = win.foreground();
    win.pressEscape();
    await waitFor(() => win.foreground() !== surface, DISMISS_WAIT_MS, sleep);
  }
  if (front()) return { front: true };
  if (win.isMinimized(window)) win.restore(window);
  win.activate(window);
  if (await waitFor(front, ACTIVATE_WAIT_MS, sleep)) return { front: true };
  win.claimInput();
  win.activate(window);
  if (await waitFor(front, ACTIVATE_WAIT_MS, sleep)) return { front: true };
  // Clicking a window's title bar activates it whoever holds the foreground,
  // and does nothing else.
  const caption = win.captionPoint(window);
  if (caption) {
    win.click(caption);
    if (await waitFor(front, CLICK_WAIT_MS, sleep)) return { front: true };
  }
  return { front: false, inFront: described(win, win.foreground()) };
}

const GA_ROOT = 2;
const GW_OWNER = 4;
const SW_RESTORE = 9;
const WM_NCHITTEST = 0x0084;
const HTCAPTION = 2;
const SMTO_ABORTIFHUNG = 0x0002;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const KEYEVENTF_KEYUP = 0x0002;
const VK_ESCAPE = 0x1b;
/** Unassigned; applications bind nothing to it (CUA uses it the same way). */
const VK_NONAME = 0xfc;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;

let native: Promise<Win32Foreground> | null = null;

/** This process's Windows desktop, loaded once and kept for its lifetime. */
export function windowsForeground(): Promise<Win32Foreground> {
  native ??= loadWin32Foreground();
  return native;
}

async function loadWin32Foreground(): Promise<Win32Foreground> {
  const { dlopen, FFIType } = await import("bun:ffi");
  const handle = FFIType.u64;
  const user32 = dlopen("user32.dll", {
    GetForegroundWindow: { args: [], returns: handle },
    IsWindow: { args: [handle], returns: FFIType.i32 },
    IsIconic: { args: [handle], returns: FFIType.i32 },
    GetWindow: { args: [handle, FFIType.u32], returns: handle },
    GetAncestor: { args: [handle, FFIType.u32], returns: handle },
    GetClassNameW: { args: [handle, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    GetWindowTextW: { args: [handle, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    GetWindowThreadProcessId: { args: [handle, FFIType.ptr], returns: FFIType.u32 },
    GetWindowRect: { args: [handle, FFIType.ptr], returns: FFIType.i32 },
    WindowFromPoint: { args: [FFIType.u64], returns: handle },
    SendMessageTimeoutW: {
      args: [handle, FFIType.u32, FFIType.u64, FFIType.i64, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.u64,
    },
    ShowWindow: { args: [handle, FFIType.i32], returns: FFIType.i32 },
    SetForegroundWindow: { args: [handle], returns: FFIType.i32 },
    BringWindowToTop: { args: [handle], returns: FFIType.i32 },
    AttachThreadInput: { args: [FFIType.u32, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
    keybd_event: {
      args: [FFIType.u8, FFIType.u8, FFIType.u32, FFIType.u64],
      returns: FFIType.void,
    },
    mouse_event: {
      args: [FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u64],
      returns: FFIType.void,
    },
    SetCursorPos: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  }).symbols;
  const kernel32 = dlopen("kernel32.dll", {
    GetCurrentThreadId: { args: [], returns: FFIType.u32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    QueryFullProcessImageNameW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  const hwnd = (window: number) => BigInt(window);
  const number = (window: bigint | number) => Number(window);
  const text = (read: (buffer: Uint16Array) => number): string => {
    const buffer = new Uint16Array(512);
    const length = read(buffer);
    return new TextDecoder("utf-16le").decode(buffer.subarray(0, Math.max(0, length)));
  };
  const key = (code: number) => {
    user32.keybd_event(code, 0, 0, 0n);
    user32.keybd_event(code, 0, KEYEVENTF_KEYUP, 0n);
  };
  const covers = (window: number, x: number, y: number): boolean => {
    const point = (BigInt(y >>> 0) << 32n) | BigInt(x >>> 0);
    const hit = number(user32.WindowFromPoint(point));
    return hit !== 0 && number(user32.GetAncestor(hwnd(hit), GA_ROOT)) === window;
  };
  return {
    foreground: () => number(user32.GetForegroundWindow()),
    isWindow: (window) => user32.IsWindow(hwnd(window)) !== 0,
    owner: (window) => number(user32.GetWindow(hwnd(window), GW_OWNER)),
    className: (window) =>
      text((buffer) => user32.GetClassNameW(hwnd(window), buffer, buffer.length)),
    title: (window) => text((buffer) => user32.GetWindowTextW(hwnd(window), buffer, buffer.length)),
    processName: (window) => {
      const pid = new Uint32Array(1);
      user32.GetWindowThreadProcessId(hwnd(window), pid);
      if (!pid[0]) return null;
      const process = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid[0]);
      if (!process) return null;
      try {
        const buffer = new Uint16Array(1024);
        const size = new Uint32Array([buffer.length]);
        if (!kernel32.QueryFullProcessImageNameW(process, 0, buffer, size)) return null;
        const path = new TextDecoder("utf-16le").decode(buffer.subarray(0, size[0]));
        return path.split(/[\\/]/u).pop()?.toLowerCase() ?? null;
      } finally {
        kernel32.CloseHandle(process);
      }
    },
    isMinimized: (window) => user32.IsIconic(hwnd(window)) !== 0,
    restore: (window) => {
      user32.ShowWindow(hwnd(window), SW_RESTORE);
    },
    activate: (window) => {
      const ours = kernel32.GetCurrentThreadId();
      const current = user32.GetForegroundWindow();
      const theirs = current ? user32.GetWindowThreadProcessId(current, null) : 0;
      const attached = theirs !== 0 && theirs !== ours && user32.AttachThreadInput(ours, theirs, 1);
      try {
        user32.SetForegroundWindow(hwnd(window));
        user32.BringWindowToTop(hwnd(window));
      } finally {
        if (attached) user32.AttachThreadInput(ours, theirs, 0);
      }
    },
    claimInput: () => key(VK_NONAME),
    pressEscape: () => key(VK_ESCAPE),
    captionPoint: (window) => {
      const rect = new Int32Array(4);
      if (!user32.GetWindowRect(hwnd(window), rect)) return null;
      const [left, top, right] = [rect[0]!, rect[1]!, rect[2]!];
      const result = new BigUint64Array(1);
      // The title bar is a band at the top; its buttons and an app's own
      // controls in it (tabs, menus) answer something other than HTCAPTION.
      for (const dy of [8, 16, 4, 24]) {
        for (const fraction of [0.5, 0.35, 0.65, 0.2, 0.8]) {
          const x = Math.round(left + (right - left) * fraction);
          const y = top + dy;
          if (!covers(window, x, y)) continue;
          const lParam = BigInt.asIntN(64, BigInt(((y & 0xffff) << 16) | (x & 0xffff)));
          const answered = user32.SendMessageTimeoutW(
            hwnd(window),
            WM_NCHITTEST,
            0n,
            lParam,
            SMTO_ABORTIFHUNG,
            200,
            result,
          );
          if (answered && Number(result[0]) === HTCAPTION) return { x, y };
        }
      }
      return null;
    },
    click: ({ x, y }) => {
      user32.SetCursorPos(x, y);
      user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0n);
      user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0n);
    },
  };
}

/**
 * Setting the text of a Windows text field through the field's own control
 * when CUA cannot set its value through UI Automation.
 *
 * CUA disables an app's main window while it sets a value in some apps (by
 * the app's program name, such as notepad.exe), so that the app cannot take
 * the foreground meanwhile. The UI Automation provider of a classic Edit
 * control refuses every value write while its window is disabled
 * (UIA_E_ELEMENTNOTENABLED), and CUA then says the element has no value
 * pattern. Notepad's document is such a control, so set_value never worked on
 * it.
 *
 * A classic Edit or RichEdit control replaces its text the way typing does
 * when its whole text is selected (EM_SETSEL) and replaced (EM_REPLACESEL):
 * the app is told its text changed, the change can be undone, and the window
 * does not come to the front. Windows carries both messages and their text
 * between processes for these controls.
 *
 * The field written is the one visible Edit or RichEdit control of the window
 * whose window rectangle is exactly the element's bounds: UI Automation gives
 * such a control's element the rectangle of the control's own window. When no
 * control or more than one has that rectangle, nothing is written, so a
 * control nested in the element or around it never is. (The CUA backend
 * also writes nothing when another settable element has the very same
 * bounds, since the control there may be that element's.) A read-only or
 * disabled control is refused before anything is sent.
 */

/** What setting a field's text needs from Windows. Window handles are plain
 * numbers; points and rectangles are in screen coordinates, as CUA gives
 * element bounds. */
export type Win32TextControls = {
  /** Every child window of `window`, and theirs, at any depth. */
  descendants(window: number): number[];
  isVisible(control: number): boolean;
  /** The control's class name and the system class it is built on ("Edit"
   * for a superclassed edit control such as a WinForms TextBox). */
  className(control: number): string;
  baseClassName(control: number): string;
  rect(control: number): { left: number; top: number; right: number; bottom: number } | null;
  style(control: number): number;
  isEnabled(control: number): boolean;
  /** Select the whole text and replace it with `text`, as undoable typing.
   * False when the control did not answer within the timeout. */
  replaceAll(control: number, text: string): boolean;
  /** The control's text, or null when it did not answer. */
  text(control: number): string | null;
  /** The length of the control's text, or null when it did not answer. */
  textLength(control: number): number | null;
  /** Whether the control's text was edited since it was last set or marked
   * unedited (EM_GETMODIFY), or null when it did not answer. */
  modified(control: number): boolean | null;
  /** Mark the control's text edited or unedited (EM_SETMODIFY). False when
   * the control did not answer. */
  setModified(control: number, modified: boolean): boolean;
};

export type TextFieldWrite =
  /** The field reads the value now. */
  | { kind: "replaced" }
  /** A password field, whose text cannot be read: it took the replacement,
   * and what it holds has the value's length and would read as the value
   * once the field changed its letters the way it changes typed ones. */
  | { kind: "replaced_unread" }
  /** Nothing was sent. */
  | { kind: "no_control" }
  | { kind: "read_only" }
  | { kind: "disabled" }
  | { kind: "single_line" }
  /** The text was sent; the field does not hold the value afterwards. */
  | { kind: "not_applied" }
  /** The app did not answer: the text may or may not have been replaced. */
  | { kind: "no_answer" };

/** What the CUA backend uses on Windows: set the text of the text field
 * shown at `bounds` in the top-level `window`. */
export type WindowsTextFields = {
  replace(
    window: number,
    bounds: { x: number; y: number; width: number; height: number },
    value: string,
  ): Promise<TextFieldWrite>;
};

/** This process's Windows desktop as the CUA backend uses it. */
export function windowsTextFields(): WindowsTextFields {
  return {
    replace: async (window, bounds, value) =>
      replaceFieldText(await windowsTextControls(), window, bounds, value),
  };
}

const ES_MULTILINE = 0x0004;
const ES_UPPERCASE = 0x0008;
const ES_LOWERCASE = 0x0010;
const ES_PASSWORD = 0x0020;
const ES_READONLY = 0x0800;

/** Edit and RichEdit controls: "Edit" (also the base of a superclassed edit
 * control), RichEdit20A/W and RICHEDIT50W, Notepad's RichEditD2DPT, and the
 * WinForms wrappers of both ("WindowsForms10.EDIT.app.0.…"). */
const TEXT_CONTROL_CLASS = /(?:^|\.)(?:edit|richedit(?:20[aw]|50w|d2dpt)?)(?:\.|$)/iu;

/** Line breaks as the control and the value compare. */
function lines(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

/** The one visible text control of `window` whose window is exactly the
 * element's area, or 0 when there is none or more than one. */
function controlOf(
  win: Win32TextControls,
  window: number,
  bounds: { x: number; y: number; width: number; height: number },
): number {
  const matches = win.descendants(window).filter((control) => {
    const rect = win.rect(control);
    return (
      rect !== null &&
      rect.left === bounds.x &&
      rect.top === bounds.y &&
      rect.right === bounds.x + bounds.width &&
      rect.bottom === bounds.y + bounds.height &&
      win.isVisible(control) &&
      (TEXT_CONTROL_CLASS.test(win.className(control)) ||
        TEXT_CONTROL_CLASS.test(win.baseClassName(control)))
    );
  });
  return matches.length === 1 ? matches[0]! : 0;
}

export function replaceFieldText(
  win: Win32TextControls,
  window: number,
  bounds: { x: number; y: number; width: number; height: number },
  value: string,
): TextFieldWrite {
  if (bounds.width <= 0 || bounds.height <= 0) return { kind: "no_control" };
  const control = controlOf(win, window, bounds);
  if (!control) return { kind: "no_control" };
  const style = win.style(control);
  if (style & ES_READONLY) return { kind: "read_only" };
  if (!win.isEnabled(control)) return { kind: "disabled" };
  const multiline = (style & ES_MULTILINE) !== 0;
  if (!multiline && /[\r\n]/u.test(value)) return { kind: "single_line" };
  if (style & ES_PASSWORD) return replacePassword(win, control, style, value);
  if (!win.replaceAll(control, multiline ? lines(value).replace(/\n/gu, "\r\n") : value))
    return { kind: "no_answer" };
  const reads = win.text(control);
  if (reads === null) return { kind: "no_answer" };
  return lines(reads) === lines(value) ? { kind: "replaced" } : { kind: "not_applied" };
}

/** Another process cannot read a password field's text, only its length, and
 * a field that ignored the replacement can have the value's length already.
 * The control marks its text edited when it takes a replacement, so it is
 * marked unedited first: a field that is still unedited afterwards did not
 * take it, and gets back the mark it had. A field that turns letters into
 * capitals or small letters (ES_UPPERCASE, ES_LOWERCASE) holds the value
 * only when the value has no letters it would change. What the app itself
 * may do to the text is not seen, so the field is not said to read the
 * value even then. */
function replacePassword(
  win: Win32TextControls,
  control: number,
  style: number,
  value: string,
): TextFieldWrite {
  const edited = win.modified(control);
  if (edited === null || (edited && !win.setModified(control, false))) return { kind: "no_answer" };
  if (!win.replaceAll(control, value)) return { kind: "no_answer" };
  const taken = win.modified(control);
  if (taken === null) return { kind: "no_answer" };
  if (!taken) {
    if (edited) win.setModified(control, true);
    return { kind: "not_applied" };
  }
  const length = win.textLength(control);
  if (length === null) return { kind: "no_answer" };
  const held =
    style & ES_UPPERCASE ? value.toUpperCase() : style & ES_LOWERCASE ? value.toLowerCase() : value;
  return length === value.length && held === value
    ? { kind: "replaced_unread" }
    : { kind: "not_applied" };
}

const GWL_STYLE = -16;
const WM_GETTEXT = 0x000d;
const WM_GETTEXTLENGTH = 0x000e;
const EM_SETSEL = 0x00b1;
const EM_GETMODIFY = 0x00b8;
const EM_SETMODIFY = 0x00b9;
const EM_REPLACESEL = 0x00c2;
const SMTO_ABORTIFHUNG = 0x0002;
const SEND_TIMEOUT_MS = 2_000;
/** More child windows than any app's window has; a bound on the walk. */
const MAX_DESCENDANTS = 4_096;

let native: Promise<Win32TextControls> | null = null;

/** This process's Windows desktop, loaded once and kept for its lifetime. */
export function windowsTextControls(): Promise<Win32TextControls> {
  native ??= loadWin32TextControls();
  return native;
}

async function loadWin32TextControls(): Promise<Win32TextControls> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const handle = FFIType.u64;
  const user32 = dlopen("user32.dll", {
    FindWindowExW: { args: [handle, handle, FFIType.ptr, FFIType.ptr], returns: handle },
    IsWindowVisible: { args: [handle], returns: FFIType.i32 },
    GetClassNameW: { args: [handle, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    RealGetWindowClassW: { args: [handle, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    GetWindowRect: { args: [handle, FFIType.ptr], returns: FFIType.i32 },
    GetWindowLongPtrW: { args: [handle, FFIType.i32], returns: FFIType.i64 },
    IsWindowEnabled: { args: [handle], returns: FFIType.i32 },
    SendMessageTimeoutW: {
      args: [handle, FFIType.u32, FFIType.u64, FFIType.u64, FFIType.u32, FFIType.u32, FFIType.ptr],
      returns: FFIType.u64,
    },
  }).symbols;
  const hwnd = (window: number) => BigInt(window);
  const decode = (buffer: Uint16Array, length: number) =>
    new TextDecoder("utf-16le").decode(buffer.subarray(0, Math.max(0, length)));
  const send = (control: number, message: number, wParam: bigint, lParam: bigint) => {
    const result = new BigUint64Array(1);
    const answered = user32.SendMessageTimeoutW(
      hwnd(control),
      message,
      wParam,
      lParam,
      SMTO_ABORTIFHUNG,
      SEND_TIMEOUT_MS,
      result,
    );
    return answered ? result[0]! : null;
  };
  const textLength = (control: number) => {
    const length = send(control, WM_GETTEXTLENGTH, 0n, 0n);
    return length === null ? null : Number(length);
  };
  return {
    descendants: (window) => {
      const found: number[] = [];
      const pending = [window];
      while (pending.length && found.length < MAX_DESCENDANTS) {
        const parent = pending.pop()!;
        let child = 0;
        while (found.length < MAX_DESCENDANTS) {
          child = Number(user32.FindWindowExW(hwnd(parent), hwnd(child), null, null));
          if (!child) break;
          found.push(child);
          pending.push(child);
        }
      }
      return found;
    },
    isVisible: (control) => user32.IsWindowVisible(hwnd(control)) !== 0,
    className: (control) => {
      const buffer = new Uint16Array(256);
      return decode(buffer, user32.GetClassNameW(hwnd(control), buffer, buffer.length));
    },
    baseClassName: (control) => {
      const buffer = new Uint16Array(256);
      return decode(buffer, user32.RealGetWindowClassW(hwnd(control), buffer, buffer.length));
    },
    rect: (control) => {
      const rect = new Int32Array(4);
      if (!user32.GetWindowRect(hwnd(control), rect)) return null;
      return { left: rect[0]!, top: rect[1]!, right: rect[2]!, bottom: rect[3]! };
    },
    style: (control) => Number(user32.GetWindowLongPtrW(hwnd(control), GWL_STYLE) & 0xffffffffn),
    isEnabled: (control) => user32.IsWindowEnabled(hwnd(control)) !== 0,
    replaceAll: (control, text) => {
      if (send(control, EM_SETSEL, 0n, 0xffffffffffffffffn) === null) return false;
      const value = Buffer.from(`${text}\0`, "utf16le");
      return send(control, EM_REPLACESEL, 1n, BigInt(ptr(value))) !== null;
    },
    text: (control) => {
      const length = textLength(control);
      if (length === null) return null;
      const buffer = new Uint16Array(length + 1);
      const read = send(control, WM_GETTEXT, BigInt(length + 1), BigInt(ptr(buffer)));
      return read === null ? null : decode(buffer, Number(read));
    },
    textLength,
    modified: (control) => {
      const edited = send(control, EM_GETMODIFY, 0n, 0n);
      return edited === null ? null : edited !== 0n;
    },
    setModified: (control, modified) =>
      send(control, EM_SETMODIFY, modified ? 1n : 0n, 0n) !== null,
  };
}

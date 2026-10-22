// Where app-shots meet the operating system. Each platform finds the window
// the person is looking at, takes its picture and reads its text; the shared
// controller (./index.ts) does everything else: settings, the shortcut, and
// handing the capture to the web app.
//
// macOS is implemented (./mac.ts). Windows and Linux plug in here:
// - Windows: the foreground window (GetForegroundWindow), its picture
//   (PrintWindow or Windows.Graphics.Capture) and its text through UI
//   Automation, from PowerShell so the app ships no native module; ordinary
//   key combinations already work through Electron.
// - Linux on X11: the active window (_NET_ACTIVE_WINDOW), its picture
//   (XGetImage) and its text through AT-SPI.
// - Linux on Wayland: no app may read another's window; it takes the
//   desktop's screenshot portal (the person picks the window) and AT-SPI
//   where the compositor allows it.

import type {
  DesktopAppShotBrowser,
  DesktopAppShotErrorCode,
  DesktopAppShotModifier,
  DesktopAppShotPermissionId,
  DesktopPlatform,
} from "../../contract";

/** One captured window, before it goes to the web app. */
export interface CapturedWindow {
  image: Uint8Array;
  app: string;
  bundleId?: string;
  title: string;
  text?: string;
  textTruncated?: boolean;
  window?: { processId: number; windowId: number };
  /** When the window is a web browser's: the page's address. */
  browser?: DesktopAppShotBrowser;
}

export class AppShotError extends Error {
  constructor(
    readonly code: DesktopAppShotErrorCode,
    message: string,
    readonly permission?: DesktopAppShotPermissionId,
  ) {
    super(message);
  }
}

export interface AppShotPlatform {
  readonly platform: DesktopPlatform;
  /** Modifier pairs it can watch for; empty when only key combinations work. */
  readonly modifierPairs: DesktopAppShotModifier[];
  /** Each permission the system asks for, allowed or not; empty where none are asked. */
  permissions(): Promise<{ id: DesktopAppShotPermissionId; granted: boolean }[]>;
  /** The system prompt, or the place in the system's settings to allow it. */
  requestPermission(id: DesktopAppShotPermissionId): Promise<void>;
  /**
   * The frontmost window of another app. `onPicture` runs as soon as its
   * picture is taken, before its text is read, so the app can give feedback.
   * Throws {@link AppShotError}.
   */
  capture(options: { onPicture?: () => void }): Promise<CapturedWindow>;
  /**
   * Calls `onTrigger` each time both keys of the pair go down. Resolves with
   * a stop function once it is watching; `onFailure` when it stops by itself.
   */
  watchModifierPair?(
    modifier: DesktopAppShotModifier,
    onTrigger: () => void,
    onFailure: (error: Error) => void,
  ): Promise<() => void>;
}

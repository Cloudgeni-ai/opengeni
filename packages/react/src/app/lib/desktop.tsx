/**
 * The web app inside an Opengeni desktop app. The desktop shell exposes a
 * small bridge (`window.opengeniDesktop`); everything here degrades to the
 * plain web when it is absent or lacks a capability.
 */
import { OPENGENI_DESKTOP_APP_HEADER } from "@opengeni/contracts";
import {
  getDesktopBridge,
  hasDesktopCapability,
  type DesktopBridge,
  type DesktopCapability,
  type DesktopPlatform,
} from "@opengeni/sdk/desktop-bridge";

export const desktopBridge: DesktopBridge | null =
  typeof window === "undefined" ? null : getDesktopBridge();

/**
 * The platform of the Opengeni desktop app from its user agent, which
 * Electron writes as `… Opengeni/<version> Chrome/… Electron/<version> …`;
 * null anywhere else, including other Electron apps.
 */
export function desktopPlatformFromUserAgent(userAgent: string): DesktopPlatform | null {
  if (!/\bOpengeni\/\d[^\s]*\s.*\bElectron\/\d/u.test(userAgent)) return null;
  if (/\bMacintosh\b|\bMac OS X\b/u.test(userAgent)) return "macos";
  if (/\bWindows\b/u.test(userAgent)) return "windows";
  return "linux";
}

/**
 * The desktop app's platform. The bridge says so; without it (a page the
 * shell's preload didn't reach) the app's user agent still does, so the page
 * keeps room for the native window controls drawn over it. Capabilities come
 * only from the bridge.
 */
export const desktopPlatform: DesktopPlatform | null =
  desktopBridge?.platform ??
  (typeof navigator === "undefined" ? null : desktopPlatformFromUserAgent(navigator.userAgent));

/**
 * In the macOS app the window's traffic lights sit in the top-left corner of
 * the page, where the rails put the brand; the Dock and menu bar already name
 * the app, so rails keep that row for the window controls.
 */
export const windowControlsInPage = desktopPlatform === "macos";

export function desktopCapability(capability: DesktopCapability): DesktopBridge | null {
  return hasDesktopCapability(desktopBridge, capability) ? desktopBridge : null;
}

/**
 * Marks the console's API requests inside the desktop app, so a sign-in that
 * finishes in the person's browser brings them back to the app.
 */
export function desktopAppHeaders(): Record<string, string> {
  return desktopBridge ? { [OPENGENI_DESKTOP_APP_HEADER]: desktopBridge.platform } : {};
}

declare global {
  interface Window {
    /** The shell calls this to move the app to a path without a reload. */
    __opengeniDesktopNavigate?: ((path: string) => void) | undefined;
  }
}

/**
 * Before the first render: mark the document so the desktop layout applies
 * from the first frame (room for the window controls, draggable title areas,
 * window materials), and let the shell navigate client-side.
 */
export function installDesktopShell(navigate: (path: string) => void): void {
  if (desktopPlatform) document.documentElement.dataset.desktop = desktopPlatform;
  if (!desktopBridge) return;
  window.__opengeniDesktopNavigate = (path: string) => {
    if (typeof path === "string" && path.startsWith("/") && !path.startsWith("//")) navigate(path);
  };
}

/**
 * The desktop app is one long-lived window: once it is idle after opening,
 * fetch the code for the pages people move between, so the first visit to
 * each one renders at once instead of showing a loading state.
 */
export function warmDesktopPages(
  pages: readonly { preload?: (() => unknown) | undefined }[],
): void {
  if (!desktopBridge) return;
  const warm = () => {
    for (const page of pages) {
      try {
        void Promise.resolve(page.preload?.()).catch(() => undefined);
      } catch {
        // A page that fails to load now loads (and reports) on its first visit.
      }
    }
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(warm, { timeout: 3_000 });
  } else {
    window.setTimeout(warm, 1_500);
  }
}

const RESTORE_KEY = "opengeni.desktop.webSessionRestoredAt";

/**
 * The page found itself signed out inside the desktop app. The app is still
 * signed in, so it renews the window's web sign-in and the page reloads. At
 * most once a minute, so a server that keeps refusing can't loop the page.
 */
export async function restoreDesktopWebSession(): Promise<boolean> {
  const bridge = desktopCapability("accounts");
  if (!bridge) return false;
  try {
    const last = Number(window.sessionStorage.getItem(RESTORE_KEY) ?? 0);
    if (Date.now() - last < 60_000) return false;
    window.sessionStorage.setItem(RESTORE_KEY, String(Date.now()));
  } catch {
    return false;
  }
  const restored = await bridge.accounts.restoreWebSession().catch(() => false);
  if (restored) window.location.reload();
  return restored;
}

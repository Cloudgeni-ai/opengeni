/**
 * The web app inside an Opengeni desktop app. The desktop shell exposes a
 * small bridge (`window.opengeniDesktop`); everything here degrades to the
 * plain web when it is absent or lacks a capability.
 */
import {
  getDesktopBridge,
  hasDesktopCapability,
  type DesktopBridge,
  type DesktopCapability,
} from "@opengeni/desktop/contract";

export const desktopBridge: DesktopBridge | null =
  typeof window === "undefined" ? null : getDesktopBridge();

/**
 * In the macOS app the window's traffic lights sit in the top-left corner of
 * the page, where the rails put the brand; the Dock and menu bar already name
 * the app, so rails keep that row for the window controls.
 */
export const windowControlsInPage = desktopBridge?.platform === "macos";

export function desktopCapability(capability: DesktopCapability): DesktopBridge | null {
  return hasDesktopCapability(desktopBridge, capability) ? desktopBridge : null;
}

declare global {
  interface Window {
    /** The shell calls this to move the app to a path without a reload. */
    __opengeniDesktopNavigate?: (path: string) => void;
  }
}

/**
 * Before the first render: mark the document so the desktop layout applies
 * from the first frame (room for the window controls, draggable title areas,
 * window materials), and let the shell navigate client-side.
 */
export function installDesktopShell(navigate: (path: string) => void): void {
  if (!desktopBridge) return;
  document.documentElement.dataset.desktop = desktopBridge.platform;
  window.__opengeniDesktopNavigate = (path: string) => {
    if (typeof path === "string" && path.startsWith("/") && !path.startsWith("//")) navigate(path);
  };
}

/**
 * The desktop app is one long-lived window: once it is idle after opening,
 * fetch the code for the pages people move between, so the first visit to
 * each one renders at once instead of showing a loading state.
 */
export function warmDesktopPages(pages: readonly { preload?: () => unknown }[]): void {
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

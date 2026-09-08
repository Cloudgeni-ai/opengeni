import type { ConnectNavigation } from "./authorization";

/** Structural browser surface so importing Connect never reads DOM globals. */
export type ConnectBrowserWindow = {
  open(
    url: string,
    target: string,
    features: string,
  ): {
    opener: unknown;
    location: { replace(url: string): void };
    close(): void;
  } | null;
  location: { assign(url: string): void };
};

function validateDestination(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("Connect authorization requires an HTTPS destination without credentials");
}

/** Pass window from the host's browser entry point. Opens a fresh blank window
 * synchronously and severs its opener BEFORE any provider content can load.
 * Never uses a reusable named target or relies on provider window messages.
 * The caller retains only the close capability for backend-polling cleanup. */
export function createBrowserConnectNavigation(browser: ConnectBrowserWindow): ConnectNavigation {
  return {
    openPopup(url) {
      validateDestination(url);
      const popup = browser.open("about:blank", "_blank", "popup,width=520,height=720");
      if (!popup) return null;
      try {
        popup.opener = null;
        if (popup.opener !== null) throw new Error("Connect popup isolation failed");
        popup.location.replace(url);
      } catch {
        try {
          popup.close();
        } catch {
          /* Preserve the isolated navigation failure. */
        }
        throw new Error("Connect popup could not navigate safely; retry with redirect mode");
      }
      return { close: () => popup.close() };
    },
    redirect(url) {
      validateDestination(url);
      browser.location.assign(url);
    },
  };
}

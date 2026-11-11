import type { ConnectNavigation, ConnectPopup } from "./authorization";

/** Structural browser surface so importing Connect never reads DOM globals. */
export type ConnectBrowserWindow = {
  open(
    url: string,
    target: string,
    features: string,
  ): {
    opener: unknown;
    readonly closed?: boolean;
    location: { replace(url: string): void };
    close(): void;
    focus?(): void;
  } | null;
  location: { assign(url: string): void };
};

function validateDestination(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("Connect authorization requires an HTTPS destination without credentials");
}

function closeIsolatedPopup(popup: NonNullable<ReturnType<ConnectBrowserWindow["open"]>>): void {
  try {
    if (popup.closed) return;
    // After opener isolation, browsers cannot close a foreign-origin window.
    // Check access first to avoid a futile close and its browser warning.
    Reflect.get(popup.location, "href");
    popup.close();
  } catch {
    /* The human closes foreign-origin or detached provider windows. */
  }
}

/** What the host can still do with an isolated window: it can see whether the
 * window is open and ask it forward, but not close or navigate it once it shows
 * another site. */
function popupHandle(popup: NonNullable<ReturnType<ConnectBrowserWindow["open"]>>): ConnectPopup {
  return {
    close: () => closeIsolatedPopup(popup),
    isOpen() {
      try {
        return popup.closed === false;
      } catch {
        return false;
      }
    },
    focus() {
      try {
        popup.focus?.();
      } catch {
        /* Focus is a request; the browser may ignore it. */
      }
    },
  };
}

/** Reserve the isolated window during the human's click, before asynchronous
 * discovery. The caller must close it if setup fails before navigation. */
export function reserveBrowserConnectNavigation(browser: ConnectBrowserWindow): {
  navigation: ConnectNavigation;
  close(): void;
} {
  const popup = browser.open("about:blank", "_blank", "popup,width=520,height=720");
  if (!popup) throw new Error("Allow popups to connect your account, then try again.");
  try {
    popup.opener = null;
    if (popup.opener !== null) throw new Error("Connect popup isolation failed");
  } catch {
    closeIsolatedPopup(popup);
    throw new Error("Connect popup could not open safely. Please try again.");
  }
  const handle = popupHandle(popup);
  const close = handle.close;
  return {
    close,
    navigation: {
      openPopup(url) {
        validateDestination(url);
        popup.location.replace(url);
        // No `closed`: browser COOP can sever this WindowProxy and report
        // closed while the provider window is still open. Keep polling durable
        // completion; the host's Stop control and bounded timeout end observation.
        return handle;
      },
      redirect(url) {
        validateDestination(url);
        close();
        browser.location.assign(url);
      },
    },
  };
}

/** Pass window from the host's browser entry point. Opens a fresh blank window
 * synchronously and severs its opener BEFORE any provider content can load.
 * Never uses a reusable named target or relies on provider window messages.
 * The caller retains only best-effort close capability for polling cleanup;
 * the human closes provider windows that remain on a foreign origin. */
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
        closeIsolatedPopup(popup);
        throw new Error("Connect popup could not navigate safely; retry with redirect mode");
      }
      // No `closed`: WindowProxy.closed is not a reliable user-cancellation
      // signal after a provider moves the popup into a different browsing
      // context group.
      return popupHandle(popup);
    },
    redirect(url) {
      validateDestination(url);
      browser.location.assign(url);
    },
  };
}

import { useEffect, useInsertionEffect, useRef } from "react";

const SITE_OPENED_EVENT = "opengeni:site-opened";

type SiteOpenedDetail = { workspaceId: string; siteId: string };

type SiteOpenedClient = {
  recordSiteOpened?: (workspaceId: string, siteId: string) => Promise<unknown>;
};

const OPENED_ENTRY_KEY = "opengeni:site-opened:";

/**
 * The console router's key for the page being shown (TanStack history state).
 * A reload, a restored tab or coming back to the page keeps it; going to the
 * Site again gets a new one.
 */
function historyEntryKey(): string | undefined {
  const state: unknown = window.history.state;
  const key =
    state && typeof state === "object" ? (state as { __TSR_key?: unknown }).__TSR_key : undefined;
  return typeof key === "string" ? key : undefined;
}

/** Whether this tab already recorded opening the Site on this page. */
function openedOnThisPage(siteId: string, entry: string | undefined): boolean {
  if (entry === undefined) return false;
  try {
    return window.sessionStorage.getItem(OPENED_ENTRY_KEY + siteId) === entry;
  } catch {
    return false;
  }
}

function rememberOpenedOnThisPage(siteId: string, entry: string | undefined): void {
  if (entry === undefined) return;
  try {
    window.sessionStorage.setItem(OPENED_ENTRY_KEY + siteId, entry);
  } catch {
    // Without storage a reload of this page counts as another open.
  }
}

/**
 * Opening a Site in the app counts as activity on its sidebar row, once per
 * page the person goes to. A new client for the same person doesn't open it
 * again, a hidden page counts once it is shown, and a reload, a restored tab
 * or coming back to a page where the open was already recorded doesn't count.
 */
export function useRecordSiteOpened(
  client: SiteOpenedClient,
  workspaceId: string,
  siteId: string,
): void {
  const clientRef = useRef(client);
  useInsertionEffect(() => {
    clientRef.current = client;
  }, [client]);
  useEffect(() => {
    if (typeof clientRef.current.recordSiteOpened !== "function") return;
    const entry = historyEntryKey();
    if (openedOnThisPage(siteId, entry)) return;
    let current = true;
    const record = () => {
      document.removeEventListener("visibilitychange", whenShown);
      const latest = clientRef.current;
      if (!current || typeof latest.recordSiteOpened !== "function") return;
      latest
        .recordSiteOpened(workspaceId, siteId)
        .then(() => {
          rememberOpenedOnThisPage(siteId, entry);
          if (!current) return;
          window.dispatchEvent(
            new CustomEvent<SiteOpenedDetail>(SITE_OPENED_EVENT, {
              detail: { workspaceId, siteId },
            }),
          );
        })
        // Ordering is a convenience: a server without it, or a failed write,
        // leaves the Site and its row as they were.
        .catch(() => undefined);
    };
    function whenShown() {
      if (document.visibilityState !== "hidden") record();
    }
    if (document.visibilityState === "hidden")
      document.addEventListener("visibilitychange", whenShown);
    else record();
    return () => {
      current = false;
      document.removeEventListener("visibilitychange", whenShown);
    };
  }, [workspaceId, siteId]);
}

/** Calls `onOpened` after this workspace records a Site open. */
export function useSiteOpenedListener(
  workspaceId: string,
  onOpened: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<SiteOpenedDetail>).detail;
      if (detail?.workspaceId === workspaceId) onOpened();
    };
    window.addEventListener(SITE_OPENED_EVENT, listener);
    return () => window.removeEventListener(SITE_OPENED_EVENT, listener);
  }, [workspaceId, onOpened, enabled]);
}

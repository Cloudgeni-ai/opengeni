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
 * Record that this person opened a Site in the app, which lists the Site in
 * their sidebar (it does not move the row: opening is not activity), once per
 * page the person goes to. A new client for the same person doesn't open it
 * again, a hidden page counts once it is shown, and a reload, a restored tab
 * or coming back to a page where the open was already recorded doesn't count.
 * Pages the open Site view moves to (choosing a conversation) belong to the
 * same open.
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
  // The page this open is remembered on, once it is recorded.
  const remembered = useRef<string | undefined>(undefined);
  useEffect(() => {
    remembered.current = undefined;
    if (typeof clientRef.current.recordSiteOpened !== "function") return;
    const entry = historyEntryKey();
    if (openedOnThisPage(siteId, entry)) {
      remembered.current = entry;
      return;
    }
    let current = true;
    const record = () => {
      document.removeEventListener("visibilitychange", whenShown);
      const latest = clientRef.current;
      if (!current || typeof latest.recordSiteOpened !== "function") return;
      latest
        .recordSiteOpened(workspaceId, siteId)
        .then(() => {
          if (!current) {
            rememberOpenedOnThisPage(siteId, entry);
            return;
          }
          remembered.current = historyEntryKey() ?? entry;
          rememberOpenedOnThisPage(siteId, remembered.current);
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
  // While the Site view stays open, follow it to the page it now shows.
  useEffect(() => {
    if (remembered.current === undefined) return;
    const entry = historyEntryKey();
    if (entry === undefined || entry === remembered.current) return;
    remembered.current = entry;
    rememberOpenedOnThisPage(siteId, entry);
  });
}

/** Calls `onOpened` with the Site after this workspace records a Site open. */
export function useSiteOpenedListener(
  workspaceId: string,
  onOpened: (siteId: string) => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<SiteOpenedDetail>).detail;
      if (detail?.workspaceId === workspaceId) onOpened(detail.siteId);
    };
    window.addEventListener(SITE_OPENED_EVENT, listener);
    return () => window.removeEventListener(SITE_OPENED_EVENT, listener);
  }, [workspaceId, onOpened, enabled]);
}

import { useEffect, useInsertionEffect, useRef } from "react";

const SITE_OPENED_EVENT = "opengeni:site-opened";

type SiteOpenedDetail = { workspaceId: string; siteId: string };

type SiteOpenedClient = {
  recordSiteOpened?: (workspaceId: string, siteId: string) => Promise<unknown>;
};

// The history entry this document first showed, and whether the person has
// gone back or forward since. A reload or restored tab keeps its entry's key.
const firstEntryKey = historyEntryKey();
let movedThroughHistory = false;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    movedThroughHistory = true;
  });
}

function historyEntryKey(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const state: unknown = window.history.state;
  const key =
    state && typeof state === "object" ? (state as { __TSR_key?: unknown }).__TSR_key : undefined;
  return typeof key === "string" ? key : undefined;
}

/**
 * A reload, or a tab the browser restored, that shows this Site again as its
 * first page. The person opened it before; showing it again is not an open.
 * Any later visit in the same document is a navigation of their own.
 */
function reloadedOntoSite(siteId: string): boolean {
  if (typeof window === "undefined" || typeof performance === "undefined") return false;
  const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
  if (entry?.type !== "reload" && entry?.type !== "back_forward") return false;
  if (movedThroughHistory || window.location.href !== entry.name) return false;
  const key = historyEntryKey();
  if (key === undefined || key !== firstEntryKey) return false;
  return window.location.pathname.endsWith(`/sites/${encodeURIComponent(siteId)}`);
}

/**
 * Opening a Site in the app counts as activity on its sidebar row, once per
 * visit. A new client for the same person doesn't open it again, a hidden page
 * counts once it is shown, and a reload or restored tab is not an open.
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
    if (reloadedOntoSite(siteId)) return;
    let current = true;
    const record = () => {
      document.removeEventListener("visibilitychange", whenShown);
      const latest = clientRef.current;
      if (!current || typeof latest.recordSiteOpened !== "function") return;
      latest
        .recordSiteOpened(workspaceId, siteId)
        .then(() => {
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

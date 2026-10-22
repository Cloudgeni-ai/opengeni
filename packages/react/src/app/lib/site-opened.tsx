import { useEffect } from "react";

const SITE_OPENED_EVENT = "opengeni:site-opened";

type SiteOpenedDetail = { workspaceId: string; siteId: string };

/** Opening a Site in the app counts as activity on its sidebar row. */
export function useRecordSiteOpened(
  client: { recordSiteOpened?: (workspaceId: string, siteId: string) => Promise<unknown> },
  workspaceId: string,
  siteId: string,
): void {
  useEffect(() => {
    if (typeof client.recordSiteOpened !== "function") return;
    let current = true;
    client
      .recordSiteOpened(workspaceId, siteId)
      .then(() => {
        if (!current) return;
        window.dispatchEvent(
          new CustomEvent<SiteOpenedDetail>(SITE_OPENED_EVENT, { detail: { workspaceId, siteId } }),
        );
      })
      // Ordering is a convenience: a server without it, or a failed write,
      // leaves the Site and its row as they were.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client, workspaceId, siteId]);
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

import { useEffect } from "react";
import { useOpenGeni } from "../../session-context";

/** Small unpaged lists reconcile on any authorized hint; the rail scopes its own pages. */
export function useSessionListHintRefresh(refresh: () => Promise<void>, error: Error | null) {
  const { workspaceId, workspaceSessionListEvent: hint, workspaceControlEvent } = useOpenGeni();
  const available = hint?.workspaceId === workspaceId && hint.available;
  useEffect(() => {
    if (available && document.visibilityState !== "hidden") void refresh();
  }, [available, hint, workspaceControlEvent, refresh]);
  useEffect(() => {
    if (!available || !error || document.visibilityState === "hidden") return;
    const timer = window.setTimeout(() => void refresh(), 15_000);
    return () => window.clearTimeout(timer);
  }, [available, error, refresh]);
}

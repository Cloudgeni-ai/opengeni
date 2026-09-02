import { useEffect } from "react";

type RefreshGitHub = (
  workspaceId: string,
  signal?: AbortSignal,
  options?: { sync?: boolean },
) => Promise<void>;

export function useGitHubHistoryRefresh(
  workspaceId: string,
  enabled: boolean,
  refreshGitHub: RefreshGitHub,
): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refreshGitHub(workspaceId);
      }, 2_000);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        scheduleRefresh();
      }
    };
    const onFocus = () => scheduleRefresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleRefresh();
    };
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, refreshGitHub, workspaceId]);
}

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
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void refreshGitHub(workspaceId);
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [enabled, refreshGitHub, workspaceId]);
}

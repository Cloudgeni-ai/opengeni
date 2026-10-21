import { useEffect } from "react";

import { userErrorText } from "../../ui/api-error";
import type { AppContextValue } from "../app-context";
import { isAbortError } from "./session-tools";
import { toast } from "./toast";
import { useGitHubHistoryRefresh } from "./use-github-history-refresh";

/**
 * Loads the routed workspace's integrations into app state: GitHub and personal
 * GitHub repositories and the workspace MCP catalog, after clearing the
 * previous workspace's repository selection. GitHub refreshes again when the
 * page comes back into view. Every host that shows a workspace's sessions (the
 * web app's workspace route, `SessionApp`) runs it once the workspace owns the
 * app state (`workspaceStateOwnerId`) and the person can open it.
 */
export function useWorkspaceIntegrations(
  context: Pick<
    AppContextValue,
    | "accessKeyVersion"
    | "refreshGitHub"
    | "refreshPersonalGitHub"
    | "refreshWorkspaceMcpServers"
    | "resetWorkspaceIntegrations"
    | "setSelectedRepoIds"
    | "setSelectedRepoRefs"
  >,
  workspaceId: string,
  enabled: boolean,
): void {
  const {
    accessKeyVersion,
    refreshGitHub,
    refreshPersonalGitHub,
    refreshWorkspaceMcpServers,
    resetWorkspaceIntegrations,
    setSelectedRepoIds,
    setSelectedRepoRefs,
  } = context;
  useGitHubHistoryRefresh(workspaceId, enabled, refreshGitHub);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const abortController = new AbortController();
    resetWorkspaceIntegrations();
    setSelectedRepoIds(new Set());
    setSelectedRepoRefs({});
    void refreshGitHub(workspaceId, abortController.signal);
    void refreshPersonalGitHub(workspaceId, abortController.signal);
    void refreshWorkspaceMcpServers(workspaceId, abortController.signal).catch((error) => {
      if (!abortController.signal.aborted && !isAbortError(error)) {
        toast.error("Couldn't load workspace MCP tools", {
          description: userErrorText(error),
        });
      }
    });
    return () => abortController.abort();
  }, [
    accessKeyVersion,
    enabled,
    refreshGitHub,
    refreshPersonalGitHub,
    refreshWorkspaceMcpServers,
    resetWorkspaceIntegrations,
    setSelectedRepoIds,
    setSelectedRepoRefs,
    workspaceId,
  ]);
}

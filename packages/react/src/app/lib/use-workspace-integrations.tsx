import { useEffect } from "react";

import { userErrorText } from "../../ui/api-error";
import type { AppContextValue } from "../app-context";
import { isAbortError } from "./session-tools";
import { isTransientServiceFailure } from "../../lib/transient-retry";
import { createQuietRetry } from "./quiet-retry";
import { toast } from "./toast";
import { useGitHubHistoryRefresh } from "./use-github-history-refresh";

/** The one "Couldn't load workspace MCP tools" toast. */
export const WORKSPACE_MCP_TOOLS_TOAST_ID = "opengeni-workspace-mcp-tools";

/**
 * Loads the routed workspace's integrations into app state: GitHub and personal
 * GitHub repositories and the workspace MCP catalog, after clearing the
 * previous workspace's repository selection. GitHub refreshes again when the
 * page comes back into view. Reads that fail because Opengeni is briefly
 * unreachable (a deploy, a network drop) try again by themselves, quietly. Every host that shows a workspace's sessions (the
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
    // Opengeni briefly unreachable (a deploy, a network drop) is not worth a
    // toast: the tools load again by themselves once it answers.
    const quietRetry = createQuietRetry();
    const loadMcpServers = () => {
      void refreshWorkspaceMcpServers(workspaceId, abortController.signal).then(
        () => quietRetry.reset(),
        (error) => {
          if (abortController.signal.aborted || isAbortError(error)) return;
          if (isTransientServiceFailure(error)) {
            quietRetry.schedule(loadMcpServers);
            return;
          }
          toast.error("Couldn't load workspace MCP tools", {
            id: WORKSPACE_MCP_TOOLS_TOAST_ID,
            description: userErrorText(error),
          });
        },
      );
    };
    loadMcpServers();
    return () => {
      quietRetry.reset();
      abortController.abort();
    };
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

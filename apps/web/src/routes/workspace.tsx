// The workspace shell: the Linear-style left rail (brand, org + workspace
// switcher, workspace nav, the session list) plus a slim canvas top strip for
// session-contextual actions around every workspace-scoped route.
import { OpenGeniProvider } from "@opengeni/react";
import { Link, Outlet } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { ProblemPanel } from "@/components/common";
import { RailProvider } from "@/components/rail/rail-context";
import { RailShell } from "@/components/rail/rail-shell";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";
import { isAbortError } from "@/lib/session-tools";

export function WorkspaceShellRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const activeWorkspace =
    context.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const {
    accessKeyVersion,
    resetSessionView,
    resetWorkspaceIntegrations,
    setSelectedRepoIds,
    setSelectedRepoRefs,
    refreshGitHub,
    refreshWorkspaceMcpServers,
  } = context;
  const previousWorkspaceId = useRef<string | null>(null);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    const abortController = new AbortController();
    if (previousWorkspaceId.current !== workspaceId) {
      resetSessionView();
    }
    previousWorkspaceId.current = workspaceId;
    resetWorkspaceIntegrations();
    setSelectedRepoIds(new Set());
    setSelectedRepoRefs({});
    void refreshGitHub(workspaceId, abortController.signal);
    void refreshWorkspaceMcpServers(workspaceId, abortController.signal).catch((error) => {
      if (!isAbortError(error)) {
        toast.error("Failed to load workspace MCP tools", { description: String(error) });
      }
    });
    return () => abortController.abort();
  }, [
    accessKeyVersion,
    activeWorkspaceId,
    refreshGitHub,
    refreshWorkspaceMcpServers,
    resetSessionView,
    resetWorkspaceIntegrations,
    setSelectedRepoIds,
    setSelectedRepoRefs,
    workspaceId,
  ]);

  if (!activeWorkspace) {
    return (
      <RailProvider workspaceId={workspaceId}>
        <RailShell>
          <ProblemPanel
            title="Workspace unavailable"
            description="You don't have access to this workspace."
            action={
              <Button asChild type="button" variant="secondary">
                <Link to="/">Open default workspace</Link>
              </Button>
            }
          />
        </RailShell>
      </RailProvider>
    );
  }

  return (
    <OpenGeniProvider
      client={context.client}
      workspaceId={workspaceId}
      onWorkspaceControlEvent={() => void context.refreshWorkspace(workspaceId)}
    >
      <RailProvider workspaceId={workspaceId}>
        <RailShell>
          <Outlet />
        </RailShell>
      </RailProvider>
    </OpenGeniProvider>
  );
}

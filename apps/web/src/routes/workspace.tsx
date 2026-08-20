// The workspace shell: the Linear-style left rail (brand, org + workspace
// switcher, workspace nav, the session list) plus a slim canvas top strip for
// session-contextual actions around every workspace-scoped route.
import { OpenGeniProvider } from "@opengeni/react";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { LoadingPanel, ProblemPanel } from "@/components/common";
import { RailProvider } from "@/components/rail/rail-context";
import { RailShell } from "@/components/rail/rail-shell";
import { Button } from "@/components/ui/button";
import { WorkspaceTenantBoundary } from "@/components/workspace-tenant-boundary";
import { useAppContext } from "@/context";
import { useGitHubHistoryRefresh } from "@/lib/use-github-history-refresh";
import { isAbortError } from "@/lib/session-tools";
import type { SlackUserLinkAccessRequest } from "@/types";

export function SlackLinkAccessRequiredDescription({ workspaceName }: { workspaceName: string }) {
  return (
    <>
      You need access to <strong>{workspaceName}</strong> to connect your Slack account.
    </>
  );
}

export function WorkspaceShellRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const activeWorkspace =
    context.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const {
    accessKeyVersion,
    resetWorkspaceIntegrations,
    setSelectedRepoIds,
    setSelectedRepoRefs,
    refreshGitHub,
    refreshWorkspaceMcpServers,
  } = context;
  const [slackAccessRequest, setSlackAccessRequest] = useState<SlackUserLinkAccessRequest | null>(
    null,
  );
  const [slackAccessError, setSlackAccessError] = useState<string | null>(null);
  const [slackAccessBusy, setSlackAccessBusy] = useState(false);
  const workspaceStateReady = context.workspaceStateOwnerId === workspaceId;
  useGitHubHistoryRefresh(
    workspaceId,
    activeWorkspaceId !== null && workspaceStateReady,
    refreshGitHub,
  );

  const hasSlackLinkContinuation = context.slackLinkContinuationWorkspaceId === workspaceId;

  const refreshSlackAccess = useCallback(
    async (request: SlackUserLinkAccessRequest) => {
      const next = await context.client.getSlackUserLinkAccess(workspaceId, request.id);
      setSlackAccessRequest(next);
      if (next.status === "completed") {
        toast.success("Slack identity linked", {
          description: "You can return to Slack and invoke OpenGeni again.",
        });
        await context.refreshWorkspace(workspaceId);
        context.clearSlackLinkContinuation();
      }
      return next;
    },
    [context, workspaceId],
  );

  useEffect(() => {
    if (!hasSlackLinkContinuation) return;
    let disposed = false;
    setSlackAccessError(null);
    void context
      .preparePendingSlackLink(workspaceId)
      .then(async (request) => {
        if (disposed || !request) return;
        setSlackAccessRequest(request);
        if (request.status === "completed") {
          toast.success("Slack identity linked", {
            description: "You can return to Slack and invoke OpenGeni again.",
          });
          await context.refreshWorkspace(workspaceId);
          context.clearSlackLinkContinuation();
        }
      })
      .catch((error) => {
        if (disposed) return;
        setSlackAccessError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      disposed = true;
    };
  }, [context, hasSlackLinkContinuation, workspaceId]);

  useEffect(() => {
    if (slackAccessRequest?.status !== "pending") return;
    const interval = window.setInterval(() => {
      void refreshSlackAccess(slackAccessRequest).catch((error) => {
        setSlackAccessError(error instanceof Error ? error.message : String(error));
      });
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [refreshSlackAccess, slackAccessRequest]);

  async function requestAccess() {
    if (!slackAccessRequest || slackAccessRequest.status !== "prepared") return;
    setSlackAccessBusy(true);
    try {
      setSlackAccessRequest(
        await context.client.requestSlackUserLinkWorkspaceAccess(
          workspaceId,
          slackAccessRequest.id,
          {
            expectedVersion: slackAccessRequest.version,
            idempotencyKey: crypto.randomUUID(),
          },
        ),
      );
      toast.success("Access request sent");
    } catch (error) {
      setSlackAccessError(error instanceof Error ? error.message : String(error));
    } finally {
      setSlackAccessBusy(false);
    }
  }

  async function cancelSlackAccess() {
    if (
      !slackAccessRequest ||
      (slackAccessRequest.status !== "prepared" && slackAccessRequest.status !== "pending")
    ) {
      return;
    }
    setSlackAccessBusy(true);
    try {
      await context.client.cancelSlackUserLinkAccess(workspaceId, slackAccessRequest.id, {
        expectedVersion: slackAccessRequest.version,
        idempotencyKey: crypto.randomUUID(),
      });
      context.clearSlackLinkContinuation();
      await navigate({ to: "/", replace: true });
    } catch (error) {
      setSlackAccessError(error instanceof Error ? error.message : String(error));
    } finally {
      setSlackAccessBusy(false);
    }
  }

  useEffect(() => {
    if (!activeWorkspaceId || !workspaceStateReady) {
      return;
    }
    const abortController = new AbortController();
    resetWorkspaceIntegrations();
    setSelectedRepoIds(new Set());
    setSelectedRepoRefs({});
    void refreshGitHub(workspaceId, abortController.signal);
    void refreshWorkspaceMcpServers(workspaceId, abortController.signal).catch((error) => {
      if (!abortController.signal.aborted && !isAbortError(error)) {
        toast.error("Failed to load workspace MCP tools", { description: String(error) });
      }
    });
    return () => abortController.abort();
  }, [
    accessKeyVersion,
    activeWorkspaceId,
    refreshGitHub,
    refreshWorkspaceMcpServers,
    resetWorkspaceIntegrations,
    setSelectedRepoIds,
    setSelectedRepoRefs,
    workspaceStateReady,
    workspaceId,
  ]);

  if (!workspaceStateReady) {
    return (
      <WorkspaceTenantBoundary
        workspaceId={workspaceId}
        stateOwnerWorkspaceId={context.workspaceStateOwnerId}
        prepareTransition={context.prepareWorkspaceTransition}
      >
        {null}
      </WorkspaceTenantBoundary>
    );
  }

  if (!activeWorkspace) {
    if (hasSlackLinkContinuation || slackAccessRequest || slackAccessError) {
      const workspaceName = slackAccessRequest?.workspaceDisplayName ?? "this workspace";
      const activePendingState =
        slackAccessRequest?.status === "prepared" || slackAccessRequest?.status === "pending";
      const terminalGuidance =
        slackAccessRequest?.status === "denied"
          ? "A workspace administrator denied this request. Request a fresh link from Slack if you still need access."
          : slackAccessRequest?.status === "cancelled"
            ? "This Slack access request was cancelled. Request a fresh link from Slack to try again."
            : "This Slack link is invalid or expired. Request a fresh link from Slack.";
      return (
        <OpenGeniProvider
          client={context.client}
          workspaceId={workspaceId}
          onWorkspaceControlEvent={() => void context.refreshWorkspace(workspaceId)}
        >
          <RailProvider workspaceId={workspaceId}>
            <RailShell>
              {!slackAccessRequest && !slackAccessError ? (
                <LoadingPanel label="Checking Slack access" />
              ) : activePendingState ? (
                <ProblemPanel
                  title={
                    slackAccessRequest?.status === "pending"
                      ? "Access requested"
                      : "Workspace access required"
                  }
                  description={<SlackLinkAccessRequiredDescription workspaceName={workspaceName} />}
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      {slackAccessRequest?.status === "prepared" ? (
                        <Button
                          type="button"
                          disabled={slackAccessBusy}
                          onClick={() => void requestAccess()}
                        >
                          Request access
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={slackAccessBusy}
                        onClick={() => void cancelSlackAccess()}
                      >
                        Cancel
                      </Button>
                    </div>
                  }
                />
              ) : (
                <ProblemPanel
                  title="Slack link unavailable"
                  description={slackAccessError ?? terminalGuidance}
                  action={
                    <Button asChild type="button" variant="secondary">
                      <Link to="/" onClick={context.clearSlackLinkContinuation}>
                        Open default workspace
                      </Link>
                    </Button>
                  }
                />
              )}
            </RailShell>
          </RailProvider>
        </OpenGeniProvider>
      );
    }
    // Still wrap OpenGeniProvider: RailShell mounts SessionList, which needs
    // the provider. Without it this path hard-crashes the rail (looks like a
    // "broken server") instead of showing the unavailable panel.
    return (
      <OpenGeniProvider
        client={context.client}
        workspaceId={workspaceId}
        onWorkspaceControlEvent={() => void context.refreshWorkspace(workspaceId)}
      >
        <RailProvider workspaceId={workspaceId}>
          <RailShell>
            <ProblemPanel
              title="Workspace unavailable"
              description="You don't have access to this workspace."
              action={
                <Button asChild type="button" variant="secondary">
                  <Link to="/" onClick={context.clearSlackLinkContinuation}>
                    Open default workspace
                  </Link>
                </Button>
              }
            />
          </RailShell>
        </RailProvider>
      </OpenGeniProvider>
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

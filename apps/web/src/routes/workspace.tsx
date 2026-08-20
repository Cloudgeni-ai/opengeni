// The workspace shell: the Linear-style left rail (brand, org + workspace
// switcher, workspace nav, the session list) plus a slim canvas top strip for
// session-contextual actions around every workspace-scoped route.
import { OpenGeniProvider } from "@opengeni/react";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { LoadingPanel, ProblemPanel } from "@/components/common";
import { RailProvider } from "@/components/rail/rail-context";
import { RailShell } from "@/components/rail/rail-shell";
import { Button } from "@/components/ui/button";
import { WorkspaceTenantBoundary } from "@/components/workspace-tenant-boundary";
import { WorkspaceUnavailableRoute } from "@/routes/workspace-unavailable";
import { useAppContext, type AppContextValue } from "@/context";
import { useGitHubHistoryRefresh } from "@/lib/use-github-history-refresh";
import { isAbortError } from "@/lib/session-tools";
import { authorizedWorkspaceFromList } from "@/lib/workspace-scope-context";
import {
  updateWorkspaceOwnedState,
  workspaceOwnedValue,
  type WorkspaceOwnedState,
} from "@/lib/workspace-owned-state";
import {
  beginWorkspaceOperationUnlessBlocked,
  type WorkspaceOperationIdentity,
} from "@/lib/workspace-transition";
import type { SlackUserLinkAccessRequest } from "@/types";

type SlackAccessState = {
  request: SlackUserLinkAccessRequest | null;
  error: string | null;
  busy: boolean;
};

function emptySlackAccessState(): SlackAccessState {
  return { request: null, error: null, busy: false };
}

export function SlackLinkAccessRequiredDescription({ workspaceName }: { workspaceName: string }) {
  return (
    <>
      You need access to <strong>{workspaceName}</strong> to connect your Slack account.
    </>
  );
}

export function WorkspaceShellRouteContent({
  workspaceId,
  context,
  navigate,
  onAuthorizedShellMount,
}: {
  workspaceId: string;
  context: AppContextValue;
  navigate: ReturnType<typeof useNavigate>;
  onAuthorizedShellMount?: () => void;
}) {
  const activeWorkspace = authorizedWorkspaceFromList({
    workspaceId,
    workspaces: context.workspaces,
    accessContext: context.accessContext,
  });
  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const {
    accessKeyVersion,
    captureWorkspaceInvocation,
    clearSlackLinkContinuation,
    client,
    ownsWorkspaceInvocation,
    preparePendingSlackLink,
    revalidatePrincipalAccess,
    resetWorkspaceIntegrations,
    refreshWorkspace,
    setSelectedRepoIds,
    setSelectedRepoRefs,
    refreshGitHub,
    refreshWorkspaceMcpServers,
  } = context;
  const [ownedSlackAccess, setOwnedSlackAccess] = useState<WorkspaceOwnedState<SlackAccessState>>(
    () => ({ workspaceId, value: emptySlackAccessState() }),
  );
  const slackOperationSequence = useRef(0);
  const activeSlackOperation = useRef<WorkspaceOperationIdentity | null>(null);
  const slackMutationBusy = useRef(false);
  if (activeSlackOperation.current?.transition.workspaceId !== workspaceId) {
    activeSlackOperation.current = null;
  }
  const slackAccess = workspaceOwnedValue(ownedSlackAccess, workspaceId, emptySlackAccessState());
  const slackAccessRequest = slackAccess.request;
  const slackAccessError = slackAccess.error;
  const slackAccessBusy = slackAccess.busy;
  const updateSlackAccess = useCallback(
    (ownedWorkspaceId: string, update: (value: SlackAccessState) => SlackAccessState) => {
      setOwnedSlackAccess((current) =>
        updateWorkspaceOwnedState(current, ownedWorkspaceId, update),
      );
    },
    [],
  );
  const beginSlackOperation = useCallback(
    (options?: { polling?: boolean }): WorkspaceOperationIdentity | null => {
      const accepted = captureWorkspaceInvocation(workspaceId);
      if (!accepted) return null;
      const started = beginWorkspaceOperationUnlessBlocked(
        slackOperationSequence.current,
        accepted,
        options?.polling === true && slackMutationBusy.current,
      );
      if (!started) return null;
      slackOperationSequence.current = started.sequence;
      activeSlackOperation.current = started.operation;
      return started.operation;
    },
    [captureWorkspaceInvocation, workspaceId],
  );
  const ownsSlackOperation = useCallback(
    (operation: WorkspaceOperationIdentity): boolean =>
      activeSlackOperation.current?.id === operation.id &&
      ownsWorkspaceInvocation(workspaceId, operation.transition),
    [ownsWorkspaceInvocation, workspaceId],
  );
  const workspaceStateReady = context.workspaceStateOwnerId === workspaceId;
  useGitHubHistoryRefresh(
    workspaceId,
    activeWorkspaceId !== null && workspaceStateReady,
    refreshGitHub,
  );

  const hasSlackLinkContinuation = context.slackLinkContinuationWorkspaceId === workspaceId;
  const hasNarrowSlackFlow =
    hasSlackLinkContinuation || slackAccessRequest !== null || slackAccessError !== null;

  useEffect(() => {
    activeSlackOperation.current = null;
    slackMutationBusy.current = false;
    setOwnedSlackAccess({ workspaceId, value: emptySlackAccessState() });
  }, [context.accessKeyVersion, workspaceId]);

  const refreshSlackAccess = useCallback(
    async (request: SlackUserLinkAccessRequest, options?: { polling?: boolean }) => {
      const operation = beginSlackOperation(options);
      if (!operation) return null;
      let next: SlackUserLinkAccessRequest;
      try {
        next = await client.getSlackUserLinkAccess(workspaceId, request.id);
      } catch (error) {
        if (ownsSlackOperation(operation)) {
          updateSlackAccess(workspaceId, (current) => ({
            ...current,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
        return null;
      }
      if (!ownsSlackOperation(operation)) return null;
      updateSlackAccess(workspaceId, (current) => ({ ...current, request: next }));
      if (next.status === "completed") {
        toast.success("Slack identity linked", {
          description: "You can return to Slack and invoke OpenGeni again.",
        });
        await refreshWorkspace(workspaceId);
        if (!ownsSlackOperation(operation)) return null;
        clearSlackLinkContinuation();
        revalidatePrincipalAccess();
      }
      return next;
    },
    [
      beginSlackOperation,
      clearSlackLinkContinuation,
      client,
      ownsSlackOperation,
      refreshWorkspace,
      revalidatePrincipalAccess,
      updateSlackAccess,
      workspaceId,
    ],
  );

  useEffect(() => {
    if (!hasSlackLinkContinuation) return;
    let disposed = false;
    const operation = beginSlackOperation();
    if (!operation) return;
    updateSlackAccess(workspaceId, (current) => ({ ...current, error: null }));
    void preparePendingSlackLink(workspaceId)
      .then(async (request) => {
        if (disposed || !request || !ownsSlackOperation(operation)) return;
        updateSlackAccess(workspaceId, (current) => ({ ...current, request }));
        if (request.status === "completed") {
          toast.success("Slack identity linked", {
            description: "You can return to Slack and invoke OpenGeni again.",
          });
          await refreshWorkspace(workspaceId);
          if (disposed || !ownsSlackOperation(operation)) return;
          clearSlackLinkContinuation();
          revalidatePrincipalAccess();
        }
      })
      .catch((error) => {
        if (disposed || !ownsSlackOperation(operation)) return;
        updateSlackAccess(workspaceId, (current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    return () => {
      disposed = true;
      if (activeSlackOperation.current?.id === operation.id) {
        activeSlackOperation.current = null;
      }
    };
  }, [
    beginSlackOperation,
    clearSlackLinkContinuation,
    hasSlackLinkContinuation,
    ownsSlackOperation,
    preparePendingSlackLink,
    refreshWorkspace,
    revalidatePrincipalAccess,
    updateSlackAccess,
    workspaceId,
  ]);

  useEffect(() => {
    if (slackAccessBusy || slackAccessRequest?.status !== "pending") return;
    const interval = window.setInterval(() => {
      void refreshSlackAccess(slackAccessRequest, { polling: true });
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [refreshSlackAccess, slackAccessBusy, slackAccessRequest]);

  async function requestAccess() {
    if (!slackAccessRequest || slackAccessRequest.status !== "prepared") return;
    const operation = beginSlackOperation();
    if (!operation) return;
    slackMutationBusy.current = true;
    updateSlackAccess(workspaceId, (current) => ({ ...current, busy: true }));
    try {
      const request = await client.requestSlackUserLinkWorkspaceAccess(
        workspaceId,
        slackAccessRequest.id,
        {
          expectedVersion: slackAccessRequest.version,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      if (!ownsSlackOperation(operation)) return;
      updateSlackAccess(workspaceId, (current) => ({ ...current, request }));
      toast.success("Access request sent");
    } catch (error) {
      if (ownsSlackOperation(operation)) {
        updateSlackAccess(workspaceId, (current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    } finally {
      if (ownsSlackOperation(operation)) {
        activeSlackOperation.current = null;
        slackMutationBusy.current = false;
        updateSlackAccess(workspaceId, (current) => ({ ...current, busy: false }));
      }
    }
  }

  async function cancelSlackAccess() {
    if (
      !slackAccessRequest ||
      (slackAccessRequest.status !== "prepared" && slackAccessRequest.status !== "pending")
    ) {
      return;
    }
    const operation = beginSlackOperation();
    if (!operation) return;
    slackMutationBusy.current = true;
    updateSlackAccess(workspaceId, (current) => ({ ...current, busy: true }));
    try {
      await client.cancelSlackUserLinkAccess(workspaceId, slackAccessRequest.id, {
        expectedVersion: slackAccessRequest.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!ownsSlackOperation(operation)) return;
      clearSlackLinkContinuation();
      if (!ownsSlackOperation(operation)) return;
      await navigate({ to: "/", replace: true });
    } catch (error) {
      if (ownsSlackOperation(operation)) {
        updateSlackAccess(workspaceId, (current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    } finally {
      if (ownsSlackOperation(operation)) {
        activeSlackOperation.current = null;
        slackMutationBusy.current = false;
        updateSlackAccess(workspaceId, (current) => ({ ...current, busy: false }));
      }
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

  if (!activeWorkspace && !hasNarrowSlackFlow) {
    return (
      <WorkspaceUnavailableRoute
        requestedWorkspaceId={workspaceId}
        workspaces={context.workspaces}
        accessContext={context.accessContext}
        suppressAuthorizedFallback={context.invalidSlackLinkQueryWorkspaceId === workspaceId}
      />
    );
  }

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
    if (hasNarrowSlackFlow) {
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
        <section
          aria-label="Slack workspace access"
          className="flex min-h-full items-center justify-center bg-canvas p-4"
        >
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
        </section>
      );
    }
    return null;
  }

  return (
    <AuthorizedWorkspaceShell
      context={context}
      workspaceId={workspaceId}
      onMount={onAuthorizedShellMount}
    >
      <Outlet />
    </AuthorizedWorkspaceShell>
  );
}

function AuthorizedWorkspaceShell({
  context,
  workspaceId,
  children,
  onMount,
}: {
  context: AppContextValue;
  workspaceId: string;
  children: ReactNode;
  onMount?: () => void;
}) {
  useEffect(() => {
    onMount?.();
  }, [onMount]);
  return (
    <OpenGeniProvider
      client={context.client}
      workspaceId={workspaceId}
      onWorkspaceControlEvent={() => void context.refreshWorkspace(workspaceId)}
    >
      <RailProvider workspaceId={workspaceId}>
        <RailShell>{children}</RailShell>
      </RailProvider>
    </OpenGeniProvider>
  );
}

export function WorkspaceShellRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  return (
    <WorkspaceShellRouteContent workspaceId={workspaceId} context={context} navigate={navigate} />
  );
}

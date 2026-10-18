// The workspace shell: the Linear-style left rail (brand, org + workspace
// switcher, workspace nav, the session list) plus a slim canvas top strip for
// session-contextual actions around every workspace-scoped route.
import { t } from "@opengeni/react/app/lib/console-text";
import { OpenGeniProvider, SecretsUiProvider, useOpenGeni } from "@opengeni/react";
import type { WorkspaceControlEvent } from "@opengeni/sdk";
import { Link, Outlet, useMatches, useNavigate } from "@tanstack/react-router";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { LoadingPanel, ProblemPanel } from "@opengeni/react/app/components/common";
import { RailProvider } from "@opengeni/react/app/components/rail/rail-context";
import { ActionsProvider } from "@opengeni/react/app/lib/actions/actions-provider";
import { DesktopThisComputerProvider } from "@opengeni/react/app/components/desktop/this-computer";
import { ConsoleMeetingRecorderProvider } from "@/components/meetings/recorder-provider";
import { AppShotCoordinator } from "@opengeni/react/app/components/desktop/app-shots";
import { RailShell } from "@/components/rail/rail-shell";
import { webSecretsUi } from "@opengeni/react/app/lib/secrets-ui";
import { workspaceManagementLocation } from "@opengeni/react/app/lib/workspace-management-location";
import { OrganizationWorkspaceAdministrationBoundary } from "@/components/settings/organization-workspace-administration";
import { Button } from "@opengeni/react/ui/button";
import { WorkspaceTenantBoundary } from "@opengeni/react/app/components/workspace-tenant-boundary";
import { WorkspaceUnavailableRoute } from "@/routes/workspace-unavailable";
import { useAppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import { useWorkspaceIntegrations } from "@opengeni/react/app/lib/use-workspace-integrations";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { orgLabel } from "@opengeni/react/app/lib/org";
import { useStreamHealthTelemetry } from "@opengeni/react/app/lib/stream-health";
import { authorizedWorkspaceFromList } from "@opengeni/react/app/lib/workspace-scope-context";
import {
  updateWorkspaceOwnedState,
  workspaceOwnedValue,
  type WorkspaceOwnedState,
} from "@/lib/workspace-owned-state";
import {
  beginWorkspaceOperationUnlessBlocked,
  type WorkspaceOperationIdentity,
} from "@opengeni/react/app/lib/workspace-transition";
import type { SlackUserLinkAccessRequest } from "@opengeni/react/app/types";

const LazyWorkspaceManagementShell = lazy(() =>
  import("@/components/settings/workspace-settings-shell").then((module) => ({
    default: module.WorkspaceManagementShell,
  })),
);
function WorkspaceManagementShell(props: ComponentProps<typeof LazyWorkspaceManagementShell>) {
  return (
    <Suspense fallback={<LoadingPanel label="Loading settings" />}>
      <LazyWorkspaceManagementShell {...props} />
    </Suspense>
  );
}

type SlackAccessState = {
  request: SlackUserLinkAccessRequest | null;
  error: string | null;
  busy: boolean;
};

function useWorkspaceManagementLocation(workspaceId: string) {
  // The URL can advance while Outlet still renders the outgoing matches.
  // Choose its shell from those same matches, or a pending settings navigation
  // removes RailProvider from a session that still needs it.
  return useMatches({
    select: (matches) => {
      const match = matches.at(-1);
      return match
        ? workspaceManagementLocation(
            match.pathname,
            workspaceId,
            "section" in match.search ? match.search.section : undefined,
          )
        : null;
    },
  });
}

export function workspaceControlEventInvalidatesWorkspace(
  event: Pick<WorkspaceControlEvent, "scope">,
): boolean {
  // Session-scoped controls invalidate session projections through the React
  // provider's live event. The workspace projection changes only for the
  // workspace-wide scope, so refetching it for every descendant pause/resume
  // turns orchestrator traffic into an unnecessary database read storm.
  return event.scope === "workspace";
}

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
  managementLocation = null,
}: {
  workspaceId: string;
  context: AppContextValue;
  navigate: ReturnType<typeof useNavigate>;
  onAuthorizedShellMount?: () => void;
  managementLocation?: ReturnType<typeof workspaceManagementLocation>;
}) {
  const activeWorkspace = authorizedWorkspaceFromList({
    workspaceId,
    workspaces: context.workspaces,
    accessContext: context.accessContext,
  });
  const activeWorkspaceId = activeWorkspace?.id ?? null;
  const {
    captureWorkspaceInvocation,
    clearSlackLinkContinuation,
    client,
    ownsWorkspaceInvocation,
    preparePendingSlackLink,
    revalidatePrincipalAccess,
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

  const hasSlackLinkContinuation = context.slackLinkContinuationWorkspaceId === workspaceId;
  const hasNarrowSlackFlow =
    hasSlackLinkContinuation || slackAccessRequest !== null || slackAccessError !== null;

  useEffect(() => {
    activeSlackOperation.current = null;
    slackMutationBusy.current = false;
    setOwnedSlackAccess({ workspaceId, value: emptySlackAccessState() });
  }, [context.accessKeyVersion, workspaceId]);

  const completeSlackAccess = useCallback(
    (operation: WorkspaceOperationIdentity): boolean => {
      if (!ownsSlackOperation(operation)) return false;
      toast.success("Slack identity linked", {
        description: "You can return to Slack and invoke Opengeni again.",
      });
      clearSlackLinkContinuation();
      revalidatePrincipalAccess();
      return true;
    },
    [clearSlackLinkContinuation, ownsSlackOperation, revalidatePrincipalAccess],
  );

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
            error: userErrorText(error),
          }));
        }
        return null;
      }
      if (!ownsSlackOperation(operation)) return null;
      updateSlackAccess(workspaceId, (current) => ({
        ...current,
        request: next,
      }));
      if (next.status === "completed") {
        completeSlackAccess(operation);
      }
      return next;
    },
    [
      beginSlackOperation,
      client,
      completeSlackAccess,
      ownsSlackOperation,
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
      .then((request) => {
        if (disposed || !request || !ownsSlackOperation(operation)) return;
        updateSlackAccess(workspaceId, (current) => ({ ...current, request }));
        if (request.status === "completed") {
          completeSlackAccess(operation);
        }
      })
      .catch((error) => {
        if (disposed || !ownsSlackOperation(operation)) return;
        updateSlackAccess(workspaceId, (current) => ({
          ...current,
          error: userErrorText(error),
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
    completeSlackAccess,
    hasSlackLinkContinuation,
    ownsSlackOperation,
    preparePendingSlackLink,
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
          error: userErrorText(error),
        }));
      }
    } finally {
      if (ownsSlackOperation(operation)) {
        activeSlackOperation.current = null;
        slackMutationBusy.current = false;
        updateSlackAccess(workspaceId, (current) => ({
          ...current,
          busy: false,
        }));
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
          error: userErrorText(error),
        }));
      }
    } finally {
      if (ownsSlackOperation(operation)) {
        activeSlackOperation.current = null;
        slackMutationBusy.current = false;
        updateSlackAccess(workspaceId, (current) => ({
          ...current,
          busy: false,
        }));
      }
    }
  }

  useWorkspaceIntegrations(context, workspaceId, activeWorkspaceId !== null && workspaceStateReady);

  if (!activeWorkspace && !hasNarrowSlackFlow && managementLocation?.kind === "settings") {
    const unavailable = (
      <WorkspaceUnavailableRoute
        requestedWorkspaceId={workspaceId}
        workspaces={context.workspaces}
        accessContext={context.accessContext}
        suppressAuthorizedFallback={context.invalidSlackLinkQueryWorkspaceId === workspaceId}
      />
    );
    return (
      <OrganizationWorkspaceAdministrationBoundary
        client={context.client}
        accessContext={context.accessContext}
        accessKeyVersion={context.accessKeyVersion}
        workspaceId={workspaceId}
        unavailable={unavailable}
      >
        {(administration) => (
          <WorkspaceManagementShell
            workspaceId={workspaceId}
            workspaceName={administration.workspace.name}
            organizationName={administration.overview.organization.name}
            organizationId={administration.organizationId}
            organizationSettingsWorkspaceId={
              context.workspaces.find(
                (candidate) => candidate.accountId === administration.organizationId,
              )?.id
            }
            organizationManagementOnly
            location={managementLocation}
          >
            <Outlet />
          </WorkspaceManagementShell>
        )}
      </OrganizationWorkspaceAdministrationBoundary>
    );
  }

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
                    variant="outline"
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
                <Button asChild type="button" variant="outline">
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
  const managementLocation = useWorkspaceManagementLocation(workspaceId);
  const activeWorkspace =
    context.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const organizationName = activeWorkspace
    ? orgLabel(t, activeWorkspace.accountId, context.accessContext.accountGrants)
    : "Organization";
  useEffect(() => {
    onMount?.();
  }, [onMount]);
  return (
    <OpenGeniProvider
      client={context.client}
      workspaceId={workspaceId}
      // The console's API adapter owns update notices and guarded page reloads.
      onWorkspaceControlEvent={(event) => {
        if (workspaceControlEventInvalidatesWorkspace(event)) {
          void context.refreshWorkspace(workspaceId);
        }
      }}
    >
      <WorkspaceStreamHealth />
      {/* Secret reference chips and the ask card's Generate use the contracts
          tokenizer and generator. */}
      <SecretsUiProvider value={webSecretsUi}>
        <DesktopThisComputerProvider workspaceId={workspaceId}>
          <AppShotCoordinator workspaceId={workspaceId} />
          {/* Settings mode swaps the rail: workspace and organization settings
          share one settings shell that draws the settings rail, and "Back to
          sessions" returns to the main rail. */}
          {/* The rail state and the action system (⌘K, shortcuts, the desktop
          menu bar) span both shells, so keys work in settings too. */}
          {/* A meeting being recorded keeps going while the person moves
          between pages, so the recorder lives above both shells. */}
          <ConsoleMeetingRecorderProvider workspaceId={workspaceId}>
            <RailProvider workspaceId={workspaceId}>
              <ActionsProvider>
                {managementLocation ? (
                  <WorkspaceManagementShell
                    workspaceId={workspaceId}
                    workspaceName={activeWorkspace?.name}
                    organizationName={organizationName}
                    location={managementLocation}
                  >
                    {children}
                  </WorkspaceManagementShell>
                ) : (
                  <RailShell>{children}</RailShell>
                )}
              </ActionsProvider>
            </RailProvider>
          </ConsoleMeetingRecorderProvider>
        </DesktopThisComputerProvider>
      </SecretsUiProvider>
    </OpenGeniProvider>
  );
}

/** Content-free workspace live-stream health; see lib/stream-health.ts. */
function WorkspaceStreamHealth(): null {
  const { workspaceControlConnectionState } = useOpenGeni();
  useStreamHealthTelemetry("workspace", workspaceControlConnectionState);
  return null;
}

export function WorkspaceShellRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const managementLocation = useWorkspaceManagementLocation(workspaceId);
  return (
    <WorkspaceShellRouteContent
      workspaceId={workspaceId}
      context={context}
      navigate={navigate}
      managementLocation={managementLocation}
    />
  );
}

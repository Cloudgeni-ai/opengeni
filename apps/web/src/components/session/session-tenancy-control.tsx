import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import type { Session, SessionEvent, SessionVisibility } from "@opengeni/sdk";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  CircleAlertIcon,
  CopyPlusIcon,
  Loader2Icon,
  LockKeyholeIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Notice } from "@/components/ui/notice";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ProblemPanel } from "@/components/common";
import { useAppContext } from "@/context";
import { isApiErrorStatus } from "@/api";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import { workspaceSessionsPath } from "@/lib/routes";
import { SessionUnavailableRoute } from "@/routes/session-unavailable";
import {
  classifySessionTenancyFailure,
  isCurrentSessionTenancyTarget,
  retryableSessionTenancyReconciliationFailure,
  type SessionTenancyTarget,
} from "@/lib/session-tenancy";
import {
  sessionTenancyOperationController,
  type SessionTenancyOperationController,
  type SessionTenancyOperationScope,
} from "@/lib/session-tenancy-operation-controller";
import {
  runCurrentTransitionInvocation,
  type WorkspaceTransitionIdentity,
} from "@/lib/workspace-transition";

type Confirmation =
  | { kind: "visibility"; visibility: SessionVisibility }
  | { kind: "fork"; visibility: SessionVisibility };

export default function SessionRouteAuxiliary(
  props:
    | { session: Session; events: SessionEvent[]; workspaceId?: never; sessionId?: never }
    | {
        workspaceId: string;
        sessionId: string;
        loadError: unknown;
        session?: never;
        events?: never;
      },
) {
  return props.session ? (
    <SessionTenancyRouteControl session={props.session} events={props.events} />
  ) : !isApiErrorStatus(props.loadError, 404) ? (
    <ProblemPanel
      title="Unable to open session"
      description={
        props.loadError instanceof Error ? props.loadError.message : String(props.loadError)
      }
      action={
        <Button asChild type="button" variant="secondary">
          <a href={workspaceSessionsPath(props.workspaceId)}>Back to sessions</a>
        </Button>
      }
    />
  ) : (
    <SessionUnavailableRoute workspaceId={props.workspaceId} sessionId={props.sessionId} />
  );
}

/** Route adapter kept inside the activation-gated lazy chunk. */
/**
 * A private fork lands in the SOURCE workspace, so it is the same product
 * decision migration 0323 makes for a private create: an organization whose
 * owner has not enabled private sessions gets no private destination in a
 * shared workspace. Migration 0333's fork lifecycle routine fails that closed
 * with SQLSTATE 55000, and this hook keeps the dialog from offering a choice
 * the database will refuse. A personal workspace is exempt, exactly as on the create path,
 * and an unknown answer fails closed rather than offering Private optimistically.
 */
function usePrivateForkCapability(options: {
  client: OpenGeniCoreClient;
  workspaceId: string;
  personalWorkspace: boolean;
  managedSession: boolean;
}): boolean {
  const { client, workspaceId, personalWorkspace, managedSession } = options;
  const [canForkPrivately, setCanForkPrivately] = useState(personalWorkspace);
  useEffect(() => {
    if (personalWorkspace) {
      setCanForkPrivately(true);
      return;
    }
    setCanForkPrivately(false);
    if (!managedSession) return;
    let current = true;
    void client
      .getSessionTenancyCreateCapabilities(workspaceId)
      .then((capabilities) => {
        if (current) setCanForkPrivately(capabilities.canCreatePrivate === true);
      })
      .catch(() => {
        if (current) setCanForkPrivately(false);
      });
    return () => {
      current = false;
    };
  }, [client, managedSession, personalWorkspace, workspaceId]);
  return canForkPrivately;
}

export function SessionTenancyRouteControl({
  session,
  events,
}: {
  session: Session;
  events: SessionEvent[];
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const workspace = context.workspaces.find((candidate) => candidate.id === session.workspaceId);
  const personalWorkspace = isPersonalWorkspace(workspace ?? null, context.managedSelfContext);
  const managedSession =
    context.clientConfig.auth.mode === "managedSession" && context.authSession !== null;
  const canForkPrivately = usePrivateForkCapability({
    client: context.client,
    workspaceId: session.workspaceId,
    personalWorkspace,
    managedSession,
  });
  const transition = context.captureWorkspaceInvocation(session.workspaceId);
  if (!transition) return null;
  const scopeLabel = personalWorkspace
    ? `${workspace?.name ?? "this workspace"} Personal workspace`
    : (workspace?.name ?? "this workspace");

  return (
    <SessionTenancyControl
      key={`${context.accessContext.subjectId}:${transition.revision}:${session.workspaceId}:${session.id}`}
      session={session}
      events={events}
      client={context.client}
      managedSession={managedSession}
      canForkPrivately={canForkPrivately}
      scopeLabel={scopeLabel}
      captureWorkspaceInvocation={context.captureWorkspaceInvocation}
      ownsWorkspaceInvocation={context.ownsWorkspaceInvocation}
      operationController={sessionTenancyOperationController}
      operationScope={{
        principalId: context.accessContext.subjectId,
        workspaceId: session.workspaceId,
        sessionId: session.id,
        workspaceTransitionRevision: transition.revision,
      }}
      onOpenSession={(workspaceId, sessionId) =>
        void navigate({
          to: "/workspaces/$workspaceId/sessions/$sessionId",
          params: { workspaceId, sessionId },
        })
      }
    />
  );
}

export function SessionTenancyControl({
  session,
  events,
  client,
  managedSession,
  canForkPrivately,
  scopeLabel,
  captureWorkspaceInvocation,
  ownsWorkspaceInvocation,
  operationController,
  operationScope,
  onOpenSession,
}: {
  session: Session;
  events?: SessionEvent[] | undefined;
  client: OpenGeniCoreClient;
  managedSession: boolean;
  /** False also covers "not yet known": a private fork is never offered on a
   *  guess, because the database refuses it under the 0323 product decision. */
  canForkPrivately: boolean;
  scopeLabel: string;
  captureWorkspaceInvocation: (workspaceId: string) => WorkspaceTransitionIdentity | null;
  ownsWorkspaceInvocation: (workspaceId: string, accepted: WorkspaceTransitionIdentity) => boolean;
  operationController: SessionTenancyOperationController;
  operationScope: SessionTenancyOperationScope;
  onRefreshSession?: (() => Promise<void>) | undefined;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
}) {
  const target = useMemo<SessionTenancyTarget>(
    () => ({ workspaceId: session.workspaceId, sessionId: session.id }),
    [session.id, session.workspaceId],
  );
  const targetRef = useRef(target);
  targetRef.current = target;
  const mountedRef = useRef(false);
  const operationSequenceRef = useRef(0);
  const visibilityEventSequenceRef = useRef(0);
  const operationSnapshot = operationController.snapshot(operationScope);
  const pendingVisibility = operationSnapshot.visibility;
  const pendingFork = operationSnapshot.fork;
  const [override, setOverride] = useState(session.tenancy);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [, setControllerRevision] = useState(0);
  const accessTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    operationSequenceRef.current += 1;
    setBusy(false);
    setFailure(null);
    setConfirmation(null);
  }, [session.id, session.workspaceId]);

  useEffect(() => {
    if (!session.tenancy) {
      setOverride(undefined);
      return;
    }
    setOverride((current) =>
      !current || session.tenancy!.authorityEpoch >= current.authorityEpoch
        ? session.tenancy
        : current,
    );
  }, [session.tenancy]);

  useEffect(() => {
    if (
      pendingVisibility &&
      (!session.tenancy ||
        session.tenancy.authorityEpoch > pendingVisibility.expectedAuthorityEpoch)
    ) {
      operationController.settleVisibility(operationScope, pendingVisibility);
      setControllerRevision((current) => current + 1);
    }
  }, [operationController, operationScope, pendingVisibility, session.tenancy]);

  const displayedTenancy = override;
  const mayManage = Boolean(displayedTenancy?.ownedByCurrentUser && managedSession);
  const mayFork = Boolean(
    displayedTenancy &&
    managedSession &&
    (displayedTenancy.visibility === "workspace" || displayedTenancy.ownedByCurrentUser),
  );
  const isCurrentInvocation = useCallback(
    (
      acceptedTarget: SessionTenancyTarget,
      acceptedTransition: WorkspaceTransitionIdentity,
      operationSequence: number,
    ) =>
      mountedRef.current &&
      operationSequenceRef.current === operationSequence &&
      isCurrentSessionTenancyTarget(targetRef.current, acceptedTarget) &&
      ownsWorkspaceInvocation(acceptedTarget.workspaceId, acceptedTransition),
    [ownsWorkspaceInvocation],
  );

  const reconcileSource = useCallback(
    async (
      acceptedTarget: SessionTenancyTarget,
      acceptedTransition: WorkspaceTransitionIdentity,
      operationSequence: number,
    ): Promise<Session | null> => {
      const result = await runCurrentTransitionInvocation({
        isCurrent: () => isCurrentInvocation(acceptedTarget, acceptedTransition, operationSequence),
        request: async () =>
          await client.getSession(acceptedTarget.workspaceId, acceptedTarget.sessionId, {
            fresh: true,
          }),
      });
      if (result.status === "stale") return null;
      setOverride(result.value.tenancy);
      return result.value;
    },
    [client, isCurrentInvocation],
  );

  const latestVisibilitySequence = events?.reduce(
    (latest, event) =>
      event.type === "session.visibility.changed" ? Math.max(latest, event.sequence) : latest,
    0,
  );
  useEffect(() => {
    if (
      !latestVisibilitySequence ||
      latestVisibilitySequence <= visibilityEventSequenceRef.current
    ) {
      return;
    }
    visibilityEventSequenceRef.current = latestVisibilitySequence;
    const acceptedTransition = captureWorkspaceInvocation(target.workspaceId);
    if (!acceptedTransition) return;
    let cancelled = false;
    void client
      .getSession(target.workspaceId, target.sessionId, { fresh: true })
      .then((current) => {
        if (
          cancelled ||
          !mountedRef.current ||
          !isCurrentSessionTenancyTarget(targetRef.current, target) ||
          !ownsWorkspaceInvocation(target.workspaceId, acceptedTransition)
        ) {
          return;
        }
        setOverride(current.tenancy);
        const retained = operationController.snapshot(operationScope).visibility;
        if (
          retained &&
          (!current.tenancy || current.tenancy.authorityEpoch > retained.expectedAuthorityEpoch)
        ) {
          operationController.settleVisibility(operationScope, retained);
          setControllerRevision((revision) => revision + 1);
        }
        setAnnouncement(
          !current.tenancy
            ? "Session access controls are no longer available."
            : current.tenancy.visibility === "private"
              ? "Session is private to you."
              : `Session is visible to ${scopeLabel}.`,
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    captureWorkspaceInvocation,
    client,
    latestVisibilitySequence,
    operationController,
    operationScope,
    ownsWorkspaceInvocation,
    scopeLabel,
    target,
  ]);

  const changeVisibility = useCallback(
    async (visibility: SessionVisibility): Promise<boolean> => {
      if (!displayedTenancy || !mayManage || visibility === displayedTenancy.visibility) {
        return true;
      }
      const acceptedTransition = captureWorkspaceInvocation(target.workspaceId);
      if (!acceptedTransition) return true;
      const operationSequence = operationSequenceRef.current + 1;
      operationSequenceRef.current = operationSequence;
      const attempt = operationController.prepareVisibility(
        operationScope,
        { visibility, expectedAuthorityEpoch: displayedTenancy.authorityEpoch },
        () => crypto.randomUUID(),
      );
      setBusy(true);
      setFailure(null);
      let receiptConfirmed = false;

      try {
        const result = await runCurrentTransitionInvocation({
          isCurrent: () => isCurrentInvocation(target, acceptedTransition, operationSequence),
          request: async () =>
            await client.updateSessionVisibility(target.workspaceId, target.sessionId, {
              visibility: attempt.visibility,
              expectedAuthorityEpoch: attempt.expectedAuthorityEpoch,
              idempotencyKey: attempt.idempotencyKey,
            }),
        });
        if (result.status === "stale") return true;
        receiptConfirmed = true;

        if (result.value.replay) {
          const authoritative = await reconcileSource(
            target,
            acceptedTransition,
            operationSequence,
          );
          if (!authoritative) return true;
          operationController.settleVisibility(operationScope, attempt);
          if (authoritative.tenancy) {
            const message =
              authoritative.tenancy.visibility === "private"
                ? "Session is private to you."
                : `Session is visible to ${scopeLabel}.`;
            setAnnouncement(message);
            toast.info("Session access refreshed", { description: message });
          } else {
            const message = "Session access controls are no longer available.";
            setAnnouncement(message);
            toast.info("Session access refreshed", { description: message });
          }
          return true;
        } else {
          setOverride({
            ...displayedTenancy,
            visibility: result.value.visibility,
            authorityEpoch: result.value.authorityEpoch,
          });
        }
        operationController.settleVisibility(operationScope, attempt);
        const message =
          result.value.visibility === "private"
            ? "Session is private to you."
            : `Session is visible to ${scopeLabel}.`;
        setAnnouncement(message);
        toast.success("Session access updated", { description: message });
        return true;
      } catch (error) {
        if (!isCurrentInvocation(target, acceptedTransition, operationSequence)) return true;
        const classified = classifySessionTenancyFailure(error);
        let authoritative: Session | null = null;
        if (classified.reconcile) {
          authoritative = await reconcileSource(
            target,
            acceptedTransition,
            operationSequence,
          ).catch(() => null);
        }
        if (!isCurrentInvocation(target, acceptedTransition, operationSequence)) return true;
        if (
          authoritative &&
          (!authoritative.tenancy ||
            authoritative.tenancy.authorityEpoch > attempt.expectedAuthorityEpoch)
        ) {
          operationController.settleVisibility(operationScope, attempt);
          if (classified.kind === "epoch_conflict") {
            setFailure(classified.message);
            setAnnouncement(classified.message);
            return true;
          }
          const message = !authoritative.tenancy
            ? "Session access controls are no longer available."
            : authoritative.tenancy.visibility === "private"
              ? "Session is private to you."
              : `Session is visible to ${scopeLabel}.`;
          setAnnouncement(message);
          toast.info("Session access refreshed", { description: message });
          return true;
        }
        const retainAttempt =
          classified.retainAttempt ||
          (receiptConfirmed && retryableSessionTenancyReconciliationFailure(error));
        if (!retainAttempt) {
          operationController.settleVisibility(operationScope, attempt);
        }
        setFailure(classified.message);
        setAnnouncement(classified.message);
        return !retainAttempt;
      } finally {
        if (isCurrentInvocation(target, acceptedTransition, operationSequence)) setBusy(false);
      }
    },
    [
      captureWorkspaceInvocation,
      client,
      displayedTenancy,
      isCurrentInvocation,
      mayManage,
      operationController,
      operationScope,
      reconcileSource,
      scopeLabel,
      target,
    ],
  );

  const forkSession = useCallback(
    async (visibility: SessionVisibility): Promise<boolean> => {
      if (!displayedTenancy || !mayFork) return true;
      const acceptedTransition = captureWorkspaceInvocation(target.workspaceId);
      if (!acceptedTransition) return true;
      const operationSequence = operationSequenceRef.current + 1;
      operationSequenceRef.current = operationSequence;
      const workspaceSharedAcknowledged =
        displayedTenancy.visibility === "private" && visibility === "workspace";
      const attempt = operationController.prepareFork(
        operationScope,
        { visibility, workspaceSharedAcknowledged },
        () => crypto.randomUUID(),
      );
      setBusy(true);
      setFailure(null);
      let receiptConfirmed = false;
      try {
        const result = await runCurrentTransitionInvocation({
          isCurrent: () => isCurrentInvocation(target, acceptedTransition, operationSequence),
          request: async () =>
            await client.forkSession(target.workspaceId, target.sessionId, {
              visibility: attempt.visibility,
              workspaceSharedAcknowledged: attempt.workspaceSharedAcknowledged,
              idempotencyKey: attempt.idempotencyKey,
            }),
        });
        if (result.status === "stale") return true;
        receiptConfirmed = true;
        const destination = await runCurrentTransitionInvocation({
          isCurrent: () => isCurrentInvocation(target, acceptedTransition, operationSequence),
          request: async () =>
            await client.getSession(result.value.workspaceId, result.value.sessionId, {
              fresh: true,
            }),
        });
        if (destination.status === "stale") return true;
        if (
          destination.value.workspaceId !== target.workspaceId ||
          destination.value.tenancy?.visibility !== result.value.visibility ||
          !destination.value.tenancy.ownedByCurrentUser
        ) {
          throw new Error("The fork receipt did not resolve to the expected owned session.");
        }
        operationController.settleFork(operationScope, attempt);
        const description =
          result.value.visibility === "private"
            ? "The independent copy is private to you."
            : `The independent copy is visible to ${scopeLabel}.`;
        setAnnouncement(description);
        toast.success(result.value.replay ? "Session fork recovered" : "Session fork created", {
          description,
        });
        onOpenSession(result.value.workspaceId, result.value.sessionId);
        return true;
      } catch (error) {
        if (!isCurrentInvocation(target, acceptedTransition, operationSequence)) return true;
        const classified = classifySessionTenancyFailure(error);
        const retainAttempt =
          classified.retainAttempt ||
          (receiptConfirmed && retryableSessionTenancyReconciliationFailure(error));
        if (!retainAttempt) operationController.settleFork(operationScope, attempt);
        setFailure(classified.message);
        setAnnouncement(classified.message);
        return !retainAttempt;
      } finally {
        if (isCurrentInvocation(target, acceptedTransition, operationSequence)) setBusy(false);
      }
    },
    [
      captureWorkspaceInvocation,
      client,
      displayedTenancy,
      isCurrentInvocation,
      mayFork,
      onOpenSession,
      operationController,
      operationScope,
      scopeLabel,
      target,
    ],
  );

  if (!displayedTenancy) return null;

  const privateSession = displayedTenancy.visibility === "private";
  const alternateVisibility: SessionVisibility = privateSession ? "workspace" : "private";
  const retryingVisibility =
    pendingVisibility?.visibility === alternateVisibility &&
    pendingVisibility.expectedAuthorityEpoch === displayedTenancy.authorityEpoch;
  const visibilityAction = privateSession
    ? "Share this session with workspace…"
    : "Limit this session to me…";
  const visibilityConfirmLabel = retryingVisibility
    ? privateSession
      ? "Retry share with workspace"
      : "Retry limit to me"
    : privateSession
      ? "Share with workspace"
      : "Limit to me";
  const stateLabel = privateSession ? "Private" : "Workspace";
  const stateDescription = privateSession
    ? "Only you can open this session."
    : `Visible to people in ${scopeLabel}.`;
  const retryingFork = pendingFork !== null;
  const stateChip = (
    <span className="inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-full border border-border bg-surface/55 px-2.5 text-xs font-medium text-fg pointer-coarse:min-h-11">
      {privateSession ? (
        <LockKeyholeIcon className="size-3.5 shrink-0 text-brand" aria-hidden="true" />
      ) : (
        <UsersIcon className="size-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
      )}
      <span className="hidden sm:inline">{stateLabel}</span>
      {failure ? <CircleAlertIcon className="size-3.5 text-status-waiting" aria-hidden /> : null}
      {mayFork ? <ChevronDownIcon className="size-3.5 text-fg-muted" aria-hidden /> : null}
    </span>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <section aria-label="Session access" className="flex shrink-0 items-center">
        {mayFork ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={busy}>
              <button
                ref={accessTriggerRef}
                type="button"
                aria-label={
                  mayManage
                    ? `${stateLabel} session access. Manage session access`
                    : `${stateLabel} session access. Session actions`
                }
                aria-busy={busy}
                className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {busy ? (
                  <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-border bg-surface/55 px-2.5 text-xs font-medium pointer-coarse:min-h-11">
                    <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
                    <span className="hidden sm:inline">Updating</span>
                  </span>
                ) : (
                  stateChip
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <div className="px-2 py-1.5">
                <p className="text-sm font-medium">{stateLabel} session</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{stateDescription}</p>
              </div>
              {mayManage ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() =>
                      setConfirmation({ kind: "visibility", visibility: alternateVisibility })
                    }
                  >
                    {privateSession ? <UsersIcon /> : <LockKeyholeIcon />}
                    {retryingVisibility ? `Retry: ${visibilityAction}` : visibilityAction}
                  </DropdownMenuItem>
                </>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() =>
                  setConfirmation({
                    kind: "fork",
                    visibility:
                      pendingFork?.visibility ??
                      (canForkPrivately ? displayedTenancy.visibility : "workspace"),
                  })
                }
              >
                <CopyPlusIcon />
                {retryingFork ? "Retry session fork…" : "Fork session…"}
              </DropdownMenuItem>
              {failure ? (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1.5 text-xs text-status-waiting">
                    <span className="font-medium">Access change needs attention.</span> {failure}
                  </div>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} aria-label={`${stateLabel} session access. ${stateDescription}`}>
                {stateChip}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">{stateDescription}</TooltipContent>
          </Tooltip>
        )}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </span>
      </section>

      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        title={
          confirmation?.kind === "fork"
            ? confirmation.visibility === "workspace"
              ? `Fork a workspace-visible copy?`
              : "Fork a private copy?"
            : confirmation?.visibility === "workspace"
              ? `Share this session with ${scopeLabel}?`
              : "Limit this session to you?"
        }
        description={
          confirmation?.kind === "fork" &&
          displayedTenancy.visibility === "private" &&
          confirmation.visibility === "workspace"
            ? `This private session's complete conversation will be copied into a new session visible to people in ${scopeLabel}. Live credentials, connections, tools, goals, and processes are not copied.`
            : confirmation?.kind === "fork"
              ? confirmation.visibility === "workspace"
                ? `Create an independent copy visible to people in ${scopeLabel}. Live credentials, connections, tools, goals, and processes are not copied.`
                : "Create an independent copy visible only to you. Live credentials, connections, tools, goals, and processes are not copied."
              : confirmation?.visibility === "workspace"
                ? "People who can access this workspace will be able to open the session after all current work has settled."
                : "Only you will be able to open the session. OpenGeni waits for all current work and sandbox access to settle first."
        }
        confirmLabel={
          confirmation?.kind === "fork"
            ? retryingFork
              ? "Retry fork"
              : confirmation.visibility === "workspace"
                ? "Fork for workspace"
                : "Fork privately"
            : visibilityConfirmLabel
        }
        // A fork only widens exposure when a private source is copied into the
        // workspace. Changing an existing session to workspace visibility always
        // does. A shared-to-shared fork exposes nothing new.
        destructive={
          confirmation?.kind === "fork"
            ? displayedTenancy.visibility === "private" && confirmation.visibility === "workspace"
            : confirmation?.visibility === "workspace"
        }
        cancelAutoFocus
        restoreFocusRef={accessTriggerRef}
        onConfirm={() => {
          if (!confirmation) return true;
          return confirmation.kind === "visibility"
            ? changeVisibility(confirmation.visibility)
            : forkSession(confirmation.visibility);
        }}
      >
        {confirmation?.kind === "fork" && !retryingFork ? (
          <div
            className={canForkPrivately ? "grid grid-cols-2 gap-2" : "grid gap-2"}
            role="radiogroup"
            aria-label="Fork visibility"
          >
            {canForkPrivately ? (
              <Button
                type="button"
                variant={confirmation.visibility === "private" ? "default" : "secondary"}
                role="radio"
                aria-checked={confirmation.visibility === "private"}
                onClick={() => setConfirmation({ kind: "fork", visibility: "private" })}
              >
                <LockKeyholeIcon /> Private
              </Button>
            ) : null}
            <Button
              type="button"
              variant={confirmation.visibility === "workspace" ? "default" : "secondary"}
              role="radio"
              aria-checked={confirmation.visibility === "workspace"}
              onClick={() => setConfirmation({ kind: "fork", visibility: "workspace" })}
            >
              <UsersIcon /> Workspace
            </Button>
          </div>
        ) : null}
        {failure ? (
          <Notice tone="waiting" title="Access change needs attention">
            {failure}
          </Notice>
        ) : null}
      </ConfirmDialog>
    </TooltipProvider>
  );
}

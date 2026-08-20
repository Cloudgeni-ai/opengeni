import type { OpenGeniCoreClient } from "@opengeni/sdk/core";
import type { Session, SessionVisibility } from "@opengeni/sdk";
import { useNavigate } from "@tanstack/react-router";
import { CopyPlusIcon, Loader2Icon, LockKeyholeIcon, UsersIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Notice } from "@/components/ui/notice";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import {
  classifySessionTenancyFailure,
  isCurrentSessionTenancyTarget,
  retryableSessionTenancyReconciliationFailure,
  type SessionTenancyTarget,
} from "@/lib/session-tenancy";
import {
  SessionTenancyOperationController,
  type SessionTenancyOperationScope,
} from "@/lib/session-tenancy-operation-controller";
import {
  runCurrentTransitionInvocation,
  type WorkspaceTransitionIdentity,
} from "@/lib/workspace-transition";

type Confirmation = { kind: "visibility"; visibility: SessionVisibility } | { kind: "fork" };

/** Route adapter kept inside the activation-gated lazy chunk. */
export function SessionTenancyRouteControl({
  session,
  onRefreshSession,
}: {
  session: Session;
  onRefreshSession: () => Promise<void>;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const transition = context.captureWorkspaceInvocation(session.workspaceId);
  if (!transition) return null;
  const workspace = context.workspaces.find((candidate) => candidate.id === session.workspaceId);
  const personalWorkspace = isPersonalWorkspace(workspace ?? null, context.managedSelfContext);
  const scopeLabel = personalWorkspace
    ? `${workspace?.name ?? "this workspace"} Personal workspace`
    : (workspace?.name ?? "this workspace");

  return (
    <SessionTenancyControl
      key={`${context.accessContext.subjectId}:${transition.revision}:${session.workspaceId}:${session.id}`}
      session={session}
      client={context.client}
      managedSession={
        context.clientConfig.auth.mode === "managedSession" && context.authSession !== null
      }
      scopeLabel={scopeLabel}
      captureWorkspaceInvocation={context.captureWorkspaceInvocation}
      ownsWorkspaceInvocation={context.ownsWorkspaceInvocation}
      operationController={context.sessionTenancyOperationController}
      operationScope={{
        principalId: context.accessContext.subjectId,
        workspaceId: session.workspaceId,
        sessionId: session.id,
        workspaceTransitionRevision: transition.revision,
      }}
      onRefreshSession={onRefreshSession}
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
  client,
  managedSession,
  scopeLabel,
  captureWorkspaceInvocation,
  ownsWorkspaceInvocation,
  operationController,
  operationScope,
  onRefreshSession,
  onOpenSession,
}: {
  session: Session;
  client: OpenGeniCoreClient;
  managedSession: boolean;
  scopeLabel: string;
  captureWorkspaceInvocation: (workspaceId: string) => WorkspaceTransitionIdentity | null;
  ownsWorkspaceInvocation: (workspaceId: string, accepted: WorkspaceTransitionIdentity) => boolean;
  operationController: SessionTenancyOperationController;
  operationScope: SessionTenancyOperationScope;
  onRefreshSession: () => Promise<void>;
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
  const operationSnapshot = operationController.snapshot(operationScope);
  const pendingVisibility = operationSnapshot.visibility;
  const pendingFork = operationSnapshot.fork;
  const [override, setOverride] = useState(session.tenancy);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [, setControllerRevision] = useState(0);

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
      await onRefreshSession().catch(() => undefined);
      return result.value;
    },
    [client, isCurrentInvocation, onRefreshSession],
  );

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
          await onRefreshSession().catch(() => undefined);
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
      onRefreshSession,
      operationController,
      operationScope,
      reconcileSource,
      scopeLabel,
      target,
    ],
  );

  const createPrivateFork = useCallback(async (): Promise<boolean> => {
    if (!displayedTenancy || !mayManage) return true;
    const acceptedTransition = captureWorkspaceInvocation(target.workspaceId);
    if (!acceptedTransition) return true;
    const operationSequence = operationSequenceRef.current + 1;
    operationSequenceRef.current = operationSequence;
    const attempt = operationController.prepareFork(operationScope, () => crypto.randomUUID());
    setBusy(true);
    setFailure(null);
    let receiptConfirmed = false;

    const invoke = async () =>
      await runCurrentTransitionInvocation({
        isCurrent: () => isCurrentInvocation(target, acceptedTransition, operationSequence),
        request: async () =>
          await client.forkSession(target.workspaceId, target.sessionId, {
            idempotencyKey: attempt.idempotencyKey,
          }),
      });

    try {
      let result;
      try {
        result = await invoke();
      } catch (error) {
        const classified = classifySessionTenancyFailure(error);
        if (classified.kind !== "outcome_unknown") throw error;
        if (!isCurrentInvocation(target, acceptedTransition, operationSequence)) return true;
        // The first request may have committed. Repeating the exact key is the
        // only authoritative reconciliation because the destination id is not
        // knowable from the source session alone.
        result = await invoke();
      }
      if (result.status === "stale") return true;
      const fork = result.value;
      receiptConfirmed = true;
      if (fork.workspaceId !== target.workspaceId) {
        throw new Error("The private fork response did not match this workspace.");
      }
      const destination = await runCurrentTransitionInvocation({
        isCurrent: () => isCurrentInvocation(target, acceptedTransition, operationSequence),
        request: async () =>
          await client.getSession(fork.workspaceId, fork.sessionId, { fresh: true }),
      });
      if (destination.status === "stale") return true;
      if (
        destination.value.workspaceId !== target.workspaceId ||
        destination.value.tenancy?.visibility !== "private" ||
        destination.value.tenancy.ownedByCurrentUser !== true
      ) {
        throw new Error("The fork is no longer an owned private session in this workspace.");
      }
      operationController.settleFork(operationScope, attempt);
      setAnnouncement("Private fork created in this workspace.");
      toast.success("Private fork created");
      onOpenSession(fork.workspaceId, fork.sessionId);
      return true;
    } catch (error) {
      if (!isCurrentInvocation(target, acceptedTransition, operationSequence)) return true;
      const classified = classifySessionTenancyFailure(error);
      if (classified.reconcile && classified.kind !== "outcome_unknown") {
        await reconcileSource(target, acceptedTransition, operationSequence).catch(() => null);
      }
      if (!isCurrentInvocation(target, acceptedTransition, operationSequence)) return true;
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
  }, [
    captureWorkspaceInvocation,
    client,
    displayedTenancy,
    isCurrentInvocation,
    mayManage,
    onOpenSession,
    operationController,
    operationScope,
    reconcileSource,
    target,
  ]);

  if (!displayedTenancy) return null;

  const privateSession = displayedTenancy.visibility === "private";
  const alternateVisibility: SessionVisibility = privateSession ? "workspace" : "private";
  const retryingVisibility =
    pendingVisibility?.visibility === alternateVisibility &&
    pendingVisibility.expectedAuthorityEpoch === displayedTenancy.authorityEpoch;
  const visibilityAction = privateSession ? "Share with workspace" : "Make private";
  const visibilityConfirmLabel = retryingVisibility
    ? `Retry ${visibilityAction.toLowerCase()}`
    : visibilityAction;

  return (
    <>
      <section
        aria-label="Session access"
        className="mx-auto mb-2 flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-lg border border-border bg-surface/55 px-3 py-2 text-sm"
      >
        <span className="inline-flex min-w-0 items-center gap-2 font-medium text-fg">
          {privateSession ? (
            <LockKeyholeIcon className="size-4 shrink-0 text-brand" aria-hidden="true" />
          ) : (
            <UsersIcon className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
          )}
          <span>Access</span>
          <Badge variant="outline">{privateSession ? "Private" : "Workspace"}</Badge>
        </span>
        <span className="min-w-0 flex-1 basis-44 text-xs leading-5 text-fg-muted">
          {privateSession
            ? "Only you can open this session."
            : `Visible to people in ${scopeLabel}.`}
        </span>
        {mayManage ? (
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-9 pointer-coarse:min-h-11"
              disabled={busy}
              onClick={() =>
                setConfirmation({ kind: "visibility", visibility: alternateVisibility })
              }
            >
              {busy && confirmation?.kind === "visibility" ? (
                <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
              ) : null}
              {visibilityAction}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-9 pointer-coarse:min-h-11"
              disabled={busy}
              onClick={() => setConfirmation({ kind: "fork" })}
            >
              {busy && confirmation?.kind === "fork" ? (
                <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <CopyPlusIcon className="size-3.5" />
              )}
              {pendingFork ? "Retry private fork" : "Private fork"}
            </Button>
          </div>
        ) : null}
        {failure ? (
          <Notice className="basis-full" tone="waiting" title="Access change needs attention">
            {failure}
          </Notice>
        ) : null}
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
            ? "Create a private fork?"
            : confirmation?.visibility === "workspace"
              ? `Share this session with ${scopeLabel}?`
              : "Make this session private?"
        }
        description={
          confirmation?.kind === "fork"
            ? "This creates an independent private session in the same workspace. Current work, access grants, connections, and sandbox state stay behind."
            : confirmation?.visibility === "workspace"
              ? "People who can access this workspace will be able to open the session after all current work has settled."
              : "Only you will be able to open the session. OpenGeni waits for all current work and sandbox access to settle first."
        }
        confirmLabel={
          confirmation?.kind === "fork"
            ? pendingFork
              ? "Retry private fork"
              : "Create private fork"
            : visibilityConfirmLabel
        }
        destructive={confirmation?.kind !== "fork" && confirmation?.visibility === "workspace"}
        cancelAutoFocus
        onConfirm={() =>
          confirmation?.kind === "fork"
            ? createPrivateFork()
            : confirmation?.kind === "visibility"
              ? changeVisibility(confirmation.visibility)
              : true
        }
      >
        {failure ? (
          <Notice tone="waiting" title="Access change needs attention">
            {failure}
          </Notice>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

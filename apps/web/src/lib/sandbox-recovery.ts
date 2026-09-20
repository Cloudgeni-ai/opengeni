import type { SandboxRecoveryProjection, SandboxRecoverySelection } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";

export type SandboxRecoveryRequest = {
  operationId: string;
  acceptHistoricalCheckpoint: true;
  selection: SandboxRecoverySelection;
};

export type SandboxRecoveryClient = {
  getSandboxRecovery: (
    workspaceId: string,
    sessionId: string,
  ) => Promise<SandboxRecoveryProjection>;
  recoverSandbox: (
    workspaceId: string,
    sessionId: string,
    request: SandboxRecoveryRequest,
  ) => Promise<{ operationId: string; recovery: SandboxRecoveryProjection }>;
};

export function sameRecoverySelection(
  left: SandboxRecoverySelection | null,
  right: SandboxRecoverySelection | null,
): boolean {
  if (!left || !right) return false;
  return (
    left.version === right.version &&
    left.sessionId === right.sessionId &&
    left.sandboxGroupId === right.sandboxGroupId &&
    left.leaseId === right.leaseId &&
    left.routeEpoch === right.routeEpoch &&
    left.authorityEpoch === right.authorityEpoch &&
    left.leaseEpoch === right.leaseEpoch &&
    left.workspaceGeneration === right.workspaceGeneration &&
    left.archiveGeneration === right.archiveGeneration &&
    left.artifactId === right.artifactId &&
    left.revision === right.revision &&
    left.capturedAt === right.capturedAt
  );
}

export type SandboxRecoveryState = {
  projection: SandboxRecoveryProjection | null;
  reading: boolean;
  submitting: boolean;
  request: SandboxRecoveryRequest | null;
  uncertain: boolean;
  error: string | null;
};

/** Public blocker codes are stable; UI copy must not expose persistence jargon. */
export function sandboxRecoveryBlocker(reason: string): string {
  const messages: Record<string, string> = {
    recovery_not_enabled: "Checkpoint recovery has not been enabled by your operator.",
    managed_modal_home_required: "Recovery supports only this session's managed Modal home.",
    singleton_required: "This sandbox is shared with another session and cannot be recovered here.",
    checkpoint_unavailable: "No recoverable checkpoint is available.",
    registered_current_checkpoint_required:
      "No verified current checkpoint is available for this recovery.",
    checkpoint_metadata_invalid: "Checkpoint details could not be verified.",
    checkpoint_artifact_invalid: "The selected checkpoint could not be verified.",
    historical_checkpoint_not_required:
      "An older checkpoint restore is not required for this sandbox.",
    lease_not_quiescent: "The sandbox has not reached a safe state for recovery.",
    session_not_quiescent: "This session is active or cancelled and cannot accept recovery.",
    execution_unresolved:
      "Execution may still be active. Recovery must wait until its outcome is settled.",
    capture_unresolved: "A checkpoint capture is still unresolved.",
    restore_failed: "Restoration failed. Operator review is required; no commands were replayed.",
    consent_stale:
      "The accepted checkpoint consent is no longer current. Operator review is required.",
    restored_checkpoint_no_longer_ready:
      "The restored sandbox is no longer ready. Operator review is required.",
    session_unavailable: "This session is unavailable.",
  };
  return messages[reason] ?? "Recovery is blocked. Ask your operator to review this session.";
}

/** GETs may repeat; a consented mutation never repeats automatically. */
export function createSandboxRecoveryController(
  client: SandboxRecoveryClient,
  workspaceId: string,
  sessionId: string,
) {
  let state: SandboxRecoveryState = {
    projection: null,
    reading: false,
    submitting: false,
    request: null,
    uncertain: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  let read: Promise<SandboxRecoveryProjection | null> | null = null;
  let revision = 0;
  let confirming = false;
  const update = (patch: Partial<SandboxRecoveryState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  function refresh(): Promise<SandboxRecoveryProjection | null> {
    if (read) return read;
    const startedRevision = revision;
    update({ reading: true });
    read = (async () => {
      try {
        const projection = await client.getSandboxRecovery(workspaceId, sessionId);
        if (revision !== startedRevision) return null;
        const observedRequest = Boolean(
          state.request &&
          projection.operationId === state.request.operationId &&
          ["consent_accepted", "restoring", "restored"].includes(projection.status),
        );
        update({
          projection,
          error: null,
          ...(observedRequest ? { uncertain: false } : {}),
        });
        return projection;
      } catch {
        if (revision === startedRevision) {
          // Never leave an old eligible action live after an unavailable read.
          update({
            projection: null,
            error: "Could not check checkpoint recovery. No new recovery request was sent.",
          });
        }
        return null;
      } finally {
        read = null;
        update({ reading: false });
      }
    })();
    return read;
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    async consent(selection: SandboxRecoverySelection): Promise<boolean> {
      if (confirming || state.request || state.submitting) return false;
      confirming = true;
      try {
        // Consent is bound to what was displayed, not a newer polling result.
        const current = await refresh();
        if (
          current?.status !== "eligible" ||
          selection.sessionId !== sessionId ||
          !sameRecoverySelection(current.checkpoint, selection)
        ) {
          update({
            error:
              "Recovery availability changed. Review the current checkpoint before consenting again.",
          });
          return false;
        }
        const request: SandboxRecoveryRequest = Object.freeze({
          operationId: crypto.randomUUID(),
          acceptHistoricalCheckpoint: true,
          selection: Object.freeze({ ...selection }),
        });
        revision++;
        update({ request, submitting: true, error: null });
        try {
          const response = await client.recoverSandbox(workspaceId, sessionId, request);
          if (response.operationId !== request.operationId)
            throw new Error("Mismatched recovery receipt");
          revision++;
          update({ projection: response.recovery, uncertain: false });
          return true;
        } catch (error) {
          revision++;
          const rejected =
            error instanceof OpenGeniApiError &&
            !error.outcomeUnknown &&
            error.status >= 400 &&
            error.status < 500;
          update({
            projection: null,
            request: rejected ? null : request,
            uncertain: !rejected,
            error: rejected
              ? "Recovery was not accepted. Check availability and review the checkpoint again."
              : "The recovery outcome is not confirmed. Check status; the original consent is retained and no request will be sent again automatically.",
          });
          return false;
        } finally {
          update({ submitting: false });
        }
      } finally {
        confirming = false;
      }
    },
  };
}

/** Typed evidence only: error prose is not a recovery authority. */
export function isStructuralSandboxFailure(payload: Record<string, unknown>): boolean {
  return (
    payload.failureCategory === "archive_recovery" ||
    payload.failureCode === "restore_degraded" ||
    payload.failureCode === "unrecoverable" ||
    payload.code === "restore_degraded" ||
    payload.code === "unrecoverable"
  );
}

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { SandboxRecoverySelection } from "@opengeni/sdk";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  createSandboxRecoveryController,
  sameRecoverySelection,
  sandboxRecoveryBlocker,
  type SandboxRecoveryClient,
} from "@/lib/sandbox-recovery";

export type SandboxRecoveryActionsProps = {
  client: SandboxRecoveryClient;
  workspaceId: string;
  sessionId: string;
  canControl: boolean;
  structuralFailure: boolean;
  retryActions?: ReactNode;
  children?: ReactNode;
};

export function SandboxRecoveryActions(props: SandboxRecoveryActionsProps) {
  const controller = useMemo(
    () => createSandboxRecoveryController(props.client, props.workspaceId, props.sessionId),
    [props.client, props.workspaceId, props.sessionId],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [selection, setSelection] = useState<SandboxRecoverySelection | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    void controller.refresh();
    // A 403 is stable for this viewer; polling it would only repeat the denial.
    const interval = setInterval(() => {
      if (!controller.getSnapshot().notApplicable) void controller.refresh();
    }, 5_000);
    return () => clearInterval(interval);
  }, [controller]);

  // This viewer cannot use checkpoint recovery (not the owning managed-human
  // session, or no session control), so the lane is not a failed check. Keep
  // the ordinary failure remedies, exactly as for an unsupported projection;
  // a retained consent request still owns the UI.
  if (state.notApplicable && !state.request) return props.children;

  const projection = state.projection;
  // Ordinary retry is disclosed only after a current read rules out this lane.
  const recoveryNotRequired =
    projection?.status === "unsupported" ||
    (projection?.status === "blocked" &&
      projection.reason === "historical_checkpoint_not_required");
  if (
    recoveryNotRequired &&
    projection?.reason !== "connected_machine_selected" &&
    !props.structuralFailure &&
    !state.request &&
    !projection?.operationId
  ) {
    return props.children;
  }
  const eligible =
    projection?.status === "eligible" && projection.checkpoint?.sessionId === props.sessionId;
  const changed = Boolean(
    selection && (!eligible || !sameRecoverySelection(selection, projection?.checkpoint ?? null)),
  );
  const pending = projection?.status === "consent_accepted" || projection?.status === "restoring";
  const restored = projection?.status === "restored";
  // Current route/restore truth supersedes the historical failure. These are
  // ordinary explicit Retry controls, not consent-driven continuation; the
  // Retry endpoint still owns exact failure, control and unknown-effect fences.
  const retryAvailable =
    !state.uncertain &&
    !state.submitting &&
    props.canControl &&
    (restored ||
      (projection?.status === "unsupported" && projection.reason === "connected_machine_selected"));
  const canConsent = eligible && props.canControl && !state.request && !state.submitting;

  return (
    <div className="mt-3 text-fg">
      <p className="text-xs text-fg-muted" role="status">
        {state.submitting
          ? "Submitting checkpoint consent… Restoration is not yet confirmed."
          : state.uncertain
            ? "Recovery outcome unconfirmed. Check its current status below."
            : projection?.status === "consent_accepted"
              ? "Checkpoint consent accepted. Restoration has not completed."
              : projection?.status === "restoring"
                ? "Restoring the selected checkpoint. Restoration has not completed."
                : restored
                  ? "Checkpoint restored. No commands were retried or replayed."
                  : eligible
                    ? "An older checkpoint is available for this session. Review what will be restored before continuing."
                    : projection
                      ? "Checkpoint recovery is unavailable for this session."
                      : "Checking checkpoint recovery availability…"}
      </p>
      {projection?.reason ? (
        <p className="mt-1 text-xs text-fg-muted">{sandboxRecoveryBlocker(projection.reason)}</p>
      ) : null}
      {!props.canControl ? (
        <p className="mt-1 text-xs text-fg-muted">
          You do not have permission to recover this sandbox.
        </p>
      ) : null}
      {canConsent ? (
        <Button
          ref={trigger}
          type="button"
          size="sm"
          className="mt-2"
          onClick={() => setSelection(Object.freeze({ ...projection.checkpoint! }))}
        >
          Review checkpoint recovery
        </Button>
      ) : !pending && !restored && !retryAvailable && !state.submitting ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="mt-2"
          disabled={state.reading}
          onClick={() => void controller.refresh()}
        >
          {state.reading ? "Checking…" : "Check recovery status"}
        </Button>
      ) : null}
      {state.error ? (
        <p role="alert" className="mt-2 text-xs">
          {state.error}
        </p>
      ) : null}
      {retryAvailable ? props.retryActions : null}
      <ConfirmDialog
        open={selection !== null}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
        title="Restore this older checkpoint?"
        description="This changes sandbox files in this session, not your conversation."
        confirmLabel="Accept and restore checkpoint"
        pendingLabel="Submitting consent…"
        cancelAutoFocus
        restoreFocusRef={trigger}
        confirmDisabled={!canConsent || changed || state.reading}
        onConfirm={async () => {
          if (!selection || !canConsent || changed) return false;
          const accepted = await controller.consent(selection);
          // An ambiguous response is not success, but its immutable request now
          // owns the UI. Close consent and expose read-only status checks.
          if (controller.getSnapshot().request) setSelection(null);
          return accepted;
        }}
      >
        {selection ? (
          <div className="space-y-2 text-sm">
            <p>
              Checkpoint captured:{" "}
              <time dateTime={selection.capturedAt}>{selection.capturedAt}</time>.
            </p>
            <p>
              Generation gap: {selection.workspaceGeneration - selection.archiveGeneration} (
              {selection.archiveGeneration} → {selection.workspaceGeneration}). This is not a count
              of lost files.
            </p>
            <p>
              Files changed after this checkpoint will be unavailable. Conversation history is
              preserved. External effects are not undone. No commands will be retried or replayed.
            </p>
            {changed ? (
              <p role="alert">
                The checkpoint or recovery availability changed. Close this dialog and review the
                current selection.
              </p>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

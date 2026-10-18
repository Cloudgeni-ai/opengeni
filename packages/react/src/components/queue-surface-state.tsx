import { Loader2Icon, RotateCwIcon } from "lucide-react";

import type { UseTurnQueueResult } from "../hooks/use-turn-queue";
import { useErrorMessage } from "../lib/error-message";
import { useOpenGeniText } from "../messages/runtime";

type QueueStateProps = {
  queue: UseTurnQueueResult;
};

export function EmptyQueueStateSurface({ queue }: QueueStateProps) {
  const hasError = Boolean(queue.error || queue.mutationError);
  return (
    <div
      className="og-root mx-auto mb-2 w-full max-w-3xl shrink-0 px-4 sm:px-6"
      data-testid="queue-surface"
    >
      <div className="overflow-hidden rounded-lg border border-border bg-surface/80 shadow-sm">
        {queue.pendingSteer && !queue.stoppingPreviousAttempt ? (
          <QueuePendingSteerStatus queue={queue} dividerAfter={hasError} />
        ) : null}
        {queue.stoppingPreviousAttempt ? (
          <QueueStoppingStatus queue={queue} dividerAfter={hasError} />
        ) : null}
        {hasError ? <QueueErrorAlert queue={queue} /> : null}
      </div>
    </div>
  );
}

/**
 * A Steer the agent reads after its current step. Nothing is cut off while it
 * waits; "Send now" interrupts the step for people who cannot wait.
 */
export function QueuePendingSteerStatus({
  queue,
  dividerAfter = false,
}: QueueStateProps & { dividerAfter?: boolean }) {
  const t = useOpenGeniText();
  const pending = queue.pendingSteer;
  if (!pending) return null;
  const sending = queue.mutationFor(pending.turnId) === "steer";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex min-h-11 items-center gap-2.5 px-3 py-1.5 text-og-control text-fg ${
        dividerAfter ? "border-b border-border" : ""
      }`}
      data-testid="pending-steer"
    >
      <Loader2Icon
        aria-hidden="true"
        className="size-3.5 shrink-0 animate-spin text-fg-muted motion-reduce:animate-none"
      />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{t("queueSurfaceState.steerReadAfterStep")}</span>{" "}
        <span className="text-fg-muted">{t("queueSurfaceState.steerNothingCutOff")}</span>
      </span>
      {queue.steerNow ? (
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-og-control font-medium text-fg-muted outline-hidden transition-colors hover:bg-surface-2 hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60 pointer-coarse:h-11"
          aria-label={t("queueSurfaceState.steerNowAriaLabel")}
          title={t("queueSurfaceState.steerNowAriaLabel")}
          disabled={sending}
          onClick={() => void queue.steerNow?.()}
        >
          {sending ? t("queueSurfaceState.steerNowSending") : t("queueSurfaceState.steerNow")}
        </button>
      ) : null}
    </div>
  );
}

export function QueueStoppingStatus({
  queue,
  dividerAfter = false,
}: QueueStateProps & { dividerAfter?: boolean }) {
  const t = useOpenGeniText();
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex min-h-11 items-center gap-2.5 bg-status-waiting/[0.07] px-3 py-2 text-og-control text-fg ${
        dividerAfter ? "border-b border-status-waiting/20" : ""
      }`}
      data-testid="stopping-previous-attempt"
    >
      <Loader2Icon
        aria-hidden="true"
        className="size-3.5 shrink-0 animate-spin text-status-waiting motion-reduce:animate-none"
      />
      <span className="min-w-0">
        <span className="font-medium">
          {queue.effectiveControl?.state === "paused"
            ? t("queueSurfaceState.stoppingCurrentAttempt")
            : t("queueSurfaceState.stoppingPreviousAttempt")}
        </span>{" "}
        <span className="text-fg-muted">
          {queue.effectiveControl?.state === "paused"
            ? t("queueSurfaceState.queuedWorkStaysSavedUntil")
            : t("queueSurfaceState.queuedWorkIsSavedAnd")}
        </span>
      </span>
    </div>
  );
}

export function QueueErrorAlert({
  queue,
  dividerBefore = false,
}: QueueStateProps & { dividerBefore?: boolean }) {
  const t = useOpenGeniText();
  const formatError = useErrorMessage();
  return (
    <div className={`${dividerBefore ? "border-t border-border" : ""} p-2`}>
      <div
        role="alert"
        className="flex min-w-0 max-w-full flex-wrap items-start gap-2 rounded-md bg-status-failed/10 px-2 py-1.5 text-og-control text-status-failed"
      >
        <span
          role="region"
          aria-label={t("queueSurfaceState.queueErrorDetails")}
          tabIndex={0}
          className="max-h-[min(5rem,20dvh)] min-w-0 max-w-full flex-[1_1_5rem] overflow-auto overscroll-contain whitespace-pre-wrap rounded-sm outline-hidden [overflow-wrap:anywhere] [unicode-bidi:plaintext] focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="queue-error-message"
          dir="auto"
        >
          {formatError(queue.mutationError ?? queue.error)}
        </span>
        <button
          type="button"
          onClick={() => {
            queue.clearMutationError();
            void queue.refresh();
          }}
          aria-label={t("queueSurfaceState.dismissQueueErrorAndRetry")}
          title={t("queueSurfaceState.retryLoadingTheQueue")}
          className="ms-auto inline-flex size-7 shrink-0 items-center justify-center self-start rounded-md outline-hidden transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none pointer-coarse:size-[44px]"
        >
          <RotateCwIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

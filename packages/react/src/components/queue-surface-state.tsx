import { Loader2Icon, RotateCwIcon } from "lucide-react";

import type { UseTurnQueueResult } from "../hooks/use-turn-queue";

type QueueStateProps = {
  queue: UseTurnQueueResult;
};

export function EmptyQueueStateSurface({ queue }: QueueStateProps) {
  const hasError = Boolean(queue.error || queue.mutationError);
  return (
    <div
      className="mx-auto mb-2 w-full max-w-3xl shrink-0 px-4 sm:px-6"
      data-testid="queue-surface"
    >
      <div className="overflow-hidden rounded-lg border border-border bg-surface/80 shadow-sm">
        {queue.stoppingPreviousAttempt ? (
          <QueueStoppingStatus queue={queue} dividerAfter={hasError} />
        ) : null}
        {hasError ? <QueueErrorAlert queue={queue} /> : null}
      </div>
    </div>
  );
}

export function QueueStoppingStatus({
  queue,
  dividerAfter = false,
}: QueueStateProps & { dividerAfter?: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex min-h-11 items-center gap-2.5 bg-status-waiting/[0.07] px-3 py-2 text-xs text-fg ${
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
            ? "Stopping current attempt…"
            : "Stopping previous attempt…"}
        </span>{" "}
        <span className="text-fg-muted">
          {queue.effectiveControl?.state === "paused"
            ? "Queued work stays saved until you resume."
            : "Queued work is saved and starts automatically."}
        </span>
      </span>
    </div>
  );
}

export function QueueErrorAlert({
  queue,
  dividerBefore = false,
}: QueueStateProps & { dividerBefore?: boolean }) {
  return (
    <div className={`${dividerBefore ? "border-t border-border" : ""} p-2`}>
      <div
        role="alert"
        className="flex min-w-0 max-w-full flex-wrap items-start gap-2 rounded-md bg-status-failed/10 px-2 py-1.5 text-xs text-status-failed"
      >
        <span
          role="region"
          aria-label="Queue error details"
          tabIndex={0}
          className="max-h-[min(5rem,20dvh)] min-w-0 max-w-full flex-[1_1_5rem] overflow-auto overscroll-contain whitespace-pre-wrap rounded-sm outline-none [overflow-wrap:anywhere] [unicode-bidi:plaintext] focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="queue-error-message"
          dir="auto"
        >
          {(queue.mutationError ?? queue.error)?.message}
        </span>
        <button
          type="button"
          onClick={() => {
            queue.clearMutationError();
            void queue.refresh();
          }}
          aria-label="Dismiss queue error and retry"
          title="Retry loading the queue"
          className="ms-auto inline-flex size-7 shrink-0 items-center justify-center self-start rounded-md outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none pointer-coarse:size-[44px]"
        >
          <RotateCwIcon className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

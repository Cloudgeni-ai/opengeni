import { Loader2Icon } from "lucide-react";
import { lazy, Suspense } from "react";

import type { QueueSurfaceProps } from "./queue-surface-implementation";

export type { QueueSurfaceProps } from "./queue-surface-implementation";

const loadQueueSurface = () => import("./queue-surface-implementation");
const LazyQueueSurface = lazy(async () => ({
  default: (await loadQueueSurface()).QueueSurface,
}));

/** The sole human prompt queue: compact above Goal, Agents, and composer. */
export function QueueSurface(props: QueueSurfaceProps) {
  const { queue } = props;
  if (
    queue.queue.length === 0 &&
    !queue.stoppingPreviousAttempt &&
    !queue.error &&
    !queue.mutationError
  ) {
    return null;
  }

  return (
    <Suspense fallback={<QueueSurfaceFallback count={queue.queue.length} />}>
      <LazyQueueSurface {...props} />
    </Suspense>
  );
}

function QueueSurfaceFallback({ count }: { count: number }) {
  return (
    <div
      aria-live="polite"
      className="mx-auto mb-2 w-full max-w-3xl shrink-0 px-4 sm:px-6"
      data-testid="queue-surface-loading"
      role="status"
    >
      <div className="overflow-hidden rounded-lg border border-border bg-surface/80 shadow-sm">
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-fg-muted pointer-coarse:min-h-[44px]">
          <Loader2Icon
            aria-hidden="true"
            className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          />
          Loading {count} queued prompt{count === 1 ? "" : "s"}…
        </div>
      </div>
    </div>
  );
}

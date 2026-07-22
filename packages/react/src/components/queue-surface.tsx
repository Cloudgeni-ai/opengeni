import { Loader2Icon } from "lucide-react";
import { lazy, Suspense, type ComponentType } from "react";

import type { QueueSurfaceProps } from "./queue-surface-implementation";
import { EmptyQueueStateSurface } from "./queue-surface-state";

export type { QueueSurfaceProps } from "./queue-surface-implementation";
export { requestQueueDraftEdit } from "./queue-surface-implementation";

const loadQueueSurface = () => import("./queue-surface-implementation");
type QueueSurfaceModule = { QueueSurface: ComponentType<QueueSurfaceProps> };
type QueueSurfaceLoader = () => Promise<QueueSurfaceModule>;

/** The sole human prompt queue: compact above Goal, Agents, and composer. */
export const QueueSurface = createQueueSurface(loadQueueSurface);

/** @internal Deterministic Suspense seam for the QueueSurface regression suite. */
export function createQueueSurfaceForTest(loadImplementation: QueueSurfaceLoader) {
  return createQueueSurface(loadImplementation);
}

function createQueueSurface(loadImplementation: QueueSurfaceLoader) {
  const LazyQueueSurface = lazy(async () => ({
    default: (await loadImplementation()).QueueSurface,
  }));

  return function QueueSurfaceBoundary(props: QueueSurfaceProps) {
    const { queue } = props;
    if (queue.queue.length === 0) {
      if (!queue.stoppingPreviousAttempt && !queue.error && !queue.mutationError) return null;
      return <EmptyQueueStateSurface queue={queue} />;
    }

    return (
      <Suspense fallback={<QueueSurfaceFallback count={queue.queue.length} />}>
        <LazyQueueSurface {...props} />
      </Suspense>
    );
  };
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

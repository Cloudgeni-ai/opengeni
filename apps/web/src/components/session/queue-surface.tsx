import type { UseTurnQueueResult } from "@opengeni/react";
import { ChevronDownIcon, Loader2Icon, RotateCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

/** The only queue surface: compact above the composer, expandable in place. */
export function QueueSurface({ queue }: { queue: UseTurnQueueResult }) {
  const [open, setOpen] = useState(false);
  const count = queue.queue.length;
  if (count === 0 && !queue.error && !queue.mutationError) return null;

  return (
    <div
      className="mx-auto mb-2 w-full max-w-3xl shrink-0 px-4 sm:px-6"
      data-testid="queue-surface"
    >
      <div className="overflow-hidden rounded-lg border border-border bg-surface/80 shadow-sm">
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left outline-none transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 pointer-coarse:min-h-11"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <ChevronDownIcon
            className={`size-3.5 shrink-0 text-fg-subtle transition-transform ${open ? "rotate-180" : ""}`}
          />
          <span className="text-xs font-medium text-fg">
            {count} queued prompt{count === 1 ? "" : "s"}
          </span>
          {!open && count > 0 ? (
            <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">
              {queue.queue[0]?.prompt}
            </span>
          ) : null}
          {queue.loading ? <Loader2Icon className="ml-auto size-3.5 animate-spin" /> : null}
        </button>

        {open && count > 0 ? (
          <ol className="divide-y divide-border border-t border-border" aria-label="Queued prompts">
            {queue.queue.map((turn, index) => (
              <li key={turn.id} className="flex min-w-0 items-start gap-2 px-3 py-2">
                <span className="mt-0.5 shrink-0 font-mono text-2xs text-fg-subtle">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap text-xs leading-5 text-fg">
                  {turn.prompt}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={queue.mutating}
                  onClick={() => void queue.removeTurn(turn.id)}
                  aria-label={`Delete queued prompt ${index + 1}`}
                  title="Delete this queued prompt"
                  className="shrink-0 hover:text-status-failed pointer-coarse:size-11"
                >
                  {queue.mutating ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2Icon className="size-3.5" />
                  )}
                </Button>
              </li>
            ))}
          </ol>
        ) : null}

        {queue.error || queue.mutationError ? (
          <div className="border-t border-border p-2">
            <Notice
              tone="failed"
              action={
                <button
                  type="button"
                  onClick={() => {
                    queue.clearMutationError();
                    void queue.refresh();
                  }}
                  aria-label="Dismiss queue error and retry"
                  title="Retry loading the queue"
                  className="inline-flex size-7 items-center justify-center rounded-md outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:size-11"
                >
                  <RotateCwIcon className="size-3.5" />
                </button>
              }
            >
              {(queue.mutationError ?? queue.error)?.message}
            </Notice>
          </div>
        ) : null}
      </div>
    </div>
  );
}

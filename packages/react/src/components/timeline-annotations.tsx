import type {
  DraftTimelineAnnotation,
  TimelineAnnotation,
  TimelineAnnotationSource,
} from "@opengeni/sdk";
import { Suspense, lazy, useRef, useState } from "react";
import { cn } from "../lib/cn";

export type TimelineAnnotationLike = DraftTimelineAnnotation | TimelineAnnotation;

const TimelineAnnotationsDialog = lazy(() => import("./timeline-annotations-dialog"));

export function TimelineAnnotationsChip({
  annotations,
  editable = false,
  focusAnnotationId,
  onFocusConsumed,
  onUpdate,
  onRemove,
  onRevealSource,
  className,
}: {
  annotations: readonly TimelineAnnotationLike[];
  editable?: boolean | undefined;
  focusAnnotationId?: string | null | undefined;
  onFocusConsumed?: (() => void) | undefined;
  onUpdate?: ((id: string, note: string) => void) | undefined;
  onRemove?: ((id: string) => void) | undefined;
  onRevealSource?: ((source: TimelineAnnotationSource) => boolean) | undefined;
  className?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  if (annotations.length === 0) return null;
  const focusRequested = Boolean(
    focusAnnotationId && annotations.some((item) => item.id === focusAnnotationId),
  );
  const visible = open || focusRequested;
  const countLabel = `${annotations.length} ${annotations.length === 1 ? "annotation" : "annotations"}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          "inline-flex min-h-8 items-center gap-1.5 rounded-full border border-og-border bg-og-surface-1 px-2.5 py-1 text-og-sm font-medium text-og-fg-muted outline-hidden transition hover:bg-og-surface-2 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-[44px]",
          className,
        )}
        aria-label={`Review ${countLabel}`}
        aria-haspopup="dialog"
        aria-expanded={visible}
        onClick={() => setOpen((current) => !current)}
      >
        {countLabel}
      </button>
      {visible ? (
        <Suspense fallback={null}>
          <TimelineAnnotationsDialog
            annotations={annotations}
            editable={editable}
            focusAnnotationId={focusAnnotationId}
            onFocusConsumed={() => {
              setOpen(true);
              onFocusConsumed?.();
            }}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onRevealSource={onRevealSource}
            triggerRef={triggerRef}
            countLabel={countLabel}
            onDismiss={(restoreFocus) => {
              setOpen(false);
              if (restoreFocus) triggerRef.current?.focus();
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}

export default TimelineAnnotationsChip;

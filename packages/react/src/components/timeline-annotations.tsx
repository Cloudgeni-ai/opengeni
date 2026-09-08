import type { TimelineAnnotationSource } from "@opengeni/sdk";
import { QuoteIcon, XIcon } from "lucide-react";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import {
  AnnotationAccentRow,
  AnnotationNotePreview,
  AnnotationQuoteSourceButton,
  type TimelineAnnotationLike,
} from "./timeline-annotation-chrome";
import { ANNOTATION_CARD_STACK_SCROLL_AT } from "./timeline-annotation-layout";
import {
  annotationDisplayOrdinal,
  annotationHasNote,
} from "./timeline-annotation-shared";

export type { TimelineAnnotationLike } from "./timeline-annotation-chrome";

const TimelineAnnotationsDialog = lazy(() => import("./timeline-annotations-dialog"));

export function TimelineAnnotationCards({
  annotations,
  onRevealSource,
  className,
}: {
  annotations: readonly TimelineAnnotationLike[];
  onRevealSource?: ((source: TimelineAnnotationSource) => boolean) | undefined;
  className?: string | undefined;
}) {
  const [unavailableId, setUnavailableId] = useState<string | null>(null);
  if (annotations.length === 0) return null;
  return (
    <div
      data-og-annotation-cards=""
      className={cn(
        "grid gap-2",
        annotations.length >= ANNOTATION_CARD_STACK_SCROLL_AT &&
          "max-h-[min(28rem,55vh)] overflow-y-auto overscroll-contain pr-1",
        className,
      )}
    >
      {annotations.map((annotation, index) => {
        const ordinal = annotationDisplayOrdinal(annotation, index);
        return (
          <section key={annotation.id} aria-label={`Annotation ${ordinal}`}>
            <AnnotationAccentRow>
              <p className="mb-0.5 text-og-xs font-medium tabular-nums text-og-fg-subtle">
                Annotation {ordinal}
              </p>
              <AnnotationQuoteSourceButton
                annotation={annotation}
                lines={2}
                onRevealSource={onRevealSource}
                onUnavailable={setUnavailableId}
              />
              {unavailableId === annotation.id ? (
                <p role="status" className="text-og-xs text-og-status-waiting">
                  Source is outside the loaded timeline window.
                </p>
              ) : null}
              <AnnotationNotePreview
                note={annotation.note}
                annotationId={annotation.id}
                ordinal={ordinal}
              />
            </AnnotationAccentRow>
          </section>
        );
      })}
    </div>
  );
}

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
  const focusRequested = Boolean(
    focusAnnotationId && annotations.some((item) => item.id === focusAnnotationId),
  );
  const [open, setOpen] = useState(focusRequested);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const openedFocusId = useRef<string | null>(focusRequested ? (focusAnnotationId ?? null) : null);

  useEffect(() => {
    if (!focusRequested || !focusAnnotationId) {
      if (!focusRequested) openedFocusId.current = null;
      return;
    }
    if (openedFocusId.current === focusAnnotationId) return;
    openedFocusId.current = focusAnnotationId;
    setOpen(true);
  }, [focusAnnotationId, focusRequested]);

  if (annotations.length === 0) return null;
  const countLabel = `${annotations.length} ${annotations.length === 1 ? "annotation" : "annotations"}`;
  const incomplete = annotations.some((annotation) => !annotationHasNote(annotation.note));
  const canClear = Boolean(editable && onRemove);

  const dismiss = (restoreFocus: boolean) => {
    setOpen(false);
    onFocusConsumed?.();
    if (restoreFocus) triggerRef.current?.focus();
  };

  return (
    <span className={cn("inline-flex max-w-full items-center", className)}>
      <span
        className={cn(
          "inline-flex max-w-full items-center rounded-full border bg-og-surface-1 text-og-fg-muted",
          incomplete ? "border-og-accent/45 bg-og-accent-soft/50" : "border-og-border",
        )}
      >
        <button
          ref={triggerRef}
          type="button"
          className={cn(
            "inline-flex min-h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full border-0 bg-transparent py-1 text-og-sm font-medium outline-hidden transition hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-[44px]",
            canClear ? "pr-1 pl-2.5" : "px-2.5",
          )}
          aria-label={`Review ${countLabel}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <QuoteIcon className="size-3.5 shrink-0 text-og-accent" aria-hidden="true" />
          <span className="min-w-0 truncate">{countLabel}</span>
        </button>
        {canClear ? (
          <button
            type="button"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-og-fg-subtle outline-hidden hover:text-og-status-failed focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:size-11"
            aria-label="Remove all annotations"
            onClick={() => {
              for (const annotation of annotations) onRemove?.(annotation.id);
            }}
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </span>
      {open ? (
        <Suspense fallback={null}>
          <TimelineAnnotationsDialog
            annotations={annotations}
            editable={editable}
            focusAnnotationId={focusAnnotationId}
            onFocusConsumed={onFocusConsumed}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onRevealSource={onRevealSource}
            triggerRef={triggerRef}
            countLabel={countLabel}
            onDismiss={dismiss}
          />
        </Suspense>
      ) : null}
    </span>
  );
}

export default TimelineAnnotationsChip;

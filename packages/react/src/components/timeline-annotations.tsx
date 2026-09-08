import type { TimelineAnnotationSource } from "@opengeni/sdk";
import { QuoteIcon, XIcon } from "lucide-react";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import {
  AnnotationAccentRow,
  AnnotationQuoteSourceButton,
  type TimelineAnnotationLike,
} from "./timeline-annotation-chrome";
import {
  annotationDisplayOrdinal,
  annotationHasNote,
  truncateAnnotationQuote,
} from "./timeline-annotation-shared";

export type { TimelineAnnotationLike } from "./timeline-annotation-chrome";

const TimelineAnnotationsDialog = lazy(() => import("./timeline-annotations-dialog"));

const PILL_QUOTE_CHARS = 40;

export function TimelineAnnotationDraftList({
  annotations,
  focusAnnotationId,
  onFocusConsumed,
  onUpdate,
  onRemove,
  onRevealSource,
  className,
}: {
  annotations: readonly TimelineAnnotationLike[];
  focusAnnotationId?: string | null | undefined;
  onFocusConsumed?: (() => void) | undefined;
  onUpdate: (id: string, note: string) => void;
  onRemove: (id: string) => void;
  onRevealSource?: ((source: TimelineAnnotationSource) => boolean) | undefined;
  className?: string | undefined;
}) {
  const focusRequested = Boolean(
    focusAnnotationId && annotations.some((item) => item.id === focusAnnotationId),
  );
  const [openId, setOpenId] = useState<string | null>(
    focusRequested ? (focusAnnotationId ?? null) : null,
  );
  const pillRefs = useRef(new Map<string, HTMLButtonElement>());
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const openedFocusId = useRef<string | null>(focusRequested ? (focusAnnotationId ?? null) : null);

  useEffect(() => {
    if (!focusRequested || !focusAnnotationId) {
      if (!focusRequested) openedFocusId.current = null;
      return;
    }
    if (openedFocusId.current === focusAnnotationId) return;
    openedFocusId.current = focusAnnotationId;
    setOpenId(focusAnnotationId);
  }, [focusAnnotationId, focusRequested]);

  useEffect(() => {
    if (openId && !annotations.some((item) => item.id === openId)) setOpenId(null);
  }, [annotations, openId]);

  if (annotations.length === 0) return null;

  const openIndex = annotations.findIndex((item) => item.id === openId);
  const openAnnotation = openIndex >= 0 ? annotations[openIndex]! : null;
  const openOrdinal = openAnnotation ? annotationDisplayOrdinal(openAnnotation, openIndex) : 0;

  const dismiss = (restoreFocus: boolean) => {
    const id = openId;
    setOpenId(null);
    onFocusConsumed?.();
    if (restoreFocus && id) pillRefs.current.get(id)?.focus();
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {annotations.map((annotation, index) => {
        const ordinal = annotationDisplayOrdinal(annotation, index);
        const incomplete = !annotationHasNote(annotation.note);
        const open = openId === annotation.id;
        const quoteLabel = truncateAnnotationQuote(annotation.quote, PILL_QUOTE_CHARS);
        return (
          <span
            key={annotation.id}
            className={cn(
              "inline-flex max-w-full items-center rounded-full border bg-og-surface-1 text-og-fg-muted",
              incomplete ? "border-og-accent/45 bg-og-accent-soft/50" : "border-og-border",
            )}
          >
            <button
              ref={(node) => {
                if (node) pillRefs.current.set(annotation.id, node);
                else pillRefs.current.delete(annotation.id);
                if (open) triggerRef.current = node;
              }}
              type="button"
              className="inline-flex min-h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full border-0 bg-transparent py-1 pr-1 pl-2.5 text-og-sm font-medium outline-hidden transition hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-[44px]"
              aria-label={
                incomplete
                  ? `Annotation ${ordinal}, needs a note: ${quoteLabel}`
                  : `Annotation ${ordinal}: ${quoteLabel}`
              }
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : annotation.id)}
            >
              <span
                aria-hidden="true"
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-og-accent/15 text-[10px] font-semibold tabular-nums text-og-accent"
              >
                {ordinal}
              </span>
              <span className="min-w-0 truncate">{quoteLabel}</span>
            </button>
            <button
              type="button"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-og-fg-subtle outline-hidden hover:text-og-status-failed focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:size-11"
              aria-label={`Remove annotation ${ordinal}`}
              onClick={() => onRemove(annotation.id)}
            >
              <XIcon className="size-3.5" aria-hidden="true" />
            </button>
          </span>
        );
      })}
      {openAnnotation ? (
        <Suspense fallback={null}>
          <TimelineAnnotationsDialog
            annotations={[openAnnotation]}
            editable
            focusAnnotationId={openAnnotation.id}
            onFocusConsumed={onFocusConsumed}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onRevealSource={onRevealSource}
            triggerRef={triggerRef}
            countLabel={`Annotation ${openOrdinal}`}
            onDismiss={dismiss}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

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
    <div className={cn("grid gap-2", className)}>
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
              {annotation.note ? (
                <p className="mt-0.5 whitespace-pre-wrap text-og-sm leading-5 text-og-fg">
                  {annotation.note}
                </p>
              ) : null}
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

  const dismiss = (restoreFocus: boolean) => {
    setOpen(false);
    onFocusConsumed?.();
    if (restoreFocus) triggerRef.current?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          "inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border border-og-border bg-og-surface-1 px-2.5 py-1 text-og-sm font-medium text-og-fg-muted outline-hidden transition hover:bg-og-surface-2 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-[44px]",
          className,
        )}
        aria-label={`Review ${countLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <QuoteIcon className="size-3.5 shrink-0 text-og-accent" aria-hidden="true" />
        <span className="min-w-0 truncate">{countLabel}</span>
      </button>
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
    </>
  );
}

export default TimelineAnnotationsChip;

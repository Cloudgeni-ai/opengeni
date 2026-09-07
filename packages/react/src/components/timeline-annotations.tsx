import type {
  DraftTimelineAnnotation,
  TimelineAnnotation,
  TimelineAnnotationSource,
} from "@opengeni/sdk";
import { QuoteIcon, XIcon } from "lucide-react";
import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import {
  annotationHasNote,
  annotationSourceLabel,
  revealLoadedAnnotationSource,
} from "./timeline-annotation-shared";

export type TimelineAnnotationLike = DraftTimelineAnnotation | TimelineAnnotation;

const TimelineAnnotationsDialog = lazy(() => import("./timeline-annotations-dialog"));

function AnnotationQuote({ quote }: { quote: string }) {
  return (
    <blockquote className="max-h-28 overflow-auto whitespace-pre-wrap border-l-2 border-og-accent/50 pl-2.5 text-og-sm leading-5 text-og-fg-muted">
      {quote}
    </blockquote>
  );
}

function SourceAction({
  annotation,
  onRevealSource,
  onUnavailable,
}: {
  annotation: TimelineAnnotationLike;
  onRevealSource?: ((source: TimelineAnnotationSource) => boolean) | undefined;
  onUnavailable: (id: string | null) => void;
}) {
  return (
    <button
      type="button"
      className="truncate rounded border-0 bg-transparent text-left text-og-xs font-medium text-og-fg-muted underline-offset-2 outline-hidden hover:text-og-fg hover:underline focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-[44px]"
      onClick={() => {
        const revealed =
          onRevealSource?.(annotation.source) ?? revealLoadedAnnotationSource(annotation.source);
        onUnavailable(revealed ? null : annotation.id);
      }}
    >
      {annotationSourceLabel(annotation.source)} · view source
    </button>
  );
}

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
  const [unavailableId, setUnavailableId] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const noteRefs = useRef(new Map<string, HTMLTextAreaElement>());

  useLayoutEffect(() => {
    if (!focusAnnotationId) return;
    const card = cardRefs.current.get(focusAnnotationId);
    const note = noteRefs.current.get(focusAnnotationId);
    card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    note?.focus();
    if (note && document.activeElement === note) onFocusConsumed?.();
  }, [focusAnnotationId, onFocusConsumed]);

  if (annotations.length === 0) return null;

  return (
    <div className={cn("grid gap-2", className)}>
      <p className="px-0.5 text-og-xs font-medium text-og-fg-muted">
        {annotations.length === 1 ? "Quoted note" : `${annotations.length} quoted notes`}
      </p>
      {annotations.map((annotation, index) => {
        const incomplete = !annotationHasNote(annotation.note);
        const focused = annotation.id === focusAnnotationId;
        return (
          <section
            key={annotation.id}
            ref={(node) => {
              if (node) cardRefs.current.set(annotation.id, node);
              else cardRefs.current.delete(annotation.id);
            }}
            className={cn(
              "rounded-og-md border bg-og-surface-2/55 p-2.5",
              incomplete ? "border-og-status-waiting/45" : "border-og-border",
              focused && "ring-2 ring-og-accent/35",
            )}
            aria-label={`Quoted note ${index + 1}`}
          >
            <div className="flex items-start justify-between gap-2">
              <SourceAction
                annotation={annotation}
                onRevealSource={onRevealSource}
                onUnavailable={setUnavailableId}
              />
              <button
                type="button"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-og-fg-subtle outline-hidden hover:bg-og-surface-1 hover:text-og-status-failed focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:size-11"
                aria-label={`Remove quoted note ${index + 1}`}
                onClick={() => onRemove(annotation.id)}
              >
                <XIcon className="size-3.5" aria-hidden="true" />
              </button>
            </div>
            {unavailableId === annotation.id ? (
              <p role="status" className="mt-1 text-og-xs text-og-status-waiting">
                Source is outside the loaded timeline window.
              </p>
            ) : null}
            <AnnotationQuote quote={annotation.quote} />
            <label className="mt-2 block text-og-xs font-medium text-og-fg-muted">
              Note
              <textarea
                ref={(node) => {
                  if (node) noteRefs.current.set(annotation.id, node);
                  else noteRefs.current.delete(annotation.id);
                }}
                value={annotation.note}
                rows={2}
                maxLength={2048}
                placeholder="What should the agent do with this?"
                className="mt-1 w-full resize-y rounded-og-sm border border-og-border bg-og-surface-1 px-2.5 py-2 text-og-sm leading-5 text-og-fg outline-hidden placeholder:text-og-fg-subtle focus:border-og-accent focus:ring-1 focus:ring-og-accent"
                onInput={(event) => onUpdate(annotation.id, event.currentTarget.value)}
              />
              {incomplete ? (
                <span className="mt-1 block font-normal text-og-status-waiting">
                  Add a note to send this quote.
                </span>
              ) : null}
            </label>
          </section>
        );
      })}
    </div>
  );
}

export function TimelineAnnotationCards({
  annotations,
  className,
}: {
  annotations: readonly TimelineAnnotationLike[];
  className?: string | undefined;
}) {
  if (annotations.length === 0) return null;
  return (
    <div className={cn("grid gap-2", className)}>
      {annotations.map((annotation) => (
        <section
          key={annotation.id}
          className="min-w-0 rounded-og-md border border-og-border/80 bg-og-surface-1/70 px-2.5 py-2"
          aria-label="Quoted note"
        >
          <p className="text-og-xs font-medium text-og-fg-subtle">
            {annotationSourceLabel(annotation.source)}
          </p>
          <AnnotationQuote quote={annotation.quote} />
          {annotation.note ? (
            <p className="mt-1.5 whitespace-pre-wrap text-og-sm leading-5 text-og-fg">
              {annotation.note}
            </p>
          ) : null}
        </section>
      ))}
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

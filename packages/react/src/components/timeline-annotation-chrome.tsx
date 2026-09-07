import type {
  DraftTimelineAnnotation,
  TimelineAnnotation,
  TimelineAnnotationSource,
} from "@opengeni/sdk";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { cn } from "../lib/cn";
import {
  annotationSourceLabel,
  revealLoadedAnnotationSource,
  truncateAnnotationQuote,
} from "./timeline-annotation-shared";

export type TimelineAnnotationLike = DraftTimelineAnnotation | TimelineAnnotation;

const NOTE_MAX_HEIGHT_PX = 160;

function autosizeNote(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 32), NOTE_MAX_HEIGHT_PX)}px`;
}

export function AnnotationQuoteSourceButton({
  annotation,
  lines = 1,
  onRevealSource,
  onUnavailable,
}: {
  annotation: TimelineAnnotationLike;
  lines?: 1 | 2 | 3;
  onRevealSource?: ((source: TimelineAnnotationSource) => boolean) | undefined;
  onUnavailable: (id: string | null) => void;
}) {
  const preview =
    lines === 1 ? truncateAnnotationQuote(annotation.quote, 88) : annotation.quote;
  const sourceLabel = annotationSourceLabel(annotation.source);
  return (
    <button
      type="button"
      title={annotation.quote}
      aria-label={`View ${sourceLabel} source: ${truncateAnnotationQuote(annotation.quote, 88)}`}
      className={cn(
        "min-w-0 w-full rounded-sm border-0 bg-transparent text-left text-og-sm leading-5 text-og-fg-muted outline-hidden transition-colors hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-[44px]",
        lines === 1
          ? "truncate"
          : lines === 2
            ? "line-clamp-2 whitespace-pre-wrap"
            : "line-clamp-3 whitespace-pre-wrap",
      )}
      onClick={() => {
        const revealed =
          onRevealSource?.(annotation.source) ?? revealLoadedAnnotationSource(annotation.source);
        onUnavailable(revealed ? null : annotation.id);
      }}
    >
      {preview}
      <span className="sr-only"> view source</span>
    </button>
  );
}

export function AnnotationAccentRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div className={cn("flex gap-2.5", className)}>
      <div aria-hidden="true" className="w-0.5 shrink-0 rounded-full bg-og-accent/55" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function AnnotationNoteField({
  annotation,
  inputRef,
  onUpdate,
}: {
  annotation: TimelineAnnotationLike;
  inputRef?: ((node: HTMLTextAreaElement | null) => void) | undefined;
  onUpdate: (id: string, note: string) => void;
}) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const setRef = (node: HTMLTextAreaElement | null) => {
    localRef.current = node;
    inputRef?.(node);
    autosizeNote(node);
  };

  useLayoutEffect(() => {
    autosizeNote(localRef.current);
  }, [annotation.note]);

  return (
    <textarea
      ref={setRef}
      value={annotation.note}
      rows={1}
      maxLength={2048}
      placeholder="Add a note…"
      aria-label="Note"
      className="mt-0.5 max-h-40 min-h-8 w-full resize-none overflow-y-auto border-0 bg-transparent px-0 py-1 text-og-sm leading-5 text-og-fg outline-hidden placeholder:text-og-fg-subtle focus-visible:ring-0"
      onInput={(event) => {
        autosizeNote(event.currentTarget);
        onUpdate(annotation.id, event.currentTarget.value);
      }}
    />
  );
}

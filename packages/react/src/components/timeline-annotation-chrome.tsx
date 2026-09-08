import type {
  DraftTimelineAnnotation,
  TimelineAnnotation,
  TimelineAnnotationSource,
} from "@opengeni/sdk";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { annotationNoteNeedsDisclosure } from "./timeline-annotation-layout";
import { useTimelineAnnotationSourceRoot } from "./timeline-annotation-reveal-context";
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

function quotePreview(quote: string): { text: string; multiline: boolean } {
  const trimmed = quote.trim();
  const multiline = trimmed.includes("\n");
  return {
    text: multiline ? trimmed : trimmed.replace(/\s+/g, " "),
    multiline,
  };
}

export function AnnotationQuoteSourceButton({
  annotation,
  lines = 2,
  onRevealSource,
  onUnavailable,
}: {
  annotation: TimelineAnnotationLike;
  lines?: 2 | 3;
  onRevealSource?: ((source: TimelineAnnotationSource) => boolean) | undefined;
  onUnavailable: (id: string | null) => void;
}) {
  const preview = quotePreview(annotation.quote);
  const sourceLabel = annotationSourceLabel(annotation.source);
  const sourceRoot = useTimelineAnnotationSourceRoot();
  return (
    <button
      type="button"
      title={annotation.quote}
      aria-label={`View ${sourceLabel} source: ${truncateAnnotationQuote(annotation.quote, 88)}`}
      className="block w-full min-w-0 rounded-sm border-0 bg-transparent text-left text-og-sm leading-5 text-og-fg-muted outline-hidden transition-colors hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-[44px]"
      onClick={() => {
        const revealed =
          onRevealSource?.(annotation.source) ??
          (sourceRoot
            ? revealLoadedAnnotationSource(annotation.source, sourceRoot.current)
            : revealLoadedAnnotationSource(annotation.source));
        onUnavailable(revealed ? null : annotation.id);
      }}
    >
      <span
        className={cn(
          "block min-w-0 max-w-full break-words",
          preview.multiline ? "whitespace-pre-wrap" : "whitespace-normal",
          lines === 3 ? "line-clamp-3" : "line-clamp-2",
        )}
      >
        {preview.text}
      </span>
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

export function AnnotationNotePreview({
  note,
  annotationId,
  ordinal,
  className,
}: {
  note: string;
  annotationId: string;
  ordinal: number;
  className?: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!note) return null;
  const collapsible = annotationNoteNeedsDisclosure(note);
  const contentId = `og-annotation-note-${annotationId}`;
  return (
    <div className={className}>
      <p
        id={contentId}
        data-og-annotation-note=""
        data-og-annotation-note-expanded={expanded ? "true" : "false"}
        className={cn(
          "mt-0.5 break-words whitespace-pre-wrap text-og-sm leading-5 text-og-fg",
          !expanded && "line-clamp-4",
        )}
      >
        {note}
      </p>
      {collapsible ? (
        <button
          type="button"
          className="mt-0.5 inline-flex min-h-7 items-center rounded-og-sm px-1 text-og-xs font-medium text-og-fg-muted outline-hidden hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-11"
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={
            expanded ? `Show less annotation ${ordinal}` : `Show more annotation ${ordinal}`
          }
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

export function AnnotationNoteField({
  annotation,
  inputRef,
  onUpdate,
  onCommit,
}: {
  annotation: TimelineAnnotationLike;
  inputRef?: ((node: HTMLTextAreaElement | null) => void) | undefined;
  onUpdate: (id: string, note: string) => void;
  onCommit?: (() => void) | undefined;
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
      className="mt-0.5 max-h-40 min-h-8 w-full resize-none overflow-y-auto break-words border-0 bg-transparent px-0 py-1 text-og-sm leading-5 text-og-fg outline-hidden placeholder:text-og-fg-subtle focus-visible:ring-0"
      onInput={(event) => {
        autosizeNote(event.currentTarget);
        onUpdate(annotation.id, event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.currentTarget.value.trim().length === 0) return;
        onCommit?.();
      }}
    />
  );
}

import type { TimelineAnnotationSource } from "@opengeni/sdk";
import { XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePortalTokenStyle } from "../lib/use-portal-token-style";
import {
  AnnotationAccentRow,
  AnnotationNoteField,
  AnnotationNotePreview,
  AnnotationQuoteSourceButton,
  type TimelineAnnotationLike,
} from "./timeline-annotation-chrome";
import {
  ANNOTATION_REVIEW_DIALOG_WIDTH_PX,
  clampAnnotationDialogPlacement,
  scrollAnnotationRowIntoList,
} from "./timeline-annotation-layout";
import { annotationDisplayOrdinal, cssEscapeAttribute } from "./timeline-annotation-shared";

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]),textarea:not([disabled]),input:not([disabled]),[href],[tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => element.tabIndex >= 0 && !element.closest("[inert]"));
}

export function TimelineAnnotationsDialog({
  annotations,
  editable,
  focusAnnotationId,
  onFocusConsumed,
  onUpdate,
  onRemove,
  onRevealSource,
  triggerRef,
  countLabel,
  onDismiss,
}: {
  annotations: readonly TimelineAnnotationLike[];
  editable: boolean;
  focusAnnotationId?: string | null | undefined;
  onFocusConsumed?: (() => void) | undefined;
  onUpdate?: ((id: string, note: string) => void) | undefined;
  onRemove?: ((id: string) => void) | undefined;
  onRevealSource?: ((source: TimelineAnnotationSource) => boolean) | undefined;
  triggerRef: RefObject<HTMLButtonElement | null>;
  countLabel: string;
  onDismiss: (restoreFocus: boolean) => void;
}) {
  const [unavailableId, setUnavailableId] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 12, top: 12, maxHeight: 280 });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const noteRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const portalStyle = usePortalTokenStyle(triggerRef.current);
  const revealNote = (id: string) => {
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-og-annotation-id="${cssEscapeAttribute(id)}"]`,
    );
    scrollAnnotationRowIntoList(listRef.current, row);
    noteRefs.current.get(id)?.focus();
  };

  const commitNotes = (fromId: string) => {
    const incomplete = annotations.filter((annotation) => {
      const live = noteRefs.current.get(annotation.id);
      return (live?.value ?? annotation.note).trim().length === 0;
    });
    if (incomplete.length === 0) {
      onDismiss(true);
      return;
    }
    const fromIndex = annotations.findIndex((annotation) => annotation.id === fromId);
    const next =
      incomplete.find(
        (item) => annotations.findIndex((annotation) => annotation.id === item.id) > fromIndex,
      ) ?? incomplete[0]!;
    revealNote(next.id);
  };

  useLayoutEffect(() => {
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const contentHeight =
        (headerRef.current?.offsetHeight ?? 44) + (listRef.current?.scrollHeight ?? 200);
      setPosition(
        clampAnnotationDialogPlacement({
          triggerLeft: rect.left,
          triggerTop: rect.top,
          triggerBottom: rect.bottom,
          contentHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          panelWidth: ANNOTATION_REVIEW_DIALOG_WIDTH_PX,
        }),
      );
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [annotations, triggerRef]);

  useLayoutEffect(() => {
    if (!focusAnnotationId) return;
    revealNote(focusAnnotationId);
    const note = noteRefs.current.get(focusAnnotationId);
    if (note && document.activeElement === note) onFocusConsumed?.();
  }, [focusAnnotationId, onFocusConsumed, annotations.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onDismiss(true);
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = focusableElements(panelRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (panelRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) {
        return;
      }
      onDismiss(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    if (!focusAnnotationId) {
      window.setTimeout(() => {
        if (document.activeElement === triggerRef.current) panelRef.current?.focus();
      }, 0);
    }
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [focusAnnotationId, onDismiss, triggerRef]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      tabIndex={-1}
      data-og-annotation-review=""
      style={{
        left: position.left,
        top: position.top,
        maxHeight: position.maxHeight,
        ...portalStyle,
      }}
      className="og-root fixed z-[75] box-border flex w-[min(25rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-og-lg border border-og-border bg-og-surface-1 text-og-fg shadow-xl outline-hidden"
      aria-label={editable ? "Edit quoted notes" : "Quoted notes"}
    >
      <div
        ref={headerRef}
        data-og-annotation-review-header=""
        className="flex shrink-0 items-start justify-between gap-3 px-3 pt-3 pb-2"
      >
        <p className="min-w-0 pt-0.5 text-og-sm font-medium text-og-fg-muted">{countLabel}</p>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-og-fg-muted outline-hidden hover:bg-og-surface-2 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:size-11"
          aria-label="Close"
          onClick={() => onDismiss(true)}
        >
          <XIcon className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div
        ref={listRef}
        data-og-annotation-review-list=""
        className="grid min-h-0 flex-1 gap-2.5 overflow-x-hidden overflow-y-auto overscroll-contain px-3 pb-3"
      >
        {annotations.map((annotation, index) => {
          const ordinal = annotationDisplayOrdinal(annotation, index);
          return (
            <section
              key={annotation.id}
              data-og-annotation-id={annotation.id}
              aria-label={`Annotation ${ordinal}`}
            >
              <AnnotationAccentRow>
                <div className="flex items-start gap-1">
                  <div className="min-w-0 flex-1">
                    <p className="mb-0.5 text-og-xs font-medium tabular-nums text-og-fg-subtle">
                      Annotation {ordinal}
                    </p>
                    <AnnotationQuoteSourceButton
                      annotation={annotation}
                      lines={2}
                      onRevealSource={onRevealSource}
                      onUnavailable={setUnavailableId}
                    />
                  </div>
                  {editable && onRemove ? (
                    <button
                      type="button"
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-og-fg-subtle outline-hidden hover:bg-og-surface-1 hover:text-og-status-failed focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:size-11"
                      aria-label={`Remove annotation ${ordinal}`}
                      onClick={() => onRemove(annotation.id)}
                    >
                      <XIcon className="size-3.5" aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                {unavailableId === annotation.id ? (
                  <p role="status" className="text-og-xs text-og-status-waiting">
                    Source is outside the loaded timeline window.
                  </p>
                ) : null}
                {editable && onUpdate ? (
                  <AnnotationNoteField
                    annotation={annotation}
                    inputRef={(node) => {
                      if (node) noteRefs.current.set(annotation.id, node);
                      else noteRefs.current.delete(annotation.id);
                    }}
                    onUpdate={onUpdate}
                    onCommit={() => commitNotes(annotation.id)}
                  />
                ) : (
                  <AnnotationNotePreview
                    note={annotation.note}
                    annotationId={annotation.id}
                    ordinal={ordinal}
                  />
                )}
              </AnnotationAccentRow>
            </section>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

export default TimelineAnnotationsDialog;

import type { TimelineAnnotationSource } from "@opengeni/sdk";
import { XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePortalTokenStyle } from "../lib/use-portal-token-style";
import {
  annotationHasNote,
  annotationSourceLabel,
  revealLoadedAnnotationSource,
} from "./timeline-annotation-shared";
import type { TimelineAnnotationLike } from "./timeline-annotations";

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
  const [position, setPosition] = useState({ left: 12, top: 12, above: false });
  const panelRef = useRef<HTMLDivElement | null>(null);
  const noteRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const portalStyle = usePortalTokenStyle(triggerRef.current);

  useLayoutEffect(() => {
    if (!focusAnnotationId) return;
    const note = noteRefs.current.get(focusAnnotationId);
    note?.focus();
    if (note && document.activeElement === note) onFocusConsumed?.();
  }, [focusAnnotationId, onFocusConsumed]);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!rect) return;
      const panelWidth = Math.min(400, window.innerWidth - 24);
      const panelHeight = panel?.offsetHeight ?? 280;
      const left = Math.min(
        Math.max(12, rect.left),
        Math.max(12, window.innerWidth - panelWidth - 12),
      );
      const spaceBelow = window.innerHeight - rect.bottom - 12;
      const spaceAbove = rect.top - 12;
      const above = spaceBelow < Math.min(panelHeight, 280) && spaceAbove > spaceBelow;
      const top = above
        ? Math.max(12 + panelHeight, rect.top - 8)
        : Math.min(rect.bottom + 8, window.innerHeight - 12);
      setPosition({ left, top, above });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [annotations, triggerRef]);

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
      style={{
        left: position.left,
        top: position.top,
        transform: position.above ? "translateY(-100%)" : undefined,
        ...portalStyle,
      }}
      className="og-root fixed z-[75] box-border max-h-[min(32rem,70vh)] w-[min(25rem,calc(100vw-1.5rem))] overflow-y-auto rounded-og-lg border border-og-border bg-og-surface-1 p-3 text-og-fg shadow-xl outline-hidden"
      aria-label={editable ? "Edit quoted notes" : "Quoted notes"}
    >
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-og-sm font-semibold">{countLabel}</p>
          <p className="text-og-xs text-og-fg-subtle">
            {editable
              ? "Tell the agent what to do with each quote."
              : "Attached to this message."}
          </p>
        </div>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-og-fg-muted outline-hidden hover:bg-og-surface-2 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:size-11"
          aria-label="Close"
          onClick={() => onDismiss(true)}
        >
          <XIcon className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="grid gap-2.5">
        {annotations.map((annotation, index) => {
          const incomplete = editable && !annotationHasNote(annotation.note);
          return (
            <section
              key={annotation.id}
              className="rounded-og-md border border-og-border bg-og-surface-2/60 p-2.5"
              aria-label={`Note ${index + 1}`}
            >
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  className="truncate rounded border-0 bg-transparent text-left text-og-xs font-medium text-og-fg-muted underline-offset-2 outline-hidden hover:text-og-fg hover:underline focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-[44px]"
                  onClick={() => {
                    const revealed =
                      onRevealSource?.(annotation.source) ??
                      revealLoadedAnnotationSource(annotation.source);
                    setUnavailableId(revealed ? null : annotation.id);
                  }}
                >
                  {annotationSourceLabel(annotation.source)} · view source
                </button>
                {editable && onRemove ? (
                  <button
                    type="button"
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-og-fg-subtle outline-hidden hover:bg-og-surface-1 hover:text-og-status-failed focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:size-11"
                    aria-label={`Remove annotation ${index + 1}`}
                    onClick={() => onRemove(annotation.id)}
                  >
                    <XIcon className="size-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              {unavailableId === annotation.id ? (
                <p role="status" className="mt-1 text-og-xs text-og-status-waiting">
                  Source is outside the loaded timeline window.
                </p>
              ) : null}
              <blockquote className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap border-l-2 border-og-accent/45 pl-2 text-og-sm leading-5 text-og-fg-muted">
                {annotation.quote}
              </blockquote>
              {editable && onUpdate ? (
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
              ) : annotation.note ? (
                <p className="mt-2 whitespace-pre-wrap text-og-sm leading-5 text-og-fg">
                  {annotation.note}
                </p>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

export default TimelineAnnotationsDialog;

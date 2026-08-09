import type {
  DraftTimelineAnnotation,
  TimelineAnnotation,
  TimelineAnnotationSource,
} from "@opengeni/sdk";
import { MessageSquareTextIcon, Trash2Icon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";

type AnnotationLike = DraftTimelineAnnotation | TimelineAnnotation;

function cssEscapeAttribute(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function revealLoadedSource(source: TimelineAnnotationSource): boolean {
  if (typeof document === "undefined") return false;
  const element = document.querySelector(
    `[data-og-annotation-source-key="${cssEscapeAttribute(source.eventId)}"]`,
  );
  if (!(element instanceof HTMLElement)) return false;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  element.animate?.(
    [
      { outline: "2px solid color-mix(in srgb, currentColor 55%, transparent)" },
      { outline: "2px solid transparent" },
    ],
    { duration: 1600, easing: "ease-out" },
  );
  return true;
}

function sourceLabel(annotation: AnnotationLike): string {
  if (annotation.source.label) return annotation.source.label;
  switch (annotation.source.kind) {
    case "user_message":
      return "User message";
    case "assistant_message":
      return "Assistant message";
    case "tool_output":
      return "Tool output";
  }
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
  annotations: readonly AnnotationLike[];
  editable?: boolean | undefined;
  focusAnnotationId?: string | null | undefined;
  onFocusConsumed?: (() => void) | undefined;
  onUpdate?: ((id: string, note: string) => void) | undefined;
  onRemove?: ((id: string) => void) | undefined;
  onRevealSource?: ((source: TimelineAnnotationSource) => boolean) | undefined;
  className?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [unavailableId, setUnavailableId] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 12, top: 12, above: false });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const noteRefs = useRef(new Map<string, HTMLTextAreaElement>());

  useEffect(() => {
    if (!focusAnnotationId || !annotations.some((item) => item.id === focusAnnotationId)) return;
    setOpen(true);
  }, [annotations, focusAnnotationId]);

  useLayoutEffect(() => {
    if (!open || !focusAnnotationId) return;
    const note = noteRefs.current.get(focusAnnotationId);
    note?.focus();
    if (note && document.activeElement === note) onFocusConsumed?.();
  }, [focusAnnotationId, onFocusConsumed, open]);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const panelWidth = Math.min(400, window.innerWidth - 24);
      const left = Math.min(
        Math.max(12, rect.left),
        Math.max(12, window.innerWidth - panelWidth - 12),
      );
      const above = rect.top > Math.min(360, window.innerHeight * 0.55);
      setPosition({ left, top: above ? rect.top - 8 : rect.bottom + 8, above });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (panelRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) {
        return;
      }
      setOpen(false);
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    if (!focusAnnotationId) {
      window.setTimeout(() => {
        if (document.activeElement === triggerRef.current) panelRef.current?.focus();
      }, 0);
    }
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [focusAnnotationId, open]);

  if (annotations.length === 0) return null;
  const countLabel = `${annotations.length} ${annotations.length === 1 ? "annotation" : "annotations"}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          "inline-flex min-h-8 items-center gap-1.5 rounded-full border border-og-border bg-og-surface-1 px-2.5 py-1 text-og-sm font-medium text-og-fg-muted outline-none transition hover:bg-og-surface-2 hover:text-og-fg focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-[44px]",
          className,
        )}
        aria-label={`Review ${countLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <MessageSquareTextIcon aria-hidden="true" className="size-3.5" />
        {countLabel}
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              tabIndex={-1}
              style={{
                left: position.left,
                top: position.top,
                transform: position.above ? "translateY(-100%)" : undefined,
              }}
              className="og-root fixed z-[75] box-border max-h-[min(32rem,70vh)] w-[min(25rem,calc(100vw-1.5rem))] overflow-y-auto rounded-og-lg border border-og-border bg-og-surface-1 p-3 text-og-fg shadow-xl outline-none"
              aria-label={editable ? "Review timeline annotations" : "Timeline annotations"}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <p className="text-og-sm font-semibold">{countLabel}</p>
                  <p className="text-og-xs text-og-fg-subtle">
                    {editable ? "Add a note for each quoted source." : "Sent with this message."}
                  </p>
                </div>
                <button
                  type="button"
                  className="rounded-md border-0 bg-transparent px-2 py-1 text-og-xs text-og-fg outline-none hover:bg-og-surface-2 focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-[44px]"
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  Close
                </button>
              </div>
              <div className="grid gap-2.5">
                {annotations.map((annotation, index) => (
                  <section
                    key={annotation.id}
                    className="rounded-og-md border border-og-border bg-og-surface-2/60 p-2.5"
                    aria-label={`Annotation ${index + 1}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        className="truncate rounded border-0 bg-transparent text-left text-og-xs font-medium text-og-fg-muted underline-offset-2 outline-none hover:text-og-fg hover:underline focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-[44px]"
                        onClick={() => {
                          const revealed =
                            onRevealSource?.(annotation.source) ??
                            revealLoadedSource(annotation.source);
                          setUnavailableId(revealed ? null : annotation.id);
                        }}
                      >
                        {sourceLabel(annotation)} · view source
                      </button>
                      {editable && onRemove ? (
                        <button
                          type="button"
                          className="shrink-0 rounded border-0 bg-transparent p-1 text-og-fg-subtle outline-none hover:bg-og-surface-1 hover:text-og-status-failed focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:size-[44px]"
                          aria-label={`Remove annotation ${index + 1}`}
                          onClick={() => onRemove(annotation.id)}
                        >
                          <Trash2Icon aria-hidden="true" className="size-3.5" />
                        </button>
                      ) : null}
                    </div>
                    {unavailableId === annotation.id ? (
                      <p role="status" className="mt-1 text-og-xs text-og-status-waiting">
                        Source is outside the loaded timeline window.
                      </p>
                    ) : null}
                    <blockquote className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap border-l-2 border-og-border pl-2 text-og-sm leading-5 text-og-fg-muted">
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
                          className="mt-1 w-full resize-y rounded-og-sm border border-og-border bg-og-surface-1 px-2.5 py-2 text-og-sm leading-5 text-og-fg outline-none placeholder:text-og-fg-subtle focus:border-og-accent focus:ring-1 focus:ring-og-accent"
                          onInput={(event) => onUpdate(annotation.id, event.currentTarget.value)}
                        />
                      </label>
                    ) : annotation.note ? (
                      <p className="mt-2 whitespace-pre-wrap text-og-sm leading-5 text-og-fg">
                        {annotation.note}
                      </p>
                    ) : null}
                  </section>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

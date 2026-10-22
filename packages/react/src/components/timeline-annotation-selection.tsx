import type { DraftTimelineAnnotation } from "@opengeni/sdk";
import { QuoteIcon } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePortalContainer } from "../ui/portal-container";
import { usePortalTokenStyle } from "../lib/use-portal-token-style";
import type { TimelineAnnotationSourceDescriptor } from "../timeline";
import { annotationFromSelection } from "../timeline/annotation-model";
import {
  clipRangeToSource,
  matchingQuoteInSource,
  quoteOccurrenceIndex,
  truncateAnnotationQuote,
  visibleClientRect,
} from "./timeline-annotation-shared";
import { useOpenGeniText } from "../messages/runtime";

type SelectionCandidate = {
  annotation: DraftTimelineAnnotation;
  left: number;
  top: number;
  keyboard: boolean;
};

const CONTROL_SELECTOR = "button,input,textarea,select,summary,[contenteditable='true']";
const POPOVER_WIDTH = 280;
const POPOVER_HEIGHT = 64;

function selectionElement(node: Node | null): Element | null {
  return node instanceof Element ? node : (node?.parentElement ?? null);
}

function containingSource(node: Node | null): HTMLElement | null {
  const element = selectionElement(node);
  const source = element?.closest("[data-og-annotation-source-key]");
  return source instanceof HTMLElement ? source : null;
}

function resolveSourceBoundary(range: Range, root: HTMLElement): HTMLElement | null {
  const start = containingSource(range.startContainer);
  const end = containingSource(range.endContainer);
  if (start && end && start !== end) return null;
  const boundary = start ?? end;
  if (!boundary || !root.contains(boundary)) return null;
  return boundary;
}

function isWhollyInsideControl(range: Range, boundary: HTMLElement): boolean {
  const start = selectionElement(range.startContainer)?.closest(CONTROL_SELECTOR);
  const end = selectionElement(range.endContainer)?.closest(CONTROL_SELECTOR);
  return (
    start instanceof Element && start === end && boundary.contains(start) && start !== boundary
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function popoverPosition(rect: DOMRect): { left: number; top: number } {
  const half = POPOVER_WIDTH / 2;
  const left = clamp(rect.left + rect.width / 2, 12 + half, window.innerWidth - 12 - half);
  const preferBelow = rect.bottom + 8 + POPOVER_HEIGHT <= window.innerHeight - 12;
  const top = preferBelow ? rect.bottom + 8 : Math.max(12, rect.top - POPOVER_HEIGHT - 8);
  return { left, top };
}

function buildCandidate(
  root: HTMLElement,
  sources: ReadonlyMap<string, TimelineAnnotationSourceDescriptor>,
  keyboard: boolean,
): SelectionCandidate | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const startBoundary = resolveSourceBoundary(range, root);
  if (!startBoundary) return null;
  if (isWhollyInsideControl(range, startBoundary)) return null;
  const clipped = clipRangeToSource(range, startBoundary);
  if (!clipped) return null;
  const sourceKey = startBoundary.dataset.ogAnnotationSourceKey;
  const source = sourceKey ? sources.get(sourceKey) : undefined;
  if (!source) return null;
  const rawQuote = clipped.toString();
  const quote = matchingQuoteInSource(source.text, rawQuote) ?? rawQuote;
  const annotation = annotationFromSelection(source, {
    text: quote,
    occurrence: quoteOccurrenceIndex(startBoundary, clipped, quote),
  });
  if (!annotation) return null;
  const rect = visibleClientRect(range) ?? visibleClientRect(clipped);
  if (!rect) return null;
  const position = popoverPosition(rect);
  return {
    annotation,
    left: position.left,
    top: position.top,
    keyboard,
  };
}

export function TimelineAnnotationSelection({
  rootRef,
  sources,
  onAnnotate,
}: {
  rootRef: RefObject<HTMLElement | null>;
  sources: ReadonlyMap<string, TimelineAnnotationSourceDescriptor>;
  onAnnotate?: ((annotation: DraftTimelineAnnotation) => void) | undefined;
}) {
  const t = useOpenGeniText();
  const [candidate, setCandidate] = useState<SelectionCandidate | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const initialSelectionObservedRef = useRef(false);
  const pointerOriginRef = useRef<"unset" | "inside" | "outside">("unset");
  const portalContainer = usePortalContainer();
  const portalStyle = usePortalTokenStyle(rootRef.current);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !onAnnotate) {
      setCandidate(null);
      return;
    }
    const update = (keyboard: boolean) => {
      setCandidate(buildCandidate(root, sources, keyboard));
    };
    // A user may finish selecting text before this lazy component arrives.
    // Reconcile once; later prop changes must not revive dismissed selections.
    if (!initialSelectionObservedRef.current) {
      initialSelectionObservedRef.current = true;
      update(false);
    }
    const onRootPointerUp = (event: PointerEvent) => {
      if (event.target instanceof Node && buttonRef.current?.contains(event.target)) return;
      // Tests may fire only pointerup on the source. A real click that started
      // outside the timeline must not resurrect leftover selection.
      if (pointerOriginRef.current === "outside") return;
      window.setTimeout(() => update(false), 0);
    };
    const onDocumentPointerUp = (event: PointerEvent) => {
      if (event.target instanceof Node && buttonRef.current?.contains(event.target)) return;
      const startedInRoot = pointerOriginRef.current === "inside";
      pointerOriginRef.current = "unset";
      if (!startedInRoot) return;
      window.setTimeout(() => update(false), 0);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCandidate(null);
        return;
      }
      window.setTimeout(() => update(true), 0);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && buttonRef.current?.contains(event.target)) {
        event.preventDefault();
        return;
      }
      pointerOriginRef.current =
        event.target instanceof Node && root.contains(event.target) ? "inside" : "outside";
      setCandidate(null);
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCandidate(null);
    };
    const onSelectionChange = () => {
      if (buttonRef.current && document.activeElement === buttonRef.current) return;
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) setCandidate(null);
    };
    root.addEventListener("pointerup", onRootPointerUp);
    root.addEventListener("keyup", onKeyUp);
    document.addEventListener("pointerup", onDocumentPointerUp);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onDocumentKeyDown);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      root.removeEventListener("pointerup", onRootPointerUp);
      root.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("pointerup", onDocumentPointerUp);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onDocumentKeyDown);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [onAnnotate, rootRef, sources]);

  useEffect(() => {
    if (candidate?.keyboard) buttonRef.current?.focus();
  }, [candidate]);

  if (!candidate || !onAnnotate || typeof document === "undefined") return null;
  const preview = truncateAnnotationQuote(candidate.annotation.quote, 72);
  return createPortal(
    <button
      ref={buttonRef}
      type="button"
      data-og-annotation-popover=""
      style={{ left: candidate.left, top: candidate.top, ...portalStyle }}
      className="og-root fixed z-[80] flex max-w-[min(18rem,calc(100vw-1.5rem))] -translate-x-1/2 items-start gap-2 rounded-2xl border border-og-border bg-og-surface-1 px-3 py-2 text-og-sm font-medium text-og-fg shadow-xl outline-hidden transition hover:border-og-accent/40 hover:bg-og-surface-2 focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:min-h-[44px]"
      aria-label={t("timelineAnnotationSelection.addANoteAboutPreview", { preview })}
      title={candidate.annotation.quote}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        onAnnotate(candidate.annotation);
        document.getSelection()?.removeAllRanges();
        setCandidate(null);
      }}
    >
      <QuoteIcon className="mt-0.5 size-3.5 shrink-0 text-og-accent" aria-hidden="true" />
      <span className="min-w-0 text-left">
        <span className="block leading-5">{t("timelineAnnotationSelection.addNote")}</span>
        <span className="mt-0.5 block truncate text-og-xs font-normal text-og-fg-muted">
          {preview}
        </span>
      </span>
    </button>,
    portalContainer ?? document.body,
  );
}

export default TimelineAnnotationSelection;

import type { DraftTimelineAnnotation } from "@opengeni/sdk";
import { useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import {
  annotationBoxIntersects,
  annotationViewportBox,
  layoutAnnotationBadges,
  type AnnotationBadgeAnchor,
  type AnnotationBox,
} from "./timeline-annotation-layout";
import {
  annotationDisplayOrdinal,
  annotationHasNote,
  annotatableText,
  buildQuoteRange,
  cssEscapeAttribute,
  matchingQuoteInSource,
  occurrenceOffsets,
} from "./timeline-annotation-shared";

function lastVisibleRect(range: Range): DOMRect | null {
  try {
    const rects = range.getClientRects();
    for (let index = rects.length - 1; index >= 0; index--) {
      const rect = rects.item(index);
      if (rect && (rect.width > 0 || rect.height > 0)) return rect;
    }
  } catch {
    // jsdom ranges may omit client rects.
  }
  try {
    const bounding = range.getBoundingClientRect();
    if (bounding.width > 0 || bounding.height > 0) return bounding;
  } catch {
    // jsdom ranges may omit layout geometry.
  }
  return null;
}

function occurrenceForAnnotation(
  sourceEl: HTMLElement,
  annotation: DraftTimelineAnnotation,
): number {
  const { text } = annotatableText(sourceEl);
  const quote = matchingQuoteInSource(text, annotation.quote) ?? annotation.quote;
  const offsets = occurrenceOffsets(text, quote);
  if (offsets.length <= 1) return 0;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  offsets.forEach((offset, index) => {
    const distance = Math.abs(offset - annotation.source.startOffset);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

function timelineScroller(root: HTMLElement): HTMLElement {
  if (root.matches("[data-og-timeline-scroller]")) return root;
  const nested = root.querySelector("[data-og-timeline-scroller]");
  return nested instanceof HTMLElement ? nested : root;
}

function currentAnnotationViewport(root: HTMLElement): AnnotationBox {
  const scroller = timelineScroller(root);
  const rect = scroller.getBoundingClientRect();
  const scrollerBox = {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
  } satisfies AnnotationBox;
  return annotationViewportBox(window.innerWidth || 1024, window.innerHeight || 768, scrollerBox);
}

function sourceInTimeline(root: HTMLElement, eventId: string): HTMLElement | null {
  const source = root.querySelector(
    `[data-og-annotation-source-key="${cssEscapeAttribute(eventId)}"]`,
  );
  return source instanceof HTMLElement ? source : null;
}

function collectMarkers(
  root: HTMLElement | null,
  annotations: readonly DraftTimelineAnnotation[],
): AnnotationBadgeAnchor[] {
  if (!root) return [];
  const viewport = currentAnnotationViewport(root);
  const next: AnnotationBadgeAnchor[] = [];
  for (const [index, annotation] of annotations.entries()) {
    const source = sourceInTimeline(root, annotation.source.eventId);
    if (!source) continue;
    const quote =
      matchingQuoteInSource(annotatableText(source).text, annotation.quote) ?? annotation.quote;
    const range = buildQuoteRange(source, quote, occurrenceForAnnotation(source, annotation));
    if (!range) continue;
    const rect = lastVisibleRect(range);
    if (!rect) continue;
    if (
      !annotationBoxIntersects(
        { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
        viewport,
      )
    ) {
      continue;
    }
    next.push({
      id: annotation.id,
      ordinal: annotationDisplayOrdinal(annotation, index),
      left: rect.right,
      top: rect.top,
      incomplete: !annotationHasNote(annotation.note),
    });
  }
  return layoutAnnotationBadges(next, viewport);
}

export function TimelineAnnotationMarkers({
  annotations,
  onSelect,
  rootRef,
}: {
  annotations: readonly DraftTimelineAnnotation[];
  onSelect?: ((id: string) => void) | undefined;
  rootRef: RefObject<HTMLElement | null>;
}) {
  const [markers, setMarkers] = useState<AnnotationBadgeAnchor[]>([]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || annotations.length === 0) {
      setMarkers([]);
      return;
    }
    const update = () => setMarkers(collectMarkers(root, annotations));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(root);
    for (const annotation of annotations) {
      const source = sourceInTimeline(root, annotation.source.eventId);
      if (source) observer?.observe(source);
    }
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer?.disconnect();
    };
  }, [annotations, rootRef]);

  if (markers.length === 0 || typeof document === "undefined") return null;
  return createPortal(
    <div className="og-root pointer-events-none fixed inset-0 z-[35]">
      {markers.map((marker) => (
        <button
          key={marker.id}
          type="button"
          data-og-annotation-badge=""
          data-og-annotation-badge-ordinal={marker.ordinal}
          style={{ left: marker.left, top: marker.top, zIndex: marker.ordinal }}
          className={cn(
            "pointer-events-auto absolute flex h-4 min-w-4 -translate-x-1/2 -translate-y-[110%] items-center justify-center rounded-full bg-og-accent px-0.5 text-[10px] font-semibold tabular-nums text-white shadow-sm outline-hidden select-none after:absolute after:-inset-2 after:content-[''] focus-visible:ring-2 focus-visible:ring-og-accent pointer-coarse:after:-inset-2.5",
            marker.incomplete && "ring-1 ring-og-accent-fg/35",
          )}
          aria-label={`Annotation ${marker.ordinal}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSelect?.(marker.id);
          }}
        >
          {marker.ordinal}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export default TimelineAnnotationMarkers;

import type { DraftTimelineAnnotation } from "@opengeni/sdk";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import {
  annotationDisplayOrdinal,
  annotationHasNote,
  annotatableText,
  buildQuoteRange,
  cssEscapeAttribute,
  matchingQuoteInSource,
  occurrenceOffsets,
} from "./timeline-annotation-shared";

type Marker = {
  id: string;
  ordinal: number;
  left: number;
  top: number;
  incomplete: boolean;
};

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

function occurrenceForAnnotation(sourceEl: HTMLElement, annotation: DraftTimelineAnnotation): number {
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

function collectMarkers(annotations: readonly DraftTimelineAnnotation[]): Marker[] {
  if (typeof document === "undefined") return [];
  const next: Marker[] = [];
  for (const [index, annotation] of annotations.entries()) {
    const source = document.querySelector(
      `[data-og-annotation-source-key="${cssEscapeAttribute(annotation.source.eventId)}"]`,
    );
    if (!(source instanceof HTMLElement)) continue;
    const quote =
      matchingQuoteInSource(annotatableText(source).text, annotation.quote) ?? annotation.quote;
    const range = buildQuoteRange(source, quote, occurrenceForAnnotation(source, annotation));
    if (!range) continue;
    const rect = lastVisibleRect(range);
    if (!rect) continue;
    next.push({
      id: annotation.id,
      ordinal: annotationDisplayOrdinal(annotation, index),
      left: rect.right,
      top: rect.top,
      incomplete: !annotationHasNote(annotation.note),
    });
  }
  return next;
}

export function TimelineAnnotationMarkers({
  annotations,
  onSelect,
}: {
  annotations: readonly DraftTimelineAnnotation[];
  onSelect?: ((id: string) => void) | undefined;
}) {
  const [markers, setMarkers] = useState<Marker[]>([]);

  useLayoutEffect(() => {
    if (annotations.length === 0) {
      setMarkers([]);
      return;
    }
    const update = () => setMarkers(collectMarkers(annotations));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    for (const annotation of annotations) {
      const source = document.querySelector(
        `[data-og-annotation-source-key="${cssEscapeAttribute(annotation.source.eventId)}"]`,
      );
      if (source instanceof HTMLElement) observer?.observe(source);
    }
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer?.disconnect();
    };
  }, [annotations]);

  if (markers.length === 0 || typeof document === "undefined") return null;
  return createPortal(
    <div className="og-root pointer-events-none fixed inset-0 z-[35]">
      {markers.map((marker) => (
        <button
          key={marker.id}
          type="button"
          data-og-annotation-badge=""
          style={{ left: marker.left, top: marker.top }}
          className={cn(
            "pointer-events-auto absolute flex size-4 -translate-x-1/2 -translate-y-[110%] items-center justify-center rounded-full bg-og-accent text-[10px] font-semibold tabular-nums text-white shadow-sm outline-hidden select-none focus-visible:ring-2 focus-visible:ring-og-accent",
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

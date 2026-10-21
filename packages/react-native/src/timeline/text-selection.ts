import type { DraftTimelineAnnotation } from "@opengeni/sdk";
import type { TimelineAnnotationSourceDescriptor } from "@opengeni/react/session";
import { annotationFromSelection } from "@opengeni/react/timeline-model";
import { useOpenGeniText } from "@opengeni/react/messages";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

/**
 * Text selection inside timeline messages. A message body sits in a view with
 * this test id prefix plus its annotation source key (empty when it cannot be
 * annotated). On iOS the package's native module then gives its text the
 * system selection (handles, Copy, Look Up, Share) instead of React Native's
 * whole-paragraph Copy; on both platforms it adds Add note to the selection
 * menu when a host takes annotations.
 */
export const ANNOTATION_SOURCE_TEST_ID_PREFIX = "og-annotation-source:";

export function annotationSourceTestId(sourceKey: string | undefined): string {
  return `${ANNOTATION_SOURCE_TEST_ID_PREFIX}${sourceKey ?? ""}`;
}

type AnnotateEvent = { sourceKey: string; quote: string; before: string; after: string };

export type QuoteBox = { x: number; y: number; width: number; height: number };

/**
 * Where a quote is drawn in its source view: the end of its last glyph, the
 * top of that line's text, and a text box for each line it spans.
 */
export type QuoteAnchor = { x: number; top: number; boxes: QuoteBox[] };

export type QuoteAnchorQuery = { quote: string; before: string; after: string };

type TextSelectionModule = {
  addListener(
    eventName: "onAnnotate",
    listener: (event: AnnotateEvent) => void,
  ): { remove(): void };
  setAnnotateTitle(title: string | null): void;
  quoteAnchors?(
    sourceKey: string,
    queries: QuoteAnchorQuery[],
  ): Promise<({ x?: number; top?: number; rects?: number[] } | null)[]>;
};

function textSelectionModule(): TextSelectionModule | null {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
  const registry = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo?.modules;
  const module = registry?.OpenGeniTextSelection as TextSelectionModule | undefined;
  return module && typeof module.addListener === "function" ? module : null;
}

/** Whether this build can turn a text selection into an annotation. */
export function nativeTextAnnotationAvailable(): boolean {
  return textSelectionModule() !== null;
}

/**
 * Measures where each quote ends inside the source drawn for `sourceKey`;
 * null for a quote that is not drawn there (or without native measuring).
 */
export async function measureQuoteAnchors(
  sourceKey: string,
  queries: QuoteAnchorQuery[],
): Promise<(QuoteAnchor | null)[]> {
  const module = textSelectionModule();
  if (!module?.quoteAnchors || queries.length === 0) return queries.map(() => null);
  try {
    const anchors = await module.quoteAnchors(sourceKey, queries);
    return queries.map((_, index) => {
      const anchor = anchors[index];
      if (typeof anchor?.x !== "number" || typeof anchor.top !== "number") return null;
      const flat = anchor.rects ?? [];
      const boxes: QuoteBox[] = [];
      for (let at = 0; at + 3 < flat.length; at += 4) {
        boxes.push({ x: flat[at]!, y: flat[at + 1]!, width: flat[at + 2]!, height: flat[at + 3]! });
      }
      return { x: anchor.x, top: anchor.top, boxes };
    });
  } catch {
    return queries.map(() => null);
  }
}

/**
 * Turns Add note on a selection into a draft annotation for `onAnnotate`.
 * `sources` maps each message's annotation source key to its source.
 */
export function useNativeTextAnnotation(
  sources: ReadonlyMap<string, TimelineAnnotationSourceDescriptor>,
  onAnnotate: ((annotation: DraftTimelineAnnotation) => void) | undefined,
): void {
  const t = useOpenGeniText();
  const latest = useRef({ sources, onAnnotate });
  latest.current = { sources, onAnnotate };
  const enabled = Boolean(onAnnotate);
  const title = t("timelineAnnotationSelection.addNote");
  useEffect(() => {
    const module = textSelectionModule();
    if (!module || !enabled) return;
    // Add note shows while some timeline listens (the module tracks listeners).
    module.setAnnotateTitle(title);
    const subscription = module.addListener("onAnnotate", (event) => {
      const source = latest.current.sources.get(event.sourceKey);
      if (!source) return;
      const annotation = annotationFromSelection(source, {
        text: event.quote,
        textBefore: event.before,
        textAfter: event.after,
      });
      if (annotation) latest.current.onAnnotate?.(annotation);
    });
    return () => subscription.remove();
  }, [enabled, title]);
}

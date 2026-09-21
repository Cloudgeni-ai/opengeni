import { createContext, useContext, useLayoutEffect, useRef, type RefObject } from "react";
import type { TimelineItem } from "../timeline/types";
import { annotatableText, rangeFromOffsets, visibleClientRect } from "./timeline-annotation-shared";

export type TimelineSearchTarget = {
  sequence: number;
  eventId?: string | undefined;
  /** Literal, case-insensitive text. No regex interpretation. */
  query: string;
  /** Zero-based occurrence within the source message. Defaults to zero. */
  occurrence?: number | undefined;
  /**
   * Zero-based UTF-16 offset of the match in the original message text, as
   * reported by backend all-occurrence search (messageMatchOffset). When set
   * it takes precedence over `occurrence` and is validated against `query`,
   * so a stale offset degrades to no highlight rather than a wrong one.
   */
  offset?: number | undefined;
};

/** Scoped to the target's group; disclosure expansion persists after closing find. */
export const TimelineSearchRevealContext = createContext<string | null>(null);
export const useTimelineSearchReveal = () => useContext(TimelineSearchRevealContext);

export function isTimelineSearchTarget(item: TimelineItem, target: TimelineSearchTarget): boolean {
  const sources =
    item.sourceEvents ??
    ("annotationSource" in item && item.annotationSource ? [item.annotationSource] : []);
  return sources.some(
    (source) =>
      source.sequence === target.sequence && (!target.eventId || source.eventId === target.eventId),
  );
}

/** Scan without allocating an offset array proportional to a huge message. */
export function literalSearchOffset(text: string, query: string, occurrence = 0): number {
  if (!query || !Number.isSafeInteger(occurrence) || occurrence < 0) return -1;
  // Regex escaping preserves UTF-16 offsets even for case folds whose lowercase
  // string representation changes length (for example dotted capital I).
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (index++ === occurrence) return match.index;
  }
  return -1;
}

/**
 * Validate a caller-supplied UTF-16 offset against the text and query. The
 * sticky flag pins the match to exactly `offset`; like literalSearchOffset,
 * regex escaping keeps offsets in UTF-16 units even for length-changing case
 * folds. Returns -1 when the offset is stale or the text no longer matches.
 */
export function matchAtOffset(text: string, query: string, offset: number): number {
  if (!query || !Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return -1;
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iyu");
  pattern.lastIndex = offset;
  // Unicode regex engines may rewind a lastIndex inside a surrogate pair.
  return pattern.exec(text)?.index === offset ? offset : -1;
}

/** Resolve a target to a UTF-16 offset: explicit offset wins, else the ordinal scan. */
export function searchMatchOffset(text: string, target: TimelineSearchTarget): number {
  if (target.offset != null) return matchAtOffset(text, target.query, target.offset);
  return literalSearchOffset(text, target.query, target.occurrence);
}

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };
let nextHighlightId = 0;

/** Range highlighting does not mutate React-owned text or its layout. */
export function useTimelineSearchNavigation(
  root: RefObject<HTMLDivElement | null>,
  itemId: string | undefined,
  target: TimelineSearchTarget | null | undefined,
  releasePin: () => void,
  revision: unknown,
) {
  const highlightName = useRef("");
  if (!highlightName.current) highlightName.current = `og-search-${++nextHighlightId}`;
  const key = target
    ? JSON.stringify([
        itemId,
        target.sequence,
        target.eventId,
        target.query,
        target.occurrence ?? 0,
        target.offset ?? null,
      ])
    : null;
  const navigated = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!key) navigated.current = null;
    if (!key || !target || !itemId || !root.current) return;
    releasePin();
    const scroller = root.current;
    const registry = (
      globalThis.CSS as (typeof CSS & { highlights?: HighlightRegistry }) | undefined
    )?.highlights;
    const HighlightClass = (
      globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
    ).Highlight;
    const style = document.createElement("style");
    style.textContent = `::highlight(${highlightName.current}) { background: var(--og-accent, #facc15); color: var(--og-accent-fg, #171717); }`;
    scroller.append(style);
    let frame = 0;
    const update = () => {
      const source = [...scroller.querySelectorAll<HTMLElement>("[data-og-search-item]")].find(
        (element) => element.dataset.ogSearchItem === itemId,
      );
      if (!source) return;
      // A virtualized renderer can explicitly identify the selected occurrence
      // when earlier occurrences are not mounted. Never accept a stale marker
      // belonging to a different sequence, occurrence, or query.
      const materialized = [
        ...source.querySelectorAll<HTMLElement>("[data-og-search-occurrence]"),
      ].find(
        (element) =>
          element.dataset.ogSearchSequence === String(target.sequence) &&
          element.dataset.ogSearchQuery === target.query &&
          (target.offset != null
            ? element.dataset.ogSearchOffset === String(target.offset)
            : element.dataset.ogSearchOccurrence === String(target.occurrence ?? 0)),
      );
      const { text, spans } = annotatableText(materialized ?? source);
      // Inside a materialized chunk the match starts at the chunk start.
      // Raw source offsets must NEVER be interpreted as rendered DOM offsets:
      // even matching characters can identify a different repeated occurrence.
      const offset = materialized
        ? matchAtOffset(text, target.query, 0)
        : target.offset != null
          ? -1
          : searchMatchOffset(text, target);
      const range =
        offset < 0 ? null : rangeFromOffsets(spans, offset, offset + target.query.length);
      if (range && registry && HighlightClass)
        registry.set(highlightName.current, new HighlightClass(range));
      else registry?.delete(highlightName.current);
      const rect = range ? visibleClientRect(range) : null;
      // A custom renderer may mount the message body later (or materialize a
      // virtualized chunk in response to renderMessageText's search context).
      // Finding its empty shell is not proof that the occurrence was revealed.
      if (navigated.current === key || !range || !rect) return;
      const box = rect;
      if (!box.height && !box.width) return;
      scroller.scrollTop +=
        box.top - scroller.getBoundingClientRect().top - scroller.clientHeight / 2;
      navigated.current = key;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(scroller, { childList: true, subtree: true, characterData: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(scroller);
    schedule();
    return () => {
      observer.disconnect();
      resize?.disconnect();
      cancelAnimationFrame(frame);
      registry?.delete(highlightName.current);
      style.remove();
    };
  }, [key, root, itemId, target, releasePin, revision]);
}

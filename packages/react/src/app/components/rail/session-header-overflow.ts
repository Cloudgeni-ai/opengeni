import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * The chat header's optional parts, most important first. The header is always
 * one row: when the title would be squeezed below its readable width, parts
 * leave the row from the end of this list and live in the "…" menu instead;
 * they come back once there is room again. One rule for every screen size, so
 * no part needs its own breakpoint. A part that can shrink (flex-shrink above
 * 1, like the automation chip's words) gives way first, down to its minimum
 * width, before anything leaves.
 */
export const SESSION_HEADER_PARTS = [
  "panel",
  "status",
  "access",
  "fullAccess",
  "automations",
  "pin",
  "find",
  "machine",
  "site",
  "model",
  "accessKey",
] as const;

export type SessionHeaderPart = (typeof SESSION_HEADER_PARTS)[number];

/** The title's readable width: its whole text, up to 40% of the header or 20rem. */
const TITLE_HEADER_SHARE = 0.4;
const TITLE_MAX_REM = 20;
/** A part comes back only with this much to spare, so a part on the edge never flickers. */
const RETURN_SLACK_PX = 8;

const NONE: ReadonlySet<SessionHeaderPart> = new Set();

export type SessionHeaderOverflow = {
  /** Parts that are in the "…" menu instead of the row. */
  collapsed: ReadonlySet<SessionHeaderPart>;
  /** The row that holds the title and the parts beside it. */
  rowRef: RefObject<HTMLDivElement | null>;
  /** The title's own box inside that row. */
  titleRef: RefObject<HTMLDivElement | null>;
  /** The action cluster on the header's other side. */
  clusterRef: RefObject<HTMLDivElement | null>;
  /** Stable ref for the element that is one part, measured while it is in the row. */
  partRef: (part: SessionHeaderPart) => (element: HTMLElement | null) => void;
};

/**
 * Keeps the header on one row by moving the least important parts into the
 * "…" menu when the title would get too narrow. `present` lists the parts this
 * chat has; `contentKey` changes whenever the title's text does; `resetKey`
 * (the chat) starts over with every part in the row; `frozen` holds the
 * current layout (while renaming).
 */
export function useSessionHeaderOverflow({
  present,
  contentKey,
  resetKey,
  frozen,
}: {
  present: readonly SessionHeaderPart[];
  contentKey: string;
  resetKey: string;
  frozen: boolean;
}): SessionHeaderOverflow {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLDivElement | null>(null);
  const clusterRef = useRef<HTMLDivElement | null>(null);
  const elements = useRef(new Map<SessionHeaderPart, HTMLElement>());
  const refs = useRef(new Map<SessionHeaderPart, (element: HTMLElement | null) => void>());
  const observer = useRef<ResizeObserver | null>(null);
  // A part's width (with its gap) from when it was last in the row.
  const widths = useRef(new Map<SessionHeaderPart, number>());
  const [collapsed, setCollapsed] = useState<ReadonlySet<SessionHeaderPart>>(NONE);
  const current = useRef(collapsed);
  const inputs = useRef({ present, frozen });
  const presentKey = present.join(" ");

  const partRef = useCallback((part: SessionHeaderPart) => {
    let ref = refs.current.get(part);
    if (!ref) {
      ref = (element) => {
        const previous = elements.current.get(part);
        if (previous && previous !== element) observer.current?.unobserve(previous);
        if (element) {
          elements.current.set(part, element);
          observer.current?.observe(element);
        } else {
          elements.current.delete(part);
        }
      };
      refs.current.set(part, ref);
    }
    return ref;
  }, []);

  // `grow` lets parts come back. Only changes from outside (size, content,
  // which parts exist) may grow; our own changes only ever move more parts
  // out, so the row always settles.
  const fit = useCallback((grow: boolean) => {
    const { present: parts, frozen: hold } = inputs.current;
    const row = rowRef.current;
    const title = titleRef.current;
    if (hold || !row || !title) return;
    const { room: start, need } = measureRoom(row, title);
    let room = start;
    const available = new Set(parts);
    const next = new Set([...current.current].filter((part) => available.has(part)));
    if (room < need) {
      for (let index = SESSION_HEADER_PARTS.length - 1; index >= 0 && room < need; index -= 1) {
        const part = SESSION_HEADER_PARTS[index]!;
        if (!available.has(part) || next.has(part)) continue;
        const width = partWidth(elements.current.get(part));
        // Hidden at this size anyway (desktop-only parts on a phone).
        if (width <= 0) continue;
        widths.current.set(part, width);
        next.add(part);
        room += width;
      }
    } else if (grow) {
      for (const part of SESSION_HEADER_PARTS) {
        if (!next.has(part)) continue;
        const width = widths.current.get(part);
        if (width === undefined || room - width < need + RETURN_SLACK_PX) continue;
        next.delete(part);
        room -= width;
      }
    }
    if (sameParts(next, current.current)) return;
    current.current = next;
    setCollapsed(next);
  }, []);

  // A different chat starts with every part in the row.
  useLayoutEffect(() => {
    widths.current.clear();
    if (current.current.size === 0) return;
    current.current = NONE;
    setCollapsed(NONE);
  }, [resetKey]);

  useLayoutEffect(() => {
    inputs.current = { present, frozen };
    fit(true);
    // `present` is compared through `presentKey`, so a new array with the
    // same parts does not measure again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit, presentKey, contentKey, frozen]);

  useLayoutEffect(() => {
    fit(false);
  }, [fit, collapsed]);

  // Anything that changes size (the header, the title, a part) fits again.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const sizes = new ResizeObserver(() => fit(true));
    observer.current = sizes;
    for (const element of [
      rowRef.current,
      titleRef.current,
      clusterRef.current,
      ...elements.current.values(),
    ]) {
      if (element) sizes.observe(element);
    }
    return () => {
      sizes.disconnect();
      observer.current = null;
    };
  }, [fit]);

  return { collapsed, rowRef, titleRef, clusterRef, partRef };
}

/**
 * How wide the title could be with the parts now in the row (`room`), and how
 * wide it should be (`need`): its whole text, up to its readable width.
 */
function measureRoom(row: HTMLElement, title: HTMLElement): { room: number; need: number } {
  const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
  let used = 0;
  let shown = 0;
  for (const child of row.children) {
    if (getComputedStyle(child).display === "none") continue;
    used += child === title ? title.getBoundingClientRect().width : rigidWidth(child);
    shown += 1;
  }
  used += gap * Math.max(0, shown - 1);
  const titleWidth = title.getBoundingClientRect().width;
  const text = title.querySelector<HTMLElement>("[data-session-title-text]");
  const natural = text
    ? titleWidth - text.getBoundingClientRect().width + text.scrollWidth
    : titleWidth;
  const header = row.closest("header");
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const readable = Math.min((header?.clientWidth ?? 0) * TITLE_HEADER_SHARE, TITLE_MAX_REM * rem);
  return { room: titleWidth + row.clientWidth - used, need: Math.min(natural, readable) };
}

function partWidth(element: HTMLElement | undefined): number {
  if (!element) return 0;
  const width = rigidWidth(element);
  if (width <= 0) return 0;
  const parent = element.parentElement;
  const gap = parent ? Number.parseFloat(getComputedStyle(parent).columnGap) || 0 : 0;
  return width + gap;
}

/** The width a part keeps: a part that gives way first can shrink to its minimum. */
function rigidWidth(element: Element): number {
  const width = element.getBoundingClientRect().width;
  const style = getComputedStyle(element);
  if ((Number.parseFloat(style.flexShrink) || 0) <= 1) return width;
  return Math.min(width, Number.parseFloat(style.minWidth) || 0);
}

function sameParts(a: ReadonlySet<SessionHeaderPart>, b: ReadonlySet<SessionHeaderPart>) {
  if (a.size !== b.size) return false;
  for (const part of a) if (!b.has(part)) return false;
  return true;
}

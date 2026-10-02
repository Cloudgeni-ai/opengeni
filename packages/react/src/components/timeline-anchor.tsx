import { Component, type ReactNode } from "react";

type Anchor = {
  element: HTMLElement;
  key: string | null;
  text: string | null;
  top: number;
  focused?: boolean;
};
export type TimelineAnchor = Anchor[];

/** Read ownership synchronously: selectionchange may follow the next React commit. */
export function timelineHasReader(scroller: HTMLElement | null): boolean {
  if (!scroller) return false;
  const focused = scroller.ownerDocument.activeElement;
  const selection = scroller.ownerDocument.getSelection();
  return Boolean(
    (focused && focused !== scroller && scroller.contains(focused)) ||
    (selection &&
      !selection.isCollapsed &&
      (scroller.contains(selection.anchorNode) || scroller.contains(selection.focusNode))),
  );
}

/** Read the old DOM immediately before React changes it, not when a fetch starts. */
export class TimelineBeforeLayout extends Component<{
  capture: () => void;
  children: ReactNode;
}> {
  getSnapshotBeforeUpdate() {
    this.props.capture();
    return null;
  }
  componentDidUpdate() {}
  render() {
    return this.props.children;
  }
}

export function captureTimelineAnchor(scroller: HTMLElement): TimelineAnchor | null {
  const viewport = scroller.getBoundingClientRect();
  if (viewport.height <= 0) return null;
  // Capture each box once: these measurements share one pre-commit DOM snapshot.
  const groups = Array.from(scroller.querySelectorAll<HTMLElement>("[data-og-group-key]"))
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.height > 0);
  const anchors: TimelineAnchor = [];
  let stickyFocus: Anchor | undefined;
  // A disclosure is the reader's explicit point of interaction. In particular,
  // anchoring a paragraph below an expanding disclosure would move its button.
  const focused = scroller.ownerDocument.activeElement;
  if (focused instanceof HTMLElement && scroller.contains(focused) && focused !== scroller) {
    const box = focused.getBoundingClientRect();
    if (box.bottom > viewport.top && box.top < viewport.bottom) {
      const anchor = { element: focused, key: null, text: null, top: box.top, focused: true };
      const section = focused.closest("[data-og-work-section]");
      // A stuck header stays put even when its section moves. Anchor the work
      // being read beneath it instead, while still retaining its focus identity.
      if (
        focused.matches('[data-og-work-header="outer"]') &&
        section &&
        section.getBoundingClientRect().top < box.top - 1
      )
        stickyFocus = anchor;
      else anchors.push(anchor);
    }
  }
  // A paragraph survives even when earlier deltas reconstruct its containing message.
  for (const { element: group, rect } of groups) {
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
    for (const element of group.querySelectorAll<HTMLElement>("p, li, pre, h1, h2, h3, h4")) {
      const box = element.getBoundingClientRect();
      const text = element.textContent;
      if (box.bottom > viewport.top && box.top < viewport.bottom && text && text.length >= 12) {
        anchors.push({ element, key: null, text, top: box.top });
      }
    }
  }
  // Prefer a retained visible row, then a following row. A following row also
  // anchors the unchanged suffix of a partially loaded message above it.
  const rows = groups.map(({ element, rect }) => ({
    element,
    key: element.getAttribute("data-og-group-key"),
    text: null,
    top: rect.top,
  }));
  anchors.push(...rows.filter((row) => row.top >= viewport.top));
  anchors.push(...rows.filter((row) => row.top < viewport.top).reverse());
  if (stickyFocus) anchors.push(stickyFocus);
  return anchors;
}

/** Return only the correction native browser anchoring has not already made. */
export function timelineAnchorCorrection(
  scroller: HTMLElement,
  anchors: TimelineAnchor,
): number | null {
  let blocks: HTMLElement[] | undefined;
  let groups: HTMLElement[] | undefined;
  for (const anchor of anchors) {
    let element: HTMLElement | undefined;
    if (
      scroller.contains(anchor.element) &&
      (!anchor.text || anchor.element.textContent === anchor.text)
    ) {
      element = anchor.element;
    } else if (anchor.key) {
      groups ??= Array.from(scroller.querySelectorAll<HTMLElement>("[data-og-group-key]"));
      element = groups.find((group) => group.getAttribute("data-og-group-key") === anchor.key);
    } else if (anchor.text) {
      blocks ??= Array.from(scroller.querySelectorAll<HTMLElement>("p, li, pre, h1, h2, h3, h4"));
      const matches = blocks.filter((block) => block.textContent === anchor.text);
      // Repeated boilerplate is not sufficient evidence of retained content.
      if (matches.length === 1) element = matches[0];
    }
    if (element) return element.getBoundingClientRect().top - anchor.top;
  }
  return null;
}

import { Component, type ReactNode } from "react";

type Anchor = { element: HTMLElement; key: string | null; text: string | null; top: number };
export type TimelineAnchor = Anchor[];

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
  const groups = Array.from(scroller.querySelectorAll<HTMLElement>("[data-og-group-key]")).filter(
    (group) => group.getBoundingClientRect().height > 0,
  );
  const anchors: TimelineAnchor = [];
  // A disclosure is the reader's explicit point of interaction. In particular,
  // anchoring a paragraph below an expanding disclosure would move its button.
  const focused = scroller.ownerDocument.activeElement;
  if (
    focused instanceof HTMLElement &&
    scroller.contains(focused) &&
    focused.matches("button[aria-expanded]")
  ) {
    const box = focused.getBoundingClientRect();
    if (box.bottom > viewport.top && box.top < viewport.bottom) {
      anchors.push({ element: focused, key: null, text: null, top: box.top });
    }
  }
  // A paragraph survives even when earlier deltas reconstruct its containing message.
  for (const group of groups) {
    const rect = group.getBoundingClientRect();
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
  const rows = groups.map((element) => ({
    element,
    key: element.getAttribute("data-og-group-key"),
    text: null,
    top: element.getBoundingClientRect().top,
  }));
  anchors.push(...rows.filter((row) => row.top >= viewport.top));
  anchors.push(...rows.filter((row) => row.top < viewport.top).reverse());
  return anchors;
}

/** Return only the correction native browser anchoring has not already made. */
export function timelineAnchorCorrection(
  scroller: HTMLElement,
  anchors: TimelineAnchor,
): number | null {
  let blocks: HTMLElement[] | undefined;
  const groups = Array.from(scroller.querySelectorAll<HTMLElement>("[data-og-group-key]"));
  for (const anchor of anchors) {
    let element: HTMLElement | undefined;
    if (
      scroller.contains(anchor.element) &&
      (!anchor.text || anchor.element.textContent === anchor.text)
    ) {
      element = anchor.element;
    } else if (anchor.key) {
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

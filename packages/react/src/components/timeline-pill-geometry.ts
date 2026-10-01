import type { TimelinePillPlacement } from "./timeline-pill-placement";

const INTERACTIVE =
  'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], [contenteditable="true"]';

/** A control this wide is a row (a disclosure header); only what it draws counts. */
const ROW_WIDTH_RATIO = 0.8;

/**
 * Hit-testing for useTimelinePillPlacement, loaded only once a pill shows so it
 * stays out of a session's first load.
 */
export function choosePlacement(
  pill: HTMLElement,
  frame: HTMLElement,
  scroller: HTMLElement,
  preference: readonly TimelinePillPlacement[],
  current: TimelinePillPlacement,
): TimelinePillPlacement {
  const pillRect = pill.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  if (pillRect.width === 0 || view.width === 0) return current;
  const inset = Math.max(0, pillRect.left - frameRect.left, frameRect.right - pillRect.right);
  const gutter = Math.min(inset, parseFloat(getComputedStyle(scroller).paddingLeft) || 16);
  const left = (placement: TimelinePillPlacement) =>
    placement === "start"
      ? frameRect.left + gutter
      : placement === "end"
        ? frameRect.right - gutter - pillRect.width
        : frameRect.left + (frameRect.width - pillRect.width) / 2;
  const collisions = (placement: TimelinePillPlacement) =>
    countCollisions(
      pill,
      scroller,
      view,
      left(placement),
      pillRect.top,
      pillRect.width,
      pillRect.height,
    );
  // Stay put while the current spot is clear, so the pill does not wander.
  if (collisions(current) === 0) return current;
  let best = current;
  let fewest = Number.POSITIVE_INFINITY;
  for (const candidate of preference) {
    const count = candidate === current ? collisions(current) : collisions(candidate);
    if (count === 0) return candidate;
    if (count < fewest) {
      fewest = count;
      best = candidate;
    }
  }
  return best;
}

function countCollisions(
  pill: HTMLElement,
  scroller: HTMLElement,
  view: DOMRect,
  left: number,
  top: number,
  width: number,
  height: number,
): number {
  const document = scroller.ownerDocument;
  let count = 0;
  for (const fx of [0.06, 0.3, 0.5, 0.7, 0.94]) {
    for (const fy of [0.2, 0.5, 0.8]) {
      const x = left + width * fx;
      const y = top + height * fy;
      if (x < view.left || x > view.right || y < view.top || y > view.bottom) continue;
      if (coversControl(document.elementsFromPoint(x, y), pill, scroller, view, x, y)) count += 1;
    }
  }
  return count;
}

function coversControl(
  stack: Element[],
  pill: HTMLElement,
  scroller: HTMLElement,
  view: DOMRect,
  x: number,
  y: number,
): boolean {
  for (const element of stack) {
    if (pill.contains(element)) continue;
    if (!scroller.contains(element) || element === scroller) return false;
    const control = element.closest(INTERACTIVE);
    if (!control || !scroller.contains(control)) return false;
    // A compact control (a link, an icon button) is covered anywhere on its box.
    if (control.getBoundingClientRect().width < view.width * ROW_WIDTH_RATIO) return true;
    // A full-width row (a disclosure header) only where it draws something: an
    // icon or the glyphs of its label, never its empty background.
    if (element.closest("svg, img, canvas, video")) return true;
    return textUnderPoint(element, x, y);
  }
  return false;
}

function textUnderPoint(element: Element, x: number, y: number): boolean {
  const range = element.ownerDocument.createRange();
  for (const node of element.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
    }
  }
  return false;
}

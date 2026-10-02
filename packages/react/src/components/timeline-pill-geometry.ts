import type { TimelinePillPlacement, TimelinePillPosition } from "./timeline-pill-placement";

const INTERACTIVE =
  'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="switch"], [role="checkbox"], [contenteditable="true"]';

/** A control this wide is a row (a disclosure header); only what it draws counts. */
const ROW_WIDTH_RATIO = 0.8;

/** The full contextual label may not fit beside a compact toolbar on phones. */
export function chooseQuestionPosition(
  pill: HTMLElement,
  frame: HTMLElement,
  scroller: HTMLElement,
  preference: readonly TimelinePillPlacement[],
  current: TimelinePillPosition,
): TimelinePillPosition {
  const rect = pill.getBoundingClientRect();
  const bounds = frame.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  if (!rect.width || !view.width) return current;
  const style = getComputedStyle(frame);
  const baseTop = bounds.top - current.offsetY;
  const left = (placement: TimelinePillPlacement) =>
    placement === "start"
      ? bounds.left + parseFloat(style.paddingLeft || "0")
      : placement === "end"
        ? bounds.right - parseFloat(style.paddingRight || "0") - rect.width
        : bounds.left + (bounds.width - rect.width) / 2;
  const controls: DOMRect[] = [];
  for (const control of scroller.querySelectorAll<HTMLElement>(INTERACTIVE)) {
    const box = control.getBoundingClientRect();
    if (!box.width || !box.height || box.bottom <= baseTop || box.top >= view.bottom) continue;
    if (box.width < view.width * ROW_WIDTH_RATIO) controls.push(box);
    else {
      for (const icon of control.querySelectorAll("svg, img, canvas, video"))
        controls.push(icon.getBoundingClientRect());
      const walker = scroller.ownerDocument.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent?.trim()) continue;
        const range = scroller.ownerDocument.createRange();
        range.selectNodeContents(text);
        controls.push(...range.getClientRects());
      }
    }
  }
  const clear = (placement: TimelinePillPlacement, offsetY: number) =>
    !controls.some(
      (control) =>
        control.right > left(placement) &&
        control.left < left(placement) + rect.width &&
        control.bottom > baseTop + offsetY &&
        control.top < baseTop + offsetY + rect.height,
    );
  const order = [current.placement, ...preference.filter((value) => value !== current.placement)];
  // Return to the normal strip once it is clear, without touching scroll geometry.
  for (const placement of order) if (clear(placement, 0)) return { placement, offsetY: 0 };
  const offsets = [...new Set(controls.map((control) => control.bottom + 4 - baseTop))]
    .filter((offset) => offset > 0 && baseTop + offset + rect.height <= view.bottom)
    .sort((a, b) => a - b);
  for (const offsetY of offsets) {
    for (const placement of order) if (clear(placement, offsetY)) return { placement, offsetY };
  }
  return current;
}

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

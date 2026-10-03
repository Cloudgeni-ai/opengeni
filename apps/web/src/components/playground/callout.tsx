import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/* ----------------------------------------------------------------------------
   One short callout at a time, in high contrast (the page's text color as its
   fill, in both themes), with a straight arrow whose tip lands exactly on the
   edge of its target. Its place is measured every frame, so it follows
   resizes, scrolling and layout changes. On phones it docks above or below the
   target with a small caret instead of an arrow. It never covers its target.
   -------------------------------------------------------------------------- */

export type CalloutSide = "right" | "left" | "below" | "above";
type Box = { left: number; top: number; right: number; bottom: number };
type Point = { x: number; y: number };

export type CalloutLayout = Readonly<{
  bubble: { left: number; top: number; width: number };
  /** Wide screens: from the bubble's edge to the target's edge. */
  arrow: { from: Point; to: Point } | null;
  /** Phones: a caret on the bubble's top or bottom edge, at this x. */
  caret: { x: number; edge: "top" | "bottom" } | null;
}>;

const GAP = 40;
const EDGE = 8;
const BUBBLE_WIDTH = 340;
const MIN_SIDE_WIDTH = 240;
const NARROW = 640;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Where the bubble and its arrow go, or null when the target is off screen. */
export function computeCalloutLayout(
  target: Box,
  bubbleHeight: number,
  viewport: { width: number; height: number },
  sides: readonly CalloutSide[],
): CalloutLayout | null {
  const { width: vw, height: vh } = viewport;
  if (target.bottom < 0 || target.top > vh || target.right < 0 || target.left > vw) return null;
  const cx = (target.left + target.right) / 2;
  const cy = (target.top + target.bottom) / 2;
  // Docked above or below the target, with a caret: phones, and the fallback.
  const dock = (width: number): CalloutLayout => {
    const left = clamp(cx - width / 2, 12, vw - width - 12);
    const fitsBelow = target.bottom + 12 + bubbleHeight <= vh - EDGE;
    const fitsAbove = target.top - 12 - bubbleHeight >= EDGE;
    // Docks on the side the callout prefers ("above" before "below"), if it fits.
    const prefersAbove =
      sides.indexOf("above") !== -1 &&
      (sides.indexOf("below") === -1 || sides.indexOf("above") < sides.indexOf("below"));
    const below = prefersAbove ? !fitsAbove && fitsBelow : fitsBelow;
    const top = below ? target.bottom + 12 : Math.max(EDGE, target.top - 12 - bubbleHeight);
    return {
      bubble: { left, top, width },
      arrow: null,
      caret: { x: clamp(cx - left, 16, width - 16), edge: below ? "top" : "bottom" },
    };
  };
  if (vw < NARROW) return dock(vw - 2 * 12);
  const width = Math.min(BUBBLE_WIDTH, vw - 2 * EDGE);
  const h = bubbleHeight;
  for (const side of sides) {
    if (side === "right" || side === "left") {
      // Beside the target the bubble may narrow a little to fit.
      const room = side === "right" ? vw - EDGE - target.right - GAP : target.left - GAP - EDGE;
      const sideWidth = Math.min(width, room);
      if (sideWidth < MIN_SIDE_WIDTH) continue;
      const left = side === "right" ? target.right + GAP : target.left - GAP - sideWidth;
      const top = clamp(cy - h / 2, EDGE, vh - h - EDGE);
      const y = clamp(cy, top + 12, top + h - 12);
      return {
        bubble: { left, top, width: sideWidth },
        arrow: {
          from: { x: side === "right" ? left - 2 : left + sideWidth + 2, y },
          // The tip lands exactly on the target's edge.
          to: { x: side === "right" ? target.right : target.left, y: cy },
        },
        caret: null,
      };
    }
    const top = side === "below" ? target.bottom + GAP : target.top - GAP - h;
    if (top < EDGE || top + h > vh - EDGE) continue;
    const left = clamp(cx - width / 2, EDGE, vw - width - EDGE);
    const x = clamp(cx, left + 16, left + width - 16);
    return {
      bubble: { left, top, width },
      arrow: {
        from: { x, y: side === "below" ? top - 2 : top + h + 2 },
        to: { x: cx, y: side === "below" ? target.bottom : target.top },
      },
      caret: null,
    };
  }
  return dock(width);
}

/**
 * The union of the boxes of every element the first matching selector finds
 * (a list falls back in order: "the Connect button, else the question").
 */
function measureTarget(selectors: string | readonly string[]): Box | null {
  let boxes: DOMRect[] = [];
  for (const selector of typeof selectors === "string" ? [selectors] : selectors) {
    boxes = Array.from(document.querySelectorAll(selector), (element) =>
      element.getBoundingClientRect(),
    ).filter((box) => box.width > 0 && box.height > 0);
    if (boxes.length > 0) break;
  }
  if (boxes.length === 0) return null;
  return {
    left: Math.min(...boxes.map((box) => box.left)),
    top: Math.min(...boxes.map((box) => box.top)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

export function Callout({
  id,
  target,
  sides,
  children,
  actions,
}: {
  id: string;
  /** CSS selector of what it points at (several elements: their union), or
   * selectors to try in order. */
  target: string | readonly string[];
  /** Where the bubble may sit, in order of preference. */
  sides: readonly CalloutSide[];
  children: ReactNode;
  actions?: ReactNode;
}) {
  const bubble = useRef<HTMLDivElement>(null);
  const marker = useId();
  const [layout, setLayout] = useState<CalloutLayout | null>(null);
  useEffect(() => {
    let frame = 0;
    let previous = "";
    const tick = () => {
      const box = measureTarget(target);
      const next = box
        ? computeCalloutLayout(
            box,
            bubble.current?.offsetHeight ?? 64,
            { width: window.innerWidth, height: window.innerHeight },
            sides,
          )
        : null;
      const key = JSON.stringify(next);
      if (key !== previous) {
        previous = key;
        setLayout(next);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [sides, target]);
  return (
    <>
      {layout?.arrow ? (
        <svg
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-40 h-dvh w-screen overflow-visible text-fg"
        >
          <defs>
            <marker
              id={marker}
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerWidth="8"
              markerHeight="8"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>
          <line
            x1={layout.arrow.from.x}
            y1={layout.arrow.from.y}
            x2={layout.arrow.to.x}
            y2={layout.arrow.to.y}
            stroke="currentColor"
            strokeWidth="2"
            markerEnd={`url(#${marker})`}
          />
        </svg>
      ) : null}
      <div
        ref={bubble}
        role="status"
        data-callout={id}
        className="og-step-in og-callout fixed z-40 flex items-center gap-3 rounded-[14px] bg-fg py-2.5 pr-2 pl-3.5 text-sm leading-5 font-medium text-canvas shadow-lg"
        style={
          layout
            ? { left: layout.bubble.left, top: layout.bubble.top, width: layout.bubble.width }
            : { left: -9999, top: 0, width: BUBBLE_WIDTH, visibility: "hidden" }
        }
      >
        {layout?.caret ? (
          <span
            aria-hidden="true"
            className="absolute size-2.5 rotate-45 bg-fg"
            style={{
              left: layout.caret.x - 5,
              ...(layout.caret.edge === "top" ? { top: -5 } : { bottom: -5 }),
            }}
          />
        ) : null}
        <p className="min-w-0 flex-1">{children}</p>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
    </>
  );
}

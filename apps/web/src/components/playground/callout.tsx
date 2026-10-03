import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/* ----------------------------------------------------------------------------
   One short callout at a time, with a straight arrow that ends exactly at the
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
const BUBBLE_WIDTH = 320;
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
      const left = side === "right" ? target.right + GAP : target.left - GAP - width;
      if (left < EDGE || left + width > vw - EDGE) continue;
      const top = clamp(cy - h / 2, EDGE, vh - h - EDGE);
      const y = clamp(cy, top + 12, top + h - 12);
      return {
        bubble: { left, top, width },
        arrow: {
          from: { x: side === "right" ? left - 2 : left + width + 2, y },
          to: { x: side === "right" ? target.right + 6 : target.left - 6, y: cy },
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
        to: { x: cx, y: side === "below" ? target.bottom + 6 : target.top - 6 },
      },
      caret: null,
    };
  }
  return dock(width);
}

/** The union of the boxes of every element the selector matches. */
function measureTarget(selector: string): Box | null {
  const boxes = Array.from(document.querySelectorAll(selector), (element) =>
    element.getBoundingClientRect(),
  ).filter((box) => box.width > 0 && box.height > 0);
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
  /** CSS selector of what it points at (several elements: their union). */
  target: string;
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
          className="pointer-events-none fixed inset-0 z-40 h-dvh w-screen overflow-visible text-fg-muted"
        >
          <defs>
            <marker
              id={marker}
              viewBox="0 0 10 10"
              refX="8"
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
            strokeWidth="1.5"
            markerEnd={`url(#${marker})`}
          />
        </svg>
      ) : null}
      <div
        ref={bubble}
        role="status"
        data-callout={id}
        className="og-step-in fixed z-40 flex items-center gap-3 rounded-[14px] border border-border-strong bg-surface py-2 pr-2 pl-3 text-sm leading-5 text-fg shadow-lg"
        style={
          layout
            ? { left: layout.bubble.left, top: layout.bubble.top, width: layout.bubble.width }
            : { left: -9999, top: 0, width: BUBBLE_WIDTH, visibility: "hidden" }
        }
      >
        {layout?.caret ? (
          <span
            aria-hidden="true"
            className="absolute size-2.5 rotate-45 border-border-strong bg-surface"
            style={{
              left: layout.caret.x - 5,
              ...(layout.caret.edge === "top"
                ? { top: -6, borderLeftWidth: 1, borderTopWidth: 1 }
                : { bottom: -6, borderRightWidth: 1, borderBottomWidth: 1 }),
            }}
          />
        ) : null}
        <p className="min-w-0 flex-1">{children}</p>
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </div>
    </>
  );
}

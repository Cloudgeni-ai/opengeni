import { MoonIcon, SquareRoundCornerIcon, SunIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { ACCENTS, CORNERS, FONTS, type ChatStyle } from "./style-knobs";

/* ---------------------------------------------------------------------------
   Coach marks: one short bubble at a time, with a pen-stroke arrow that draws
   in and points at a live element. Bubbles sit in the margins beside the
   product; without room (phones, narrow windows) they dock above or below the
   element. They never cover the element they point at, and they are part of
   the page's tab order, so every step works from the keyboard.
   --------------------------------------------------------------------------- */

export type AnchorKind = "composer" | "reply" | "palette" | "chat";

/** The first matching element that is actually laid out (a hidden twin has no box). */
function visible(selector: string): Element | null {
  for (const element of document.querySelectorAll(selector)) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return element;
  }
  return null;
}

function anchorElement(kind: AnchorKind): Element | null {
  switch (kind) {
    case "composer":
      return (
        visible("[data-tour='composer']") ??
        visible("[data-tour='chat'] [data-og-conversation-composer]") ??
        visible("[data-tour='chat'] [data-og-conversation] textarea")
      );
    case "reply": {
      const groups = document.querySelectorAll(
        "[data-tour='chat'] [data-og-conversation] [data-og-timeline-group-anchor]",
      );
      return groups.item(groups.length - 1) ?? visible("[data-tour='chat']");
    }
    case "palette":
      // The palette itself when it shows; on phones, the Restyle button until it opens.
      return visible("[data-tour='palette']") ?? visible("[data-tour='palette-toggle']");
    default:
      return visible("[data-tour='chat']");
  }
}

type Layout = { bubble: { left: number; top: number; width: number }; path: string } | null;

const BUBBLE_WIDTH = 240;
const GAP = 40;
/** The playground's top bar and the product's own nav; bubbles stay below both. */
const TOP_CHROME = 112;

/** A soft curve that bows away from the straight line, like a quick pen stroke. */
function curve(start: { x: number; y: number }, end: { x: number; y: number }): string {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const bend = Math.min(60, length * 0.28);
  const cx = (start.x + end.x) / 2 - (dy / length) * bend;
  const cy = (start.y + end.y) / 2 + (dx / length) * bend;
  return `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
}

export function computeCoachLayout(
  anchorBox: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  },
  chatBox: { left: number; right: number; top: number },
  viewport: { width: number; height: number },
  side: "left" | "right",
  bubbleHeight: number,
): Layout {
  const anchor = anchorBox;
  const chat = chatBox;
  const vw = viewport.width;
  const vh = viewport.height;
  const margin = side === "left" ? chat.left : vw - chat.right;
  const clampY = (y: number) => Math.max(TOP_CHROME + 8, Math.min(vh - bubbleHeight - 12, y));
  if (margin >= BUBBLE_WIDTH + GAP + 16) {
    // Side mode: the bubble lives in the blank margin next to the product.
    const width = Math.min(BUBBLE_WIDTH, margin - GAP - 16);
    const left = side === "left" ? chat.left - GAP - width : chat.right + GAP;
    const anchorMid = anchor.top + anchor.height / 2;
    const insideMargin = side === "left" ? anchor.right < chat.left : anchor.left > chat.right;
    if (insideMargin) {
      // The anchor sits in that margin too (the palette): go below and point up.
      const top = clampY(anchor.bottom + 48);
      const bubble = { left: Math.min(left, vw - width - 16), top, width };
      const start = { x: bubble.left + width / 2, y: top - 6 };
      const end = { x: anchor.left + anchor.width / 2, y: anchor.bottom + 6 };
      return { bubble, path: curve(start, end) };
    }
    const top = clampY(anchorMid - bubbleHeight / 2);
    const bubble = { left, top, width };
    const start = {
      x: side === "left" ? left + width + 6 : left - 6,
      y: top + Math.min(bubbleHeight / 2, 28),
    };
    const end = {
      x: side === "left" ? anchor.left - 8 : anchor.right + 8,
      y: Math.max(anchor.top + 10, Math.min(anchor.bottom - 10, anchorMid)),
    };
    return { bubble, path: curve(start, end) };
  }
  // Dock mode: above the element if it fits, otherwise below it. A large
  // anchor (the whole chat) gets the bubble inside its top edge, no arrow, so
  // the composer and its send button stay clear.
  const width = Math.min(320, vw - 24);
  if (anchor.height > vh * 0.5) {
    const left = Math.max(12, (vw - width) / 2);
    return {
      bubble: { left, top: Math.max(TOP_CHROME + 8, anchor.top + 16), width },
      path: "",
    };
  }
  const left = Math.max(12, Math.min(vw - width - 12, anchor.left + anchor.width / 2 - width / 2));
  const above = anchor.top - bubbleHeight - 36 > TOP_CHROME + 8;
  const top = above
    ? anchor.top - bubbleHeight - 30
    : Math.min(vh - bubbleHeight - 12, anchor.bottom + 30);
  const x = Math.max(left + 24, Math.min(left + width - 24, anchor.left + anchor.width / 2));
  const start = { x, y: above ? top + bubbleHeight + 4 : top - 4 };
  const end = { x: x + 6, y: above ? anchor.top - 6 : anchor.bottom + 6 };
  return { bubble: { left, top, width }, path: curve(start, end) };
}

function measure(kind: AnchorKind, side: "left" | "right", bubbleHeight: number): Layout {
  const anchor = anchorElement(kind)?.getBoundingClientRect();
  const chat = visible("[data-tour='chat']")?.getBoundingClientRect();
  if (!anchor || !chat || anchor.width === 0) return null;
  return computeCoachLayout(
    anchor,
    chat,
    { width: window.innerWidth, height: window.innerHeight },
    side,
    bubbleHeight,
  );
}

export function CoachMark({
  id,
  anchor,
  side = "left",
  step,
  title,
  body,
  code,
  children,
}: {
  id: string;
  anchor: AnchorKind;
  side?: "left" | "right";
  /** "Step 2 of 7", for screen readers and the bubble's quiet meta. */
  step: string;
  title: string;
  body?: string;
  code?: string;
  children?: ReactNode;
}) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const markerId = useId();
  const titleId = useId();
  const [layout, setLayout] = useState<Layout>(null);
  useEffect(() => {
    let frame = 0;
    let previous = "";
    const tick = () => {
      const next = measure(anchor, side, bubbleRef.current?.offsetHeight ?? 96);
      const key = JSON.stringify(next);
      if (key !== previous) {
        previous = key;
        setLayout(next);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [anchor, side]);
  return (
    <>
      <svg
        className="og-coach-arrow pointer-events-none fixed inset-0 z-40 h-dvh w-screen overflow-visible text-fg-subtle"
        aria-hidden="true"
      >
        <defs>
          <marker
            id={markerId}
            viewBox="0 0 10 10"
            refX="7"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path
              d="M 1 1 L 8 5 L 1 9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </marker>
        </defs>
        {layout?.path ? (
          <path
            key={`${id}:${anchor}`}
            d={layout.path}
            pathLength={1}
            markerEnd={`url(#${markerId})`}
          />
        ) : null}
      </svg>
      <div
        ref={bubbleRef}
        key={id}
        role="group"
        aria-labelledby={titleId}
        data-coach-mark={id}
        className="og-step-in fixed z-40 grid gap-2 rounded-2xl border border-border bg-surface p-3.5 text-fg shadow-lg"
        style={
          layout
            ? { left: layout.bubble.left, top: layout.bubble.top, width: layout.bubble.width }
            : { left: -9999, top: 0, width: BUBBLE_WIDTH }
        }
      >
        <p className="text-2xs font-medium text-fg-subtle">{step}</p>
        <p id={titleId} className="-mt-1 text-sm leading-5 font-semibold text-fg">
          {title}
        </p>
        {body ? <p className="-mt-1 text-xs leading-4.5 text-fg-muted">{body}</p> : null}
        {code ? (
          <code className="justify-self-start rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs text-fg">
            {code}
          </code>
        ) : null}
        {children ? (
          <div className="mt-1 flex flex-wrap items-center gap-1.5">{children}</div>
        ) : null}
      </div>
    </>
  );
}

/* ----------------------------- Palette ---------------------------------- */

/**
 * Restyle: accent, corners, font and theme. Each press changes the --og-*
 * properties on the product, which is all a real product sets.
 */
export function Palette({
  style,
  onChange,
  orientation,
  className,
}: {
  style: ChatStyle;
  onChange: (style: ChatStyle) => void;
  orientation: "vertical" | "horizontal";
  className?: string;
}) {
  const cycle = <T,>(list: readonly T[], value: T) =>
    list[(list.indexOf(value) + 1) % list.length]!;
  const vertical = orientation === "vertical";
  return (
    <div
      role="group"
      aria-label="Restyle the chat"
      data-tour="palette"
      className={cn(
        "og-step-in flex items-center gap-2 rounded-full border border-border bg-surface p-2 shadow-md",
        vertical ? "flex-col" : "flex-row",
        className,
      )}
    >
      <div
        role="radiogroup"
        aria-label="Accent"
        className={cn("flex gap-1.5", vertical && "flex-col")}
      >
        {ACCENTS.map((accent) => {
          const selected = style.accent.name === accent.name;
          return (
            <button
              key={accent.name}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={accent.name}
              title={accent.name}
              className={cn(
                "size-6 rounded-full border-2 outline-none transition-[box-shadow] duration-[120ms] focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:size-8",
                selected ? "border-surface ring-2 ring-fg" : "border-transparent",
              )}
              style={{ background: accent.value }}
              onClick={() => onChange({ ...style, accent })}
            />
          );
        })}
      </div>
      <span aria-hidden="true" className={cn("bg-border", vertical ? "h-px w-5" : "h-5 w-px")} />
      <PaletteButton
        label={`Corners: ${style.corners.name}`}
        onClick={() => onChange({ ...style, corners: cycle(CORNERS, style.corners) })}
      >
        <SquareRoundCornerIcon aria-hidden="true" />
      </PaletteButton>
      <PaletteButton
        label={`Font: ${style.font.name}`}
        onClick={() => onChange({ ...style, font: cycle(FONTS, style.font) })}
      >
        <span
          aria-hidden="true"
          className="text-[13px] font-semibold"
          style={{ fontFamily: style.font.css }}
        >
          Aa
        </span>
      </PaletteButton>
      <PaletteButton
        label={style.theme === "light" ? "Dark theme" : "Light theme"}
        onClick={() => onChange({ ...style, theme: style.theme === "light" ? "dark" : "light" })}
      >
        {style.theme === "light" ? <MoonIcon aria-hidden="true" /> : <SunIcon aria-hidden="true" />}
      </PaletteButton>
    </div>
  );
}

function PaletteButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-full bg-surface-2 text-fg outline-none transition-colors duration-[120ms] hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:size-11 [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

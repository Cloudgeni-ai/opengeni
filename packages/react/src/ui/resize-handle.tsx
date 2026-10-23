import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "../lib/cn";

/** Keyboard steps in pixels: an arrow key, and an arrow key with Shift. */
const STEP = 16;
const LARGE_STEP = 64;
/** Two presses without movement within this many milliseconds are a double-click. */
const DOUBLE_PRESS_MS = 400;
/** A press that travels no further than this is a click, not a drag. */
const CLICK_SLOP_PX = 4;
/**
 * Covers the page while dragging so an iframe under the pointer (a Site)
 * cannot swallow the movement. Inline styles: it is portaled to the body,
 * outside any styled root, and must also escape ancestors that would contain
 * a fixed element (transform, filter, contain).
 */
const COVER_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 2147483646,
  cursor: "col-resize",
};

export type ResizeHandleProps = {
  /** The accessible name, for example "Resize chat". */
  label: string;
  /** The id of the panel this handle resizes. */
  controls: string;
  /** The panel's width in pixels. */
  value: number;
  min: number;
  /** The widest the panel may be now, for example what the window leaves room for. */
  max: number;
  /**
   * Which edge of the panel the handle sits on. `start` is a panel on the
   * right with the handle on its left edge: dragging left widens it.
   */
  edge: "start" | "end";
  /** Every intermediate width while dragging; apply it without re-rendering if you can. */
  onResize?: ((width: number) => void) | undefined;
  /** The chosen width: once per drag, and on every key press. */
  onResizeEnd: (width: number) => void;
  /** Double-click: back to the default width. */
  onReset?: (() => void) | undefined;
  /** Enter: hide the panel, as the window splitter pattern collapses its pane. */
  onCollapse?: (() => void) | undefined;
  className?: string | undefined;
};

function clamp(width: number, min: number, max: number) {
  return Math.round(Math.min(Math.max(width, min), Math.max(min, max)));
}

/**
 * A vertical window splitter on a panel's edge. Place it inside the panel,
 * which must be `position: relative`. At rest it is only the panel's own
 * border; hover thickens the line, a drag shows it in the brand tint and
 * keyboard focus shows it in the accent colour. It is a focusable `separator` whose
 * value is the panel width: the arrow keys move it (Shift for larger steps),
 * Home and End go to the narrowest and widest, and Enter hides the panel when
 * it can be hidden. While dragging, a transparent layer covers the page so an
 * iframe under the pointer (a Site) cannot swallow the movement. Coarse
 * pointers get a 44px target.
 */
export function ResizeHandle({
  label,
  controls,
  value,
  min,
  max,
  edge,
  onResize,
  onResizeEnd,
  onReset,
  onCollapse,
  className,
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const [liveValue, setLiveValue] = useState<number | null>(null);
  const teardown = useRef<(() => void) | null>(null);
  // The cover that keeps a drag over an iframe also takes the second click
  // of a double-click, so a double press is recognised here instead.
  const lastPress = useRef<{ at: number; x: number } | null>(null);
  // An unmount mid-drag must not leave listeners or body styles behind.
  useEffect(() => () => teardown.current?.(), []);
  const direction = edge === "start" ? -1 : 1;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    teardown.current?.();
    const startX = event.clientX;
    const startWidth = value;
    const upper = max;
    const widthAt = (clientX: number) =>
      clamp(startWidth + direction * (clientX - startX), min, upper);
    let latest = startWidth;
    // Whether the pointer travelled: a press that didn't is a click, even if
    // a drag at a limit or out and back leaves the width where it started.
    let moved = false;
    setDragging(true);
    setLiveValue(startWidth);
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const track = (clientX: number) => {
      if (Math.abs(clientX - startX) > CLICK_SLOP_PX) moved = true;
      const next = widthAt(clientX);
      if (next === latest) return;
      latest = next;
      setLiveValue(next);
      onResize?.(next);
    };
    const move = (moveEvent: PointerEvent) => {
      // The release happened where this page couldn't see it.
      if (moveEvent.buttons === 0) {
        finish(moveEvent.clientX);
        return;
      }
      track(moveEvent.clientX);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      teardown.current = null;
      setDragging(false);
      setLiveValue(null);
    };
    // Ends the drag: commits a new width, or puts back the one it started at.
    const settle = () => {
      stop();
      if (latest !== startWidth) {
        onResizeEnd(latest);
        return true;
      }
      onResize?.(startWidth);
      return false;
    };
    const finish = (clientX: number) => {
      track(clientX);
      settle();
      if (moved) {
        lastPress.current = null;
        return;
      }
      const now = Date.now();
      const previous = lastPress.current;
      if (
        previous &&
        now - previous.at <= DOUBLE_PRESS_MS &&
        Math.abs(previous.x - startX) <= CLICK_SLOP_PX
      ) {
        lastPress.current = null;
        onReset?.();
      } else lastPress.current = { at: now, x: startX };
    };
    const up = (upEvent: PointerEvent) => finish(upEvent.clientX);
    // A cancelled pointer or a window losing focus keeps where the drag got to.
    const cancel = () => {
      lastPress.current = null;
      settle();
    };
    teardown.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? LARGE_STEP : STEP;
    const upper = Math.max(min, max);
    let next: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        next = value - direction * step;
        break;
      case "ArrowRight":
        next = value + direction * step;
        break;
      case "Home":
        next = min;
        break;
      case "End":
        next = upper;
        break;
      case "Enter":
        if (!onCollapse) return;
        event.preventDefault();
        onCollapse();
        return;
      default:
        return;
    }
    event.preventDefault();
    const width = clamp(next, min, upper);
    if (width !== value) onResizeEnd(width);
  };

  const shown = liveValue ?? value;
  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-controls={controls}
        aria-valuenow={shown}
        aria-valuetext={`${shown} pixels`}
        aria-valuemin={min}
        aria-valuemax={Math.max(min, max)}
        tabIndex={0}
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className={cn(
          "group absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none outline-hidden select-none pointer-coarse:w-11",
          edge === "start"
            ? "-left-1 pointer-coarse:-left-5.5"
            : "-right-1 pointer-coarse:-right-5.5",
          className,
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-[width,background-color] duration-150 motion-reduce:transition-none",
            dragging
              ? "w-0.5 bg-brand/70"
              : "bg-transparent group-hover:w-0.5 group-hover:bg-border-strong group-focus-visible:w-0.5 group-focus-visible:bg-og-accent",
          )}
        />
      </div>
      {dragging && typeof document !== "undefined"
        ? createPortal(
            <div aria-hidden="true" data-resize-cover="" style={COVER_STYLE} />,
            document.body,
          )
        : null}
    </>
  );
}

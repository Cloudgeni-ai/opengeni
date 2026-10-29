import { useEffect, useLayoutEffect, type RefObject } from "react";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * While `active`, keeps `--og-window-bar-row-left` on the canvas at the
 * canvas's left edge in the window, so a header the host lifts into the
 * window bar's row (the macOS app's `[data-window-bar-row]` rules) starts
 * where the canvas starts: beside the rail at any width, while the rail
 * collapses or is resized, and in full screen. The canvas fills the window to
 * its right edge, so every move of its left edge changes its width.
 */
export function useWindowBarRowLeft(
  canvasRef: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useIsomorphicLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!active || !canvas) return;
    const update = () =>
      canvas.style.setProperty(
        "--og-window-bar-row-left",
        `${canvas.getBoundingClientRect().left}px`,
      );
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(canvas);
    return () => {
      observer?.disconnect();
      canvas.style.removeProperty("--og-window-bar-row-left");
    };
  }, [canvasRef, active]);
}

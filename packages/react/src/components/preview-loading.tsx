import { useEffect, useRef } from "react";
import { paintPreviewLoading } from "../preview-loading-paint";

/** Private loading surface: never receives or executes the unfinished fence. */
export function PreviewLoading() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      return; // The CSS grid and status remain when canvas is unavailable.
    }
    if (!ctx) return;
    const context = ctx;
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let frame: number | undefined;
    let time = 2;
    let last: number | undefined;
    let disposed = false;
    // Without visibility observation, keep a static surface rather than doing
    // unbounded work for previews that may be outside the viewport.
    let visible = false;
    const canAnimate = () => !disposed && visible && !document.hidden && motion?.matches === false;

    function draw() {
      const w = canvas!.clientWidth;
      const h = canvas!.clientHeight;
      if (!w || !h || document.hidden || disposed) return;
      const d = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas!.width !== Math.round(w * d) || canvas!.height !== Math.round(h * d)) {
        canvas!.width = Math.round(w * d);
        canvas!.height = Math.round(h * d);
      }
      const style = getComputedStyle(canvas!);
      const ink = style.getPropertyValue("--_og-preview-ink").trim() || "#9fdccd";
      const glowColor = style.getPropertyValue("--_og-preview-glow").trim() || "#5fb8a3";
      context.setTransform(d, 0, 0, d, 0, 0);
      paintPreviewLoading(context, w, h, time, ink, glowColor);
      canvas!.dataset.painted = "true";
    }

    function stop() {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
      last = undefined;
    }
    function tick(stamp: number) {
      frame = undefined;
      if (!canAnimate()) return;
      if (last !== undefined) time += Math.min((stamp - last) / 1000, 0.05);
      last = stamp;
      draw();
      frame = window.requestAnimationFrame(tick);
    }
    function refresh() {
      stop();
      if (disposed || document.hidden || (!visible && intersection)) return;
      draw();
      if (canAnimate() && typeof window.requestAnimationFrame === "function") {
        frame = window.requestAnimationFrame(tick);
      }
    }
    const intersection =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            visible = entry?.isIntersecting === true;
            refresh();
          })
        : undefined;
    intersection?.observe(canvas);
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(refresh) : undefined;
    resize?.observe(canvas);
    // Observe only ancestors, not the document subtree. This also updates the
    // static reduced-motion canvas when a host changes its local theme.
    const theme =
      typeof MutationObserver === "function" ? new MutationObserver(refresh) : undefined;
    for (let ancestor = canvas.parentElement; ancestor; ancestor = ancestor.parentElement) {
      theme?.observe(ancestor, {
        attributes: true,
        attributeFilter: ["class", "style", "data-og-theme"],
      });
    }
    motion?.addEventListener?.("change", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("resize", refresh);
    // Old hosts get one still frame; observed surfaces wait until onscreen.
    if (!intersection) draw();
    return () => {
      disposed = true;
      stop();
      intersection?.disconnect();
      resize?.disconnect();
      theme?.disconnect();
      motion?.removeEventListener?.("change", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("resize", refresh);
    };
  }, []);

  return (
    <div className="og-preview-loading">
      <canvas ref={ref} aria-hidden="true" />
      <span className="og-preview-loading-label">Preparing preview…</span>
    </div>
  );
}

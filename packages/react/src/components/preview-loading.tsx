import { useEffect, useRef } from "react";

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
      const ink = style.getPropertyValue("--_og-preview-ink").trim() || "#bca3ef";
      const glowColor = style.getPropertyValue("--_og-preview-glow").trim() || "#8f6ccc";
      context.setTransform(d, 0, 0, d, 0, 0);
      context.clearRect(0, 0, w, h);
      const cx = w * (0.5 + 0.13 * Math.sin(time * 0.21));
      const cy = h * (0.5 + 0.12 * Math.cos(time * 0.27));
      const glow = context.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.65);
      glow.addColorStop(0, glowColor);
      glow.addColorStop(1, "transparent");
      context.globalAlpha = 0.09;
      context.fillStyle = glow;
      context.fillRect(0, 0, w, h);
      const rows = Math.ceil(h / 18) + 7;
      const cols = Math.ceil(w / 18) + 7;
      const points = Array.from({ length: rows }, (_row, r) =>
        Array.from({ length: cols }, (_col, c) => {
          const x = (c - 3) * 18;
          const y = (r - 3) * 18;
          const dist = Math.hypot((x - cx) * 0.8, y - cy);
          const wave = Math.sin(dist * 0.032 - time * 0.95);
          return {
            x: x + ((x - cx) / Math.max(dist, 1)) * wave * 4,
            y: y + ((y - cy) / Math.max(dist, 1)) * wave * 4,
            l: Math.pow((wave + 1) / 2, 5),
          };
        }),
      );
      context.strokeStyle = ink;
      context.fillStyle = ink;
      context.lineWidth = 0.65;
      points.forEach((row, r) =>
        row.forEach((p, c) => {
          context.globalAlpha = 0.035 + p.l * 0.055;
          context.beginPath();
          if (c + 1 < cols) {
            context.moveTo(p.x, p.y);
            context.lineTo(row[c + 1]!.x, row[c + 1]!.y);
          }
          if (r + 1 < rows) {
            context.moveTo(p.x, p.y);
            context.lineTo(points[r + 1]![c]!.x, points[r + 1]![c]!.y);
          }
          context.stroke();
          context.globalAlpha = 0.15 + p.l * 0.55;
          context.beginPath();
          context.arc(p.x, p.y, 0.85 + p.l * 0.65, 0, Math.PI * 2);
          context.fill();
        }),
      );
      context.globalAlpha = 1;
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

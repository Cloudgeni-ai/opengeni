/**
 * One frame of the "Preparing preview…" ripple: a soft drifting glow under an
 * 18px lattice whose points swell along an outward wave. DOM-free and
 * self-contained (it closes over nothing), so the web canvas effect and the
 * native preview document (which embeds its source) draw the same thing.
 */
export function paintPreviewLoading(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
  ink: string,
  glowColor: string,
): void {
  context.clearRect(0, 0, width, height);
  const cx = width * (0.5 + 0.13 * Math.sin(time * 0.21));
  const cy = height * (0.5 + 0.12 * Math.cos(time * 0.27));
  const glow = context.createRadialGradient(cx, cy, 0, cx, cy, Math.max(width, height) * 0.65);
  glow.addColorStop(0, glowColor);
  glow.addColorStop(1, "transparent");
  context.globalAlpha = 0.09;
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);
  const rows = Math.ceil(height / 18) + 7;
  const cols = Math.ceil(width / 18) + 7;
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
}

/** The ripple's private ink and glow, tuned to the app's teal on a neutral ground. */
export const PREVIEW_LOADING_COLORS = {
  dark: { ink: "#9fdccd", glow: "#5fb8a3", background: "#1b1b1b" },
  light: { ink: "#5f8f84", glow: "#9fe3d3", background: "#f9f9f9" },
} as const;

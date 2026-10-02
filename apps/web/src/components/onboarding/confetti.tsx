import { useEffect, useRef } from "react";

/** The palette's own hues, so the burst matches the theme it falls on. */
const TOKENS = [
  "--color-status-idle",
  "--color-status-waiting",
  "--color-status-running",
  "--color-primary-border",
  "--color-brand",
];

const PIECES = 140;
const DURATION_MS = 2600;

type Piece = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  spin: number;
  angle: number;
  color: string;
};

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * A short burst of confetti over the page, once, for a moment worth marking.
 * Decorative only: hidden from assistive technology, never blocks a click, and
 * skipped entirely when the person asks for reduced motion.
 */
export function Confetti({ play }: { play: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!play || !canvas || prefersReducedMotion()) return;
    const context = canvas.getContext?.("2d");
    if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.scale(ratio, ratio);
    const styles = getComputedStyle(document.documentElement);
    const colors = TOKENS.map((token) => styles.getPropertyValue(token).trim()).filter(Boolean);
    const palette = colors.length > 0 ? colors : ["currentColor"];
    const pieces: Piece[] = Array.from({ length: PIECES }, (_, index) => {
      // Two bursts from the lower corners toward the middle.
      const left = index % 2 === 0;
      const angle = (left ? -60 : -120) + (Math.random() - 0.5) * 50;
      const speed = 9 + Math.random() * 9;
      return {
        x: left ? width * 0.08 : width * 0.92,
        y: height * 0.95,
        vx: Math.cos((angle * Math.PI) / 180) * speed,
        vy: Math.sin((angle * Math.PI) / 180) * speed,
        size: 5 + Math.random() * 6,
        spin: (Math.random() - 0.5) * 0.3,
        angle: Math.random() * Math.PI,
        color: palette[index % palette.length]!,
      };
    });
    let frame = 0;
    const started = performance.now();
    const draw = (now: number) => {
      const elapsed = now - started;
      context.clearRect(0, 0, width, height);
      const fade = Math.max(0, 1 - Math.max(0, elapsed - DURATION_MS * 0.6) / (DURATION_MS * 0.4));
      for (const piece of pieces) {
        piece.vy += 0.32;
        piece.vx *= 0.99;
        piece.x += piece.vx;
        piece.y += piece.vy;
        piece.angle += piece.spin;
        context.save();
        context.globalAlpha = fade;
        context.translate(piece.x, piece.y);
        context.rotate(piece.angle);
        context.fillStyle = piece.color;
        context.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2);
        context.restore();
      }
      if (elapsed < DURATION_MS) frame = requestAnimationFrame(draw);
      else context.clearRect(0, 0, width, height);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [play]);
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-confetti={play ? "" : undefined}
      className="pointer-events-none fixed inset-0 z-50 size-full"
    />
  );
}

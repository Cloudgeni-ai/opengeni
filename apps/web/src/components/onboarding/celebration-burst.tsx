import { useEffect, useRef } from "react";

// The palette's own hues: teal, peach, amber, and the neutral brand grey.
const PIECE_CLASSES = ["bg-status-idle", "bg-status-waiting", "bg-status-running", "bg-brand"];
const PIECES = 36;
const DURATION_MS = 1_800;

/**
 * A one-time confetti burst from the upper middle of the viewport, for the
 * free-credits moment. It is decorative (hidden from assistive technology),
 * never blocks a click, plays once, and does nothing under reduced motion.
 * Pieces animate transform and opacity only, through the Web Animations API,
 * so no global keyframes ship in the app stylesheet.
 */
export function CelebrationBurst() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container || typeof container.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const animations = Array.from(container.children, (piece, index) => {
      // Deterministic spread so the burst looks the same every time.
      const angle = ((index * 137.5) % 180) - 90;
      const distance = 140 + ((index * 53) % 160);
      const x = Math.sin((angle * Math.PI) / 180) * distance;
      const lift = -(60 + ((index * 29) % 90));
      const fall = 220 + ((index * 41) % 180);
      const spin = ((index % 2 === 0 ? 1 : -1) * (360 + ((index * 67) % 360))).toFixed(0);
      return (piece as HTMLElement).animate(
        [
          { transform: "translate(0, 0) rotate(0deg)", opacity: 1 },
          {
            transform: `translate(${(x * 0.7).toFixed(1)}px, ${lift}px) rotate(${Number(spin) / 2}deg)`,
            opacity: 1,
            offset: 0.35,
          },
          { transform: `translate(${x.toFixed(1)}px, ${fall}px) rotate(${spin}deg)`, opacity: 0 },
        ],
        {
          duration: DURATION_MS + ((index * 31) % 500),
          delay: (index % 6) * 20,
          easing: "cubic-bezier(0.2, 0.6, 0.35, 1)",
          fill: "both",
        },
      );
    });
    return () => {
      for (const animation of animations) animation.cancel();
    };
  }, []);

  // A fixed, clipped layer: pieces flying past the card never add a scrollbar.
  return (
    <div
      aria-hidden="true"
      data-slot="celebration-burst"
      className="pointer-events-none fixed inset-0 z-10 overflow-hidden"
    >
      <div ref={ref} className="absolute top-[30%] left-1/2">
        {Array.from({ length: PIECES }, (_, index) => (
          <span
            key={index}
            className={`absolute h-2.5 w-1.5 rounded-[2px] opacity-0 ${PIECE_CLASSES[index % PIECE_CLASSES.length]}`}
          />
        ))}
      </div>
    </div>
  );
}

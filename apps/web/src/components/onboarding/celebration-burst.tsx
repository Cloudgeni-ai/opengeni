import { useEffect, useRef } from "react";

// Pastels from the palette (the dark-theme status hues and the glow bases),
// plus the brand grey, so the burst reads as festive in both themes without
// introducing a new hue.
const PIECE_COLORS = ["#83cbb0", "#e9ab77", "#d5bd72", "#9fe3d3", "#ffb787", "var(--color-brand)"];
const PIECES_PER_CANNON = 34;
const CENTER_PIECES = 30;

type Shape = "strip" | "square" | "dot" | "ribbon";
const SHAPES: Shape[] = ["strip", "square", "strip", "dot", "ribbon"];

/** Deterministic 0..1 noise, so a burst looks the same on every run and test. */
function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

type Piece = {
  id: string;
  /** Launch point as a fraction of the viewport. */
  originX: number;
  originY: number;
  /** Launch angle in degrees (0 = straight up, negative = left). */
  angle: number;
  speed: number;
  delay: number;
  shape: Shape;
  color: string;
};

function pieces(): Piece[] {
  const list: Piece[] = [];
  // Two cannons from the lower corners, aimed up and inward, then a pop from
  // above the card: a "you won" moment rather than a single puff.
  for (const side of [-1, 1] as const) {
    for (let index = 0; index < PIECES_PER_CANNON; index += 1) {
      const seed = index + (side === 1 ? 101 : 0);
      list.push({
        id: `${side}-${index}`,
        originX: side === -1 ? 0.04 : 0.96,
        originY: 0.98,
        angle: -side * (18 + noise(seed) * 34),
        speed: 0.72 + noise(seed + 7) * 0.5,
        delay: noise(seed + 13) * 160,
        shape: SHAPES[index % SHAPES.length] ?? "strip",
        color: PIECE_COLORS[(index + (side === 1 ? 3 : 0)) % PIECE_COLORS.length] ?? "#83cbb0",
      });
    }
  }
  for (let index = 0; index < CENTER_PIECES; index += 1) {
    const seed = index + 211;
    list.push({
      id: `center-${index}`,
      originX: 0.5,
      originY: 0.3,
      angle: -80 + noise(seed) * 160,
      speed: 0.32 + noise(seed + 5) * 0.3,
      delay: 260 + noise(seed + 11) * 140,
      shape: SHAPES[(index + 2) % SHAPES.length] ?? "square",
      color: PIECE_COLORS[(index + 1) % PIECE_COLORS.length] ?? "#e9ab77",
    });
  }
  return list;
}

const SHAPE_CLASSES: Record<Shape, string> = {
  strip: "h-3 w-1.5 rounded-[2px]",
  square: "size-2 rounded-[2px]",
  dot: "size-2 rounded-full",
  ribbon: "h-4 w-1 rounded-full",
};

/**
 * Confetti for winning credits: two cannons from the lower corners and a pop
 * above the card. It is decorative (hidden from assistive technology), never
 * blocks a click, plays once per mount (change `key` to play it again), and
 * does nothing under reduced motion. Pieces animate transform and opacity
 * only, through the Web Animations API, so no global keyframes ship in the
 * app stylesheet. Each flight is sampled from a ballistic arc with drag.
 */
export function CelebrationBurst() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container || typeof container.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const width = window.innerWidth || 1024;
    const height = window.innerHeight || 768;
    const scale = Math.max(height, Math.min(width, 1200));
    const layout = pieces();
    const animations = Array.from(container.children, (element, index) => {
      const piece = layout[index];
      if (!piece) return null;
      const radians = (piece.angle * Math.PI) / 180;
      const velocityX = Math.sin(radians) * piece.speed * scale * 1.15;
      const velocityY = -Math.cos(radians) * piece.speed * scale * 1.35;
      const gravity = scale * 1.6;
      const duration = 2_600 + noise(index + 17) * 900;
      const seconds = duration / 1_000;
      const spin = (noise(index + 23) > 0.5 ? 1 : -1) * (540 + noise(index + 29) * 720);
      const sway = 18 + noise(index + 31) * 26;
      const frames: Keyframe[] = [];
      const steps = 9;
      for (let step = 0; step <= steps; step += 1) {
        const progress = step / steps;
        const time = progress * seconds;
        // Drag flattens the arc so pieces flutter down instead of dropping.
        const drag = 1 - Math.exp(-2.2 * time);
        const x = (velocityX / 2.2) * drag + Math.sin(progress * Math.PI * 3) * sway;
        const y = (velocityY / 2.2) * drag + 0.5 * gravity * time * time * 0.38;
        frames.push({
          transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(spin * progress).toFixed(0)}deg) rotateY(${(progress * 720).toFixed(0)}deg)`,
          opacity: progress < 0.75 ? 1 : 1 - (progress - 0.75) / 0.25,
          offset: progress,
        });
      }
      return (element as HTMLElement).animate(frames, {
        duration,
        delay: piece.delay,
        easing: "linear",
        fill: "both",
      });
    });
    return () => {
      for (const animation of animations) animation?.cancel();
    };
  }, []);

  // A fixed, clipped layer: pieces flying past the card never add a scrollbar.
  return (
    <div
      aria-hidden="true"
      data-slot="celebration-burst"
      className="pointer-events-none fixed inset-0 z-[60] overflow-hidden"
    >
      <div ref={ref} className="absolute inset-0">
        {pieces().map((piece) => (
          <span
            key={piece.id}
            className={`absolute opacity-0 ${SHAPE_CLASSES[piece.shape]}`}
            style={{
              left: `${piece.originX * 100}%`,
              top: `${piece.originY * 100}%`,
              backgroundColor: piece.color,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
export const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/** Normalised position of `t` inside [t0, t1], clamped to 0..1. */
export const progress = (t: number, t0: number, t1: number) =>
  t1 === t0 ? (t >= t1 ? 1 : 0) : clamp((t - t0) / (t1 - t0));

export type Ease = (x: number) => number;

/** CSS-style cubic-bezier easing, solved numerically for x. */
export function bezier(x1: number, y1: number, x2: number, y2: number): Ease {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let s = x;
    for (let i = 0; i < 8; i += 1) {
      const err = sampleX(s) - x;
      if (Math.abs(err) < 1e-6) break;
      const d = slopeX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 20 && Math.abs(sampleX(s) - x) > 1e-6; i += 1) {
      if (sampleX(s) < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return sampleY(s);
  };
}

export const ease = {
  linear: ((x) => x) as Ease,
  outCubic: ((x) => 1 - Math.pow(1 - x, 3)) as Ease,
  inCubic: ((x) => x * x * x) as Ease,
  inOutCubic: ((x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)) as Ease,
  outQuint: ((x) => 1 - Math.pow(1 - x, 5)) as Ease,
  inOutQuint: ((x) => (x < 0.5 ? 16 * x ** 5 : 1 - Math.pow(-2 * x + 2, 5) / 2)) as Ease,
  outExpo: ((x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x))) as Ease,
  inOutSine: ((x) => -(Math.cos(Math.PI * x) - 1) / 2) as Ease,
  /** Decisive, long-tailed deceleration used for most entrances. */
  emphasized: bezier(0.2, 0, 0, 1),
  /** Gentle camera move. */
  camera: bezier(0.45, 0, 0.15, 1),
  /** Accelerating exit. */
  exit: bezier(0.3, 0, 0.8, 0.15),
};

export function tween(
  t: number,
  t0: number,
  t1: number,
  from: number,
  to: number,
  e: Ease = ease.emphasized,
): number {
  return lerp(from, to, e(progress(t, t0, t1)));
}

/** Step response of a damped spring released at t0 (0 → 1). */
export function spring(
  t: number,
  t0: number,
  { stiffness = 220, damping = 24, mass = 1 }: { stiffness?: number; damping?: number; mass?: number } = {},
): number {
  const x = t - t0;
  if (x <= 0) return 0;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * x) * (Math.cos(wd * x) + ((zeta * w0) / wd) * Math.sin(wd * x));
  }
  return 1 - Math.exp(-w0 * x) * (1 + w0 * x);
}

export type Key = { t: number; v: number; e?: Ease };

/** Piecewise keyframes; each key's easing shapes the segment that ends at it. */
export function keys(t: number, list: Key[]): number {
  const first = list[0];
  if (!first) return 0;
  if (t <= first.t) return first.v;
  for (let i = 1; i < list.length; i += 1) {
    const a = list[i - 1]!;
    const b = list[i]!;
    if (t <= b.t) return lerp(a.v, b.v, (b.e ?? ease.camera)(progress(t, a.t, b.t)));
  }
  return list[list.length - 1]!.v;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

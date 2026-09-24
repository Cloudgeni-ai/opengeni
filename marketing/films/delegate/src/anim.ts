export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Cubic-bezier easing identical to CSS `cubic-bezier(x1, y1, x2, y2)`. */
export function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      const d = slopeX(t);
      if (Math.abs(err) < 1e-6 || Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    return sampleY(clamp01(t));
  };
}

export const ease = {
  linear: (x: number) => x,
  inOut: bezier(0.65, 0, 0.35, 1),
  /** Camera: long, confident acceleration and a soft landing. */
  camera: bezier(0.7, 0, 0.2, 1),
  out: bezier(0.16, 1, 0.3, 1),
  in: bezier(0.55, 0, 1, 0.45),
  snap: bezier(0.2, 0.9, 0.1, 1),
  /** Hand-like pointer travel: quick start, long deceleration. */
  pointer: bezier(0.3, 0.1, 0.1, 1),
};

/** Eased 0..1 progress of time `t` across [a, b]. */
export function prog(t: number, a: number, b: number, fn: (x: number) => number = ease.inOut) {
  return fn(clamp01((t - a) / (b - a)));
}

/** Damped spring response 0 → 1 starting at `start` (seconds). */
export function springAt(t: number, start: number, stiffness = 170, damping = 18, mass = 1) {
  const x = t - start;
  if (x <= 0) return 0;
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w0 * x) * (Math.cos(wd * x) + ((zeta * w0) / wd) * Math.sin(wd * x));
  }
  return 1 - Math.exp(-w0 * x) * (1 + w0 * x);
}

export type Key = { t: number; [k: string]: number };

/** Piecewise interpolation across keyframes; each segment uses `fn`.
 * Keys marked with `hold` keep the previous value until their time. */
export function track(keys: Key[], t: number, prop: string, fn = ease.camera): number {
  if (t <= keys[0].t) return keys[0][prop];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t <= b.t) {
      const segFn = (b as { e?: number }).e === 1 ? ease.inOut : fn;
      const x = segFn(clamp01((t - a.t) / (b.t - a.t)));
      return lerp(a[prop], b[prop], x);
    }
  }
  return keys[keys.length - 1][prop];
}

/** Zoom must interpolate in log space or pushes feel like they accelerate. */
export function trackScale(keys: Key[], t: number, fn = ease.camera): number {
  const logKeys = keys.map((k) => ({ ...k, ls: Math.log(k.s) }));
  return Math.exp(track(logKeys, t, "ls", fn));
}

/** Point on a quadratic Bézier. */
export function quad(p0: number, p1: number, p2: number, t: number) {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

/** Point on a cubic Bézier. */
export function cubic(p0: number, p1: number, p2: number, p3: number, t: number) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

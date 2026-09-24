import { Easing } from "remotion";

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);
export const easeIn = Easing.bezier(0.55, 0, 0.9, 0.35);
export const easeSoft = Easing.bezier(0.33, 0, 0.2, 1);
/** Quick lift, long weightless deceleration: for objects being placed. */
export const easeGlide = Easing.bezier(0.32, 0, 0.08, 1);

/** Eased 0..1 progress of t through [start, end]. */
export function prog(t: number, start: number, end: number, easing = easeOut): number {
  if (end <= start) return t >= end ? 1 : 0;
  return easing(clamp((t - start) / (end - start)));
}

/** Critically-damped-ish settle with a single small overshoot, for landings. */
export function settle(p: number): number {
  const c = clamp(p);
  return 1 - Math.exp(-6.5 * c) * Math.cos(7.2 * c);
}

export function mix(a: string, b: string, p: number): string {
  const pa = hex(a);
  const pb = hex(b);
  const c = pa.map((v, i) => Math.round(lerp(v, pb[i], clamp(p))));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

export function alpha(color: string, a: number): string {
  const [r, g, b] = hex(color);
  return `rgba(${r}, ${g}, ${b}, ${clamp(a)})`;
}

function hex(color: string): [number, number, number] {
  const h = color.replace("#", "");
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

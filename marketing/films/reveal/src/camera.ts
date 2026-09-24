import { T } from "./timeline";
import { FIELD } from "./scenes/AppPage";
import { clamp, easeInOut, easeSoft, lerp } from "./lib/anim";

export type Cam = { x: number; y: number; s: number };

/** Her app slides fully out of frame to uncover the code page beneath it... */
export const SLIDE_OUT = 1920 + 820;
/** ...then returns to sit beside the code for the final frame. */
export const SLIDE_DISTANCE = 1920 + 240;
/** Centre of the final frame: between her app (slid left) and the code. */
export const FINAL_CENTER_X = (-SLIDE_DISTANCE + 1920) / 2;
export const BRAND_TOP = 1290;

const closeUp = (s: number): Cam => ({ x: FIELD.x - 16 + 960 / s, y: 540 / s, s });

const FULL: Cam = { x: 960, y: 540, s: 1 };
const FULL_DRIFT: Cam = { x: 972, y: 530, s: 1.032 };
const CARD_FOCUS: Cam = { x: 640, y: 360, s: 1.5 };
const WIDE: Cam = { x: 960, y: 372, s: 0.665 };
const PUSH: Cam = { x: 940, y: 600, s: 1.45 };
const FINAL: Cam = { x: FINAL_CENTER_X, y: 640, s: 0.444 };
const FINAL_SETTLE: Cam = { x: FINAL_CENTER_X, y: 640, s: 0.456 };

type Segment = { t0: number; t1: number; from: Cam; to: Cam; ease?: (x: number) => number };

const CU_START = 1.8;
const CU_END = 1.88;
const cuAt = (t: number) => closeUp(lerp(CU_START, CU_END, easeSoft(clamp(t / T.pullStart))));
const h0 = T.highlights[0].start;

const SEGMENTS: Segment[] = [
  { t0: T.pullStart, t1: T.pullEnd, from: closeUp(CU_END), to: FULL },
  { t0: T.pullEnd, t1: T.closeStart, from: FULL, to: FULL_DRIFT },
  { t0: T.cardIn + 0.15, t1: T.cardIn + 1.05, from: FULL_DRIFT, to: CARD_FOCUS },
  { t0: T.wideHerStart, t1: T.wideHerEnd, from: CARD_FOCUS, to: WIDE },
  { t0: h0 - 0.6, t1: h0 - 0.02, from: WIDE, to: PUSH },
  { t0: T.finalStart, t1: T.finalEnd, from: PUSH, to: FINAL },
  { t0: T.finalEnd, t1: T.duration, from: FINAL, to: FINAL_SETTLE, ease: (x: number) => x },
];

function between(a: Cam, b: Cam, p: number): Cam {
  return {
    x: lerp(a.x, b.x, p),
    y: lerp(a.y, b.y, p),
    s: Math.exp(lerp(Math.log(a.s), Math.log(b.s), p)),
  };
}

export function cameraAt(t: number): Cam {
  if (t < T.pullStart) return cuAt(t);
  let current: Cam = closeUp(CU_END);
  for (const seg of SEGMENTS) {
    if (t < seg.t0) return current;
    if (t <= seg.t1) {
      const p = (seg.ease ?? easeInOut)(clamp((t - seg.t0) / (seg.t1 - seg.t0)));
      return between(seg.from, seg.to, p);
    }
    current = seg.to;
  }
  return current;
}

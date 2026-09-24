import { T } from "./timeline";
import { CODE_X } from "./scenes/CodePage";
import { END_CX, END_CY } from "./scenes/EndCard";
import { FIELD } from "./scenes/AppPage";
import { clamp, easeInOut, easeSoft, lerp } from "./lib/anim";

export type Cam = { x: number; y: number; s: number };

const closeUp = (s: number): Cam => ({ x: FIELD.x - 16 + 960 / s, y: 540 / s, s });

const FULL: Cam = { x: 960, y: 540, s: 1 };
const FULL_DRIFT: Cam = { x: 972, y: 530, s: 1.032 };
const CARD_FOCUS: Cam = { x: 640, y: 360, s: 1.5 };
const WIDE_HER: Cam = { x: 960, y: 372, s: 0.665 };
const WIDE_YOU: Cam = { x: CODE_X + 960, y: 372, s: 0.665 };
const PUSH: Cam = { x: CODE_X + 940, y: 600, s: 1.33 };
const WIDE_BOTH: Cam = { x: 2040, y: 372, s: 0.455 };
const END: Cam = { x: END_CX, y: END_CY, s: 0.455 };
const END_SETTLE: Cam = { x: END_CX, y: END_CY, s: 0.468 };

type Segment = { t0: number; t1: number; from: Cam; to: Cam; ease?: (x: number) => number; bump?: number };

const CU_START = 1.8;
const CU_END = 1.88;

const cuAt = (t: number) => closeUp(lerp(CU_START, CU_END, easeSoft(clamp(t / T.pullStart))));

const h0 = T.highlights[0].start;

const SEGMENTS: Segment[] = [
  { t0: T.pullStart, t1: T.pullEnd, from: closeUp(CU_END), to: FULL },
  { t0: T.pullEnd, t1: T.closeStart, from: FULL, to: FULL_DRIFT },
  { t0: T.cardIn + 0.15, t1: T.cardIn + 1.05, from: FULL_DRIFT, to: CARD_FOCUS },
  { t0: T.wideHerStart, t1: T.wideHerEnd, from: CARD_FOCUS, to: WIDE_HER },
  { t0: T.panStart, t1: T.panEnd, from: WIDE_HER, to: WIDE_YOU, bump: 0.16 },
  { t0: h0 - 0.6, t1: h0 - 0.02, from: WIDE_YOU, to: PUSH },
  { t0: T.wideBothStart, t1: T.wideBothEnd, from: PUSH, to: WIDE_BOTH },
  { t0: T.endStart, t1: T.endEnd, from: WIDE_BOTH, to: END },
  { t0: T.endEnd, t1: T.duration, from: END, to: END_SETTLE, ease: (x: number) => x },
];

function between(a: Cam, b: Cam, p: number, bump = 0): Cam {
  const s = Math.exp(lerp(Math.log(a.s), Math.log(b.s), p)) * (1 - bump * Math.sin(Math.PI * p));
  return { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), s };
}

export function cameraAt(t: number): Cam {
  if (t < T.pullStart) return cuAt(t);
  let current: Cam = closeUp(CU_END);
  for (const seg of SEGMENTS) {
    if (t < seg.t0) return current;
    if (t <= seg.t1) {
      const p = (seg.ease ?? easeInOut)(clamp((t - seg.t0) / (seg.t1 - seg.t0)));
      return between(seg.from, seg.to, p, seg.bump);
    }
    current = seg.to;
  }
  return current;
}

import { CLIENTS, REQUEST } from "./data";

/** Story cues in seconds. Picture (Remotion) and sound (audio/compose.py via
 * scripts/export-cues.ts) both read these, so sync is exact by construction. */
/** Music runs at 75 BPM in 4/4: one beat = 0.8 s, one bar = 3.2 s. The film
 * opens on a short pickup; downbeats fall at 2.4 + 3.2k s. Structural moments
 * sit on the grid: the ask (bar 1), Enter (bar 2), landings (eighths), the
 * question (bar 4), THE LAST CLICK (bar 5), "hour" (bar 6), end line (bar 8). */
export const BEAT = 0.8;
export const BAR = BEAT * 4;
export const DOWNBEAT0 = 2.4;
export const bar = (k: number, beat = 0) => DOWNBEAT0 + BAR * k + BEAT * beat;

export const T = {
  // Act 1 — operating the software
  benClick: 0.3,
  dialogOpen: 0.35,
  cancelClick: 1.45,
  askClick: 2.05,
  typeStart: 2.27,
  typeEnd: bar(0, 3) + 0.3,
  enter: bar(1),

  // Act 2 — delegating inside it
  lieStart: bar(1) + 1.2,
  lieEnd: bar(1) + 1.92,
  check: bar(1) + 0.75,
  checkGap: 0.16,
  flights: bar(2, 0.5) - 0.85,
  flightGap: 0.4,
  flightDur: 0.85,
  draft: bar(3) - 0.3,
  approvalIn: bar(3),
  sitUp: bar(3, 2),
  approve: bar(4),
  sent: bar(4) + 0.25,
  sentGap: 0.11,
  clear: bar(4, 1.5),
  lieAgain: bar(4, 2),
  dim: bar(4, 2) + 0.3,

  // Act 3 — morning, backstage: what it took
  wipe: bar(5),
  code: bar(5) + 0.3,
  ann1: bar(5, 1),
  ann2: bar(5, 3),
  ann3: bar(6, 1),
  whole: bar(6, 2),
  line1: bar(7),
  line2: bar(7, 1),
  mark: bar(7, 2),
  end: bar(7, 2) + 2.4,
} as const;

export const DURATION_S = T.end;

/** Every mouse click in the film. The approval is deliberately the last one. */
export const CLICKS = [T.benClick, T.cancelClick, T.askClick, T.approve];

export const flightStart = (i: number) => T.flights + i * T.flightGap;
export const flightEnd = (i: number) => flightStart(i) + T.flightDur;
export const sentAt = (i: number) => T.sent + i * T.sentGap;

/** Deterministic pseudo-random in [0,1). */
export function rand(seed: number) {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** Humanized per-character timestamps for the typed request. Pauses after
 * punctuation and at word boundaries; normalized to [typeStart, typeEnd]. */
export const TYPE_TIMES: number[] = (() => {
  const weights: number[] = [];
  for (let i = 0; i < REQUEST.length; i++) {
    const prev = REQUEST[i - 1] ?? "";
    let w = 0.75 + rand(i + 1) * 0.5;
    if (prev === "." || prev === ",") w += 3.2;
    else if (prev === " ") w += 0.55;
    if (REQUEST[i] === "'") w += 0.4;
    weights.push(w);
  }
  const total = weights.reduce((a, b) => a + b, 0);
  const span = T.typeEnd - T.typeStart;
  const out: number[] = [];
  let acc = 0;
  for (const w of weights) {
    acc += w;
    out.push(T.typeStart + (acc / total) * span);
  }
  return out;
})();

export function typedCount(t: number) {
  let n = 0;
  while (n < TYPE_TIMES.length && TYPE_TIMES[n] <= t) n++;
  return n;
}

export const CLIENT_COUNT = CLIENTS.length;

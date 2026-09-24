import { CLIENTS, REQUEST } from "./data";

/** Story cues in seconds. Picture (Remotion) and sound (audio/compose.py via
 * scripts/export-cues.ts) both read these, so sync is exact by construction. */
/** Music runs at 75 BPM in 4/4: one beat = 0.8 s, one bar = 3.2 s.
 * Structural moments sit on the grid: Enter (bar 2), the landings (eighths),
 * the approval card (bar 4), THE LAST CLICK (bar 5), "hour" (bar 6),
 * the end line (bar 8). */
export const BEAT = 0.8;
export const BAR = BEAT * 4;

export const T = {
  // Act 1 — operating the software
  benClick: 0.4,
  dialogOpen: 0.45,
  cancelClick: 2.4,
  askClick: 3.2,
  typeStart: 3.42,
  typeEnd: 5.95,
  enter: 6.4,

  // Act 2 — delegating inside it
  lieStart: 6.75,
  lieEnd: 7.6,
  check: 7.2,
  checkGap: 0.15,
  flights: 8.95,
  flightGap: 0.4,
  flightDur: 1.05,
  draft: 12.5,
  approvalIn: 12.8,
  sitUp: 14.4,
  approve: 16.0,
  sent: 16.25,
  sentGap: 0.11,
  clear: 17.2,
  lieAgain: 17.6,
  dim: 17.9,

  // Act 3 — it could be yours
  toMark: 18.3,
  markArrive: 19.2,
  flip: 19.6,
  wipe: 20.4,
  yourFly: 20.6,
  code: 20.9,
  ann1: 21.6,
  ann2: 22.4,
  ann3: 23.2,
  codeOut: 25.2,
  line1: 25.6,
  line2: 26.4,
  mark: 27.2,
  end: 29.6,
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

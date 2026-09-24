// Single source of truth for picture and sound. Every time is in seconds.
// scripts/export-cues.ts writes these to audio/cues.json for the score.

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const REQUEST = "I'm sick today. Move my clients to next week and let them know.";

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPE_START = 0.35;

/** Time at which each character of REQUEST appears. Human rhythm: quick runs,
 * a breath after the first sentence, small hesitations between words. */
export const TYPE_TIMES: number[] = (() => {
  const rand = mulberry32(24092026);
  const times: number[] = [];
  let t = TYPE_START;
  for (let i = 0; i < REQUEST.length; i++) {
    const ch = REQUEST[i];
    const prev = REQUEST[i - 1];
    let gap = 0.03 + rand() * 0.024;
    if (prev === " ") gap += 0.012 + rand() * 0.02;
    if (prev === ".") gap += 0.34;
    if (ch === " " && rand() > 0.7) gap += 0.03;
    times.push(t);
    t += gap;
  }
  return times;
})();

const TYPE_END = TYPE_TIMES[TYPE_TIMES.length - 1];

export const T = {
  typeStart: TYPE_START,
  typeEnd: TYPE_END,
  enter: TYPE_END + 0.22,
  pullStart: TYPE_END + 0.3,
  pullEnd: TYPE_END + 1.65,
  scanStart: TYPE_END + 0.95,
  scanStagger: 0.07,
  moves: [
    { start: TYPE_END + 1.62, land: TYPE_END + 2.32 },
    { start: TYPE_END + 2.4, land: TYPE_END + 3.1 },
  ],
  toast: TYPE_END + 2.47,
  closeStart: 7.9,
  closeEnd: 8.6,
  hiddenMoves: [8.78, 9.08, 9.38, 9.68],
  openStart: 9.92,
  openEnd: 10.47,
  cardIn: 10.62,
  sendTap: 12.7,
  sentTicks: [12.79, 12.87, 12.95, 13.03, 13.11, 13.19],
  cardOut: 13.45,
  wideHerStart: 13.6,
  wideHerEnd: 14.9,
  superHer: 14.35,
  panStart: 15.6,
  panEnd: 16.9,
  superYou: 16.6,
  highlights: [
    { key: "tenant", start: 18.1, end: 19.0 },
    { key: "tools", start: 19.0, end: 19.95 },
    { key: "approval", start: 19.95, end: 20.95 },
  ],
  wideBothStart: 20.95,
  wideBothEnd: 22.15,
  endStart: 23.8,
  endEnd: 24.8,
  duration: 28.0,
} as const;

export const DURATION_FRAMES = Math.round(T.duration * FPS);

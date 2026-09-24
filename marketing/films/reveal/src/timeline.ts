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

/** Time at which each character of REQUEST appears. Human rhythm: quick
 * bursts inside words, small gaps between them, a breath after the first
 * sentence, and a beat of thought before "next week" and "let them know". */
export const TYPE_TIMES: number[] = (() => {
  const rand = mulberry32(24092026);
  const times: number[] = [];
  let t = TYPE_START;
  for (let i = 0; i < REQUEST.length; i++) {
    const prev = REQUEST[i - 1];
    let gap = 0.021 + rand() * 0.017;
    if (prev === " ") gap += 0.026 + rand() * 0.04;
    if (prev === ".") gap += 0.34;
    if (REQUEST.startsWith("next", i) || REQUEST.startsWith("let", i)) gap += 0.1;
    if (rand() < 0.05) gap += 0.05;
    if (i > 0) t += gap;
    times.push(t);
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
    { start: TYPE_END + 1.6, land: TYPE_END + 2.42 },
    { start: TYPE_END + 2.42, land: TYPE_END + 3.24 },
  ],
  toast: TYPE_END + 2.6,
  closeStart: 7.95,
  closeEnd: 8.7,
  hiddenMoves: [8.85, 9.15, 9.45, 9.75],
  openStart: 10.0,
  openEnd: 10.75,
  cardIn: 10.9,
  sendTap: 12.95,
  sentTicks: [13.04, 13.12, 13.2, 13.28, 13.36, 13.44],
  cardOut: 13.7,
  wideHerStart: 13.85,
  wideHerEnd: 15.1,
  superHer: 14.6,
  slideStart: 15.9,
  slideEnd: 17.1,
  superYou: 16.8,
  highlights: [
    { key: "tenant", start: 18.4, end: 19.35 },
    { key: "tools", start: 19.35, end: 20.35 },
    { key: "approval", start: 20.35, end: 21.35 },
  ],
  finalStart: 21.35,
  finalEnd: 22.65,
  brandIn: 22.8,
  duration: 26.5,
} as const;

export const DURATION_FRAMES = Math.round(T.duration * FPS);

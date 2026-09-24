import { rng } from "./lib/anim";

export const FPS = 60;
export const BPM = 100;
export const BEAT = 60 / BPM;

export const MESSAGE = "Our flight lands 3 hours late. Can you fix the rest of today?";

export const WIDGET_GREETING = "Hi! I’m Acme Assistant. Ask me anything!";
export const WIDGET_REPLY_INTRO = "So sorry about the delay! Here’s how to update each booking yourself:";
export const WIDGET_STEPS = [
  "Open Itinerary → Car rental",
  "Tap “Modify pickup”",
  "Choose a new pickup time",
  "Go back to Itinerary → Hotel",
  "Tap “Add note”",
  "Go back to Itinerary → Dinner",
  "Tap “Change time”",
  "Repeat for any other bookings",
];
export const WIDGET_SIGNOFF = "Hope this helps!";

/** All cue times in seconds. The film is one continuous shot. */
export const T = {
  // Act 1 — the bolted-on assistant
  typeStart: -0.95,
  send: 2.05,
  dotsStart: 2.3,
  replyStart: 2.8,
  listStart: 3.4,
  listGap: 0.235,
  signoff: 5.45,

  // Act 2 — the truth
  shrink: [6.1, 6.95] as const,
  super1: 6.6,
  super2: 7.8,
  supersOut: 9.35,

  // Act 3 — the missing piece
  pop: 9.6,
  unshrink: [9.62, 10.55] as const,
  slotDraw: [9.95, 10.75] as const,
  slotText: 10.35,
  dock: 12.0,
  messageLand: 12.45,

  // Act 4 — inside the product
  step1: 13.2,
  question: 13.8,
  cursorIn: 14.25,
  tap: 15.0,
  step2: 15.6,
  step3: 16.8,
  step4: 18.0,
  allSet: 19.2,
  pray: 20.25,

  // Act 5 — the source of what we just watched
  scan: [21.15, 21.85] as const,
  code: 21.6,
  pageScroll: [26.05, 26.75] as const,

  // Act 6 — payoff
  end: 26.4,
  fin: 29.4,
};

export const DURATION = T.fin;
export const TOTAL_FRAMES = Math.round(DURATION * FPS);

/** Deterministic, human-feeling keystroke times for MESSAGE. */
export const TYPING: number[] = (() => {
  const r = rng(7);
  const times: number[] = [];
  let t = T.typeStart;
  for (let i = 0; i < MESSAGE.length; i += 1) {
    const ch = MESSAGE[i]!;
    const prev = MESSAGE[i - 1] ?? "";
    let gap = 0.043 + r() * 0.03;
    if (prev === " ") gap += r() * 0.035;
    if (prev === "." || prev === ",") gap += 0.13;
    if (ch === " ") gap *= 0.8;
    t += gap;
    times.push(t);
  }
  const scale = (1.87 - T.typeStart) / (times[times.length - 1]! - T.typeStart);
  return times.map((x) => T.typeStart + (x - T.typeStart) * scale);
})();

export function typedCount(t: number): number {
  let n = 0;
  for (const k of TYPING) if (k <= t) n += 1;
  return n;
}

/** Word-by-word streaming schedule for the widget's reply intro. */
export const REPLY_WORDS = WIDGET_REPLY_INTRO.split(" ");
export const replyWordTime = (i: number) => T.replyStart + i * 0.052;

/** Cue sheet consumed by scripts/audio/compose.py. */
export function audioCues() {
  return {
    fps: FPS,
    bpm: BPM,
    duration: DURATION,
    keys: TYPING.filter((k) => k >= 0),
    send: T.send,
    dots: T.dotsStart,
    replyWords: REPLY_WORDS.map((_, i) => replyWordTime(i)),
    listItems: WIDGET_STEPS.map((_, i) => T.listStart + i * T.listGap),
    signoff: T.signoff,
    shrink: T.shrink[0],
    super1: T.super1,
    super2: T.super2,
    supersOut: T.supersOut,
    pop: T.pop,
    slotDraw: T.slotDraw[0],
    slotText: T.slotText,
    dock: T.dock,
    messageLand: T.messageLand,
    steps: [T.step1, T.step2, T.step3, T.step4],
    question: T.question,
    tap: T.tap,
    allSet: T.allSet,
    pray: T.pray,
    scan: T.scan[0],
    code: T.code,
    pageScroll: T.pageScroll[0],
    end: T.end,
  };
}

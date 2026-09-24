import { rng } from "./lib/anim";

export const FPS = 60;
/** 112.5 BPM: one beat is exactly 32 frames at 60 fps, so cuts land on the grid. */
export const BPM = 112.5;
export const BEAT = 60 / BPM;
const b = (n: number) => n * BEAT;

export const MESSAGE = "Our flight lands 3 hours late. Can you fix the rest of today?";

export const WIDGET_GREETING = "Hi! I’m Acme Assistant. Ask me anything!";
export const WIDGET_REPLY_INTRO = "So sorry about the delay! Here’s how to update each booking yourself:";
export const WIDGET_STEPS = [
  "Open Itinerary → Car rental",
  "Tap “Modify pickup”",
  "Choose a new pickup time",
  "Go back to Itinerary → Hotel",
  "Tap “Add note”",
  "Repeat for dinner and the rest",
];
export const WIDGET_SIGNOFF = "Hope this helps!";
/** Typical canned prompts: every one of them asks for information, none for an action. */
export const WIDGET_SUGGESTIONS = ["What’s the weather in Lisbon?", "Top things to do", "Packing tips"];

/** All cue times in seconds. The film is one continuous camera take. */
export const T = {
  // Act 1 — the bolted-on assistant
  typeStart: -1.05,
  typeEnd: 1.42,
  send: b(3),
  dotsStart: 1.8,
  replyStart: 2.2,
  listStart: 2.78,
  listGap: 0.22,
  signoff: 4.08,

  // Act 2 — the truth
  shrink: [4.72, 5.55] as const,
  super1: b(10),
  super2: b(12),
  supersOut: 7.95,

  // Act 3 — the missing piece
  pop: b(16),
  unshrink: [8.55, 9.45] as const,
  slotDraw: [8.72, 9.2] as const,
  slotText: 8.95,
  dock: b(20),
  messageLand: b(20) + 0.43,

  // Act 4 — inside the product
  step1: b(22),
  question: b(23),
  cursorIn: 12.5,
  tap: b(25),
  step2: b(26),
  step3: b(28),
  step4: b(30),
  allSet: b(32),
  pray: b(34),

  // Act 5 — inside the agent panel: the code that put it there
  zoomIn: [18.72, 19.5] as const,
  clearPanel: [18.6, 18.78] as const,
  codeUI: b(37),
  codeServer: b(39),
  zoomOut: [24.42, 25.05] as const,

  // Act 6 — the same composition as act 2, opposite truth
  endShrink: [25.28, 26.12] as const,
  end: b(48),
  wordmark: b(50),
  fin: b(54),
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
  const scale = (T.typeEnd - T.typeStart) / (times[times.length - 1]! - T.typeStart);
  return times.map((x) => T.typeStart + (x - T.typeStart) * scale);
})();

export function typedCount(t: number): number {
  let n = 0;
  for (const k of TYPING) if (k <= t) n += 1;
  return n;
}

/** Word-by-word streaming schedule for the widget's reply intro. */
export const REPLY_WORDS = WIDGET_REPLY_INTRO.split(" ");
export const replyWordTime = (i: number) => T.replyStart + i * 0.045;

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
    zoomIn: T.zoomIn[0],
    codeUI: T.codeUI,
    codeServer: T.codeServer,
    zoomOut: T.zoomOut[0],
    endShrink: T.endShrink[0],
    end: T.end,
    wordmark: T.wordmark,
  };
}

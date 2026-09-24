/** Writes audio/cues.json from the picture timeline so sound is frame-locked. */
import { writeFileSync } from "node:fs";
import { BAR, BEAT, CLICKS, DOWNBEAT0, T, TYPE_TIMES, flightEnd, flightStart, sentAt } from "../src/timeline";
import { REQUEST } from "../src/data";

const cues = {
  bpm: 60 / BEAT,
  beat: BEAT,
  bar: BAR,
  downbeat0: DOWNBEAT0,
  duration: T.end,
  T,
  clicks: CLICKS,
  keys: TYPE_TIMES.map((t, i) => ({ t, ch: REQUEST[i] })),
  chips: Array.from({ length: 7 }, (_, i) => T.check + i * T.checkGap),
  liftoffs: Array.from({ length: 7 }, (_, i) => flightStart(i)),
  landings: Array.from({ length: 7 }, (_, i) => flightEnd(i)),
  sends: Array.from({ length: 7 }, (_, i) => sentAt(i)),
  yourLands: T.yourFly + 0.85,
};

writeFileSync("audio/cues.json", JSON.stringify(cues, null, 2));
console.log("audio/cues.json", Object.keys(cues).join(", "));

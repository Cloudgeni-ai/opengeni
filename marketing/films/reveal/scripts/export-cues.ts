// Writes audio/cues.json from src/timeline.ts so the score and picture share
// one timeline. Run: bun scripts/export-cues.ts
import { writeFileSync } from "node:fs";
import { FPS, REQUEST, T, TYPE_TIMES } from "../src/timeline";

const cues = {
  fps: FPS,
  request: REQUEST,
  typeTimes: TYPE_TIMES,
  ...T,
};

writeFileSync(new URL("../audio/cues.json", import.meta.url), `${JSON.stringify(cues, null, 2)}\n`);
console.log("audio/cues.json written");

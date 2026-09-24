/** Render review stills at given timestamps (seconds) with one bundle.
 * Usage: bun scripts/stills.ts out/stills 0.3 1.4 5.2 ... */
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { mkdirSync } from "node:fs";
import path from "node:path";

const [outDir = "out/stills", ...times] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
const composition = await selectComposition({ serveUrl, id: "TheLastClickSilent", inputProps: { withAudio: false } });
for (const s of times) {
  const frame = Math.min(composition.durationInFrames - 1, Math.round(Number(s) * composition.fps));
  const output = path.join(outDir, `t${Number(s).toFixed(2).padStart(5, "0")}.png`);
  await renderStill({ composition, serveUrl, output, frame, inputProps: { withAudio: false } });
  console.log(output);
}

// Render individual frames for review: node scripts/stills.mjs <frame> [frame...]
// Bundles once, then renders each frame to out/stills/fNNNN.png.
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const frames = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
if (frames.length === 0) {
  console.error("usage: node scripts/stills.mjs <frame> [frame...]");
  process.exit(1);
}

await mkdir("out/stills", { recursive: true });
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
const composition = await selectComposition({ serveUrl, id: "Reveal" });
for (const frame of frames) {
  const output = `out/stills/f${String(frame).padStart(4, "0")}.png`;
  await renderStill({ composition, serveUrl, output, frame });
  console.log(output);
}

import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(root, "src/service-worker.ts"), resolve(root, "src/popup.ts")],
  outdir: output,
  target: "browser",
  format: "esm",
  minify: true,
  sourcemap: "external",
  naming: "[dir]/[name].js",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const file of ["manifest.json", "popup.html", "popup.css"]) {
  await cp(resolve(root, file), resolve(output, file));
}

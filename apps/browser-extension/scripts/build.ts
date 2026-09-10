import { cp, mkdir, readFile, rm } from "node:fs/promises";
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
await cp(resolve(root, "icons"), resolve(output, "icons"), { recursive: true });

// Chrome deliberately requires an explicit user install for an ordinary
// existing profile. Ship one deterministic unpacked-extension archive for the
// first-party setup surface; production may replace that link with the Chrome
// Web Store without changing the React contract.
const installFiles = [
  "manifest.json",
  "popup.html",
  "popup.css",
  "popup.js",
  "service-worker.js",
  "icons/icon-128.png",
] as const;
const archiveEntries: Record<string, Uint8Array> = {};
for (const file of installFiles) {
  archiveEntries[`opengeni-browser-extension/${file}`] = await readFile(resolve(output, file));
}
await Bun.write(
  resolve(output, "opengeni-browser-extension.tar"),
  await new Bun.Archive(archiveEntries).bytes(),
);

// The Web Store assigns its own identity and rejects a development `key`.
// Preserve the unpacked package above and prepare a distinct store ZIP.
if (!Bun.argv.includes("--store")) process.exit(0);
const storeOutput = resolve(output, "store");
await mkdir(storeOutput, { recursive: true });
for (const file of installFiles) {
  await mkdir(dirname(resolve(storeOutput, file)), { recursive: true });
  await cp(resolve(output, file), resolve(storeOutput, file));
}
const storeManifest = JSON.parse(await readFile(resolve(output, "manifest.json"), "utf8"));
delete storeManifest.key;
await Bun.write(
  resolve(storeOutput, "manifest.json"),
  `${JSON.stringify(storeManifest, null, 2)}\n`,
);
const zip = Bun.spawnSync(
  ["zip", "-q", "-X", resolve(output, "opengeni-browser-extension-store.zip"), ...installFiles],
  { cwd: storeOutput },
);
if (zip.exitCode !== 0) throw new Error(`Store ZIP failed: ${zip.stderr.toString()}`);

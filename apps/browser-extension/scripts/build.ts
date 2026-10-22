import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { brandedManifest, brandedPopup, defaultBrand, ICON_FILES, readBrand } from "./brand";
import { packagedManifest, storeManifest } from "./manifest";

// `--brand <file>` builds a product's own branded extension (see scripts/brand.ts);
// without it, Opengeni Browser. `--out <dir>` picks the output folder.
const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    store: { type: "boolean", default: false },
    brand: { type: "string" },
    out: { type: "string" },
  },
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const brand = args.brand
  ? await readBrand(resolve(process.cwd(), args.brand))
  : defaultBrand(sourceManifest, root);
const output = args.out ? resolve(process.cwd(), args.out) : resolve(root, "dist");
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
  define: {
    __EXTENSION_BRAND_NAME__: JSON.stringify(brand.name),
    __EXTENSION_BRAND_PRODUCT__: JSON.stringify(brand.product),
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await Bun.write(
  resolve(output, "popup.html"),
  brandedPopup(await readFile(resolve(root, "popup.html"), "utf8"), brand),
);
await cp(resolve(root, "popup.css"), resolve(output, "popup.css"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const manifest = packagedManifest(brandedManifest(sourceManifest, brand), packageJson.version);
await Bun.write(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await mkdir(resolve(output, "icons"), { recursive: true });
for (const icon of ICON_FILES) {
  await cp(resolve(brand.iconsDir, icon), resolve(output, "icons", icon));
}
await cp(resolve(root, "fonts"), resolve(output, "fonts"), { recursive: true });

// Chrome deliberately requires an explicit user install for an ordinary
// existing profile. Ship one deterministic unpacked-extension archive for the
// development fallback on the first-party setup surface. Ordinary installs
// use the Chrome Web Store without changing the React contract.
const installFiles = [
  "manifest.json",
  "popup.html",
  "popup.css",
  "popup.js",
  "service-worker.js",
  ...ICON_FILES.map((icon) => `icons/${icon}`),
  "fonts/dm-sans-latin-wght-normal.woff2",
  "fonts/OFL.txt",
] as const;
const archiveEntries: Record<string, Uint8Array> = {};
for (const file of installFiles) {
  archiveEntries[`${brand.packageName}/${file}`] = await readFile(resolve(output, file));
}
await Bun.write(
  resolve(output, `${brand.packageName}.tar`),
  await new Bun.Archive(archiveEntries).bytes(),
);

// Preserve the unpacked package above and prepare a distinct store ZIP.
if (!args.store) process.exit(0);
const storeOutput = resolve(output, "store");
await mkdir(storeOutput, { recursive: true });
for (const file of installFiles) {
  await mkdir(dirname(resolve(storeOutput, file)), { recursive: true });
  await cp(resolve(output, file), resolve(storeOutput, file));
}
await Bun.write(
  resolve(storeOutput, "manifest.json"),
  `${JSON.stringify(storeManifest(manifest), null, 2)}\n`,
);
const zip = Bun.spawnSync(
  ["zip", "-q", "-X", resolve(output, `${brand.packageName}-store.zip`), ...installFiles],
  { cwd: storeOutput },
);
if (zip.exitCode !== 0) throw new Error(`Store ZIP failed: ${zip.stderr.toString()}`);

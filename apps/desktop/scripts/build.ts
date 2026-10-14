// Bundle the desktop app into dist/: one ES module for the main process (the
// SDK and the updater split into chunks that load after the window is up),
// CommonJS preloads (sandboxed preloads can't be modules), and static pages.

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const production = process.argv.includes("--production");
const kit = dirname(Bun.resolveSync("@opengeni/desktop/contract", root));

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

async function bundle(options: Parameters<typeof Bun.build>[0]): Promise<void> {
  const result = await Bun.build({
    target: "node",
    external: ["electron"],
    minify: production,
    sourcemap: production ? "none" : "linked",
    define: { "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development") },
    ...options,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

await bundle({
  entrypoints: [join(root, "src", "main.ts")],
  outdir: dist,
  format: "esm",
  splitting: true,
  naming: { entry: "[name].mjs", chunk: "chunks/[name]-[hash].mjs" },
});
for (const [entry, name] of [
  ["preload.ts", "preload.cjs"],
  ["welcome-preload.ts", "welcome-preload.cjs"],
] as const) {
  await bundle({
    entrypoints: [join(root, "src", entry)],
    outdir: dist,
    format: "cjs",
    naming: name,
  });
}

cpSync(join(kit, "pages"), join(dist, "pages"), { recursive: true });
cpSync(join(root, "..", "web", "public", "favicon.svg"), join(dist, "pages", "logo.svg"));
cpSync(join(root, "assets"), join(dist, "assets"), { recursive: true });
console.log(`built ${production ? "production" : "development"} bundle in ${dist}`);

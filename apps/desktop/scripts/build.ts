// Bundle the desktop app into dist/: one ES module for the main process (the
// SDK and the updater split into chunks that load after the window is up),
// CommonJS preloads (sandboxed preloads can't be modules), and static pages.
// dist/ is the packaged app's root: its package.json has no dependencies, so
// nothing from the workspace's node_modules reaches the app archive.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { macLoginAgentName, macLoginAgentPlist } from "@opengeni/desktop/mac-login-agent";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist");
const production = process.argv.includes("--production");
const kit = dirname(Bun.resolveSync("@opengeni/desktop/contract", root));
const appId = "ai.opengeni.desktop";

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
cpSync(join(root, "resources", "icon.png"), join(dist, "assets", "icon.png"));

// macOS: the launch agent that opens the app hidden at login, which
// electron-builder copies into Contents/Library/LaunchAgents.
const launchAgents = join(root, "build", "LaunchAgents");
rmSync(launchAgents, { recursive: true, force: true });
mkdirSync(launchAgents, { recursive: true });
writeFileSync(join(launchAgents, macLoginAgentName(appId)), macLoginAgentPlist(appId));

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
  string,
  unknown
>;
// Releases stamp their version without editing package.json.
const version = process.env.OPENGENI_DESKTOP_VERSION || manifest.version;
writeFileSync(
  join(dist, "package.json"),
  `${JSON.stringify(
    {
      name: "opengeni-desktop",
      productName: "Opengeni",
      version,
      description: manifest.description,
      homepage: manifest.homepage,
      license: manifest.license,
      author: manifest.author,
      type: "module",
      main: "main.mjs",
      // Linux: the installed packages' desktop entry, so URL scheme
      // registration and notifications name the right app.
      desktopName: "opengeni.desktop",
    },
    null,
    2,
  )}\n`,
);
console.log(`built ${production ? "production" : "development"} bundle in ${dist}`);

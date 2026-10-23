// Bundles the main-process module and the window's preload into desktop/out,
// and writes the launch agent that opens the app at login. build.sh and dev.sh
// run it; electron-builder packs desktop/out with main.cjs.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { macLoginAgentName, macLoginAgentPlist } from "@opengeni/desktop/mac-login-agent";

const here = import.meta.dirname;
const out = join(here, "out");
const APP_ID = "ai.opengeni.simple";

rmSync(out, { recursive: true, force: true });
const built = await Bun.build({
  entrypoints: [join(here, "computer.ts"), join(here, "preload.ts")],
  outdir: out,
  target: "node",
  format: "cjs",
  naming: "[name].cjs",
  external: ["electron"],
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}

// electron-builder copies build/LaunchAgents into Contents/Library/LaunchAgents.
const launchAgents = join(here, "build", "LaunchAgents");
mkdirSync(launchAgents, { recursive: true });
writeFileSync(join(launchAgents, macLoginAgentName(APP_ID)), macLoginAgentPlist(APP_ID));
console.log(`bundled ${built.outputs.map((output) => output.path).join(", ")}`);

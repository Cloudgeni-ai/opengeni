/**
 * Bundle the gateway shell's browser script (the shared Site bridge host plus
 * the gateway transport) into a TypeScript module the Worker inlines with a
 * per-response nonce. `--check` fails when the committed module is stale.
 */
import { resolve } from "node:path";
import { MERGEABLE_MINIFY, mergeableScriptModule } from "../../../scripts/mergeable-script-module";

const app = resolve(import.meta.dir, "..");

export async function buildShellModule(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(app, "src/shell/shell-entry.ts")],
    target: "browser",
    format: "iife",
    minify: MERGEABLE_MINIFY,
  });
  if (!result.success) throw new AggregateError(result.logs, "Gateway shell build failed");
  // Inlined in a <script> element: never let the source end or comment out the element.
  const script = (await result.outputs[0]!.text())
    .replace(/<\/script/giu, "<\\/script")
    .replace(/<!--/gu, "<\\!--");
  return mergeableScriptModule({
    generator: "apps/site-gateway/scripts/build-shell.ts",
    name: "SITE_GATEWAY_SHELL_SCRIPT",
    script,
  });
}

if (import.meta.main) {
  const destination = resolve(app, "src/shell/shell-script.gen.ts");
  const source = await buildShellModule();
  const file = Bun.file(destination);
  const current = (await file.exists()) ? await file.text() : null;
  if (process.argv.includes("--check")) {
    if (current !== source) throw new Error("Regenerate the gateway shell: bun run build:shell");
  } else if (current !== source) {
    await Bun.write(destination, source);
  }
  console.log(`gateway shell: ${source.length} bytes`);
}

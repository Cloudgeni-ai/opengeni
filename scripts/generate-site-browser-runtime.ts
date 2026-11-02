import { resolve } from "node:path";
import { MERGEABLE_MINIFY, mergeableScriptModule } from "./mergeable-script-module";

const root = resolve(import.meta.dir, "..");
const result = await Bun.build({
  entrypoints: [resolve(root, "packages/sdk/src/site-browser-entry.ts")],
  target: "browser",
  format: "iife",
  minify: MERGEABLE_MINIFY,
});
if (!result.success) throw new AggregateError(result.logs, "Site runtime build failed");
const script = await result.outputs[0]!.text();
const source = mergeableScriptModule({
  generator: "scripts/generate-site-browser-runtime.ts",
  name: "SITE_BROWSER_RUNTIME",
  script,
});
const destination = resolve(root, "packages/sdk/src/site-browser-runtime.gen.ts");
if (process.argv.includes("--check")) {
  if ((await Bun.file(destination).text()) !== source)
    throw new Error("Regenerate the Site browser runtime");
} else if (
  !(await Bun.file(destination).exists()) ||
  (await Bun.file(destination).text()) !== source
) {
  await Bun.write(destination, source);
}

import { resolve } from "node:path";
import { MERGEABLE_MINIFY, mergeableScriptModule } from "./mergeable-script-module";

const root = resolve(import.meta.dir, "..");
export async function renderSiteBrowserRuntime(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(root, "packages/sdk/src/site-browser-entry.ts")],
    target: "browser",
    format: "iife",
    minify: MERGEABLE_MINIFY,
    plugins: [
      {
        name: "site-runtime-has-no-npm-client-version",
        setup(build) {
          // This checked-in host bridge is not a published npm client. Keep its
          // bytes independent of package bumps: Version PR tree reproduction does
          // not rebuild browser bundles. Ordinary published SDK builds still embed
          // the real package version; only this exact JSON import is substituted.
          build.onLoad({ filter: /[/\\]packages[/\\]sdk[/\\]package\.json$/ }, (args) => {
            if (resolve(args.path) !== resolve(root, "packages/sdk/package.json")) return;
            return { contents: '{"version":null}', loader: "json" };
          });
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "Site runtime build failed");
  const script = await result.outputs[0]!.text();
  return mergeableScriptModule({
    generator: "scripts/generate-site-browser-runtime.ts",
    name: "SITE_BROWSER_RUNTIME",
    script,
  });
}
if (import.meta.main) {
  const source = await renderSiteBrowserRuntime();
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
}

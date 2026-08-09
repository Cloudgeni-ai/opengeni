import { measureBrowserBuildClosure } from "./support";

const result = await Bun.build({
  entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
  external: ["@resvg/resvg-js", "docx", "exceljs", "pptxgenjs", "sharp"],
});
if (!result.success) {
  throw new AggregateError(result.logs, "artifact browser facade build failed");
}
process.stdout.write(JSON.stringify(await measureBrowserBuildClosure(result.outputs)));

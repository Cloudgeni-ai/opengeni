import { defineConfig } from "tsup";

import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/reference.ts",
    "src/native.ts",
    "src/runtime.ts",
    "src/runtime-cli.ts",
    "src/runtime-cli-entry.ts",
    "src/runtime-development.ts",
    "src/materializer-cli.ts",
    "src/materializer-cli-entry.ts",
    "src/production-spreadsheet.ts",
    "src/production-document.ts",
    "src/production-presentation.ts",
    "src/document.ts",
    "src/document-render.ts",
    "src/document-docx-codec.ts",
    "src/presentation.ts",
    "src/presentation-render.ts",
    "src/presentation-pptx.ts",
    "src/spreadsheet.ts",
    "src/spreadsheet-render.ts",
    "src/spreadsheet-xlsx-codec.ts",
  ],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  // Keep codecs/rasterizers behind their lazy imports. Consumers pay for only
  // the formats they use, while package dependencies remain normal npm edges.
  external: [/^@opengeni\//, ...Object.keys(pkg.dependencies ?? {})],
});

import { defineConfig } from "tsup";

// @opengeni/codex ships ESM + .d.ts. Every @opengeni/* specifier is external so
// sibling packages resolve through their own published versions.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    constants: "src/constants.ts",
    "realtime-v3": "src/realtime-v3.ts",
  },
  format: ["esm"],
  target: "es2022",
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//],
});

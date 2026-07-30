import { defineConfig } from "tsup";
import { emitDeclarationsOnSuccess } from "../../scripts/tsup-declarations";

// @opengeni/codex ships ESM + .d.ts. Every @opengeni/* specifier is external so
// sibling packages resolve through their own published versions.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    constants: "src/constants.ts",
  },
  format: ["esm"],
  target: "es2022",
  dts: false,
  onSuccess: emitDeclarationsOnSuccess,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//],
});

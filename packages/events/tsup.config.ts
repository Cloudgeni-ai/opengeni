import { defineConfig } from "tsup";
import { emitDeclarationsOnSuccess } from "../../scripts/tsup-declarations";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: false,
  onSuccess: emitDeclarationsOnSuccess,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//],
});

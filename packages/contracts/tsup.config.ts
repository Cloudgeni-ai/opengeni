import { defineConfig } from "tsup";
import { emitDeclarationsOnSuccess } from "../../scripts/tsup-declarations";

// @opengeni/contracts ships ESM + .d.ts. zod is its only runtime dependency
// and stays external (a normal `dependencies` entry), so consumers dedupe it.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: false,
  onSuccess: emitDeclarationsOnSuccess,
  sourcemap: true,
  clean: true,
});

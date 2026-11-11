import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  // CPU sampling loads Bun's built-in profiler at run time.
  external: ["bun:jsc"],
});

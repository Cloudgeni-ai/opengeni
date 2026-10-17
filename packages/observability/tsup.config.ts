import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  // The CPU sampler loads Bun's built-in profiler at run time, only under Bun.
  external: ["bun:jsc"],
});

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/testing/index.ts", "src/testing/fake-provider.ts"],
  // The shared provider contract suite runs inside `bun test`.
  external: ["bun:test"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
});

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/browser-state-authority.ts", "src/browser-controller-authority.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
});

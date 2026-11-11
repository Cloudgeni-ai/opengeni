import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/permission-guide.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//, "electron"],
});

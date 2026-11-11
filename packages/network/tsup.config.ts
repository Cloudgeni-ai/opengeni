import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/responses-websocket.ts", "src/azure-entra.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
});

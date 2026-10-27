import { cpSync } from "node:fs";

import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/contract.ts",
    "src/main/mac-login-agent.ts",
    "src/main/system-audio.ts",
    "src/preload/content.ts",
    "src/preload/system-audio.ts",
    "src/preload/welcome.ts",
  ],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: [/^@opengeni\//, "electron", "electron-updater"],
  // Apps copy the welcome pages from beside the contract entry, so they ship
  // next to it in dist as they sit next to it in src.
  async onSuccess() {
    cpSync("src/pages", "dist/pages", { recursive: true });
  },
});

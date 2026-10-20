import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import webConfig from "../vite.config";

// Isolated browser fixture: the real file page and library with deterministic files.
const config = webConfig as UserConfig;
export default defineConfig({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      "@/context": fileURLToPath(new URL("./file-audience-context.ts", import.meta.url)),
      "@": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
});

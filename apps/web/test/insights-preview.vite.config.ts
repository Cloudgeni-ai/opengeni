import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import webConfig from "../vite.config";

// Isolated browser preview: the real Insights UI over deterministic data.
const config = webConfig as UserConfig;
export default defineConfig({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      "@/context": fileURLToPath(new URL("./insights-preview-context.ts", import.meta.url)),
      "@": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
});

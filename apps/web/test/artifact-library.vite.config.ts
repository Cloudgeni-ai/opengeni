import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import webConfig from "../vite.config";

// Isolated browser fixture: real UI and retained loader, deterministic metadata.
const config = webConfig as UserConfig;
export default defineConfig({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      "@/context": fileURLToPath(new URL("./artifact-library-context.ts", import.meta.url)),
      "@": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
});

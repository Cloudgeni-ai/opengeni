import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import webConfig from "../vite.config";
import { previewHost } from "./preview-host";

// Isolated browser fixture: the real Site page with deterministic metadata.
const config = webConfig as UserConfig;
export default defineConfig({
  ...config,
  plugins: [...(config.plugins ?? []), previewHost()],
  resolve: {
    ...config.resolve,
    alias: {
      "@/context": fileURLToPath(new URL("./site-audience-context.ts", import.meta.url)),
      "@": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
});

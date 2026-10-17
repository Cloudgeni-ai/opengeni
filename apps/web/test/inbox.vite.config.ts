import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import webConfig from "../vite.config";

// Isolated browser fixture: the real Inbox page with deterministic items.
const config = webConfig as UserConfig;
export default defineConfig({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      "@/context": fileURLToPath(new URL("./inbox-context.ts", import.meta.url)),
      "@": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
});

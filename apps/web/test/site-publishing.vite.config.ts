import { fileURLToPath } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import webConfig from "../vite.config";

// Isolated browser fixture: the production Site page, Publish to web page and
// Site sign-in page with sample data.
const config = webConfig as UserConfig;
export default defineConfig({
  ...config,
  resolve: {
    ...config.resolve,
    alias: {
      "@/context": fileURLToPath(new URL("./site-publishing-context.ts", import.meta.url)),
      "@": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
});

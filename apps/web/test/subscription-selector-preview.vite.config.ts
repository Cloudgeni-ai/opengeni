import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { previewHost } from "./preview-host";

// Local-only fixture: the production session header, account control and
// composer model picker for each subscription provider, with synthetic data.
export default defineConfig({
  plugins: [react(), tailwindcss(), previewHost()],
  resolve: {
    alias: [{ find: "@", replacement: path.resolve(import.meta.dirname, "../src") }],
    dedupe: ["react", "react-dom"],
  },
});

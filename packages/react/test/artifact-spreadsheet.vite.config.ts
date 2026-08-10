import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const demoRoot = resolve(import.meta.dirname, "../demo");

/** Stable, non-watching fixture server for deterministic browser assertions. */
export default defineConfig({
  root: demoRoot,
  plugins: [viteReact(), tailwindcss()],
  server: {
    cors: true,
    hmr: false,
    watch: { ignored: ["**/*"] },
  },
  optimizeDeps: {
    entries: [resolve(demoRoot, "artifact-spreadsheet-scroll-fixture.tsx")],
  },
});

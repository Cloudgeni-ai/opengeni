import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.OPENGENI_SVELTE_DEMO_BASE ?? "/",
  plugins: [svelte()],
  build: {
    outDir: process.env.OPENGENI_SVELTE_DEMO_OUT_DIR ?? "../demo-dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});

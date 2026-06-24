import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [viteReact(), tailwindcss()],
  build: {
    rollupOptions: {
      // Two pages: the full component harness (index.html) and the dedicated
      // timeline tool-call renderer harness (timeline.html), both static.
      input: {
        main: resolve(__dirname, "index.html"),
        timeline: resolve(__dirname, "timeline.html"),
      },
    },
  },
});

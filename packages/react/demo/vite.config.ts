import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.OPENGENI_REACT_DEMO_BASE ?? "/",
  plugins: [viteReact(), tailwindcss()],
  build: {
    outDir: process.env.OPENGENI_REACT_DEMO_OUT_DIR ?? "../demo-dist",
    // The harness deliberately exposes the full lazy language/theme catalog.
    // Keep the warning boundary aligned with the production app's enforced
    // 800 kB raw lazy-chunk budget; the largest generated chunk remains below
    // that limit and production additionally gates every asset by gzip size.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      // Pages: the full component harness (index.html), the timeline tool-call
      // renderer harness (timeline.html), the queue presentation browser
      // regression (queue.html), and the Machines / enrollment UI screenshot
      // harness (machines.html — M9 / V12), all static.
      input: {
        main: resolve(__dirname, "index.html"),
        timeline: resolve(__dirname, "timeline.html"),
        fleetPolicy: resolve(__dirname, "fleet-policy.html"),
        queue: resolve(__dirname, "queue.html"),
        machines: resolve(__dirname, "machines.html"),
        workbench: resolve(__dirname, "workbench.html"),
        workbenchDock: resolve(__dirname, "workbench-dock.html"),
        workbenchEmbed: resolve(__dirname, "workbench-embed.html"),
        terminal: resolve(__dirname, "terminal.html"),
        transcription: resolve(__dirname, "transcription.html"),
        realtime: resolve(__dirname, "realtime.html"),
      },
    },
  },
});

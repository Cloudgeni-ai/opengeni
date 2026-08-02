import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const allowedHosts = process.env.OPENGENI_WEB_ALLOWED_HOSTS?.split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  build: {
    // Vite's default 500 kB raw threshold misclassifies deliberately lazy
    // syntax/WASM assets. The post-build budget gate measures the recursive
    // initial graph and every chunk by gzip size; 800 kB remains a hard raw cap.
    chunkSizeWarningLimit: 800,
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // The session workbench is the primary interactive route. Keep
              // its static graph route-aware, but coalesce tiny shared groups
              // so a cold navigation does not fan out into dozens of requests.
              name: "session",
              test: /src[\\/]routes[\\/]session\.tsx$/,
              includeDependenciesRecursively: true,
              entriesAware: true,
              entriesAwareMergeThreshold: 128 * 1024,
              priority: 2,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 3000,
    ...(allowedHosts?.length ? { allowedHosts } : {}),
  },
  preview: {
    port: 3000,
    ...(allowedHosts?.length ? { allowedHosts } : {}),
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
  },
  plugins: [
    tanstackRouter({ target: "react", enableRouteGeneration: false }),
    viteReact(),
    tailwindcss(),
    {
      name: "compact-index-html",
      transformIndexHtml: {
        order: "post",
        handler: (html) => html.replace(/>\s+</g, "><").trim(),
      },
    },
  ],
});

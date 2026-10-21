// The Opengeni add-in for Excel (apps/web/office): its own small pages,
// built into the web app's dist under /office/ and served by the same origin.
import path from "node:path";
import { fileURLToPath } from "node:url";

import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(dirname, "office"),
  base: "/office/",
  envDir: dirname,
  // The pane renders the published session app with its published stylesheet.
  plugins: [viteReact()],
  build: {
    outDir: path.resolve(dirname, "dist/office"),
    emptyOutDir: true,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        index: path.resolve(dirname, "office/index.html"),
        "auth-callback": path.resolve(dirname, "office/auth-callback.html"),
      },
    },
  },
});

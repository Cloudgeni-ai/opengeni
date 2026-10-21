import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { previewHost } from "./preview-host";

// Preview-only context; status and card components/styles are production imports.
export default defineConfig({
  plugins: [react(), tailwindcss(), previewHost()],
  resolve: {
    alias: [
      {
        find: /^@\/context$/,
        replacement: path.resolve(
          import.meta.dirname,
          "fixtures/knowledge-index-preview/context.ts",
        ),
      },
      { find: "@", replacement: path.resolve(import.meta.dirname, "../src") },
    ],
    dedupe: ["react", "react-dom"],
  },
});

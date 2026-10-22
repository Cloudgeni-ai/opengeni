import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { previewHost } from "./preview-host";

export default defineConfig({
  plugins: [react(), tailwindcss(), previewHost()],
  resolve: {
    alias: [
      {
        // Components read the app context from either module.
        find: /^(?:@\/context|@opengeni\/react\/app\/app-context)$/,
        replacement: path.resolve(
          import.meta.dirname,
          "fixtures/model-defaults-preview/context.ts",
        ),
      },
      { find: "@", replacement: path.resolve(import.meta.dirname, "../src") },
    ],
    dedupe: ["react", "react-dom"],
  },
});

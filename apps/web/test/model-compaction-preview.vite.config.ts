import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@\/context$/,
        replacement: path.resolve(
          import.meta.dirname,
          "fixtures/model-compaction-preview/context.ts",
        ),
      },
      { find: "@", replacement: path.resolve(import.meta.dirname, "../src") },
    ],
    dedupe: ["react", "react-dom"],
  },
});

import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Preview imports the production conversation card and styles. Only its
// authenticated app context is replaced with sample GitHub binding states.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@\/context$/,
        replacement: path.resolve(
          import.meta.dirname,
          "fixtures/github-connect-preview/context.ts",
        ),
      },
      { find: "@", replacement: path.resolve(import.meta.dirname, "../src") },
    ],
    dedupe: ["react", "react-dom"],
  },
});

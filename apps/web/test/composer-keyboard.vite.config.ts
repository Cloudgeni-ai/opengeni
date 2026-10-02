import path from "node:path";
import { realpathSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    fs: {
      // Detached worktrees can share installed dependencies, including font files.
      allow: [
        path.resolve(import.meta.dirname, "../../.."),
        realpathSync(path.resolve(import.meta.dirname, "../../../node_modules")),
      ],
    },
  },
  resolve: {
    alias: [
      {
        find: "@/context",
        replacement: path.resolve(import.meta.dirname, "composer-keyboard-context.ts"),
      },
      { find: "@", replacement: path.resolve(import.meta.dirname, "../src") },
    ],
    dedupe: ["react", "react-dom", "radix-ui"],
  },
});

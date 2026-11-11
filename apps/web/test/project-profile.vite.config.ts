import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { previewHost } from "./preview-host";

export default defineConfig({
  plugins: [react(), tailwindcss(), previewHost()],
  // The fixture is served once per test run; skip file watching so a busy
  // machine's inotify limits can't stop the server from starting.
  server: { watch: null },
  resolve: {
    alias: [
      {
        find: "@/context",
        replacement: path.resolve(import.meta.dirname, "project-profile-context.ts"),
      },
      {
        find: "@/components/rail/rail-context",
        replacement: path.resolve(import.meta.dirname, "project-profile-context.ts"),
      },
      { find: "@", replacement: path.resolve(import.meta.dirname, "../src") },
    ],
    dedupe: ["react", "react-dom", "radix-ui"],
  },
});

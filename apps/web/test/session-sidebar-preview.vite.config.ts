import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { previewHost } from "./preview-host";

export default defineConfig({
  plugins: [react(), tailwindcss(), previewHost()],
  resolve: {
    alias: [
      {
        find: "@/context",
        replacement: path.resolve(import.meta.dirname, "session-sidebar-context.ts"),
      },
      {
        find: "@/components/rail/rail-context",
        replacement: path.resolve(import.meta.dirname, "session-sidebar-context.ts"),
      },
      { find: "@", replacement: path.resolve(import.meta.dirname, "../src") },
    ],
    dedupe: ["react", "react-dom", "radix-ui"],
  },
});

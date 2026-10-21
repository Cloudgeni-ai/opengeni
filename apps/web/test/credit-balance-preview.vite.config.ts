import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { previewHost } from "./preview-host";

// Standalone screenshot fixture importing the actual production balance component.
export default defineConfig({
  plugins: [react(), tailwindcss(), previewHost()],
  resolve: {
    alias: [{ find: "@", replacement: path.resolve(import.meta.dirname, "../src") }],
    dedupe: ["react", "react-dom"],
  },
});

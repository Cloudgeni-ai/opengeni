import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { previewHost } from "./preview-host";

// Serves test/command-menu-sites-preview.html: the real sidebar, Site view and
// ⌘K menu over sample workspace data.
const stub = path.resolve(import.meta.dirname, "command-menu-sites-context.ts");
export default defineConfig({
  plugins: [react(), tailwindcss(), previewHost()],
  resolve: {
    alias: [
      { find: "@/context", replacement: stub },
      { find: "@/components/rail/rail-context", replacement: stub },
      { find: "@", replacement: path.resolve(import.meta.dirname, "../src") },
    ],
    dedupe: ["react", "react-dom", "radix-ui"],
  },
});

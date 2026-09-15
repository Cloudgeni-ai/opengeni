import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const here = path.dirname(fileURLToPath(import.meta.url));
// Fixture-only adapters replace authentication/network, not the production
// timeline, preview components, iframe bridge, styles, or scroll behavior.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: "@/context", replacement: path.join(here, "chat-media-context-fixture.ts") },
      { find: "@/lib/appearance", replacement: path.join(here, "chat-media-context-fixture.ts") },
      { find: "@", replacement: path.resolve(here, "../src") },
    ],
    dedupe: ["react", "react-dom", "radix-ui"],
  },
});

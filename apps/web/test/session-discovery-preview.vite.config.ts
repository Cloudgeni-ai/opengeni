import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: "@/context",
        replacement: path.resolve(import.meta.dirname, "session-discovery-preview-context.ts"),
      },
      { find: "@", replacement: path.resolve(import.meta.dirname, "../src") },
    ],
    dedupe: ["react", "react-dom", "radix-ui"],
  },
  server: { host: "127.0.0.1", port: 4330, strictPort: true },
});

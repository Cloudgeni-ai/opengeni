import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      "@/context": fileURLToPath(
        new URL("./workspace-api-keys-preview-context.ts", import.meta.url),
      ),
      "@tanstack/react-router": fileURLToPath(
        new URL("./workspace-api-keys-preview-router.ts", import.meta.url),
      ),
      "@": fileURLToPath(new URL("../src", import.meta.url)),
    },
    dedupe: ["react", "react-dom", "radix-ui"],
  },
  server: { host: "127.0.0.1", port: 4336 },
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { previewHost } from "./preview-host";
export default defineConfig({
  plugins: [react(), tailwind(), previewHost()],
  resolve: {
    alias: {
      "@/context": fileURLToPath(new URL("./retained-text-preview-context.ts", import.meta.url)),
      "@": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
  server: { host: "127.0.0.1", port: 4317 },
});

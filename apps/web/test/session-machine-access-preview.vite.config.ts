import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: "@/lib/use-workspace-rigs",
        replacement: fileURLToPath(
          new URL("./session-machine-access-preview-hooks.ts", import.meta.url),
        ),
      },
      {
        find: "@/lib/use-workspace-machines",
        replacement: fileURLToPath(
          new URL("./session-machine-access-preview-hooks.ts", import.meta.url),
        ),
      },
      { find: "@", replacement: fileURLToPath(new URL("../src", import.meta.url)) },
    ],
    dedupe: ["react", "react-dom", "radix-ui"],
  },
  server: { host: "127.0.0.1", port: 3188, strictPort: true },
});

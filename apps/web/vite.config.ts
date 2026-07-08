import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const allowedHosts = process.env.OPENGENI_WEB_ALLOWED_HOSTS?.split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  server: {
    port: 3000,
    ...(allowedHosts?.length ? { allowedHosts } : {}),
  },
  preview: {
    port: 3000,
    ...(allowedHosts?.length ? { allowedHosts } : {}),
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
  },
  plugins: [
    tanstackRouter({ target: "react", enableRouteGeneration: false }),
    viteReact(),
    tailwindcss(),
  ],
});

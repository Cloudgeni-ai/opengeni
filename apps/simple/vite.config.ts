import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { opengeniApiUrl, SIMPLE_SERVER_PORT } from "./server/config";

// The simple app talks to Opengeni through this origin: `/v1` goes to the
// Opengeni API, `/app` to the small companion server that keeps agent profiles,
// avatars and usage. The browser never needs another origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5190,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/v1": { target: opengeniApiUrl(), changeOrigin: true, ws: true },
      "/app": { target: `http://127.0.0.1:${SIMPLE_SERVER_PORT}`, changeOrigin: true },
    },
  },
});

import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [viteReact()],
  server: {
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:4200", changeOrigin: true },
    },
  },
});

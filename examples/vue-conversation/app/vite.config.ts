import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  server: {
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:4104" },
  },
});

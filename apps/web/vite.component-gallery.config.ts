import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@opengeni/react/connect": resolve(
        import.meta.dirname,
        "../../packages/react/src/device-authorization.tsx",
      ),
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  build: {
    outDir: "dist-component-gallery",
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    rollupOptions: { input: resolve(import.meta.dirname, "component-gallery.html") },
  },
});

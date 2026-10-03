import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

// Serves the production onboarding components with a recording fake client:
//   apps/web/node_modules/.bin/vite --config apps/web/test/signup-onboarding.vite.config.ts
//   bun apps/web/test/signup-onboarding.browser.ts
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react(), tailwind()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
    dedupe: ["react", "react-dom", "radix-ui"],
  },
  server: { host: "127.0.0.1", port: 4341, strictPort: true },
});

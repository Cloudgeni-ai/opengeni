import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Organization Accounts with a former workspace account, rendered with the real
// Models page against a synthetic client (fixtures/workspace-accounts-preview).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@\/context$/,
        replacement: path.resolve(
          import.meta.dirname,
          "fixtures/workspace-accounts-preview/context.ts",
        ),
      },
      {
        find: /^@tanstack\/react-router$/,
        replacement: path.resolve(
          import.meta.dirname,
          "fixtures/workspace-accounts-preview/router.ts",
        ),
      },
      { find: "@", replacement: path.resolve(import.meta.dirname, "../src") },
    ],
    dedupe: ["react", "react-dom"],
  },
});

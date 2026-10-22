import path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import sidebar from "./session-sidebar-preview.vite.config";

export default mergeConfig(
  sidebar,
  defineConfig({
    resolve: {
      alias: [
        {
          find: "@/context",
          replacement: path.resolve(import.meta.dirname, "desktop-rail-context.ts"),
        },
        {
          find: "@/components/rail/rail-context",
          replacement: path.resolve(import.meta.dirname, "desktop-rail-context.ts"),
        },
      ],
    },
  }),
);

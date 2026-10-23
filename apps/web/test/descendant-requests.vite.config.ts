import path from "node:path";
import { realpathSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { previewHost } from "./preview-host";

// Preview of a parent session's sub-session requests:
// `vite --config test/descendant-requests.vite.config.ts`, then open
// /test/descendant-requests.html?scenario=question|approval|stack|other (add &light).
export default defineConfig({
  plugins: [react(), tailwindcss(), previewHost()],
  server: {
    fs: {
      // Detached worktrees can share installed dependencies, including font files.
      allow: [
        path.resolve(import.meta.dirname, "../../.."),
        realpathSync(path.resolve(import.meta.dirname, "../../../node_modules")),
      ],
    },
  },
  resolve: {
    alias: [{ find: "@", replacement: path.resolve(import.meta.dirname, "../src") }],
    dedupe: ["react", "react-dom", "radix-ui"],
  },
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { previewHost } from "./preview-host";

// The production Settings > Computer use page; only the app context and the
// desktop's This computer context are stood in for.
const fixture = fileURLToPath(
  new URL("./fixtures/this-computer-preview/host.tsx", import.meta.url),
);
export default defineConfig({
  plugins: [react(), tailwind(), previewHost()],
  resolve: {
    alias: [
      ...["@/context", "@/api", "@opengeni/react/app/components/desktop/this-computer"].map(
        (find) => ({ find, replacement: fixture }),
      ),
      { find: "@", replacement: fileURLToPath(new URL("../src", import.meta.url)) },
    ],
    dedupe: ["react", "react-dom", "radix-ui"],
  },
  // No file watching: screenshots need none, and a busy machine may have no
  // watches left to give.
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT ?? 3241),
    strictPort: true,
    watch: null,
  },
});

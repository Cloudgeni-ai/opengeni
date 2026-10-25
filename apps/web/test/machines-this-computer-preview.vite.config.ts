import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { previewHost } from "./preview-host";

// Settings > Machines and the sidebar's "Use this computer" inside the desktop
// app, with a stand-in desktop bridge. `?scene=` picks the computer's state;
// `?environment=web` drops the bridge to show the browser's dialog.
const fixture = fileURLToPath(
  new URL("./fixtures/machines-this-computer-preview/host.tsx", import.meta.url),
);
export default defineConfig({
  root: fileURLToPath(new URL("./fixtures/machines-this-computer-preview", import.meta.url)),
  plugins: [react(), tailwind(), previewHost()],
  resolve: {
    alias: [
      ...["@/context", "@/lib/use-workspace-machines"].map((find) => ({
        find,
        replacement: fixture,
      })),
      { find: "@", replacement: fileURLToPath(new URL("../src", import.meta.url)) },
    ],
    dedupe: ["react", "react-dom", "radix-ui"],
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PREVIEW_PORT ?? 3198),
    strictPort: true,
  },
});

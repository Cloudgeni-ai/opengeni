import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { previewHost } from "./preview-host";

const fixture = fileURLToPath(
  new URL("./fixtures/computer-connect-preview/host.tsx", import.meta.url),
);
export default defineConfig({
  plugins: [react(), tailwind(), previewHost()],
  resolve: {
    alias: [
      ...[
        "@/context",
        "@/api",
        "@/lib/use-workspace-machines",
        "@/components/desktop/this-computer",
      ].map((find) => ({ find, replacement: fixture })),
      { find: "@", replacement: fileURLToPath(new URL("../src", import.meta.url)) },
    ],
    dedupe: ["react", "react-dom", "radix-ui"],
  },
  server: { host: "127.0.0.1", port: 3199, strictPort: true },
});

import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { uiverifyPlugin } from "@uiverify/vitest/plugin";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Serve hoisted workspace fonts from normal URLs: the pinned SDK skips /@fs/.
  root: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [react(), tailwindcss(), uiverifyPlugin()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: ["react", "react-dom", "radix-ui"],
  },
  test: {
    // Keep Vitest browser captures separate from the repository's Bun unit tests.
    include: ["apps/web/test/visual/**/*.visual.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        contextOptions: { locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" },
      }),
      instances: [{ browser: "chromium" }],
      viewport: { width: 1100, height: 900 },
    },
  },
});

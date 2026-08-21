import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { safeReactHmrPlugin } from "./vite-safe-react-hmr";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const browserExtensionArchive = path.resolve(
  dirname,
  "../browser-extension/dist/opengeni-browser-extension.tar",
);
const allowedHosts = process.env.OPENGENI_WEB_ALLOWED_HOSTS?.split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  build: {
    // The canonical post-build budget below computes gzip sizes for the exact
    // initial/session graphs and every chunk. Avoid Vite recomputing compressed
    // sizes for hundreds of lazy syntax assets before that bounded gate runs.
    reportCompressedSize: false,
    // Vite's default 500 kB raw threshold misclassifies deliberately lazy
    // syntax/WASM assets. The post-build budget gate measures the recursive
    // initial graph and every chunk by gzip size; 800 kB remains a hard raw cap.
    chunkSizeWarningLimit: 800,
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // Keep Radix, Lucide's eager icon factory, and the two class-name
              // helpers (web `cn` and @opengeni/react `cn` with clsx and
              // tailwind-merge) in one UI runtime. entriesAware route merging
              // can otherwise split Popper scopes, place an icon and its
              // factory across a circular chunk, or fold a tiny universally
              // shared helper into a route-only chunk and drag that route's
              // code into the initial graph.
              name: "ui-runtime",
              test: /(?:(?:node_modules|\.bun)[\\/](?:@radix-ui(?:\+|\/)|radix-ui(?:@|\/)|clsx(?:@|\/)|tailwind-merge(?:@|\/))|apps[\\/]web[\\/]src[\\/]lib[\\/]utils\.ts$|packages[\\/]react[\\/]src[\\/]lib[\\/]cn\.ts$|[\\/]lucide-react[\\/]dist[\\/]esm[\\/](?:(?:createLucideIcon|Icon|context|defaultAttributes)\.mjs|shared[\\/]))/,
              priority: 15,
            },
            {
              // These tiny, always-loaded navigation and status primitives are
              // one app-shell unit. Keeping them together avoids an extra
              // request without pulling any route implementation into startup.
              name: "app-shell",
              test: /(?:apps[\\/]web[\\/]src[\\/](?:lib[\\/]routes\.ts|components[\\/]ui[\\/](?:empty-state|meta-chip|status-dot)\.tsx)|lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](?:chevron-down|chevron-left|circle-alert)\.mjs)$/,
              includeDependenciesRecursively: false,
              priority: 4,
            },
            {
              // The hierarchy rail is substantial and belongs to the lazy
              // workspace shell. Its channel, browse, pin, and row-action
              // expansion must not turn route-shared helpers into startup
              // dependencies for signed-out and non-workspace pages.
              name: "session-rail",
              test: /apps[\\/]web[\\/]src[\\/]components[\\/]rail[\\/]session-list\.tsx$/,
              includeDependenciesRecursively: true,
              entriesAware: true,
              entriesAwareMergeThreshold: 192 * 1024,
              priority: 3,
            },
            {
              // A few tiny primitives are shared by the initial composer and
              // the active-session route. Pin that boundary so entry-aware
              // merging cannot use an icon or label helper to pull the full
              // session workbench into startup.
              name: "session-shared-primitives",
              test: /(?:apps[\\/]web[\\/]src[\\/]lib[\\/](?:format|machine-selectability)\.ts|packages[\\/]react[\\/]src[\\/](?:hooks[\\/]use-machines|workstream-control-event)\.ts|lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](?:git-branch|rotate-cw|server)\.mjs)$/,
              includeDependenciesRecursively: false,
              priority: 16,
            },
            {
              // The session workbench is the primary interactive route. Keep
              // its static graph route-aware, but coalesce tiny shared groups
              // so a cold navigation does not fan out into dozens of requests.
              // 192 KiB (up from 92) keeps the initial and direct-session file
              // counts inside the budget after the capabilities route stopped
              // importing several small shared modules; the smaller threshold
              // left three sub-50 KiB shared chunks in both graphs.
              name: "session",
              test: /src[\\/]routes[\\/]session\.tsx$/,
              includeDependenciesRecursively: true,
              entriesAware: true,
              entriesAwareMergeThreshold: 192 * 1024,
              priority: 2,
            },
            {
              // Keep the three Office editors, sync stack, Worker bootstrap,
              // and modality runtimes behind their one direct route. Like the
              // session group, entriesAware preserves genuinely shared shell
              // code without folding route-only dependencies into startup.
              name: "editable-artifact",
              test: /src[\\/]routes[\\/]editable-artifact\.tsx$/,
              includeDependenciesRecursively: true,
              entriesAware: true,
              entriesAwareMergeThreshold: 128 * 1024,
              priority: 3,
            },
            {
              // Keep schema parsing from being folded into a larger shared
              // startup chunk when a lazy route changes its import boundary.
              name: "schema-runtime",
              test: /(?:node_modules|\.bun)[\\/]zod(?:@|[\\/])/,
              includeDependenciesRecursively: false,
              priority: 4,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 3000,
    ...(allowedHosts?.length ? { allowedHosts } : {}),
  },
  preview: {
    port: 3000,
    ...(allowedHosts?.length ? { allowedHosts } : {}),
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
    dedupe: ["react", "react-dom", "radix-ui"],
  },
  plugins: [
    tanstackRouter({ target: "react", enableRouteGeneration: false }),
    viteReact(),
    tailwindcss(),
    safeReactHmrPlugin(),
    {
      name: "opengeni-browser-extension-archive",
      configureServer(server) {
        server.middlewares.use("/opengeni-browser-extension.tar", async (_request, response) => {
          try {
            const archive = await readFile(browserExtensionArchive);
            response.statusCode = 200;
            response.setHeader("content-type", "application/x-tar");
            response.setHeader(
              "content-disposition",
              'attachment; filename="opengeni-browser-extension.tar"',
            );
            response.setHeader("cache-control", "no-store");
            response.end(archive);
          } catch {
            response.statusCode = 503;
            response.end("OpenGeni Browser extension is not built yet.");
          }
        });
      },
      async generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "opengeni-browser-extension.tar",
          source: await readFile(browserExtensionArchive),
        });
      },
    },
    {
      name: "compact-index-html",
      transformIndexHtml: {
        order: "post",
        handler: (html) => html.replace(/>\s+</g, "><").trim(),
      },
    },
  ],
});

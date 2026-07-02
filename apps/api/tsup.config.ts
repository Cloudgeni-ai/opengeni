import { defineConfig } from "tsup";

// @opengeni/api-router is an ENGINE-DISTRIBUTION surface. Stage C publishes the
// full @opengeni/* runtime closure to npm, so every @opengeni/*, hono, and
// @temporalio/* specifier is marked external — resolved by the consumer, never
// inlined.
//
// The framework-agnostic domain/access/billing core was carved out to
// @opengeni/core (Chunk 3, behavior-preserving move); what remains here is the
// Hono adapter/router (`createApp`, the `./routes/*`, the MCP HTTP transport,
// the access HTTP adapters). This `dist` build exists to PROVE that router
// surface type-checks and compiles cleanly for the release package.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    app: "src/app.ts",
  },
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//, /^@temporalio\//, "hono"],
});

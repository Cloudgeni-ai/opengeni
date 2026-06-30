import { defineConfig } from "tsup";

// @opengeni/api-router is an ENGINE-DISTRIBUTION surface, not a registry-clean
// leaf: its runtime closure includes the deliberately-unpublished engine-internal
// packages (@opengeni/documents, @opengeni/storage, @opengeni/observability,
// @opengeni/github, @opengeni/runtime, @opengeni/codex), so a host that consumes
// it consumes the whole engine (a workspace/git install, not a bare
// `npm install`). Every @opengeni/*, hono, and @temporalio/* specifier is marked
// external — resolved by the consumer, never inlined.
//
// The framework-agnostic domain/access/billing core was carved out to
// @opengeni/core (Chunk 3, behavior-preserving move); what remains here is the
// Hono adapter/router (`createApp`, the `./routes/*`, the MCP HTTP transport,
// the access HTTP adapters). This `dist` build exists to PROVE that router
// surface type-checks and compiles cleanly for the closure guard; the runtime
// entry stays on src so internal workspace consumers and the standalone runner
// resolve `./src/index.ts`.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//, /^@temporalio\//, "hono"],
});

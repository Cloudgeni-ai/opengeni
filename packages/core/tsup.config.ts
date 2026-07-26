import { defineConfig } from "tsup";

// @opengeni/core ships ESM + .d.ts. Every @opengeni/* specifier is marked
// external so its published/engine-internal siblings (@opengeni/contracts,
// @opengeni/config, @opengeni/db, @opengeni/events, @opengeni/runtime,
// @opengeni/codex) are resolved by the consumer rather than inlined.
// @modelcontextprotocol/sdk and hono stay normal runtime `dependencies` and are
// externalized. NOTE: this is the behavior-preserving move pass — the domain
// still throws Hono `HTTPException`, so `hono` is a real runtime dep here (the
// typed-errors carve-out is deferred). The type-only devDependencies
// (@opengeni/storage/documents/observability, better-auth) are erased by the
// transpile and never appear in the emitted JS.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//, "hono"],
});

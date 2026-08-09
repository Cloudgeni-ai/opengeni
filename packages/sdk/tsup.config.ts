import { defineConfig } from "tsup";

// @opengeni/sdk ships ESM + .d.ts. Its ordinary surfaces hand-mirror the public
// wire types (pinned by test/contract-parity.test.ts); only the opt-in editable
// artifact entries import canonical bounds/codecs from @opengeni/contracts.
//
// Every @opengeni/* specifier stays external. This keeps the Worker contract
// edge explicit and is load-bearing for the publish closure guard: if a stray
// server import appears, it remains visible in dist instead of being inlined.
export default defineConfig({
  entry: [
    "src/index.ts",
    "src/core.ts",
    "src/artifacts.ts",
    "src/realtime.ts",
    "src/editable-artifacts.ts",
    "src/editable-artifacts-worker.ts",
    "src/codex-realtime-controller.ts",
    "src/gateway-realtime-transport.ts",
  ],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//],
});

import { defineConfig } from "tsup";

// @opengeni/runtime has two public entry points:
//   .          -> the full agent loop
//   ./sandbox  -> the API-safe sandbox leaf
//
// The runtime ships `src/` as well as `dist/` because the bundled skill library
// is data, not compiled JS; index.ts resolves it from src when running from dist.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "sandbox/index": "src/sandbox/index.ts",
  },
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//],
});

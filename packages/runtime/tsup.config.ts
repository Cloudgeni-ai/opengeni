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
    "skill-library": "src/skill-library.ts",
  },
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    /^@opengeni\//,
    /^@modelcontextprotocol\/sdk(?:$|\/)/,
    /^debug$/,
    /^openai(?:$|\/)/,
    /^ws$/,
  ],
  // The OpenAI Agents packages require Zod 4 as a peer. Bundle that complete
  // implementation boundary so an embedding host can use another Zod major
  // without changing Agents' runtime schema identity underneath it.
  noExternal: [/^@openai\/agents(?:$|\/|-)/, /^zod(?:$|\/)/],
});

import { defineConfig } from "tsup";

// @opengeni/config ships ESM + .d.ts. Every @opengeni/* specifier is marked
// external so sibling published packages (e.g. @opengeni/contracts) are resolved
// by the consumer, not inlined. zod stays a normal runtime `dependencies` entry
// and is externalized for dedupe.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//],
});

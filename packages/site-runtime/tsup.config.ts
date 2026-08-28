import { defineConfig } from "tsup";

// The Site Runtime is intentionally a tiny browser-only package. Keep sibling
// packages external so its published closure cannot accidentally acquire an
// OpenGeni server dependency or bundle a credential-bearing transport.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external: [/^@opengeni\//],
});

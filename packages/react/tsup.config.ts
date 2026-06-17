import { defineConfig } from "tsup";

import pkg from "./package.json" with { type: "json" };

// @opengeni/react ships ESM + .d.ts. Its only @opengeni runtime import is
// @opengeni/sdk; everything in `dependencies` (motion, lucide-react, radix-ui,
// clsx, tailwind-merge) plus React itself is marked external so we never bundle
// a second copy. CSS is shipped untouched from styles/ (the ./styles.css and
// ./tokens.css subpath exports) — tsup does not compile it.
//
// All @opengeni/* are externalized (via the regex below). @opengeni/sdk stays a
// real external import in dist (correct — it's a published runtime dep). This
// also keeps the publish closure guard honest: any stray server import survives
// as a literal `@opengeni/<server>` specifier instead of being inlined, so the
// guard can grep for and reject it.
const external = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  /^@opengeni\//,
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  external,
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});

import { defineConfig } from "tsup";

import pkg from "./package.json" with { type: "json" };

// @opengeni/react ships ESM + .d.ts. Its only @opengeni runtime edge is the
// SDK; isolated projection artifact entries are artifact-runtime-free, while
// legacy structural authoring types come from the optional reference peer.
// Dependencies, peers, and React itself are external
// so we never bundle a second copy. CSS is shipped untouched from styles/ (the
// ./styles.css and ./compiled.css / ./tokens.css subpath exports) — the package
// CSS build owns compiled.css and tsup does not process any stylesheet.
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
  entry: [
    "src/index.ts",
    "src/composer.ts",
    "src/session.ts",
    "src/session-ui.ts",
    "src/machines.ts",
    "src/model-policy.ts",
    "src/realtime.ts",
    "src/artifacts.ts",
    "src/artifacts-spreadsheet.ts",
    "src/artifacts-document.ts",
    "src/artifacts-presentation.ts",
  ],
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
